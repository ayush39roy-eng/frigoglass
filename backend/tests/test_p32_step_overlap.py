"""P32-T03: per-project step overlap, parallel steps (ADR 0043,
docs/API_CONTRACT_P32.md A3, DOMAIN_RULES "Parallel steps").

Covered:
- `PATCH /projects/{id}/steps/{step_id}/timing` with `overlap_weeks`: set,
  clear (null and 0), 0 normalised to null, unchanged, the first-step 422
  (`loc: ["body", "overlap_weeks"]`), range and strict-int 422s, started 409
  `STEP_STARTED` (clearing allowed), Done 409, skipped 409 (lead 0 and an
  effort-zeroed step, clearing allowed), the audit's old/new values, RBAC as
  the existing timing tests;
- `GET /gantt` step rows serve `overlap_weeks` and the template's sorted
  `predecessor_ids`;
- `build_schedule_input_from_db` passes `overlap_weeks` (null -> 0), includes
  an overlap-only row, drops a stale overlap on a first step, and the run's
  `workflow_snapshot.step_timing` records the overlap only when non-zero;
- a workflow re-point clears the overlap; the DB CHECK 1..104.

The scheduler's overlap semantics are algorithm-engineer's
(`tests/scheduling/`); here only the plumbing is checked.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    RoleName,
    SolverType,
    WorkflowStepStatus,
)
from models.workflow import WorkflowStepTemplate
from scheduling.greedy import run_greedy_sgs
from scheduling.types import StepTimingInput
from services.project_steps import sync_project_steps
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.factories import make_chamber, make_hub
from tests.test_p12_step_timing import (
    _act_as,
    _audits,
    _client,
    _gantt_steps,
    _gantt_world,
    _step,
    _url,
    _world,
)
from tests.test_p12_step_timing import _cleanup as _p12_cleanup
from tests.test_p12_step_timing import dispatch as _p12_dispatch

# The P12 timing fixtures, re-exported under their pytest names: the
# autouse cleanup and the `run_greedy_schedule.delay` / SSE recorder.
_cleanup = _p12_cleanup
dispatch = _p12_dispatch


async def _patch(db_session, project, step_id: str, payload: dict):
    async with _client(db_session) as client:
        return await client.patch(_url(project, step_id), json=payload)


async def _assert_overlap_untouched(db_session, w, step_id: str, expected=None) -> None:
    row = await _step(db_session, w.project, step_id)
    await db_session.refresh(row)
    assert row.overlap_weeks == expected
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is False
    assert await _audits(db_session, "project.step_timing", w.project) == []


async def _input_for(db_session, project):
    schedule_input = await build_schedule_input_from_db(db_session)
    return next(p for p in schedule_input.projects if p.project_id == str(project.id))


# --- set / clear / normalise / unchanged ---------------------------------------------------


async def test_set_overlap_saves_audits_queues_and_reaches_the_scheduler(db_session, dispatch):
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])

    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 3})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["overlap_weeks"] == 3
    assert body["duration_override_weeks"] is None and body["start_not_before_week"] is None
    assert body["effective_duration_weeks"] == 6
    assert body["recalc_status"] == "queued" and len(dispatch.calls) == 1
    row = await _step(db_session, w.project, "PDD-E")
    assert row.overlap_weeks == 3
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is True

    (audit,) = await _audits(db_session, "project.step_timing", w.project)
    assert audit.actor_user_id == user.id
    assert audit.before_state == {
        "project_id": str(w.project.id), "step_id": "PDD-E",
        "duration_override_weeks": None, "start_not_before_week": None, "overlap_weeks": None,
    }
    assert audit.after_state == {
        "project_id": str(w.project.id), "step_id": "PDD-E",
        "duration_override_weeks": None, "start_not_before_week": None, "overlap_weeks": 3,
        "recalc_status": "queued", "baseline_run_id": str(w.run.id),
    }

    # A row carrying only an overlap reaches the scheduler input.
    p = await _input_for(db_session, w.project)
    assert p.step_timing == (StepTimingInput("PDD-E", None, None, overlap_weeks=3),)


async def test_overlap_combines_with_the_other_timing_fields(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(
        db_session, w.project, "PDD-E",
        {"duration_override_weeks": 9, "start_not_before_week": 40, "overlap_weeks": 104},
    )
    assert resp.status_code == 200, resp.text
    assert (resp.json()["duration_override_weeks"], resp.json()["overlap_weeks"]) == (9, 104)
    p = await _input_for(db_session, w.project)
    assert p.step_timing == (StepTimingInput("PDD-E", 9, 40, overlap_weeks=104),)


@pytest.mark.parametrize("clear", [None, 0])
async def test_clear_overlap_with_null_or_zero(db_session, dispatch, clear):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.overlap_weeks = 4
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)

    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": clear})

    assert resp.status_code == 200, resp.text
    assert resp.json()["overlap_weeks"] is None
    assert resp.json()["recalc_status"] == "queued"
    await db_session.refresh(row)
    assert row.overlap_weeks is None
    (audit,) = await _audits(db_session, "project.step_timing", w.project)
    assert audit.before_state["overlap_weeks"] == 4
    assert audit.after_state["overlap_weeks"] is None
    p = await _input_for(db_session, w.project)
    assert p.step_timing == ()


async def test_zero_on_a_step_without_overlap_is_unchanged(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 0})
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "unchanged"
    assert resp.json()["overlap_weeks"] is None
    assert dispatch.calls == []
    await _assert_overlap_untouched(db_session, w, "PDD-E")


async def test_same_overlap_is_unchanged_and_writes_nothing(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.overlap_weeks = 2
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "unchanged"
    assert resp.json()["overlap_weeks"] == 2
    assert dispatch.calls == []
    await _assert_overlap_untouched(db_session, w, "PDD-E", expected=2)


async def test_other_field_change_keeps_the_overlap(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.overlap_weeks = 2
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"duration_override_weeks": 7})
    assert resp.status_code == 200, resp.text
    assert resp.json()["overlap_weeks"] == 2
    await db_session.refresh(row)
    assert (row.duration_override_weeks, row.overlap_weeks) == (7, 2)


# --- 422s -------------------------------------------------------------------------------


async def test_first_step_overlap_is_422_on_the_field(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-A", {"overlap_weeks": 2})
    assert resp.status_code == 422
    body = resp.json()
    assert body["code"] == "VALIDATION_ERROR"
    assert [e["loc"] for e in body["detail"]] == [["body", "overlap_weeks"]]
    await _assert_overlap_untouched(db_session, w, "PDD-A")


@pytest.mark.parametrize("payload", [{"overlap_weeks": 0}, {"overlap_weeks": None}])
async def test_first_step_may_send_no_overlap(db_session, dispatch, payload):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-A", payload)
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "unchanged"


async def test_first_step_422_precedes_the_409s(db_session, dispatch):
    # 422 before 409, as for every other validation error.
    w = await _world(db_session, frozen=True)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-A", {"overlap_weeks": 2})
    assert resp.status_code == 422 and resp.json()["code"] == "VALIDATION_ERROR"


async def test_first_step_follows_the_template_dag(db_session, dispatch):
    # The rule reads the template's predecessors, not `sequence_order`.
    w = await _world(db_session)
    template = await db_session.get(WorkflowStepTemplate, "PDD-E")
    template.predecessor_ids = []
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    assert resp.status_code == 422
    assert resp.json()["detail"][0]["loc"] == ["body", "overlap_weeks"]


@pytest.mark.parametrize("value", [-1, 105])
async def test_out_of_range_is_coded_422(db_session, dispatch, value):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": value})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
    assert resp.json()["detail"][0]["loc"] == ["body", "overlap_weeks"]
    await _assert_overlap_untouched(db_session, w, "PDD-E")


@pytest.mark.parametrize("value", ["3", 2.5, True])
async def test_non_int_is_422(db_session, dispatch, value):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": value})
    assert resp.status_code == 422
    await _assert_overlap_untouched(db_session, w, "PDD-E")


# --- 409s -------------------------------------------------------------------------------


async def _start(db_session, w, step_id: str, step_status: WorkflowStepStatus):
    row = await _step(db_session, w.project, step_id)
    row.status, row.percent_complete, row.actual_start_week = step_status, 40, 30
    if step_status == WorkflowStepStatus.BLOCKED:
        row.blocked_reason = "Waiting on supplier"
    await db_session.flush()
    return row


@pytest.mark.parametrize(
    "step_status", [WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED]
)
async def test_started_step_refuses_a_new_overlap(db_session, dispatch, step_status):
    w = await _world(db_session)
    await _start(db_session, w, "PDD-E", step_status)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    both = await _patch(
        db_session, w.project, "PDD-E", {"duration_override_weeks": 8, "overlap_weeks": 2}
    )
    assert resp.status_code == 409 and resp.json()["code"] == "STEP_STARTED"
    assert both.status_code == 409 and both.json()["code"] == "STEP_STARTED"
    await _assert_overlap_untouched(db_session, w, "PDD-E")


@pytest.mark.parametrize(
    "step_status", [WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED]
)
async def test_started_step_may_clear_an_overlap_set_before_it_started(
    db_session, dispatch, step_status
):
    w = await _world(db_session)
    row = await _start(db_session, w, "PDD-E", step_status)
    row.overlap_weeks = 3
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(
        db_session, w.project, "PDD-E",
        {"duration_override_weeks": None, "start_not_before_week": None, "overlap_weeks": None},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["overlap_weeks"] is None
    await db_session.refresh(row)
    assert row.overlap_weeks is None


async def test_started_step_keeps_its_overlap_on_a_resize(db_session, dispatch):
    w = await _world(db_session)
    row = await _start(db_session, w, "PDD-E", WorkflowStepStatus.IN_PROGRESS)
    row.overlap_weeks = 3
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(
        db_session, w.project, "PDD-E", {"duration_override_weeks": 8, "overlap_weeks": 3}
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["overlap_weeks"] == 3


async def test_done_step_is_409(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.status, row.percent_complete = WorkflowStepStatus.DONE, 100
    row.actual_start_week, row.actual_end_week = 29, 30
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    noop = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 0})
    assert resp.status_code == 409 and resp.json()["code"] == "STEP_DONE"
    assert noop.status_code == 200 and noop.json()["recalc_status"] == "unchanged"
    await _assert_overlap_untouched(db_session, w, "PDD-E")


async def test_lead_zero_step_is_409_skipped(db_session, dispatch):
    # PDD / B: PDD-B has lead time 0 -> skipped.
    w = await _world(db_session, category=ProjectCategory.B)
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-B", {"overlap_weeks": 2})
    assert resp.status_code == 409 and resp.json()["code"] == "STEP_SKIPPED"
    await _assert_overlap_untouched(db_session, w, "PDD-B")


async def test_effort_zeroed_step_refuses_a_new_overlap_but_may_clear(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.effort_weeks = 0
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    assert resp.status_code == 409 and resp.json()["code"] == "STEP_SKIPPED"
    await _assert_overlap_untouched(db_session, w, "PDD-E")

    row.overlap_weeks = 2  # left from before the effort split zeroed it
    await db_session.flush()
    clear = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": None})
    assert clear.status_code == 200, clear.text
    assert clear.json()["overlap_weeks"] is None


# --- RBAC (as the existing timing tests) ------------------------------------------------


@pytest.mark.parametrize(
    "role",
    [RoleName.ENGINEER, RoleName.EXECUTIVE_VIEWER, RoleName.PORTFOLIO_MANAGER, RoleName.AUDITOR],
)
async def test_roles_without_gantt_write_get_403(db_session, dispatch, role):
    w = await _world(db_session)
    await _act_as(db_session, role)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    assert resp.status_code == 403
    assert dispatch.calls == []
    await _assert_overlap_untouched(db_session, w, "PDD-E")


async def test_hub_planner_of_another_hub_gets_404(db_session, dispatch):
    w = await _world(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[other.id])
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    assert resp.status_code == 404
    await _assert_overlap_untouched(db_session, w, "PDD-E")


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.SUPER_ADMIN])
async def test_admin_roles_may_set_an_overlap(db_session, dispatch, role):
    w = await _world(db_session)
    await _act_as(db_session, role)
    resp = await _patch(db_session, w.project, "PDD-E", {"overlap_weeks": 2})
    assert resp.status_code == 200, resp.text


# --- GET /gantt -------------------------------------------------------------------------


async def test_gantt_serves_overlap_and_sorted_template_predecessors(db_session):
    w = await _gantt_world(db_session)
    (await _step(db_session, w.project, "PDD-E")).overlap_weeks = 2
    # A configurable DAG (ADR 0009): two predecessors, stored unsorted.
    (await db_session.get(WorkflowStepTemplate, "PDD-I")).predecessor_ids = ["PDD-H", "PDD-F"]
    await db_session.flush()
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    steps = await _gantt_steps(db_session)

    assert steps["PDD-E"]["overlap_weeks"] == 2
    assert steps["PDD-D"]["overlap_weeks"] is None
    assert steps["PDD-A"]["predecessor_ids"] == []
    assert steps["PDD-E"]["predecessor_ids"] == ["PDD-D"]
    assert steps["PDD-I"]["predecessor_ids"] == ["PDD-F", "PDD-H"]


# --- Scheduler input --------------------------------------------------------------------


async def test_schedule_input_drops_a_stale_overlap_on_a_first_step(db_session):
    w = await _world(db_session, active_run=False)
    (await _step(db_session, w.project, "PDD-A")).overlap_weeks = 3  # bypassing the API
    a = await _step(db_session, w.project, "PDD-D")
    a.duration_override_weeks, a.overlap_weeks = 5, None
    await db_session.flush()
    p = await _input_for(db_session, w.project)
    assert p.step_timing == (StepTimingInput("PDD-D", 5, None),)
    assert p.step_timing[0].overlap_weeks == 0


async def test_greedy_run_snapshot_records_overlap_only_when_non_zero(db_session):
    w = await _world(db_session, active_run=False)
    await make_chamber(
        db_session, lab_region=LabRegion.GREECE, max_concurrent=3,
        allowed_stages=["PDD-F", "PDD-H"],
    )
    (await _step(db_session, w.project, "PDD-D")).duration_override_weeks = 3
    (await _step(db_session, w.project, "PDD-F")).overlap_weeks = 2
    await db_session.flush()

    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    assert run.workflow_snapshot["step_timing"] == [
        {"project_id": str(w.project.id), "step_id": "PDD-D",
         "duration_override_weeks": 3, "start_not_before_week": None},
        {"project_id": str(w.project.id), "step_id": "PDD-F",
         "duration_override_weeks": None, "start_not_before_week": None, "overlap_weeks": 2},
    ]


# --- Re-point and DB constraint ---------------------------------------------------------


async def test_workflow_repoint_clears_overlap(db_session):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.overlap_weeks = 3
    await db_session.flush()
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    w.project.hub_id, w.project.category = oem.id, ProjectCategory.A_OEM
    await db_session.flush()
    await sync_project_steps(db_session, w.project, hub_is_oem=True)
    await db_session.refresh(row)
    assert row.step_template_id == "OEM-E"
    assert row.overlap_weeks is None


@pytest.mark.parametrize("value", [0, 105, -1])
async def test_db_check_constraint(db_session, value):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.overlap_weeks = value
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


async def test_db_check_accepts_the_bounds(db_session):
    w = await _world(db_session)
    rows = [await _step(db_session, w.project, s) for s in ("PDD-E", "PDD-F")]
    rows[0].overlap_weeks, rows[1].overlap_weeks = 1, 104
    await db_session.flush()
    stored = (
        await db_session.execute(
            select(type(rows[0]).overlap_weeks).where(
                type(rows[0]).project_id == w.project.id,
                type(rows[0]).overlap_weeks.is_not(None),
            )
        )
    ).scalars().all()
    assert sorted(stored) == [1, 104]
