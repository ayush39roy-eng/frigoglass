"""P9-T03: the Celery task body behind `POST /projects/{id}/recalculate`
(`workers.schedule_tasks._run_cp_sat_schedule_async(..., activate=True,
recalc_project_id=...)`), run directly against a dedicated real Postgres 17
(the task opens its own engine, so it needs committed rows, the same reason
`tests/test_export_worker_task.py` uses its own container).

The workspace path runs the real greedy scheduler (`solver=GREEDY`, P9-T03
follow-up, OQ #10). For the admin CP-SAT path `run_cp_sat` is replaced by
greedy so the test stays fast; that test is about activation, not the solver.

Asserts: the run completes AND becomes active (the previous one is
deactivated), `schedule_stale` is cleared for its projects, live stage rows
get planned weeks, `workflow_snapshot` is written, and the "Schedule
recalculated — finish moved week X → week Y" audit event lands on the
project. The admin dispatch path (`activate=False`) keeps the P3-T06
behaviour: completed, not active, stale untouched.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import workers.schedule_tasks as schedule_tasks
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    ScheduleRunStatus,
    SolverType,
)
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from models.workflow import ProjectWorkflowStep
from scheduling.greedy import run_greedy_sgs
from services.project_steps import sync_project_steps
from services.schedule_persistence import create_queued_schedule_run
from services.workspace import event_summary
from tests.conftest import run_alembic


class _FakeTask:
    request = SimpleNamespace(id="fake-worker-task-id")


@pytest.fixture(scope="module")
def postgres_url():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        result = run_alembic(["upgrade", "head"], url)
        assert result.returncode == 0, result.stderr
        yield url


@pytest.fixture(autouse=True)
def _patch(monkeypatch, postgres_url):
    monkeypatch.setenv("RPD_DATABASE_URL", postgres_url)

    def _greedy_as_cp_sat(schedule_input, **_kwargs):
        info = SimpleNamespace(status_name="OPTIMAL", wall_time_seconds=0.01, objective_value=1.0)
        return run_greedy_sgs(schedule_input), info

    monkeypatch.setattr(schedule_tasks, "run_cp_sat", _greedy_as_cp_sat)
    monkeypatch.setattr(schedule_tasks, "publish_progress", lambda *a, **k: None)


async def _seed(
    url: str, hub_name: HubName, version: int, solver: SolverType = SolverType.CP_SAT
) -> tuple[uuid.UUID, uuid.UUID, uuid.UUID]:
    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as db:
            hub = Hub(name=hub_name, lab_region=LabRegion.GREECE, is_oem=False)
            db.add(hub)
            await db.flush()
            leader = Engineer(
                name="L", hub_id=hub.id, fte=1.0, allowed_categories=[EngineerAllowedCategory.C]
            )
            db.add(leader)
            await db.flush()
            project = Project(
                name=f"Recalc {hub_name.value}", hub_id=hub.id, leader_engineer_id=leader.id,
                category=ProjectCategory.C, type=ProjectType.NM, status=ProjectStatus.IN_QUEUE,
                priority=ProjectPriority.P1, frozen=False, delay_weeks=0, carry_over=False,
                schedule_stale=True,
                # No chamber is seeded; without lab steps the project is schedulable.
                certification_testing_required=False,
            )
            db.add(project)
            await db.flush()
            await sync_project_steps(db, project, False)
            previous = ScheduleRun(
                version=version, solver_type=SolverType.GREEDY,
                status=ScheduleRunStatus.COMPLETED, is_active=True,
            )
            # Only one active run may exist: deactivate any from another test first.
            for other in (
                await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
            ).scalars():
                other.is_active = False
            await db.flush()
            db.add(previous)
            await db.flush()
            db.add(
                ScheduleRunProjectOutcome(
                    schedule_run_id=previous.id, project_id=project.id, projected_end_week=44,
                    last_step_end_week=44, within_year=True,
                )
            )
            run = await create_queued_schedule_run(
                db, solver_type=solver, trigger_reason="workspace_recalc",
                triggered_by_user_id=None,
            )
            await db.commit()
            return project.id, previous.id, run.id
    finally:
        await engine.dispose()


async def _read(url: str, fn):
    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with factory() as db:
            return await fn(db)
    finally:
        await engine.dispose()


async def test_recalc_worker_activates_clears_stale_and_emits_event(postgres_url):
    project_id, previous_id, run_id = await _seed(
        postgres_url, HubName.RD_GREECE, 5001, SolverType.GREEDY
    )
    result = await schedule_tasks._run_cp_sat_schedule_async(
        _FakeTask(),
        schedule_run_id=str(run_id),
        triggered_by_user_id=None,
        deterministic_time=1.0,
        activate=True,
        recalc_project_id=str(project_id),
        solver=SolverType.GREEDY,
    )
    assert result["status"] == "completed"
    # P9-R02b: greedy runs carry no solver verdict (ruling 6, ScheduleOutput).
    assert result["solver_status"] is None

    async def _check(db):
        run = await db.get(ScheduleRun, run_id)
        previous = await db.get(ScheduleRun, previous_id)
        project = await db.get(Project, project_id)
        outcome = (
            await db.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == run_id,
                    ScheduleRunProjectOutcome.project_id == project_id,
                )
            )
        ).scalar_one()
        planned = (
            await db.execute(
                select(ProjectWorkflowStep.planned_start_week).where(
                    ProjectWorkflowStep.project_id == project_id,
                    ProjectWorkflowStep.step_template_id == "PDD-A",
                )
            )
        ).scalar_one()
        event = (
            await db.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "project.schedule_recalculated",
                    AuditLogEntry.entity_id == str(project_id),
                )
            )
        ).scalar_one()
        return run, previous, project, outcome, planned, event

    run, previous, project, outcome, planned, event = await _read(postgres_url, _check)
    assert run.status == ScheduleRunStatus.COMPLETED
    assert run.solver_type == SolverType.GREEDY and run.objective_value is None
    assert run.solver_status is None
    assert run.is_active is True and previous.is_active is False
    assert run.trigger_reason == "workspace_recalc"
    assert run.workflow_snapshot is not None and len(run.workflow_snapshot["lead_times"]) == 98
    assert project.schedule_stale is False
    assert planned is not None
    assert outcome.projected_end_week is not None
    assert event.before_state["projected_end_week"] == 44
    assert event.after_state["projected_end_week"] == outcome.projected_end_week
    assert event_summary(event) == (
        f"Schedule recalculated — finish moved week 44 → week {outcome.projected_end_week}"
    )


async def test_admin_dispatch_path_still_never_activates(postgres_url):
    project_id, previous_id, run_id = await _seed(postgres_url, HubName.PD_ROMANIA, 6001)
    await schedule_tasks._run_cp_sat_schedule_async(
        _FakeTask(), schedule_run_id=str(run_id), triggered_by_user_id=None,
        deterministic_time=1.0,
    )

    async def _check(db):
        return (
            await db.get(ScheduleRun, run_id),
            await db.get(ScheduleRun, previous_id),
            await db.get(Project, project_id),
        )

    run, previous, project = await _read(postgres_url, _check)
    assert run.status == ScheduleRunStatus.COMPLETED
    assert run.solver_status in ("OPTIMAL", "FEASIBLE")
    assert run.is_active is False and previous.is_active is True
    assert project.schedule_stale is True
