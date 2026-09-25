"""Unit tests for `services/schedule_persistence.py`. No dedicated test file
existed for this module before P3-T06 (it was previously exercised only via
`api/routers/schedule_runs.py`'s own live smoke-test verification, per
`docs/MEMORY.md`'s P3-T01 entry) — this file adds real regression coverage
for both the pre-existing `persist_schedule_output` behaviour (a safety net
for this task's edits to that function) and the new P3-T06 additions:
`create_queued_schedule_run`, the `existing_run`/`objective_value`
parameters, and the `sync_live_workflow_steps=True` + `activate=False` guard.
"""

from __future__ import annotations

from sqlalchemy import select

from models.enums import ScheduleRunStatus, SolverType
from models.schedule import ScheduleRun
from models.workflow import ProjectWorkflowStep
from scheduling.greedy import run_greedy_sgs
from services.schedule_persistence import (
    build_schedule_input_from_db,
    create_queued_schedule_run,
    persist_schedule_output,
)
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_user,
    make_workflow_step_template,
)


async def _seed_minimal_schedulable_project(db_session):
    hub = await make_hub(db_session)
    await make_workflow_step_template(
        db_session,
        step_id="PDD-A",
        name="Marketing Brief",
        kind="design",
        base_weeks=2,
        sequence_order=1,
    )
    await make_workflow_step_template(
        db_session,
        step_id="PDD-F",
        name="Proof of Concept",
        kind="lab",
        base_weeks=3,
        sequence_order=2,
    )
    engineer = await make_engineer(db_session, hub)
    await make_chamber(db_session, allowed_stages=["PDD-F"])
    project = await make_project(db_session, hub, leader=engineer)
    return project


async def test_create_queued_schedule_run_defaults(db_session):
    run = await create_queued_schedule_run(
        db_session,
        solver_type=SolverType.CP_SAT,
        trigger_reason="cp_sat_dispatch",
        triggered_by_user_id=None,
    )
    assert run.status == ScheduleRunStatus.QUEUED
    assert run.is_active is False
    assert run.solver_type == SolverType.CP_SAT
    assert run.celery_task_id is None
    assert run.version is not None


async def test_create_queued_schedule_run_reserves_distinct_versions(db_session):
    run_a = await create_queued_schedule_run(
        db_session, solver_type=SolverType.CP_SAT, trigger_reason="x", triggered_by_user_id=None
    )
    run_b = await create_queued_schedule_run(
        db_session, solver_type=SolverType.CP_SAT, trigger_reason="x", triggered_by_user_id=None
    )
    assert run_a.version != run_b.version


async def test_persist_schedule_output_new_row_unchanged_behaviour(db_session):
    """Regression guard: the original (P3-T01) greedy-recalc call shape must
    still create a brand-new COMPLETED, active row exactly as before.
    """

    await _seed_minimal_schedulable_project(db_session)
    schedule_input = await build_schedule_input_from_db(db_session)
    schedule_output = run_greedy_sgs(schedule_input)

    run = await persist_schedule_output(
        db_session,
        schedule_input,
        schedule_output,
        solver_type=SolverType.GREEDY,
        trigger_reason="manual_recalc",
        activate=True,
    )

    assert run.status == ScheduleRunStatus.COMPLETED
    assert run.is_active is True
    assert run.solver_type == SolverType.GREEDY
    assert run.objective_value is None


async def test_persist_schedule_output_reuses_existing_run_in_place(db_session):
    """The P3-T06 CP-SAT dispatch shape: one ScheduleRun row, created QUEUED,
    ends up COMPLETED with the SAME id/version — never a second row.
    """

    await _seed_minimal_schedulable_project(db_session)
    schedule_input = await build_schedule_input_from_db(db_session)
    schedule_output = run_greedy_sgs(schedule_input)  # stand-in ScheduleOutput

    queued_run = await create_queued_schedule_run(
        db_session,
        solver_type=SolverType.CP_SAT,
        trigger_reason="cp_sat_dispatch",
        triggered_by_user_id=None,
    )
    queued_run.status = ScheduleRunStatus.RUNNING
    db_session.add(queued_run)
    await db_session.flush()

    user = await make_user(db_session)

    completed_run = await persist_schedule_output(
        db_session,
        schedule_input,
        schedule_output,
        solver_type=SolverType.CP_SAT,
        trigger_reason="cp_sat_dispatch",
        triggered_by_user_id=user.id,
        activate=False,
        sync_live_workflow_steps=False,
        existing_run=queued_run,
        objective_value=4.0,
    )
    assert completed_run.triggered_by_user_id == user.id

    assert completed_run.id == queued_run.id
    assert completed_run.version == queued_run.version
    assert completed_run.status == ScheduleRunStatus.COMPLETED
    assert completed_run.is_active is False
    assert completed_run.objective_value == 4.0
    assert completed_run.completed_at is not None

    # Exactly one ScheduleRun row exists for this run — never a second one.
    rows = (
        (await db_session.execute(select(ScheduleRun).where(ScheduleRun.id == queued_run.id)))
        .scalars()
        .all()
    )
    assert len(rows) == 1


async def test_persist_schedule_output_not_activated_does_not_touch_live_workflow_steps(
    db_session,
):
    """A non-activated CP-SAT run must never overwrite the live Gantt's
    `ProjectWorkflowStep.planned_*` fields — this is the exact bug the
    `sync_live_workflow_steps` + `activate` coupling guards against.
    """

    project = await _seed_minimal_schedulable_project(db_session)
    schedule_input = await build_schedule_input_from_db(db_session)
    schedule_output = run_greedy_sgs(schedule_input)

    before = (
        await db_session.execute(
            select(ProjectWorkflowStep.planned_start_week).where(
                ProjectWorkflowStep.project_id == project.id
            )
        )
    ).scalars().all()
    assert all(v is None for v in before)  # nothing scheduled/activated yet

    queued_run = await create_queued_schedule_run(
        db_session,
        solver_type=SolverType.CP_SAT,
        trigger_reason="cp_sat_dispatch",
        triggered_by_user_id=None,
    )

    await persist_schedule_output(
        db_session,
        schedule_input,
        schedule_output,
        solver_type=SolverType.CP_SAT,
        trigger_reason="cp_sat_dispatch",
        activate=False,
        sync_live_workflow_steps=False,
        existing_run=queued_run,
    )

    after = (
        await db_session.execute(
            select(ProjectWorkflowStep.planned_start_week).where(
                ProjectWorkflowStep.project_id == project.id
            )
        )
    ).scalars().all()
    assert all(v is None for v in after)


async def test_persist_schedule_output_rejects_sync_without_activate(db_session):
    await _seed_minimal_schedulable_project(db_session)
    schedule_input = await build_schedule_input_from_db(db_session)
    schedule_output = run_greedy_sgs(schedule_input)

    try:
        await persist_schedule_output(
            db_session,
            schedule_input,
            schedule_output,
            solver_type=SolverType.CP_SAT,
            trigger_reason="cp_sat_dispatch",
            activate=False,
            sync_live_workflow_steps=True,
        )
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "sync_live_workflow_steps" in str(exc)
