"""Owner 2026-11-24: old runs' step detail is pruned, keeping the latest
completed runs, the active run and plan-week rollover runs in full."""

from __future__ import annotations

from contextlib import asynccontextmanager

import pytest
from sqlalchemy import func, select

from api.db import get_db
from api.main import app
from models.enums import RoleName, ScheduleRunStatus
from models.plan_week_rollover import PlanWeekRollover
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import WorkflowStepTemplate
from services import run_retention
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub, make_project, make_schedule_run
from tests.p12_helpers import act_as, client_for


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _isolate(db) -> None:
    """Existing rows in the shared test DB must not count: mark them queued
    (never pruned) inside this rolled-back transaction."""
    from sqlalchemy import update

    await db.execute(
        update(ScheduleRun).values(status=ScheduleRunStatus.QUEUED, is_active=False)
    )


async def _run_with_steps(db, project, template_id, version, **kw) -> ScheduleRun:
    run = await make_schedule_run(db, version=version, **kw)
    db.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id, project_id=project.id, step_template_id=template_id,
            sequence_order=1, duration_weeks=1, start_week=1, end_week=1,
        )
    )
    await db.flush()
    return run


async def _steps(db, run) -> int:
    return (
        await db.execute(
            select(func.count()).select_from(ScheduleRunProjectStep)
            .where(ScheduleRunProjectStep.schedule_run_id == run.id)
        )
    ).scalar_one()


async def test_prune_keeps_latest_active_and_rollover_runs(db_session, monkeypatch):
    db = db_session
    await _isolate(db)
    hub = await make_hub(db)
    project = await make_project(db, hub)
    template_id = (await db.execute(select(WorkflowStepTemplate.id).limit(1))).scalar_one()
    old_active = await _run_with_steps(db, project, template_id, 9001, is_active=True)
    old_rollover = await _run_with_steps(db, project, template_id, 9002)
    db.add(PlanWeekRollover(week=60, plan_year=2026, attempts=1, status="queued",
                            last_run_id=old_rollover.id))
    old_plain = await _run_with_steps(db, project, template_id, 9003)
    old_failed = await _run_with_steps(db, project, template_id, 9004,
                                       status=ScheduleRunStatus.FAILED)
    newest = [await _run_with_steps(db, project, template_id, 9100 + i) for i in range(3)]
    await db.flush()

    prunable = await run_retention.runs_to_prune(db, keep=3)
    assert set(prunable) == {old_plain.id, old_failed.id}

    @asynccontextmanager
    async def factory():
        yield db

    monkeypatch.setattr(db, "commit", db.flush)
    pruned, deleted = await run_retention.prune_old_run_steps(factory, keep=3)
    assert (pruned, deleted) == (2, 2)
    assert await _steps(db, old_plain) == 0
    assert await _steps(db, old_failed) == 0
    assert await _steps(db, old_active) == 1
    assert await _steps(db, old_rollover) == 1
    for run in newest:
        assert await _steps(db, run) == 1
    # The run rows themselves stay.
    assert await db.get(ScheduleRun, old_plain.id) is not None


async def test_dry_run_endpoint_counts_and_admin_refused(db_session):
    db = db_session
    await _isolate(db)
    hub = await make_hub(db)
    project = await make_project(db, hub)
    template_id = (await db.execute(select(WorkflowStepTemplate.id).limit(1))).scalar_one()
    old = await _run_with_steps(db, project, template_id, 9201)
    for i in range(run_retention.KEEP_RUNS_WITH_STEPS):
        await make_schedule_run(db, version=9300 + i)
    await act_as(db, RoleName.SUPER_ADMIN)
    async with client_for(db) as client:
        resp = await client.post("/schedule-runs/prune-old-steps?dry_run=true")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["dry_run"] is True
    assert body["remaining_runs"] == 1 and body["step_rows_in_batch"] == 1
    assert await _steps(db, old) == 1

    clear_current_principal_override()
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        resp = await client.post("/schedule-runs/prune-old-steps?dry_run=true")
    assert resp.status_code == 403
