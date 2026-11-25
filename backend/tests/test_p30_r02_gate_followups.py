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
from httpx import AsyncClient, Response
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
from tests.p62_audit import P71A_TEMPLATE_VERSION as V0  # noqa: N814
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
# PDD-E's lead edited to 10 (T = 16) would have given E = 200 * 10 / 16 = 125
# > 104 (R7) before P33; since P33-T08 the split's weights are immutable.
_FIGURE_200 = {"PDD-A": 20, "PDD-D": 20, "PDD-E": 80, "PDD-J": 20, "PDD-K": 40, "PDD-M": 20}
#: P33-T10: a template edit goes through the apply (the lead-times PUT is 410).
_E_TO_10 = {
    "changes": [{"workflow_id": "PDD", "category": "B", "base_version": V0,
                 "steps": [{"step_id": "PDD-E", "weeks": 10}]}],
    "selection": {"mode": "all_not_reached"},
}


async def test_lead_time_edit_never_reshapes_a_split(db_session):
    """P33-T08 (DOMAIN_RULES "Category templates" §B, R33-2; was "a lead-time
    edit rejected by R7 rolls back"). The split's weights are the immutable
    `effort_weight_weeks`, so the edit that used to push PDD-E to 125 weeks
    (R7) is accepted and changes no project's split: R6's triggers no longer
    include the lead-time edit."""

    w = await _effort_world(db_session)
    project = await stepped_project(
        db_session, w.greece, name="Big B", leader=w.lead, category=ProjectCategory.B
    )
    project_id = project.id
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project_id}", json={"design_effort_weeks": 200})
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project_id)
    assert {k: effort[k] for k in _FIGURE_200} == _FIGURE_200
    audits_before = len(await _rederive_audits(db_session, project_id))

    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post("/workflow-templates/apply", json=_E_TO_10)
    assert resp.status_code == 200, resp.text
    # Own design figure: the length is not applied (OR-4), nothing is written.
    assert resp.json()["applied"] == {"automatic": 0, "selected": 0, "own_effort_not_applied": 1}
    assert await _lead_weeks(db_session, "PDD-E") == 10
    effort = await _effort(db_session, project_id)
    assert {k: effort[k] for k in _FIGURE_200} == _FIGURE_200
    assert len(await _rederive_audits(db_session, project_id)) == audits_before


async def test_unfreeze_rejected_by_r7_keeps_the_project_frozen(db_session):
    """R7 on unfreeze. Before P33 the over-104 split came from a lead-time
    edit made while frozen; since P33-T08 a template edit never reshapes a
    split (R33-2), so the stored figure itself is over the limit here (300
    over PDD / B's weights gives PDD-E 120 weeks), as a frozen project's
    figure stored before R7 existed would be."""

    w = await _effort_world(db_session)
    project = await stepped_project(
        db_session, w.greece, name="Frozen big B", leader=w.lead, category=ProjectCategory.B,
        frozen=True, actual_start_week=20, design_effort_weeks=Decimal("300"),
    )  # fmt: skip
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        # Unfreezing would re-derive E to 120 weeks: rejected before any write.
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
    """A check-in that moves a stage off Not Started re-derives (R6).

    Figure 4 on PDD / B gives A1 E2 K1 with D at 0 (skipped).

    P33-T13 (ADR 0048): this used to keep D schedulable with a stored user
    override, check it in and see R3 raise it to 1. p33c made that state
    impossible (no user override can be stored), so a zero-share step is
    skipped: it is never due and a check-in on it is refused, writing
    nothing. Starting E (share 2) re-derives with no share change, so no
    `project.effort_rederived` row is added (one is written only when a share
    changes) and the split is unchanged."""

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
    run = await make_schedule_run(db_session, is_active=True)
    await plan_step(db_session, run, project, "PDD-D", CW - 1, CW, engineer=w.lead)
    await plan_step(db_session, run, project, "PDD-E", CW - 1, CW, engineer=w.lead)
    audits_before = await _rederive_audits(db_session, project.id)
    assert [a.after_state["trigger"] for a in audits_before] == ["effort_figure"]

    async def check_in(step_id: str) -> Response:
        async with client_for(db_session) as client:
            return await client.post(
                "/check-ins",
                json={
                    "entries": [
                        {
                            "project_id": str(project.id),
                            "step_id": step_id,
                            "status": "In Progress",
                            "percent_complete": 30,
                        }
                    ]
                },
            )

    resp = await check_in("PDD-D")
    assert resp.status_code == 422, resp.text
    assert resp.json()["code"] == "CHECKIN_INVALID"
    assert resp.json()["detail"]["errors"][0]["code"] == "NOT_DUE"
    row_d = await live_step(db_session, project, "PDD-D")
    await db_session.refresh(row_d)
    assert row_d.status == WorkflowStepStatus.NOT_STARTED

    resp = await check_in("PDD-E")
    assert resp.status_code == 200, resp.text
    assert resp.json()["accepted"] == 1
    row_e = await live_step(db_session, project, "PDD-E")
    await db_session.refresh(row_e)
    assert row_e.status == WorkflowStepStatus.IN_PROGRESS
    effort = await _effort(db_session, project)
    assert (effort["PDD-A"], effort["PDD-D"], effort["PDD-E"], effort["PDD-K"]) == (1, 0, 2, 1)
    assert await _rederive_audits(db_session, project.id) == audits_before


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
