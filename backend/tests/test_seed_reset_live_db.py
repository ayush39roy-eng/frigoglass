"""P24-T01 follow-up: `seed_demo_data --reset --schedule` works on a live DB.

The owner's dev DB failed the reseed with
`fk_notifications_previous_schedule_run_id_schedule_runs`: `--reset` deleted
`schedule_runs` before the `notifications` that reference them. A check-in
would have failed next (`stage_checkins` was append-only with no escape
hatch, and its `project_id` is NOT NULL).

This module seeds client_2026 with a schedule run, then adds every
user-generated row type that references a run, a project, an engineer or a
hub: notifications (both run FKs), stage check-ins, comments, files,
priority-move and scenario-apply history, access grants, user VIP items, links
and pins, an engineer-user link, a user hub scope, a pending follow-up and an
audit row. It reseeds with `--reset --schedule` and asserts what is deleted
and what is kept.

It uses its own throwaway container (the seed commits real data).
"""

from __future__ import annotations

import asyncio
import importlib
from typing import Any

import pytest
from sqlalchemy import func, insert, select, text, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from models import (
    AuditLogEntry,
    Engineer,
    Notification,
    PriorityApplicationResult,
    PriorityApplicationRun,
    Project,
    ProjectAccessGrant,
    ProjectComment,
    ProjectFile,
    ProjectWorkflowStep,
    ScenarioApplyChange,
    ScenarioApplyRun,
    ScheduleRun,
    ScheduleRunFollowUp,
    StageCheckin,
    User,
    UserHubScope,
)
from models.vip import VipItem, vip_item_projects
from tests.conftest import run_alembic


@pytest.fixture(scope="module")
def db_url():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"alembic upgrade head failed:\n{r.stdout}\n{r.stderr}"
        yield url


async def _add_live_rows(url: str) -> dict[str, Any]:
    """Every dependent row type, pointing at the active run and seeded rows."""

    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as s:
            run = (await s.execute(select(ScheduleRun))).scalars().one()
            projects = (
                (await s.execute(select(Project).order_by(Project.external_code).limit(2)))
                .scalars()
                .all()
            )
            p, p2 = projects
            step = (
                await s.execute(
                    select(ProjectWorkflowStep.step_template_id)
                    .where(ProjectWorkflowStep.project_id == p.id)
                    .order_by(ProjectWorkflowStep.sequence_order)
                    .limit(1)
                )
            ).scalar_one()
            engineer = (
                (await s.execute(select(Engineer).order_by(Engineer.name).limit(1))).scalars().one()
            )

            alice = User(email="alice@example.test", full_name="Alice", oidc_subject="a-sub")
            bob = User(email="bob@example.test", full_name="Bob", oidc_subject="b-sub")
            s.add_all([alice, bob])
            await s.flush()

            s.add(
                AuditLogEntry(
                    action="test.live_row",
                    entity_type="project",
                    entity_id=str(p.id),
                    hub_id=p.hub_id,
                    actor_user_id=alice.id,
                )
            )
            s.add(UserHubScope(user_id=bob.id, hub_id=p.hub_id))
            engineer.user_id = bob.id
            s.add(
                Notification(
                    recipient_user_id=alice.id,
                    reason="delay_introduced",
                    project_id=p.id,
                    hub_id=p.hub_id,
                    message="delayed",
                    schedule_run_id=run.id,
                    previous_schedule_run_id=run.id,
                )
            )
            s.add(
                StageCheckin(
                    project_id=p.id,
                    step_template_id=step,
                    week=42,
                    user_id=alice.id,
                    status="In Progress",
                    percent_complete=10,
                )
            )
            s.add(ProjectComment(project_id=p.id, body_md="note", author_user_id=alice.id))
            s.add(
                ProjectFile(
                    project_id=p.id,
                    display_name="spec.pdf",
                    uploaded_by_user_id=alice.id,
                    size_bytes=1,
                    content_type="application/pdf",
                    minio_object_key="projects/x/spec.pdf",
                )
            )
            prun = PriorityApplicationRun(version=1, applied_by_user_id=alice.id)
            srun = ScenarioApplyRun(version=1, applied_by_user_id=alice.id)
            s.add_all([prun, srun])
            await s.flush()
            s.add(
                PriorityApplicationResult(
                    priority_application_run_id=prun.id,
                    project_id=p.id,
                    weighted_score=50,
                    normalized_pct=50,
                    suggested_band="P2",
                    set_priority="P2",
                )
            )
            s.add(
                ScenarioApplyChange(
                    scenario_apply_run_id=srun.id,
                    entity_type="project",
                    entity_id=str(p.id),
                    project_id=p.id,
                    hub_id=p.hub_id,
                    after_state={"priority": "P1"},
                )
            )
            grant = ProjectAccessGrant(
                project_id=p.id, user_id=bob.id, project_role="editor", granted_by_user_id=alice.id
            )
            item = VipItem(area="India", pillar="INNOVATION", title="User-made item")
            s.add_all([grant, item])
            await s.flush()
            await s.execute(insert(vip_item_projects).values(item_id=item.id, project_id=p.id))
            # A manual pin with no link (ADR 0022): user config.
            await s.execute(update(Project).where(Project.id == p2.id).values(is_vip=True))
            await s.execute(
                update(ScheduleRunFollowUp).values(
                    pending=True, last_trigger_reason="check_in", request_count=3
                )
            )
            await s.commit()
            return {
                "run_id": run.id,
                "project_id": p.id,
                "pinned_project_id": p2.id,
                "engineer_id": engineer.id,
                "grant_id": grant.id,
                "item_id": item.id,
                "bob_id": bob.id,
            }
    finally:
        await engine.dispose()


