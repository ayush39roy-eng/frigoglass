"""P12-T03: `services.tracking` (ADR 0021 §1, §4, §5; DOMAIN_RULES "Weekly
check-in and tracking status").

Pure helpers (plan_percent, due-ness, due-since, status) plus the DB-backed
`tracking_status_for` for each of live / due / overdue / idle.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest

from models.enums import (
    HubName,
    LabRegion,
    ProjectStatus,
    RoleName,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from services.tracking import (
    DueStage,
    due_since_week,
    due_stages_for,
    plan_percent,
    stage_is_due,
    status_from_due_stages,
    tracking_status_for,
)
from tests.factories import make_hub, make_schedule_run, make_user
from tests.p12_helpers import CW, add_checkin, plan_step, set_progress, stepped_project


def _live(status=WorkflowStepStatus.NOT_STARTED, duration=4, start=None, effort=None):
    # ADR 0041 R5: the live row's three durations feed the one skip predicate.
    return SimpleNamespace(
        status=status,
        duration_weeks=duration,
        actual_start_week=start,
        duration_override_weeks=None,
        effort_weeks=effort,
    )


def _run(start, end, skipped=False):
    return SimpleNamespace(start_week=start, end_week=end, skipped=skipped)


def _stage(*, this=False, last=False, since=CW) -> DueStage:
    return DueStage(
        project_id=uuid.uuid4(), step_id="PDD-E", step_name="x", kind=WorkflowStepKind.DESIGN,
        sequence_order=5, status=WorkflowStepStatus.IN_PROGRESS, percent_complete=10,
        blocked_reason=None, planned_start_week=None, planned_end_week=None, plan_percent=None,
        due_since_week=since, checked_in_this_week=this, checked_in_last_week=last,
        last_checkin_week=None, assigned_engineer_ids=frozenset(),
    )


@pytest.mark.parametrize(
    ("start", "end", "expected"),
    [
        (28, 34, 57),  # 4 / 7
        (31, 31, 100),
        (32, 40, 0),  # not started per plan
        (10, 20, 100),  # window over
        (31, 34, 25),
        (None, 34, None),
        (28, None, None),
    ],
)
def test_plan_percent(start, end, expected):
    assert plan_percent(start, end, CW) == expected


def test_plan_percent_degenerate_window():
    assert plan_percent(35, 30, CW) == 0
    assert plan_percent(20, 10, CW) == 100


def test_stage_is_due_rules():
    kw = dict(kind=WorkflowStepKind.DESIGN, cert_required=True, current_week=CW)
    # Window contains CW.
    assert stage_is_due(_live(), _run(28, 34), **kw)
    # Active status, window elsewhere or none.
    assert stage_is_due(_live(WorkflowStepStatus.IN_PROGRESS, start=20), _run(10, 20), **kw)
    assert stage_is_due(_live(WorkflowStepStatus.BLOCKED, start=20), None, **kw)
    # Not started, window in the future / past / none.
    assert not stage_is_due(_live(), _run(32, 40), **kw)
    assert not stage_is_due(_live(), _run(10, 30), **kw)
    assert not stage_is_due(_live(), None, **kw)
    # Done never; skipped never.
    assert not stage_is_due(_live(WorkflowStepStatus.DONE), _run(28, 34), **kw)
    assert not stage_is_due(_live(), _run(28, 34, skipped=True), **kw)
    assert not stage_is_due(_live(WorkflowStepStatus.IN_PROGRESS, duration=0, start=5), None, **kw)
    # ADR 0041 R5: an effort-zeroed step is skipped, even if a (stale) run
    # still plans it over CW.
    assert not stage_is_due(_live(effort=0), _run(28, 34), **kw)
    assert stage_is_due(_live(effort=2), _run(28, 34), **kw)
    # A lab step on a project without certification testing is skipped.
    assert not stage_is_due(
        _live(WorkflowStepStatus.IN_PROGRESS, start=5),
        None,
        kind=WorkflowStepKind.LAB,
        cert_required=False,
        current_week=CW,
    )


def test_due_since_week():
    # Became due this week per plan.
    assert due_since_week(_live(), _run(31, 34), CW) == 31
    # Window started earlier.
    assert due_since_week(_live(), _run(28, 34), CW) == 28
    # Active with an older actual start, plan elsewhere in the future.
    assert due_since_week(_live(WorkflowStepStatus.IN_PROGRESS, start=25), _run(35, 40), CW) == 25
    # Active, overrunning a past window.
    assert due_since_week(_live(WorkflowStepStatus.IN_PROGRESS, start=29), _run(20, 25), CW) == 20
    # Active with neither a start nor a window: due from this week.
    assert due_since_week(_live(WorkflowStepStatus.BLOCKED), None, CW) == CW


def test_status_from_due_stages():
    assert status_from_due_stages([]) == "idle"
    assert status_from_due_stages([_stage(this=True), _stage(this=True)]) == "live"
    # One missing this week but reported last week → due.
    assert status_from_due_stages([_stage(this=True), _stage(last=True, since=20)]) == "due"
    # Newly due this week, never reported → due, not overdue.
    assert status_from_due_stages([_stage(since=CW)]) == "due"
    # Due since last week, nothing this week or last → overdue.
    assert status_from_due_stages([_stage(since=CW - 1)]) == "overdue"
    assert status_from_due_stages([_stage(this=True), _stage(since=10)]) == "overdue"


async def test_tracking_status_for_each_status(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    user = await make_user(db_session, RoleName.HUB_PLANNER)
    run = await make_schedule_run(db_session, is_active=True)

    live = await stepped_project(db_session, hub, name="Live")
    await plan_step(db_session, run, live, "PDD-E", 28, 34)
    await add_checkin(db_session, live, "PDD-E", CW, user)

    due = await stepped_project(db_session, hub, name="Due")
    await plan_step(db_session, run, due, "PDD-E", 28, 34)
    await add_checkin(db_session, due, "PDD-E", CW - 1, user)

    overdue = await stepped_project(db_session, hub, name="Overdue")
    await plan_step(db_session, run, overdue, "PDD-E", 25, 34)
    await add_checkin(db_session, overdue, "PDD-E", CW - 3, user)

    idle = await stepped_project(db_session, hub, name="Idle")
    await plan_step(db_session, run, idle, "PDD-E", 40, 45)

    # In progress with no window, started weeks ago, never reported → overdue.
    active = await stepped_project(db_session, hub, name="Active")
    await set_progress(db_session, active, "PDD-B", WorkflowStepStatus.IN_PROGRESS, percent=30,
                       start=20)

    # Out of the plan: never due, even with a stage left In Progress.
    parked = await stepped_project(db_session, hub, name="Parked", status=ProjectStatus.ON_HOLD)
    await set_progress(db_session, parked, "PDD-B", WorkflowStepStatus.IN_PROGRESS, percent=30,
                       start=20)

    # Done in the window → not due → idle.
    done = await stepped_project(db_session, hub, name="Done")
    await plan_step(db_session, run, done, "PDD-E", 28, 34)
    await set_progress(db_session, done, "PDD-E", WorkflowStepStatus.DONE, percent=100,
                       start=28, end=30)

    ids = [p.id for p in (live, due, overdue, idle, active, parked, done)]
    result = await tracking_status_for(db_session, ids)
    assert result == {
        live.id: "live",
        due.id: "due",
        overdue.id: "overdue",
        idle.id: "idle",
        active.id: "overdue",
        parked.id: "idle",
        done.id: "idle",
    }
    assert await tracking_status_for(db_session, []) == {}


async def test_due_stages_carry_plan_and_checkin_fields(db_session):
    hub = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    user = await make_user(db_session, RoleName.HUB_PLANNER)
    run = await make_schedule_run(db_session, is_active=True)
    project = await stepped_project(db_session, hub, name="Fields")
    await plan_step(db_session, run, project, "PDD-E", 28, 34)
    await plan_step(db_session, run, project, "PDD-F", 31, 34)
    await plan_step(db_session, run, project, "PDD-G", 29, 33, skipped=True)
    await add_checkin(db_session, project, "PDD-E", 29, user)
    await add_checkin(db_session, project, "PDD-E", CW, user)

    stages = (await due_stages_for(db_session, [project.id]))[project.id]
    assert [s.step_id for s in stages] == ["PDD-E", "PDD-F"]
    e, f = stages
    assert (e.planned_start_week, e.planned_end_week, e.plan_percent) == (28, 34, 57)
    assert e.checked_in_this_week and not e.checked_in_last_week
    assert e.last_checkin_week == CW
    assert e.due_since_week == 28
    assert (f.plan_percent, f.last_checkin_week, f.checked_in_this_week) == (25, None, False)
    assert f.step_name == "Proof of Concept"


async def test_no_active_run_only_active_stages_are_due(db_session):
    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await stepped_project(db_session, hub, name="No run")
    await set_progress(db_session, project, "PDD-C", WorkflowStepStatus.BLOCKED, percent=10,
                       start=30, reason="Waiting for parts")
    stages = (await due_stages_for(db_session, [project.id]))[project.id]
    assert [(s.step_id, s.planned_start_week, s.plan_percent) for s in stages] == [
        ("PDD-C", None, None)
    ]
    assert (await tracking_status_for(db_session, [project.id]))[project.id] == "overdue"


@pytest.mark.parametrize(
    ("action", "after", "expected"),
    [
        ("project.check_in", {"week": 31, "stages": [{}, {}]},
         "Weekly check-in — 2 stages reported (week 31)"),
        ("project.check_in", {"week": 31, "stages": [{}]},
         "Weekly check-in — 1 stage reported (week 31)"),
        ("project.vip_pin", {"is_vip": True}, "Pinned as a VIP project"),
        ("project.vip_unpin", {"is_vip": False}, "VIP pin removed"),
    ],
)
def test_activity_summaries_for_p12_actions(action, after, expected):
    from models.audit import AuditLogEntry
    from services.workspace import event_summary

    entry = AuditLogEntry(
        action=action, entity_type="Project", entity_id="x", before_state={}, after_state=after
    )
    assert event_summary(entry) == expected
