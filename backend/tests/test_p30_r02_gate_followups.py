"""P30-R02: non-blocking follow-ups from gate P30-T20 (P28-P30).

1. Deterministic ordering (QA 1b / workflow N3):
   `/dashboard/hub-type-pipeline` orders by hub, then type (NULL type last);
   `/dashboard/completing-within-year` rows by project name, then id. The
   order must not follow the query plan, so it is compared before and after
   `ANALYZE` and under forced plan shapes.
2. Missing R7 / R6 coverage (QA 3): effort-split rejection on a lead-time
   edit (422 + rollback) and on unfreeze (422, still frozen); the check-in
   re-derivation result (`project.effort_rederived`, trigger
   `stage_status`).
3. S30-L2: `GET /capacity/engineer-utilization?hub_id=<unknown>` is a normal
   empty 200, not a 500 from the read-audit row's hub FK.
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, text, update

import api.routers.checkins as checkins_router
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    RoleName,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import CW, act_as, client_for, live_step, plan_step, stepped_project
from tests.test_p13_region_filter import (
    REGIONS,
    _client,
    _get,
    _hub_type_key,
    _seeded,
)
from tests.test_p13_region_filter import _act_as as _p13_act_as
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    checkins_router.CHECKIN_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    checkins_router.CHECKIN_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(checkins_router, "publish_progress", lambda *a, **k: None)
    return calls


# --- 1. Deterministic ordering ---------------------------------------------------------


async def _ordered_bodies(client: AsyncClient) -> dict[str, Any]:
    out: dict[str, Any] = {
        "hub_type": await _get(client, "/dashboard/hub-type-pipeline"),
        "completing": (await _get(client, "/dashboard/completing-within-year"))["rows"],
    }
    for region in REGIONS:
        out[f"hub_type/{region}"] = await _get(
            client, "/dashboard/hub-type-pipeline", region=region
        )
        out[f"completing/{region}"] = (
            await _get(client, "/dashboard/completing-within-year", region=region)
        )["rows"]
    return out


async def test_dashboard_orders_are_stable_after_analyze_and_across_plans(db_session):
    seeded = await _seeded(db_session)
    # A NULL type must sit in a fixed position (last within its hub).
    some_project = (
        await db_session.execute(select(Project).order_by(Project.name, Project.id).limit(1))
    ).scalar_one()
    await db_session.execute(update(Project).where(Project.id == some_project.id).values(type=None))
    await db_session.flush()
    await _p13_act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        before = await _ordered_bodies(client)
        await db_session.execute(text("ANALYZE projects"))
        await db_session.execute(text("ANALYZE hubs"))
        await db_session.execute(text("ANALYZE schedule_run_project_outcomes"))
        after_analyze = await _ordered_bodies(client)
        # Force the other aggregate / join shapes too (transaction-local).
        await db_session.execute(text("SET LOCAL enable_hashagg = off"))
        await db_session.execute(text("SET LOCAL enable_hashjoin = off"))
        forced = await _ordered_bodies(client)

    assert before == after_analyze == forced

    hub_type = before["hub_type"]
    assert hub_type == sorted(hub_type, key=_hub_type_key)
    assert any(r["type"] is None for r in hub_type)
    for hub in {r["hub"] for r in hub_type}:
        types = [r["type"] for r in hub_type if r["hub"] == hub]
        if None in types:
            assert types[-1] is None
    for region in REGIONS:
        rows = before[f"hub_type/{region}"]
        assert rows == sorted(rows, key=_hub_type_key)

    # Completing rows: exactly the DB's own ORDER BY name, id over the run.
    expected_ids = [
        str(pid)
        for pid in (
            await db_session.execute(
                select(Project.id)
                .join(ScheduleRunProjectOutcome, ScheduleRunProjectOutcome.project_id == Project.id)
                .where(ScheduleRunProjectOutcome.schedule_run_id == seeded.run.id)
                .order_by(Project.name, Project.id)
            )
        ).scalars()
    ]
    assert [r["project_id"] for r in before["completing"]] == expected_ids
    assert len(expected_ids) > 0
    for region in REGIONS:
        ids = [r["project_id"] for r in before[f"completing/{region}"]]
        assert ids == [i for i in expected_ids if i in set(ids)]


# --- 2. R7 rejection on a lead-time edit and on unfreeze; R6 from check-ins -----------


async def _effort_world(db) -> SimpleNamespace:
    greece = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    cats = [EngineerAllowedCategory(c) for c in ("A+", "A", "B", "C")]
    lead = await make_engineer(db, greece, name="Lead GR", allowed_categories=cats)
    await db.flush()
    return SimpleNamespace(greece=greece, lead=lead)


async def _effort(db, project: Project | uuid.UUID) -> dict[str, int | None]:
    project_id = project if isinstance(project, uuid.UUID) else project.id
    rows = (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(ProjectWorkflowStep.project_id == project_id)
            .order_by(ProjectWorkflowStep.sequence_order)
        )
    ).scalars()
    return {r.step_template_id: r.effort_weeks for r in rows}


async def _rederive_audits(db, project_id: uuid.UUID) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(
                    AuditLogEntry.action == "project.effort_rederived",
                    AuditLogEntry.entity_id == str(project_id),
                )
                .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
            )
        )
        .scalars()
        .all()
    )


async def _lead_weeks(db, step_id: str) -> int:
    weeks: int = (
        await db.execute(
            select(WorkflowLeadTime.weeks)
            .execution_options(populate_existing=True)
            .where(
                WorkflowLeadTime.workflow_id == "PDD",
                WorkflowLeadTime.category == ProjectCategory.B,
                WorkflowLeadTime.step_id == step_id,
            )
        )
    ).scalar_one()
    return weeks


# PDD / B design leads A1 D1 E4 J1 K2 M1 (T = 10). Figure 200:
# A20 D20 E80 J20 K40 M20, every step <= 104 (accepted at write).
# PDD-E's lead edited to 10 (T = 16): E = 200 * 10 / 16 = 125 > 104 (R7).
_FIGURE_200 = {"PDD-A": 20, "PDD-D": 20, "PDD-E": 80, "PDD-J": 20, "PDD-K": 40, "PDD-M": 20}
_E_TO_10 = {
    "lead_times": [{"workflow_id": "PDD", "category": "B", "step_id": "PDD-E", "weeks": 10}]
}


async def test_lead_time_edit_rejected_by_r7_rolls_back(db_session):
    w = await _effort_world(db_session)
    project = await stepped_project(
        db_session, w.greece, name="Big B", leader=w.lead, category=ProjectCategory.B
    )
    project_id = project.id  # the rollback below expires every loaded object
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project_id}", json={"design_effort_weeks": 200})
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project_id)
    assert {k: effort[k] for k in _FIGURE_200} == _FIGURE_200
    lead_before = await _lead_weeks(db_session, "PDD-E")
    audits_before = len(await _rederive_audits(db_session, project_id))
    # The handler rolls the session back on rejection; release the setup's
    # savepoint first so only the request's own work is undone.
    await db_session.commit()

    await act_as(db_session, RoleName.SUPER_ADMIN)
    await db_session.commit()
    async with client_for(db_session) as client:
        resp = await client.put("/workflow-settings/lead-times", json=_E_TO_10)
    assert resp.status_code == 422, resp.text
    body = resp.json()
    assert body["code"] == "EFFORT_SPLIT_REJECTED"
    assert body["detail"][0]["loc"][-1] == "design_effort_weeks"

    # Nothing was written: lead time, split, audit rows all unchanged.
    assert await _lead_weeks(db_session, "PDD-E") == lead_before == 4
    effort = await _effort(db_session, project_id)
    assert {k: effort[k] for k in _FIGURE_200} == _FIGURE_200
    assert len(await _rederive_audits(db_session, project_id)) == audits_before
    lead_audits = (
        (
            await db_session.execute(
                select(AuditLogEntry).where(AuditLogEntry.action.like("%lead_times_update"))
            )
        )
        .scalars()
        .all()
    )
    assert lead_audits == []


async def test_unfreeze_rejected_by_r7_keeps_the_project_frozen(db_session):
    w = await _effort_world(db_session)
    project = await stepped_project(
        db_session, w.greece, name="Frozen big B", leader=w.lead, category=ProjectCategory.B,
        frozen=True, actual_start_week=20, design_effort_weeks=Decimal("200"),
    )  # fmt: skip
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        # Accepted while frozen: the frozen project is exempt from the
        # re-derivation (I10), so its split is not checked here.
        resp = await client.put("/workflow-settings/lead-times", json=_E_TO_10)
        assert resp.status_code == 200, resp.text
        # Unfreezing would re-derive E to 125 weeks: rejected before any write.
        resp = await client.post(f"/gantt/projects/{project.id}/freeze", json={"frozen": False})
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "EFFORT_SPLIT_REJECTED"
    assert resp.json()["detail"][0]["loc"][-1] == "design_effort_weeks"
    reloaded = (
        await db_session.execute(
            select(Project)
            .execution_options(populate_existing=True)
            .where(Project.id == project.id)
        )
    ).scalar_one()
    assert reloaded.frozen is True and reloaded.actual_start_week == 20
    assert await _rederive_audits(db_session, project.id) == []
    assert all(v is None for v in (await _effort(db_session, project)).values())


async def test_check_in_start_rederives_the_split_r3_r6(db_session, dispatch):
    """A check-in that moves a stage off Not Started re-derives (R3 input).

    Figure 4 on PDD / B gives A1 E2 K1 with D at 0 (skipped). An EXISTING
    user override keeps D schedulable (R4), so it can be due and checked in;
    once started, R3 raises its effort to max(1, 0) = 1 (Σ = E + 1)."""

    w = await _effort_world(db_session)
    project = await stepped_project(
        db_session, w.greece, name="B4", leader=w.lead, category=ProjectCategory.B
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 4})
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project)
    assert (effort["PDD-A"], effort["PDD-D"], effort["PDD-E"], effort["PDD-K"]) == (1, 0, 2, 1)
    row_d = await live_step(db_session, project, "PDD-D")
    row_d.duration_override_weeks = 2
    await db_session.flush()
    run = await make_schedule_run(db_session, is_active=True)
    await plan_step(db_session, run, project, "PDD-D", CW - 1, CW, engineer=w.lead)
    audits_before = await _rederive_audits(db_session, project.id)
    assert [a.after_state["trigger"] for a in audits_before] == ["effort_figure"]

    async with client_for(db_session) as client:
        resp = await client.post(
            "/check-ins",
            json={
                "entries": [
                    {
                        "project_id": str(project.id),
                        "step_id": "PDD-D",
                        "status": "In Progress",
                        "percent_complete": 30,
                    }
                ]
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["accepted"] == 1

    row_d = await live_step(db_session, project, "PDD-D")
    await db_session.refresh(row_d)
    assert row_d.status == WorkflowStepStatus.IN_PROGRESS
    effort = await _effort(db_session, project)
    assert (effort["PDD-A"], effort["PDD-D"], effort["PDD-E"], effort["PDD-K"]) == (1, 1, 2, 1)
    assert row_d.duration_override_weeks == 2  # the user's figure is never cleared
    audits = await _rederive_audits(db_session, project.id)
    assert len(audits) == 2
    audit = next(a for a in audits if a.after_state["trigger"] == "stage_status")
    assert audit.after_state["design_split"]["raised_step_ids"] == ["PDD-D"]
    assert audit.before_state["effort_weeks"]["PDD-D"] == 0
    assert audit.after_state["effort_weeks"]["PDD-D"] == 1


# --- 3. S30-L2: unknown hub_id on engineer-utilization ----------------------------------


async def _utilization_audits(db) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == "capacity.engineer_utilization.read")
                .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
            )
        )
        .scalars()
        .all()
    )


@pytest.mark.parametrize("scoped", [False, True])
async def test_engineer_utilization_unknown_hub_is_empty_not_500_s30_l2(db_session, scoped):
    w = await _effort_world(db_session)
    unknown = uuid.uuid4()
    if scoped:
        await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.greece.id])
    else:
        await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/capacity/engineer-utilization", params={"hub_id": str(unknown)})
        assert resp.status_code == 200, resp.text
        assert resp.json()["engineers"] == []
        # A real hub filter still names the hub in the audit column.
        known = await client.get(
            "/capacity/engineer-utilization", params={"hub_id": str(w.greece.id)}
        )
        assert known.status_code == 200, known.text
        assert [e["name"] for e in known.json()["engineers"]] == ["Lead GR"]
    # One outer test transaction: `occurred_at` cannot order the two rows.
    audits = {(a.after_state or {})["hub_id"]: a for a in await _utilization_audits(db_session)}
    assert set(audits) == {str(unknown), str(w.greece.id)}
    first, second = audits[str(unknown)], audits[str(w.greece.id)]
    assert first.hub_id is None
    assert first.after_state == {"hub_id": str(unknown), "region": None, "row_count": 0}
    assert second.hub_id == w.greece.id
    assert (second.after_state or {})["hub_id"] == str(w.greece.id)
