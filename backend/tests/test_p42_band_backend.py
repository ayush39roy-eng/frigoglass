"""P42-T03 (ADR 0056 as ruled at P42-T01, R42-1..R42-10; docs/API_CONTRACT_P42.md).

Backend side of "priority bands mean something for scheduling":

- the two stored outcome flags (`counts_toward_year`, `not_scheduled_priority`)
  are persisted exactly as the scheduler emits them (R42-4, I50);
- every surface buckets with NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED >
  WITHIN_YEAR > SPILLOVER > LEFT_OUT, the six counts (plus `excluded_count`)
  sum to the row count, and every within-year denominator counts counting
  rows only (R42-6, I53);
- labels are served (R42-1), the Capacity `Queue` key displays "Q";
- run changes compare both flags (I20); notifications raise no regression
  for a non-counting outcome; check-ins / tracking leave out non-frozen P4/Q;
  VIP never auto-fills them; the priority preview says "leaves the plan" /
  "joins the queue" (R42-8); I25 remaining demand drops non-frozen P4/Q.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    NotificationReason,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    SolverType,
    WorkflowStepStatus,
)
from models.notification import Notification
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from scheduling import run_greedy_sgs
from seed import seed_demo_data
from services.demand_load import load_demand
from services.export_builder import build_gantt_sheets
from services.outcome_buckets import (
    BUCKET_ORDER,
    NOT_SCHEDULED_LABEL,
    outcome_bucket,
    outcome_label,
    priority_label,
    queued_display,
)
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.tracking import due_stages_for
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override, make_principal
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
)
from tests.p12_helpers import act_as, client_for, set_progress, stepped_project

SIX = (
    "not_scheduled_priority_count",
    "queued_count",
    "blocked_count",
    "within_year_count",
    "spillover_count",
    "left_out_count",
)


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _seed_and_run(db_session: AsyncSession) -> ScheduleRun:
    """The demo seed (P4/Q and queued P3 projects included) and one
    persisted, active greedy run."""

    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    return await persist_schedule_output(
        db_session,
        schedule_input,
        run_greedy_sgs(schedule_input),
        solver_type=SolverType.GREEDY,
        trigger_reason="test",
        activate=True,
    )


async def _outcomes(db_session: AsyncSession, run: ScheduleRun) -> list[ScheduleRunProjectOutcome]:
    return list(
        (
            await db_session.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == run.id
                )
            )
        )
        .scalars()
        .all()
    )


# --- pure helpers ----------------------------------------------------------------------


class _Row:
    def __init__(self, **kw: Any) -> None:
        self.within_year = kw.get("within_year", False)
        self.spillover = kw.get("spillover", False)
        self.left_out = kw.get("left_out", False)
        self.blocked = kw.get("blocked", False)
        self.counts_toward_year = kw.get("counts_toward_year", True)
        self.not_scheduled_priority = kw.get("not_scheduled_priority", False)


def test_bucket_precedence() -> None:
    assert BUCKET_ORDER == (
        "NOT_SCHEDULED_PRIORITY",
        "QUEUED",
        "BLOCKED",
        "WITHIN_YEAR",
        "SPILLOVER",
        "LEFT_OUT",
    )
    nsp = _Row(not_scheduled_priority=True, counts_toward_year=False, left_out=True)
    assert outcome_bucket(nsp) == "NOT_SCHEDULED_PRIORITY"
    assert outcome_bucket(_Row(counts_toward_year=False, blocked=True)) == "QUEUED"
    assert outcome_bucket(_Row(counts_toward_year=False, left_out=True)) == "QUEUED"
    assert outcome_bucket(_Row(blocked=True, within_year=True)) == "BLOCKED"
    assert outcome_bucket(_Row(within_year=True)) == "WITHIN_YEAR"
    assert outcome_bucket(_Row(spillover=True)) == "SPILLOVER"
    assert outcome_bucket(_Row(left_out=True)) == "LEFT_OUT"
    assert outcome_bucket(_Row()) is None
    assert outcome_bucket(None) is None


def test_labels_and_queued_display() -> None:
    assert priority_label(ProjectPriority.P1) == "Must do this year"
    assert priority_label("P2") == "Good to have this year"
    assert priority_label(ProjectPriority.P3) == "In queue"
    assert priority_label(ProjectPriority.P4) == "Miscellaneous"
    assert priority_label(ProjectPriority.Q) == "Unprioritised"
    assert priority_label(None) is None
    assert queued_display(left_out=False, projected_end_week=40) == "Queued — fits by W40"
    assert queued_display(left_out=False, projected_end_week=52) == "Queued — fits by W52"
    assert queued_display(left_out=False, projected_end_week=60) == "Queued — after W52"
    assert queued_display(left_out=True, projected_end_week=None) == "Queued — no slot"
    nsp = _Row(not_scheduled_priority=True, counts_toward_year=False)
    assert outcome_label(nsp, None) == NOT_SCHEDULED_LABEL == "Not scheduled (P4)"
    assert outcome_label(_Row(within_year=True), 30) is None


# --- persistence -----------------------------------------------------------------------


async def test_flags_are_persisted_as_emitted(db_session: AsyncSession) -> None:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session,
        schedule_input,
        output,
        solver_type=SolverType.GREEDY,
        trigger_reason="test",
        activate=True,
    )
    stored = {str(o.project_id): o for o in await _outcomes(db_session, run)}
    emitted = {o.project_id: o for o in output.project_outcomes}
    assert stored.keys() == emitted.keys()
    for pid, o in emitted.items():
        assert stored[pid].counts_toward_year == o.counts_toward_year, pid
        assert stored[pid].not_scheduled_priority == o.not_scheduled_priority, pid
    # The seed holds not-scheduled P4/Q projects. P53 (R53-2, I53): a queued
    # P3 counts, so a P53 run has no counting-false row besides frozen P4/Q.
    assert sum(o.not_scheduled_priority for o in stored.values()) > 0
    # I49: a not-scheduled project books no rows and is never within / spillover.
    for row in stored.values():
        if row.not_scheduled_priority:
            assert not row.counts_toward_year
            assert not (row.within_year or row.spillover or row.left_out or row.blocked)


# --- dashboard -------------------------------------------------------------------------


async def test_completing_within_year_buckets_sum_to_row_count(db_session: AsyncSession) -> None:
    run = await _seed_and_run(db_session)
    stored = await _outcomes(db_session, run)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
    rows = body["rows"]
    assert len(rows) == len(stored)
    assert sum(body[k] for k in SIX) + body["excluded_count"] == len(rows)
    # Each count equals the rows of its bucket.
    by_bucket: dict[str | None, int] = {}
    for r in rows:
        by_bucket[r["outcome"]] = by_bucket.get(r["outcome"], 0) + 1
    assert body["not_scheduled_priority_count"] == by_bucket.get("NOT_SCHEDULED_PRIORITY", 0) > 0
    # P53 (I53): no QUEUED row in a P53 run.
    assert body["queued_count"] == by_bucket.get("QUEUED", 0) == 0
    assert body["within_year_count"] == by_bucket.get("WITHIN_YEAR", 0)
    assert body["spillover_count"] == by_bucket.get("SPILLOVER", 0)
    assert body["left_out_count"] == by_bucket.get("LEFT_OUT", 0)
    assert body["blocked_count"] == by_bucket.get("BLOCKED", 0)
    assert body["excluded_count"] == by_bucket.get(None, 0)
    # I53: the denominator is counting rows only.
    counting = sum(body[k] for k in SIX[2:])
    assert body["counting_outcome_count"] == counting
    assert body["within_year_share_pct"] == round(body["within_year_count"] / counting * 100, 2)
    # Rows carry the stored flags and the band label.
    flags = {str(o.project_id): o for o in stored}
    for r in rows:
        o = flags[r["project_id"]]
        assert r["counts_toward_year"] == o.counts_toward_year
        assert r["not_scheduled_priority"] == o.not_scheduled_priority
        assert r["priority_label"] == (dc.PRIORITY_LABELS[r["priority"]] if r["priority"] else None)
        if r["outcome"] in ("NOT_SCHEDULED_PRIORITY", "QUEUED"):
            assert not r["within_year"] or r["outcome"] == "NOT_SCHEDULED_PRIORITY"
    # Regions reconcile for the two new buckets too.
    for k in SIX:
        assert sum(reg[k] for reg in body["regions"]) == body[k], k


async def _hand_built(db_session: AsyncSession) -> tuple[ScheduleRun, dict[str, Project]]:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    specs: dict[str, tuple[ProjectPriority, ProjectStatus, dict[str, bool]]] = {
        "within": (ProjectPriority.P1, ProjectStatus.IN_DEVELOPMENT, {"within_year": True}),
        "spill": (ProjectPriority.P1, ProjectStatus.IN_DEVELOPMENT, {"spillover": True}),
        "left": (ProjectPriority.P2, ProjectStatus.IN_QUEUE, {"left_out": True}),
        "blocked": (ProjectPriority.P2, ProjectStatus.IN_DEVELOPMENT, {"blocked": True}),
        "queued_left": (
            ProjectPriority.P3,
            ProjectStatus.IN_QUEUE,
            {"left_out": True, "counts_toward_year": False},
        ),
        "queued_fit": (
            ProjectPriority.P3,
            ProjectStatus.IN_QUEUE,
            {"counts_toward_year": False},
        ),
        "p4": (
            ProjectPriority.P4,
            ProjectStatus.IN_QUEUE,
            {"counts_toward_year": False, "not_scheduled_priority": True},
        ),
        "on_hold": (ProjectPriority.P4, ProjectStatus.ON_HOLD, {}),
    }
    projects: dict[str, Project] = {}
    for name, (prio, status, flags) in specs.items():
        project = await make_project(db_session, hub, name=name, priority=prio, status=status)
        projects[name] = project
        values: dict[str, Any] = dict(
            schedule_run_id=run.id,
            project_id=project.id,
            left_out=False,
            cat_not_allowed=False,
            spillover=False,
            within_year=False,
            blocked=False,
            projected_end_week=40 if name in ("within", "queued_fit") else None,
        )
        values.update(flags)
        db_session.add(ScheduleRunProjectOutcome(**values))
    await db_session.flush()
    return run, projects


async def test_hand_built_buckets_and_denominators(db_session: AsyncSession) -> None:
    await _hand_built(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/dashboard/completing-within-year")).json()
        analytics = (await client.get("/dashboard/analytics")).json()
        register = (await client.get("/dashboard/projects")).json()
    assert {k: body[k] for k in SIX} == {
        "not_scheduled_priority_count": 1,
        "queued_count": 2,
        "blocked_count": 1,
        "within_year_count": 1,
        "spillover_count": 1,
        "left_out_count": 1,
    }
    assert body["excluded_count"] == 1
    assert sum(body[k] for k in SIX) + body["excluded_count"] == len(body["rows"]) == 8
    assert body["counting_outcome_count"] == 4
    assert body["within_year_share_pct"] == 25.0

    # Priority delivery: P3 has 2 projects, both queued → counting_total 0.
    bands = {b["priority"]: b for b in body["priority_delivery"]}
    assert [b["priority"] for b in body["priority_delivery"]] == ["P1", "P2", "P3", "P4", "Q"]
    assert bands["P1"]["priority_label"] == "Must do this year"
    assert bands["P3"]["queued_total"] == 2 and bands["P3"]["counting_total"] == 0
    assert bands["P3"]["within_year_share_pct"] == 0.0
    # P4: one not scheduled + one On Hold (status-excluded, counts).
    assert bands["P4"]["not_scheduled_priority_total"] == 1
    assert bands["P4"]["total"] == 2 and bands["P4"]["counting_total"] == 1
    assert bands["P1"]["counting_total"] == 2
    assert bands["P1"]["within_year_share_pct"] == 50.0
    for b in body["priority_delivery"]:
        assert b["counting_total"] == (
            b["total"] - b["queued_total"] - b["not_scheduled_priority_total"]
        )

    # Analytics: the hub × type cell's denominator drops the 3 non-counting.
    (cell,) = analytics["completing_hub_type"]
    assert cell["pipeline_count"] == 8
    assert cell["counting_count"] == 5
    assert cell["completing_count"] == 1
    assert cell["completing_pct"] == 20.0
    (hub_total,) = analytics["completing_by_hub"]
    assert hub_total["counting_count"] == 5

    # Register: the new buckets and the flags.
    outcomes = {r["project_name"]: r for r in register["rows"]}
    assert outcomes["p4"]["outcome"] == "NOT_SCHEDULED_PRIORITY"
    assert outcomes["queued_left"]["outcome"] == "QUEUED"
    assert outcomes["queued_fit"]["counts_toward_year"] is False
    assert outcomes["within"]["outcome"] == "WITHIN_YEAR"
    assert outcomes["p4"]["priority_label"] == "Miscellaneous"


async def test_greedy_recalc_counts_counting_rows_only(db_session: AsyncSession) -> None:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post("/schedule-runs/greedy-recalc")
    assert resp.status_code == 201, resp.text
    body = resp.json()
    run_id = uuid.UUID(body["schedule_run"]["id"])
    stored = await _outcomes(db_session, (await db_session.get(ScheduleRun, run_id)))  # type: ignore[arg-type]
    counting = [o for o in stored if o.counts_toward_year and not o.not_scheduled_priority]
    assert body["left_out_count"] == sum(o.left_out for o in counting)
    assert body["within_year_count"] == sum(o.within_year for o in counting)
    assert body["spillover_count"] == sum(o.spillover for o in counting)
    assert body["not_scheduled_priority_count"] == sum(o.not_scheduled_priority for o in stored)
    assert body["queued_count"] == sum(
        (not o.counts_toward_year) and not o.not_scheduled_priority for o in stored
    )
    # P53 (I53): a queued P3 counts; QUEUED is empty in a P53 run.
    assert body["queued_count"] == 0 and body["not_scheduled_priority_count"] > 0


# --- labels ----------------------------------------------------------------------------


async def test_reference_priorities_serves_labels(db_session: AsyncSession) -> None:
    await act_as(db_session, RoleName.ENGINEER)
    async with client_for(db_session) as client:
        resp = await client.get("/reference/priorities")
    assert resp.status_code == 200
    assert resp.json() == [
        {
            "code": "P1",
            "label": "Must do this year",
            "short_label": "P1",
            "not_scheduled": False,
            "queued_when_in_queue": False,
        },
        {
            "code": "P2",
            "label": "Good to have this year",
            "short_label": "P2",
            "not_scheduled": False,
            "queued_when_in_queue": False,
        },
        {
            "code": "P3",
            "label": "In queue",
            "short_label": "P3",
            "not_scheduled": False,
            "queued_when_in_queue": True,
        },
        {
            "code": "P4",
            "label": "Miscellaneous",
            "short_label": "P4",
            "not_scheduled": True,
            "queued_when_in_queue": True,
        },
        {
            "code": "Q",
            "label": "Unprioritised",
            "short_label": "Q",
            "not_scheduled": True,
            "queued_when_in_queue": True,
        },
    ]


async def test_reference_priorities_requires_authentication(db_session: AsyncSession) -> None:
    """P42-T05 / S42-L1: no principal (no token) is 401, as for every reference route."""

    clear_current_principal_override()
    async with client_for(db_session) as client:
        resp = await client.get("/reference/priorities")
    assert resp.status_code == 401


async def test_priority_board_columns_labels_and_queued_badge(db_session: AsyncSession) -> None:
    run, projects = await _hand_built(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.get("/priority-board")
    assert resp.status_code == 200, resp.text
    columns = {c["priority"]: c for c in resp.json()["columns"]}
    assert [c["label"] for c in resp.json()["columns"]] == [
        "Must do this year",
        "Good to have this year",
        "In queue",
        "Miscellaneous",
        "Unprioritised",
    ]
    assert [c["not_scheduled"] for c in resp.json()["columns"]] == [
        False,
        False,
        False,
        True,
        True,
    ]
    p3 = {c["name"]: c for c in columns["P3"]["cards"]}
    assert columns["P3"]["queued_count"] == 2
    assert p3["queued_left"]["queued"] is True
    assert p3["queued_left"]["outcome_label"] == "Queued — no slot"
    assert p3["queued_fit"]["outcome_label"] == "Queued — fits by W40"
    p4 = {c["name"]: c for c in columns["P4"]["cards"]}
    assert p4["p4"]["queued"] is False
    assert p4["p4"]["not_scheduled_priority"] is True
    assert p4["p4"]["outcome_label"] == "Not scheduled (P4)"
    p1 = {c["name"]: c for c in columns["P1"]["cards"]}
    assert p1["within"]["queued"] is False and p1["within"]["outcome_label"] is None
    assert p1["within"]["counts_toward_year"] is True


async def test_gantt_and_workspace_serve_flags(db_session: AsyncSession) -> None:
    run, projects = await _hand_built(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        gantt = (await client.get("/gantt", params={"limit": "500"})).json()
        ws_p4 = (await client.get(f"/projects/{projects['p4'].id}/workspace")).json()
        ws_q = (await client.get(f"/projects/{projects['queued_fit'].id}/workspace")).json()
        ws_w = (await client.get(f"/projects/{projects['within'].id}/workspace")).json()
    rows = {r["project_name"]: r for r in gantt["rows"]}
    assert rows["p4"]["not_scheduled_priority"] is True
    assert rows["p4"]["outcome"] == "NOT_SCHEDULED_PRIORITY"
    assert rows["p4"]["outcome_label"] == "Not scheduled (P4)"
    assert rows["p4"]["priority_label"] == "Miscellaneous"
    assert rows["queued_fit"]["counts_toward_year"] is False
    assert rows["queued_fit"]["outcome_label"] == "Queued — fits by W40"
    assert rows["within"]["outcome"] == "WITHIN_YEAR"
    assert rows["within"]["outcome_label"] is None

    assert ws_p4["schedule"]["not_scheduled_priority"] is True
    assert ws_p4["schedule"]["outcome_label"] == "Not scheduled (P4)"
    assert ws_p4["schedule"]["priority_label"] == "Miscellaneous"
    assert ws_q["schedule"]["outcome"] == "QUEUED"
    assert ws_q["schedule"]["counts_toward_year"] is False
    assert ws_w["schedule"]["outcome"] == "WITHIN_YEAR"
    assert ws_w["schedule"]["counts_toward_year"] is True


# --- capacity --------------------------------------------------------------------------


async def test_class_breakdown_excludes_non_counting(db_session: AsyncSession) -> None:
    await _hand_built(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = (await client.get("/capacity/class-breakdown")).json()
        hubs = (await client.get("/capacity/hubs")).json()
    assert body["priority_bucket_labels"] == {
        "P1": "P1",
        "P2": "P2",
        "P3": "P3",
        "P4": "P4",
        "Queue": "Q",
    }
    assert hubs["priority_bucket_labels"]["Queue"] == "Q"
    row = next(r for r in body["rows"] if r["category"] == "A")
    # Schedulable rows: within, spill, blocked (deliverable), left (left out),
    # queued_left + queued_fit (queued), p4 (not scheduled). On Hold: none.
    assert row["queued_count"] == 2
    assert row["not_scheduled_priority_count"] == 1
    assert row["left_out_count"] == 1
    assert row["deliverable_count"] == 3
    assert row["total_count"] == 4
    assert sum(row["left_out_by_priority"].values()) == 1
    assert row["deliverable_by_priority"]["P3"] == 0


async def test_remaining_demand_drops_non_frozen_p4(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(
        db_session, hub, name="L", allowed_categories=[EngineerAllowedCategory.A]
    )
    project = await stepped_project(
        db_session,
        hub,
        name="Band",
        leader=leader,
        status=ProjectStatus.IN_DEVELOPMENT,
        priority=ProjectPriority.P2,
        category=ProjectCategory.A,
    )
    before = await load_demand(db_session)
    row = next(r for r in before.rows if r.project_id == str(project.id))
    assert row.priority == "P2"
    remaining_before = before.projects[project.id].design_remaining
    assert remaining_before > 0
    # The only P4: rank 1 (I37b: a band member keeps a dense rank).
    project.priority = ProjectPriority.P4
    project.band_rank = 1
    await db_session.flush()
    after = await load_demand(db_session)
    assert next(r for r in after.rows if r.project_id == str(project.id)).priority == "P4"
    assert after.projects[project.id].design_remaining == 0
    # Full-year demand is unchanged (R42-6).
    assert (
        after.projects[project.id].design_full_year == before.projects[project.id].design_full_year
    )
    # A frozen P4 still counts in remaining demand.
    project.frozen = True
    await db_session.flush()
    frozen = await load_demand(db_session)
    assert frozen.projects[project.id].design_remaining == remaining_before


# --- run changes, notifications --------------------------------------------------------


async def test_run_changes_compare_both_flags(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, name="Flagged")
    old = await make_schedule_run(db_session, is_active=False)
    new = await make_schedule_run(db_session, is_active=True)
    for run, counts, nsp in ((old, True, False), (new, False, True)):
        db_session.add(
            ScheduleRunProjectOutcome(
                schedule_run_id=run.id,
                project_id=project.id,
                left_out=False,
                cat_not_allowed=False,
                spillover=False,
                within_year=False,
                blocked=False,
                counts_toward_year=counts,
                not_scheduled_priority=nsp,
            )
        )
    await db_session.flush()
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.get(f"/schedule-runs/{new.id}/changes", params={"against": str(old.id)})
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()["rows"]
    assert row["before_counts_toward_year"] is True
    assert row["after_counts_toward_year"] is False
    assert row["before_not_scheduled_priority"] is False
    assert row["after_not_scheduled_priority"] is True
    assert row["priority_label"] == "In queue"


async def test_no_regression_notification_for_non_counting_outcome(
    db_session: AsyncSession,
) -> None:
    from scheduling.types import ProjectScheduleOutcome
    from services.notifications import generate_schedule_change_notifications

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="L")
    project = await make_project(db_session, hub, leader=leader, name="Goes queued")
    # A recipient: a Portfolio Manager reads every hub.
    await make_user(db_session, RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    prev = await make_schedule_run(db_session, is_active=False)
    db_session.add(
        ScheduleRunProjectOutcome(
            schedule_run_id=prev.id,
            project_id=project.id,
            left_out=False,
            cat_not_allowed=False,
            spillover=False,
            within_year=True,
            blocked=False,
            last_step_end_week=40,
        )
    )
    new = await make_schedule_run(db_session, is_active=True)
    await db_session.flush()

    def outcome(counts: bool) -> ProjectScheduleOutcome:
        return ProjectScheduleOutcome(
            project_id=str(project.id),
            excluded=False,
            left_out=True,
            cat_not_allowed=False,
            spillover=False,
            within_year=False,
            no_leader=False,
            no_chamber_step_id=None,
            start_week=None,
            end_week=None,
            steps=(),
            eng_conflict=False,
            overlap=False,
            counts_toward_year=counts,
        )

    queued = await generate_schedule_change_notifications(
        db_session,
        new_run=new,
        previous_active_run_id=prev.id,
        project_outcomes=(outcome(False),),
    )
    assert queued == []
    counting = await generate_schedule_change_notifications(
        db_session,
        new_run=new,
        previous_active_run_id=prev.id,
        project_outcomes=(outcome(True),),
    )
    assert counting and all(n.reason == NotificationReason.PROJECT_LEFT_OUT for n in counting)
    stored = (await db_session.execute(select(Notification))).scalars().all()
    assert len(stored) == len(counting)


# --- check-ins / tracking, VIP ---------------------------------------------------------


async def test_tracking_leaves_out_non_frozen_p4(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="L")
    p4 = await stepped_project(
        db_session, hub, name="P4 started", leader=leader, priority=ProjectPriority.P4
    )
    p2 = await stepped_project(
        db_session, hub, name="P2 started", leader=leader, priority=ProjectPriority.P2
    )
    for project in (p4, p2):
        await set_progress(
            db_session, project, "PDD-A", WorkflowStepStatus.IN_PROGRESS, percent=10, start=20
        )
    due = await due_stages_for(db_session, [p4.id, p2.id], active_run=None, current_week=TEST_WEEK)
    assert due.get(p4.id, []) == []
    assert due.get(p2.id)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.get("/check-ins/due")
    assert resp.status_code == 200, resp.text
    names = {p["name"] for p in resp.json()["projects"]}
    assert "P4 started" not in names
    assert "P2 started" in names


async def test_vip_never_auto_fills_non_frozen_p4(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    p4 = await make_project(db_session, hub, name="AAA P4", priority=ProjectPriority.P4)
    pinned = await make_project(
        db_session, hub, name="Pinned P4", priority=ProjectPriority.P4, is_vip=True
    )
    pipeline_p4 = await make_project(
        db_session, hub, name="Pipeline P4", priority=ProjectPriority.Q
    )
    p2 = await make_project(db_session, hub, name="ZZZ P2", priority=ProjectPriority.P2)
    for project, nsp in ((p4, True), (pinned, True), (p2, False)):
        db_session.add(
            ScheduleRunProjectOutcome(
                schedule_run_id=run.id,
                project_id=project.id,
                left_out=False,
                cat_not_allowed=False,
                spillover=False,
                within_year=False,
                blocked=False,
                counts_toward_year=not nsp,
                not_scheduled_priority=nsp,
            )
        )
    await db_session.flush()
    assert pipeline_p4.id  # no outcome row: "pipeline, not yet in run"
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.get("/vip-projects")
    assert resp.status_code == 200, resp.text
    rows = {p["name"]: p for h in resp.json()["hubs"] for p in h["projects"]}
    assert "AAA P4" not in rows
    assert "Pipeline P4" not in rows
    assert rows["Pinned P4"]["selection"] == "pinned"
    assert rows["Pinned P4"]["outcome_label"] == "Not scheduled (P4)"
    assert rows["ZZZ P2"]["selection"] == "auto"
    assert rows["ZZZ P2"]["priority_label"] == "Good to have this year"


# --- priority preview (R42-8) ----------------------------------------------------------


async def _preview_fixture(db_session: AsyncSession) -> dict[str, Project]:
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(
        db_session, hub, name="L", allowed_categories=[EngineerAllowedCategory.A]
    )
    out: dict[str, Project] = {}
    for name, prio in (("Counting P2", ProjectPriority.P2), ("Was P4", ProjectPriority.P4)):
        out[name] = await stepped_project(
            db_session,
            hub,
            name=name,
            leader=leader,
            status=ProjectStatus.IN_QUEUE,
            priority=prio,
            category=ProjectCategory.A,
            certification_testing_required=False,
        )
    await make_schedule_run(db_session, is_active=True)
    return out


async def test_preview_into_p4_leaves_the_plan(db_session: AsyncSession) -> None:
    projects = await _preview_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/projects/{projects['Counting P2'].id}/priority/preview", json={"priority": "P4"}
        )
    assert resp.status_code == 200, resp.text
    moved = resp.json()["moved"]
    assert moved["not_scheduled_priority_before"] is False
    assert moved["not_scheduled_priority_after"] is True
    assert moved["counts_toward_year_after"] is False
    assert moved["effect"] == "leaves_plan"
    assert moved["effect_label"] == "leaves the plan"
    # Never "pushed out of the year": the moved project is not in `changes`.
    assert all(c["project_id"] != str(projects["Counting P2"].id) for c in resp.json()["changes"])


async def test_preview_p4_to_p3_in_queue_joins_the_queue(db_session: AsyncSession) -> None:
    projects = await _preview_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/projects/{projects['Was P4'].id}/priority/preview", json={"priority": "P3"}
        )
    assert resp.status_code == 200, resp.text
    moved = resp.json()["moved"]
    assert moved["not_scheduled_priority_before"] is True
    assert moved["not_scheduled_priority_after"] is False
    # P53 (R53-2): a queued P3 counts; the copy says it joins the plan.
    assert moved["counts_toward_year_after"] is True
    assert moved["effect"] == "joins_queue"
    assert moved["effect_label"] == "joins the plan — scheduled after P1/P2 and started P3"
    for change in resp.json()["changes"]:
        assert "counts_toward_year_before" in change
        assert "priority_label" in change


async def test_preview_p4_to_p1_has_no_effect_label(db_session: AsyncSession) -> None:
    projects = await _preview_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/projects/{projects['Was P4'].id}/priority/preview", json={"priority": "P1"}
        )
    assert resp.status_code == 200, resp.text
    moved = resp.json()["moved"]
    assert moved["counts_toward_year_after"] is True
    assert moved["effect"] is None and moved["effect_label"] is None


# --- exports ---------------------------------------------------------------------------


async def test_gantt_export_carries_both_columns(db_session: AsyncSession) -> None:
    await _hand_built(db_session)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    sheets = await build_gantt_sheets(db_session, principal)
    ((headers, rows),) = sheets.values()
    assert "counts_toward_year" in headers and "not_scheduled_priority" in headers
    by_name = {r["project_name"]: r for r in rows}
    assert by_name["p4"]["not_scheduled_priority"] is True
    assert by_name["p4"]["counts_toward_year"] is False
    assert by_name["within"]["counts_toward_year"] is True


# --- plan import breakdowns -----------------------------------------------------------


def test_import_breakdown_places_queued_and_not_scheduled() -> None:
    from schemas.whatif_import import ImportProjectOut
    from services.whatif_import import breakdown_year_key, import_breakdowns

    def served(ref: str, outcome: str, finish: int | None) -> ImportProjectOut:
        return ImportProjectOut(
            ref=ref, source="file", file_row=1, replaces_project_id=None, name=ref,
            hub="R&D-Greece", capacity_hub="R&D-Greece", category="C", priority="P3",
            status="In Queue", leader_name=None, leader_ref=None, leader_auto_assigned=False,
            outcome=outcome, within_plan_year=False, start_week=None, end_week=finish,
            finish_week=finish, unconstrained_end_week=None, before_outcome=None,
            before_finish_week=None, eng_conflict=False, cat_not_allowed=False,
            lab_overlap=False, no_leader=False, no_chamber_step_id=None, data_error=None,
            steps=[], counts_toward_year=False,
            not_scheduled_priority=outcome == "not_scheduled_priority",
        )  # fmt: skip

    fit = served("fit", "queued", 40)
    slot = served("slot", "queued", None)
    nsp = served("nsp", "not_scheduled_priority", None)
    assert breakdown_year_key(fit) == "2026"
    assert breakdown_year_key(slot) == "not_placed"
    assert breakdown_year_key(nsp) is None
    body = import_breakdowns([fit, slot, nsp]).model_dump()
    al = body["by_year"]["all"]
    assert al["outcomes"]["queued"] == 2 and al["outcomes"]["not_scheduled_priority"] == 1
    (src,) = al["by_source"]
    assert (src["total"], src["within_year"], src["queued"], src["not_placed"]) == (3, 0, 2, 0)
    y = body["by_year"]["2026"]
    assert y["total"] == 1 and y["by_source"][0]["within_year"] == 0
    assert y["by_source"][0]["queued"] == 1
    assert [q["count"] for q in y["by_finish_quarter"]] == [1]
    # A P41 snapshot without the P42 keys still validates (defaults).
    legacy = {k: v for k, v in fit.model_dump().items()}
    del legacy["counts_toward_year"], legacy["not_scheduled_priority"]
    legacy["outcome"] = "within_year"
    assert ImportProjectOut.model_validate(legacy).counts_toward_year is True