async def _state(url: str) -> dict[str, Any]:
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine)() as s:

            async def count(model) -> int:
                return await s.scalar(select(func.count()).select_from(model)) or 0

            follow_up = (await s.execute(select(ScheduleRunFollowUp))).scalars().one()
            return {
                "notifications": await count(Notification),
                "stage_checkins": await count(StageCheckin),
                "project_comments": await count(ProjectComment),
                "project_files": await count(ProjectFile),
                "priority_application_runs": await count(PriorityApplicationRun),
                "priority_application_results": await count(PriorityApplicationResult),
                "scenario_apply_runs": await count(ScenarioApplyRun),
                "scenario_apply_changes": await count(ScenarioApplyChange),
                "schedule_run_ids": set((await s.execute(select(ScheduleRun.id))).scalars()),
                "audit": await count(AuditLogEntry),
                "user_hub_scopes": await count(UserHubScope),
                "grant_ids": set((await s.execute(select(ProjectAccessGrant.id))).scalars()),
                "vip_items": set((await s.execute(select(VipItem.id))).scalars()),
                "vip_links": set(
                    (
                        await s.execute(
                            select(vip_item_projects.c.item_id, vip_item_projects.c.project_id)
                        )
                    ).all()
                ),
                "vip_pins": set(
                    (await s.execute(select(Project.id).where(Project.is_vip.is_(True)))).scalars()
                ),
                "engineer_users": dict(
                    (
                        await s.execute(
                            select(Engineer.id, Engineer.user_id).where(
                                Engineer.user_id.is_not(None)
                            )
                        )
                    ).all()
                ),
                "follow_up": (follow_up.pending, follow_up.request_count),
            }
    finally:
        await engine.dispose()


async def _checkin_update_still_rejected(url: str) -> None:
    """The reseed's escape hatch allows DELETE only: UPDATE is still rejected,
    even with the setting on."""

    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SET LOCAL rpd.allow_checkin_delete = 'on'"))
            with pytest.raises(DBAPIError, match="append-only"):
                await conn.execute(update(StageCheckin).values(percent_complete=99))
            await conn.rollback()
    finally:
        await engine.dispose()


def test_reset_schedule_succeeds_with_live_user_rows(db_url, monkeypatch):
    monkeypatch.setenv("RPD_DATABASE_URL", db_url)
    seed_demo_data = importlib.reload(importlib.import_module("seed.seed_demo_data"))

    first = asyncio.run(seed_demo_data.run(reset_first=False, schedule=True))
    assert first["schedule_run"]["version"] == 1

    ids = asyncio.run(_add_live_rows(db_url))
    asyncio.run(_checkin_update_still_rejected(db_url))
    before = asyncio.run(_state(db_url))
    assert before["notifications"] == 1 and before["stage_checkins"] == 1

    counts = asyncio.run(seed_demo_data.run(reset_first=True, schedule=True))
    assert counts["_verified_from_db"]["projects"] == 253
    assert counts["schedule_run"]["projects"] == 253
    assert counts["reset_user_config"] == {
        "access_grants_kept": 1,
        "access_grants_dropped": 0,
        "vip_links_kept": len(before["vip_links"]),
        "vip_links_dropped": 0,
        "vip_pins_kept": len(before["vip_pins"]),
        "engineer_user_links_kept": 1,
        "engineer_user_links_dropped": 0,
    }

    after = asyncio.run(_state(db_url))
    # Deleted: they only describe the replaced data.
    for key in (
        "notifications",
        "stage_checkins",
        "project_comments",
        "project_files",
        "priority_application_runs",
        "priority_application_results",
        "scenario_apply_runs",
        "scenario_apply_changes",
    ):
        assert after[key] == 0, key
    assert len(after["schedule_run_ids"]) == 1
    assert ids["run_id"] not in after["schedule_run_ids"]
    assert after["follow_up"] == (False, 0)

    # Kept: the audit log (append-only), so the hubs and the user hub scope.
    assert after["audit"] == before["audit"] == 1
    assert after["user_hub_scopes"] == 1
    # Kept: user configuration, restored onto the same (uuid5) ids.
    assert after["grant_ids"] == {ids["grant_id"]}
    assert ids["item_id"] in after["vip_items"]
    assert (ids["item_id"], ids["project_id"]) in after["vip_links"]
    assert after["vip_links"] == before["vip_links"]
    assert ids["pinned_project_id"] in after["vip_pins"]
    assert after["vip_pins"] == before["vip_pins"]
    assert after["engineer_users"] == {ids["engineer_id"]: ids["bob_id"]}

    # A second reseed in a row is still clean.
    again = asyncio.run(seed_demo_data.run(reset_first=True, schedule=True))
    assert again["schedule_run"]["version"] == 1
