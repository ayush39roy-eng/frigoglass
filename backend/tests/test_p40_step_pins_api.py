"""P40-T03b: manual step pins, backend side (ADR 0054 ruling R40-1..R40-15;
docs/DOMAIN_RULES.md "Manual step weeks"; docs/API_CONTRACT_P40.md).

Covers `PUT /gantt/step-pins` (RBAC over every role, hub scope, every refusal
code, all-or-nothing, the audit rows, the no-op, ONE greedy run per save with
the priority-move lifecycle), clear-on-start (stage PATCH, check-in) and on a
workflow re-point, the Admin-only unfreeze, the Gantt payload fields
(including `include_unplaced`, `by_step` and `current_step_counts`), the
input builder / run snapshot, persistence of the run flags, the per-week
readers and plan-import `PIN_DROPPED`.

`run_greedy_schedule.delay` and `publish_progress` are patched; nothing
reaches Celery or Redis.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

import api.routers.checkins as checkins_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    ProjectAccessRole,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
    WorkflowStepStatus,
)
from models.project_access import ProjectAccessGrant
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from models.workflow import ProjectWorkflowStep
from services.schedule_persistence import (
    build_schedule_input_from_db,
    build_workflow_snapshot_from_input,
)
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import (
    CW,
    act_as,
    add_outcome,
    client_for,
    link_engineer,
    live_step,
    plan_step,
    set_progress,
    stepped_project,
)
from workers.schedule_tasks import run_greedy_schedule

ALL_ROLES = list(RoleName)
PIN_ROLES = {RoleName.ADMIN, RoleName.SUPER_ADMIN}


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
    published: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(
        priority_move, "publish_progress", lambda *a, **k: published.append((a, k))
    )
    monkeypatch.setattr(
        checkins_router, "publish_progress", lambda *a, **k: published.append((a, k))
    )
    return SimpleNamespace(calls=calls, published=published)


async def _world(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    leader = await make_engineer(db_session, gr, name="Pin Leader", fte=0.5)
    run = await make_schedule_run(db_session, is_active=True)
    a = await stepped_project(db_session, gr, name="Alpha", leader=leader)
    await plan_step(db_session, run, a, "PDD-E", 33, 36, engineer=leader)
    await add_outcome(db_session, run, a)
    b = await stepped_project(db_session, gr, name="Bravo", leader=leader)
    far = await stepped_project(db_session, india, name="India project")
    return SimpleNamespace(gr=gr, india=india, leader=leader, run=run, a=a, b=b, far=far)


def _item(project, step="PDD-E", start=40, end=43):
    return {
        "project_id": str(project.id),
        "step_template_id": step,
        "manual_start_week": start,
        "manual_end_week": end,
    }


async def _put(db_session, items):
    async with client_for(db_session) as client:
        return await client.put("/gantt/step-pins", json={"items": items})


async def _audits(db_session, action):
    return list(
        (
            await db_session.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == action)
                .order_by(AuditLogEntry.occurred_at)
            )
        ).scalars()
    )


async def _runs(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(ScheduleRun)) or 0


def _codes(resp):
    body = resp.json()
    return body["code"], [(e["index"], e["code"]) for e in body["detail"]["errors"]]


# --- RBAC ----------------------------------------------------------------------------


@pytest.mark.parametrize("role", ALL_ROLES, ids=[r.value for r in ALL_ROLES])
async def test_only_admin_and_super_admin_roles_may_write_pins(db_session, dispatch, role):
    w = await _world(db_session)
    await act_as(db_session, role)
    resp = await _put(db_session, [_item(w.a)])
    if role in PIN_ROLES:
        assert resp.status_code == 200, resp.text
        row = await live_step(db_session, w.a, "PDD-E")
        assert (row.manual_start_week, row.manual_end_week) == (40, 43)
    else:
        assert resp.status_code == 403, resp.text
        row = await live_step(db_session, w.a, "PDD-E")
        assert (row.manual_start_week, row.manual_end_week) == (None, None)


async def test_project_grant_admin_is_not_enough(db_session, dispatch):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    db_session.add(
        ProjectAccessGrant(
            project_id=w.a.id,
            user_id=user.id,
            project_role=ProjectAccessRole.ADMIN,
            granted_by_user_id=user.id,
        )
    )
    await db_session.flush()
    resp = await _put(db_session, [_item(w.a)])
    assert resp.status_code == 403


async def test_hub_scope_out_of_scope_reads_as_not_found(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN, hub_ids=[w.gr.id], hub_scope_all=False)
    resp = await _put(db_session, [_item(w.a), _item(w.far)])
    assert resp.status_code == 404, resp.text
    assert _codes(resp) == ("PROJECT_NOT_FOUND", [(1, "PROJECT_NOT_FOUND")])
    # Same answer for a project that does not exist.
    ghost = {**_item(w.a), "project_id": str(uuid.UUID(int=7))}
    resp = await _put(db_session, [ghost])
    assert _codes(resp) == ("PROJECT_NOT_FOUND", [(0, "PROJECT_NOT_FOUND")])
    row = await live_step(db_session, w.a, "PDD-E")
    assert row.manual_start_week is None  # all-or-nothing
    assert dispatch.calls == []


# --- refusals ------------------------------------------------------------------------


async def test_shape_refusals_pin_invalid_and_duplicate(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(
        db_session,
        [
            _item(w.a, start=40, end=None),
            _item(w.a, "PDD-F", start=45, end=44),
            _item(w.b),
            _item(w.b),
        ],
    )
    assert resp.status_code == 422
    assert _codes(resp) == (
        "PIN_INVALID",
        [(0, "PIN_INVALID"), (1, "PIN_INVALID"), (3, "DUPLICATE_STEP")],
    )
    row = await live_step(db_session, w.b, "PDD-E")
    assert row.manual_start_week is None


async def test_missing_key_is_request_validation(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    body = _item(w.a)
    del body["manual_end_week"]
    resp = await _put(db_session, [body])
    assert resp.status_code == 422
    assert "code" not in resp.json()


@pytest.mark.parametrize(
    ("start", "end"), [(CW - 1, 40), (40, 53), (0, 3)], ids=["before-cw", "past-52", "zero"]
)
async def test_pin_out_of_range(db_session, dispatch, start, end):
    w = await _world(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    resp = await _put(db_session, [_item(w.a, start=start, end=end)])
    assert resp.status_code == 422, resp.text
    assert _codes(resp) == ("PIN_OUT_OF_RANGE", [(0, "PIN_OUT_OF_RANGE")])
    assert f"W{CW}" in resp.json()["detail"]["errors"][0]["message"]


async def test_boundaries_cw_and_52_are_accepted(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(w.a, start=CW, end=CW), _item(w.b, start=52, end=52)])
    assert resp.status_code == 200, resp.text


async def test_unknown_step(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(w.a, "OEM-E"), _item(w.a, "NOPE")])
    assert resp.status_code == 422
    assert _codes(resp) == ("UNKNOWN_STEP", [(0, "UNKNOWN_STEP"), (1, "UNKNOWN_STEP")])


async def test_conflict_codes_and_all_or_nothing(db_session, dispatch):
    w = await _world(db_session)
    frozen = await stepped_project(
        db_session, w.gr, name="Frozen", frozen=True, actual_start_week=20
    )
    closed = await stepped_project(
        db_session, w.gr, name="Closed", status=ProjectStatus.CANCELLED, priority=None
    )
    await set_progress(
        db_session, w.b, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=10, start=30
    )
    skipped = await live_step(db_session, w.b, "PDD-F")
    skipped.plan_weeks = 0
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(
        db_session,
        [
            _item(w.a),  # valid: must not be written
            _item(frozen),
            _item(closed),
            _item(w.b, "PDD-E"),
            _item(w.b, "PDD-F"),
        ],
    )
    assert resp.status_code == 409, resp.text
    assert _codes(resp) == (
        "PROJECT_FROZEN",
        [
            (1, "PROJECT_FROZEN"),
            (2, "PROJECT_CLOSED"),
            (3, "STEP_STARTED"),
            (4, "STEP_SKIPPED"),
        ],
    )
    row = await live_step(db_session, w.a, "PDD-E")
    assert row.manual_start_week is None
    assert await _audits(db_session, "project.step_pinned") == []
    assert dispatch.calls == []


async def test_range_errors_win_over_conflicts(db_session, dispatch):
    w = await _world(db_session)
    frozen = await stepped_project(
        db_session, w.gr, name="Frozen", frozen=True, actual_start_week=20
    )
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(frozen), _item(w.a, start=10, end=12)])
    assert resp.status_code == 422
    assert _codes(resp) == ("PIN_OUT_OF_RANGE", [(1, "PIN_OUT_OF_RANGE")])


async def test_clear_on_frozen_project_is_refused_but_unchanged_is_a_no_op(
    db_session, dispatch
):
    w = await _world(db_session)
    frozen = await stepped_project(
        db_session, w.gr, name="Frozen", frozen=True, actual_start_week=20
    )
    row = await live_step(db_session, frozen, "PDD-E")
    row.manual_start_week, row.manual_end_week = 10, 12  # set before the freeze
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(frozen, start=None, end=None)])
    assert resp.status_code == 409
    assert _codes(resp) == ("PROJECT_FROZEN", [(0, "PROJECT_FROZEN")])
    # Re-sending the stored pair (past CW, frozen) is a no-op, never refused.
    resp = await _put(db_session, [_item(frozen, start=10, end=12)])
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["changes"] == [] and body["unchanged_count"] == 1
    assert body["recalc_status"] == "unchanged"
    assert "X-Schedule-Recalc" not in resp.headers
    assert dispatch.calls == []


# --- success: audit, stale, one run ------------------------------------------------


async def test_save_audits_marks_stale_and_dispatches_one_greedy_run(db_session, dispatch):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.ADMIN)
    runs_before = await _runs(db_session)
    resp = await _put(
        db_session,
        [_item(w.a, "PDD-E", 40, 43), _item(w.a, "PDD-F", 44, 44), _item(w.b, "PDD-E", 35, 38)],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "queued"
    assert body["current_week"] == CW
    assert body["unchanged_count"] == 0
    assert [(c["step_template_id"], c["action"]) for c in body["changes"]] == [
        ("PDD-E", "pinned"), ("PDD-F", "pinned"), ("PDD-E", "pinned"),
    ]
    assert set(body["projects_marked_stale"]) == {str(w.a.id), str(w.b.id)}
    assert resp.headers["X-Schedule-Recalc"] == "queued"
    assert resp.headers["X-Schedule-Run-Id"] == body["schedule_run_id"]
    assert resp.headers["X-Schedule-Baseline-Run-Id"] == str(w.run.id)

    # ONE greedy run for the whole batch.
    assert await _runs(db_session) == runs_before + 1
    (args, kwargs), = dispatch.calls
    assert args == (body["schedule_run_id"],)
    assert kwargs["activate"] is True and kwargs["recalc_project_id"] is None
    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run.trigger_reason == "step_pin"
    assert run.solver_type == SolverType.GREEDY
    assert run.status == ScheduleRunStatus.QUEUED
    assert run.current_week == CW

    await db_session.refresh(w.a)
    await db_session.refresh(w.b)
    assert w.a.schedule_stale and w.b.schedule_stale

    audits = await _audits(db_session, "project.step_pinned")
    assert len(audits) == 3
    row = await live_step(db_session, w.a, "PDD-E")
    first = next(a for a in audits if a.entity_id == str(row.id))
    assert first.actor_user_id == user.id and first.hub_id == w.gr.id
    assert first.entity_type == "ProjectWorkflowStep"
    assert first.before_state == {
        "project_id": str(w.a.id), "step_id": "PDD-E", "stage": "Not Started",
        "manual_start_week": None, "manual_end_week": None,
    }
    assert first.after_state == {
        "project_id": str(w.a.id), "step_id": "PDD-E", "stage": "Not Started",
        "manual_start_week": 40, "manual_end_week": 43, "cause": "manual",
    }

    # Change one, clear one, keep one: exactly two audit rows more. (The
    # first run finished, so the second save queues its own.)
    run.status = ScheduleRunStatus.COMPLETED
    await db_session.flush()
    dispatch.calls.clear()
    resp = await _put(
        db_session,
        [
            _item(w.a, "PDD-E", 41, 41),
            _item(w.a, "PDD-F", None, None),
            _item(w.b, "PDD-E", 35, 38),
        ],
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["unchanged_count"] == 1
    assert [c["action"] for c in body["changes"]] == ["pinned", "cleared"]
    assert body["changes"][0]["before_start_week"] == 40
    assert body["projects_marked_stale"] == [str(w.a.id)]
    assert len(dispatch.calls) == 1
    (cleared,) = await _audits(db_session, "project.step_pin_cleared")
    assert cleared.before_state["manual_start_week"] == 44
    assert cleared.after_state["manual_start_week"] is None
    assert cleared.after_state["cause"] == "manual"
    assert len(await _audits(db_session, "project.step_pinned")) == 4


async def test_deferred_while_a_run_is_in_flight(db_session, dispatch):
    w = await _world(db_session)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await act_as(db_session, RoleName.ADMIN)
    runs_before = await _runs(db_session)
    resp = await _put(db_session, [_item(w.a)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "deferred"
    assert resp.headers["X-Schedule-Recalc"] == "deferred"
    assert "X-Schedule-Run-Id" not in resp.headers
    assert dispatch.calls == [] and await _runs(db_session) == runs_before


async def test_not_needed_for_a_non_schedulable_project(db_session, dispatch):
    w = await _world(db_session)
    on_hold = await stepped_project(
        db_session, w.gr, name="Held", status=ProjectStatus.ON_HOLD, priority=None
    )
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(on_hold)])
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "not_needed"
    assert dispatch.calls == []
    row = await live_step(db_session, on_hold, "PDD-E")
    assert (row.manual_start_week, row.manual_end_week) == (40, 43)


# --- clear on start / workflow change ------------------------------------------------


async def _pin(db_session, project, step="PDD-E", start=40, end=43):
    row = await live_step(db_session, project, step)
    row.manual_start_week, row.manual_end_week = start, end
    await db_session.flush()
    return row


async def test_stage_patch_leaving_not_started_clears_the_pin(db_session, dispatch):
    w = await _world(db_session)
    await _pin(db_session, w.a)
    user = await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.a.id}/stages/PDD-E",
            json={"status": "In Progress", "percent_complete": 10, "actual_start_week": CW},
        )
    assert resp.status_code == 200, resp.text
    row = await live_step(db_session, w.a, "PDD-E")
    await db_session.refresh(row)
    assert (row.manual_start_week, row.manual_end_week) == (None, None)
    (audit,) = await _audits(db_session, "project.step_pin_cleared")
    assert audit.actor_user_id == user.id
    assert audit.before_state["stage"] == "Not Started"
    assert audit.before_state["manual_start_week"] == 40
    assert audit.after_state["stage"] == "In Progress"
    assert audit.after_state["cause"] == "stage_started"


async def test_stage_patch_staying_not_started_keeps_the_pin(db_session, dispatch):
    w = await _world(db_session)
    await _pin(db_session, w.a)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.a.id}/stages/PDD-E", json={"remaining_weeks_override": 2}
        )
    assert resp.status_code == 200, resp.text
    row = await live_step(db_session, w.a, "PDD-E")
    assert row.manual_start_week == 40
    assert await _audits(db_session, "project.step_pin_cleared") == []


async def test_check_in_clears_the_pin(db_session, dispatch):
    w = await _world(db_session)
    run = w.run
    # Make PDD-E due this week (planned start <= CW).
    project = await stepped_project(db_session, w.gr, name="Due", leader=w.leader)
    await plan_step(db_session, run, project, "PDD-E", CW - 2, CW + 3)
    await _pin(db_session, project)
    user = await act_as(db_session, RoleName.ENGINEER)
    await link_engineer(db_session, w.leader, user)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/check-ins",
            json={
                "entries": [
                    {
                        "project_id": str(project.id),
                        "step_id": "PDD-E",
                        "status": "In Progress",
                        "percent_complete": 20,
                    }
                ]
            },
        )
    assert resp.status_code == 200, resp.text
    row = await live_step(db_session, project, "PDD-E")
    await db_session.refresh(row)
    assert row.manual_start_week is None and row.manual_end_week is None
    (audit,) = await _audits(db_session, "project.step_pin_cleared")
    assert audit.after_state["cause"] == "stage_started"
    assert audit.actor_user_id == user.id


async def test_workflow_change_clears_pins(db_session, dispatch):
    w = await _world(db_session)
    oem = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE, is_oem=True
    )
    await _pin(db_session, w.b, "PDD-E")
    await _pin(db_session, w.b, "PDD-G", 45, 46)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.b.id}", json={"hub_id": str(oem.id), "category": "A-OEM"}
        )
    assert resp.status_code == 200, resp.text
    rows = (
        await db_session.execute(
            select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == w.b.id)
        )
    ).scalars().all()
    assert all(r.manual_start_week is None and r.manual_end_week is None for r in rows)
    audits = await _audits(db_session, "project.step_pin_cleared")
    assert {a.before_state["step_id"] for a in audits} == {"PDD-E", "PDD-G"}
    assert {a.after_state["step_id"] for a in audits} == {"OEM-E", "OEM-G"}
    assert {a.after_state["cause"] for a in audits} == {"workflow_change"}


async def test_writers_that_never_touch_a_pin_freeze_and_unfreeze(db_session, dispatch):
    w = await _world(db_session)
    await _pin(db_session, w.a)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        r1 = await client.post(
            f"/gantt/projects/{w.a.id}/freeze", json={"frozen": True, "actual_start_week": 20}
        )
        r2 = await client.post(f"/gantt/projects/{w.a.id}/freeze", json={"frozen": False})
    assert r1.status_code == 200 and r2.status_code == 200, (r1.text, r2.text)
    row = await live_step(db_session, w.a, "PDD-E")
    await db_session.refresh(row)
    assert (row.manual_start_week, row.manual_end_week) == (40, 43)


# --- unfreeze permission (R40-10) -------------------------------------------------------


async def test_unfreeze_requires_admin_role_freeze_does_not(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    async with client_for(db_session) as client:
        r = await client.post(
            f"/gantt/projects/{w.a.id}/freeze", json={"frozen": True, "actual_start_week": 20}
        )
        assert r.status_code == 200, r.text
        r = await client.post(f"/gantt/projects/{w.a.id}/freeze", json={"frozen": False})
    assert r.status_code == 403
    assert r.json()["code"] == "UNFREEZE_REQUIRES_ADMIN"
    await db_session.refresh(w.a)
    assert w.a.frozen is True
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        r = await client.post(f"/gantt/projects/{w.a.id}/freeze", json={"frozen": False})
    assert r.status_code == 200, r.text


# --- Gantt payload -----------------------------------------------------------------


async def test_gantt_serves_pin_fields(db_session, dispatch):
    w = await _world(db_session)
    step = await plan_step(db_session, w.run, w.a, "PDD-F", 37, 40)
    step.pinned = True
    step.manual_overlap = True
    outcome = (
        await db_session.execute(
            select(ScheduleRunProjectOutcome).where(
                ScheduleRunProjectOutcome.project_id == w.a.id
            )
        )
    ).scalar_one()
    outcome.pin_lapsed = True
    outcome.manual_overlap = True
    await _pin(db_session, w.a, "PDD-E", 45, 46)
    await db_session.flush()

    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/gantt", params={"project_id": str(w.a.id)})
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()["rows"]
    assert row["pin_lapsed"] is True and row["manual_overlap"] is True
    steps = {s["step_id"]: s for s in row["steps"]}
    e, f = steps["PDD-E"], steps["PDD-F"]
    # The live pin is served; its length is the current length.
    assert (e["manual_start_week"], e["manual_end_week"]) == (45, 46)
    assert e["current_length_weeks"] == 2
    assert e["pinned"] is False and e["pin_editable"] is True and e["pin_block_reason"] is None
    # No live pin: the run row's window.
    assert f["pinned"] is True and f["manual_overlap"] is True
    assert f["current_length_weeks"] == 4
    assert set(steps) == {"PDD-E", "PDD-F"}  # run rows only by default

    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    async with client_for(db_session) as client:
        resp = await client.get("/gantt", params={"project_id": str(w.a.id)})
    (row,) = resp.json()["rows"]
    for s in row["steps"]:
        assert s["pin_editable"] is False and s["pin_block_reason"] == "NOT_ALLOWED"
        # The live pin is not personal data: served to every reader.
    assert {s["step_id"]: s["manual_start_week"] for s in row["steps"]}["PDD-E"] == 45


async def test_gantt_include_unplaced_lists_live_steps_with_lengths(db_session, dispatch):
    w = await _world(db_session)
    await set_progress(
        db_session, w.a, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=10, end=12
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get(
            "/gantt", params={"project_id": str(w.a.id), "include_unplaced": "true"}
        )
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()["rows"]
    steps = {s["step_id"]: s for s in row["steps"]}
    assert len(steps) == 14
    assert [s["sequence_order"] for s in row["steps"]] == sorted(
        s["sequence_order"] for s in row["steps"]
    )
    unplaced = [s for s in row["steps"] if s["planned_start_week"] is None]
    assert len(unplaced) == 13
    assert steps["PDD-A"]["pin_block_reason"] == "STEP_STARTED"
    for s in unplaced:
        if s["skipped"]:
            assert s["current_length_weeks"] == 0
            continue
        if s["kind"] == "design":
            # ceil(eff / 0.5) = 2 * eff for the half-time leader.
            assert s["current_length_weeks"] == 2 * s["plan_weeks"] or s["own_effort"]
        else:
            assert s["current_length_weeks"] >= 0


async def test_gantt_weekly_by_step_reconciles_and_current_step_counts(db_session, dispatch):
    w = await _world(db_session)
    await plan_step(db_session, w.run, w.a, "PDD-F", CW, CW + 1)
    await plan_step(db_session, w.run, w.b, "PDD-E", CW - 1, CW + 2)
    await plan_step(db_session, w.run, w.b, "PDD-G", 40, 41, skipped=True)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/gantt")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for wk in body["weekly_active_counts"]:
        assert sum(wk["by_step"].values()) == wk["pdd"] + wk["oem"]
        assert all(v > 0 for v in wk["by_step"].values())
    week = {wk["week"]: wk for wk in body["weekly_active_counts"]}
    assert week[CW]["by_step"] == {"PDD-E": 1, "PDD-F": 1}
    assert week[34]["by_step"] == {"PDD-E": 1}
    assert body["current_week"] == CW
    assert body["current_step_counts"] == {"PDD-E": 1, "PDD-F": 1}


# --- builder, snapshot, persistence ------------------------------------------------


async def test_builder_maps_live_pins_and_snapshot_carries_them_only_when_present(
    db_session, dispatch
):
    w = await _world(db_session)
    si = await build_schedule_input_from_db(db_session, current_week=CW)
    assert all(p.step_pins == () for p in si.projects)
    assert "step_pins" not in build_workflow_snapshot_from_input(si)

    await _pin(db_session, w.a, "PDD-F", 44, 45)
    await _pin(db_session, w.a, "PDD-E", 40, 43)
    si = await build_schedule_input_from_db(db_session, current_week=CW)
    a = next(p for p in si.projects if p.project_id == str(w.a.id))
    assert [(p.step_id, p.start_week, p.end_week) for p in a.step_pins] == [
        ("PDD-E", 40, 43), ("PDD-F", 44, 45),
    ]
    b = next(p for p in si.projects if p.project_id == str(w.b.id))
    assert b.step_pins == ()
    snap = build_workflow_snapshot_from_input(si)
    assert snap["step_pins"] == [
        {"project_id": str(w.a.id), "step_id": "PDD-E", "start_week": 40, "end_week": 43},
        {"project_id": str(w.a.id), "step_id": "PDD-F", "start_week": 44, "end_week": 45},
    ]
