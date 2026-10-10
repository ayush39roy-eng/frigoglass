"""P12-T03: the coalesced follow-up run (ADR 0023 §2–§4, contract §8, I24).

Two parts:
- **Dedicated Postgres** (the worker and the sweeper open their own engines,
  and the dispatch path commits): a burst of N `deferred` auto-triggers
  during one run gives exactly one `follow_up` run whose input carries every
  change (I24); the hand-over after a completed run, after a failed run and
  after a sweep; the bound "one in flight + one pending".
- **Shared savepoint DB, through the API**: a priority move and a check-in
  answering `deferred` set the flag; an auto-trigger that queues clears it;
  the explicit Workspace Recalculate and the admin CP-SAT dispatch never
  touch it (409 as before).

`run_greedy_schedule.delay` and every `publish_progress` are patched;
nothing reaches Celery or Redis.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import api.routers.checkins as checkins_router
import services.priority_move as priority_move
import services.run_dispatch as run_dispatch
import workers.schedule_run_sweeper as sweeper
import workers.schedule_tasks as schedule_tasks
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun
from services.priority_move import apply_priority_change
from services.project_steps import sync_project_steps
from services.schedule_persistence import build_schedule_input_from_db, create_queued_schedule_run
from tests.auth_helpers import clear_current_principal_override, make_principal
from tests.conftest import run_alembic
from tests.factories import make_hub, make_schedule_run, make_user
from tests.p12_helpers import act_as, client_for, plan_step, stepped_project
from workers.schedule_tasks import run_greedy_schedule


class _FakeTask:
    request = SimpleNamespace(id="fake-worker-task-id")


@pytest.fixture(autouse=True)
def _cleanup():
    checkins_router.CHECKIN_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def delays(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    for module in (run_dispatch, priority_move, checkins_router, schedule_tasks, sweeper):
        monkeypatch.setattr(module, "publish_progress", lambda *a, **k: None)
    return calls


# --- Dedicated container --------------------------------------------------------------


@pytest.fixture(scope="module")
def postgres_url():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        result = run_alembic(["upgrade", "head"], url)
        assert result.returncode == 0, result.stderr
        yield url


@pytest.fixture
def real_db(postgres_url, monkeypatch):
    monkeypatch.setenv("RPD_DATABASE_URL", postgres_url)
    return postgres_url


async def _session(url):
    engine = create_async_engine(url)
    return engine, async_sessionmaker(engine, expire_on_commit=False)


async def _reset(url) -> None:
    """Each dedicated-container test starts with no queued/running run and
    the flag cleared (rows are committed, so they outlive a test).
    """

    engine, factory = await _session(url)
    try:
        async with factory() as db:
            for run in (
                await db.execute(
                    select(ScheduleRun).where(
                        ScheduleRun.status.in_(
                            [ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING]
                        )
                    )
                )
            ).scalars():
                run.status = ScheduleRunStatus.CANCELLED
            flag = await db.get(ScheduleRunFollowUp, 1)
            assert flag is not None
            flag.pending = False
            flag.request_count = 0
            flag.requested_at = None
            await db.commit()
    finally:
        await engine.dispose()


async def _in_session(url, fn):
    engine, factory = await _session(url)
    try:
        async with factory() as db:
            return await fn(db)
    finally:
        await engine.dispose()


async def _flag(url) -> ScheduleRunFollowUp:
    async def _read(db):
        row = await db.get(ScheduleRunFollowUp, 1)
        assert row is not None
        return row

    return await _in_session(url, _read)


async def _runs(url, reason: str) -> list[ScheduleRun]:
    async def _read(db):
        return list(
            (
                await db.execute(select(ScheduleRun).where(ScheduleRun.trigger_reason == reason))
            ).scalars()
        )

    return await _in_session(url, _read)


async def _seed_project(url, hub_name: HubName) -> tuple[uuid.UUID, uuid.UUID]:
    async def _write(db):
        hub = Hub(name=hub_name, lab_region=LabRegion.GREECE, is_oem=False)
        db.add(hub)
        await db.flush()
        project = Project(
            name=f"Follow-up {hub_name.value}", hub_id=hub.id, category=ProjectCategory.C,
            type=ProjectType.NM, status=ProjectStatus.IN_QUEUE, priority=ProjectPriority.P3,
            frozen=False, delay_weeks=0, carry_over=False,
            certification_testing_required=False,
        )
        db.add(project)
        await db.flush()
        await sync_project_steps(db, project, False)
        user = await make_user(db, RoleName.PORTFOLIO_MANAGER)
        await db.commit()
        return project.id, user.id

    return await _in_session(url, _write)


async def _new_run(url, status: ScheduleRunStatus, *, age_seconds: int = 0) -> uuid.UUID:
    async def _write(db):
        run = await create_queued_schedule_run(
            db, solver_type=SolverType.GREEDY, trigger_reason="test_in_flight",
            triggered_by_user_id=None,
        )
        run.status = status
        if age_seconds:
            run.created_at = datetime.now(UTC) - timedelta(seconds=age_seconds)
        await db.commit()
        return run.id

    return await _in_session(url, _write)


async def _finish(url, run_id: uuid.UUID, status: ScheduleRunStatus) -> None:
    async def _write(db):
        run = await db.get(ScheduleRun, run_id)
        run.status = status
        await db.commit()

    await _in_session(url, _write)


async def test_burst_of_deferred_collapses_into_one_follow_up(real_db, delays):
    """I24: N deferred auto-triggers during one run → exactly one follow-up,
    and its input reflects every change saved before it was dispatched.
    """

    url = real_db
    await _reset(url)
    project_id, user_id = await _seed_project(url, HubName.RD_GREECE)
    in_flight = await _new_run(url, ScheduleRunStatus.RUNNING)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    answers: list[str] = []
    for target in (ProjectPriority.P2, ProjectPriority.P1, ProjectPriority.P4):
        async def _move(db, target=target):
            project = await db.get(Project, project_id)
            return (await apply_priority_change(db, project, target, principal)).recalc_status

        answers.append(await _in_session(url, _move))
    for reason in ("step_timing", "check_in"):
        async def _other(db, reason=reason):
            found = await run_dispatch.find_in_flight_run(db, trigger_reason=reason)
            await db.commit()
            return "deferred" if found is not None else "queued"

        answers.append(await _in_session(url, _other))
    assert answers == ["deferred"] * 5
    flag = await _flag(url)
    assert (flag.pending, flag.request_count, flag.last_trigger_reason) == (True, 5, "check_in")
    assert delays == []

    # While the run is still in flight, the hand-over does nothing.
    assert await _in_session(url, run_dispatch.dispatch_follow_up_if_requested) is None
    assert (await _flag(url)).pending is True

    await _finish(url, in_flight, ScheduleRunStatus.COMPLETED)
    first = await _in_session(url, run_dispatch.dispatch_follow_up_if_requested)
    second = await _in_session(url, run_dispatch.dispatch_follow_up_if_requested)
    assert first is not None and second is None
    follow_ups = await _runs(url, "follow_up")
    assert [r.id for r in follow_ups] == [first]
    assert follow_ups[0].status == ScheduleRunStatus.QUEUED
    assert follow_ups[0].celery_task_id == "celery-task-1"
    assert len(delays) == 1
    args, kwargs = delays[0]
    assert args == (str(first),)
    assert (kwargs["activate"], kwargs["recalc_project_id"]) == (True, None)
    assert (await _flag(url)).pending is False

    async def _input_priority(db):
        schedule_input = await build_schedule_input_from_db(db)
        [proj] = [p for p in schedule_input.projects if p.project_id == str(project_id)]
        return proj.priority

    # The follow-up's worker builds its input from the DB: the last of the
    # three moves (P2 → P1 → P4) is in it.
    assert await _in_session(url, _input_priority) == "P4"

    async def _audit(db):
        return (
            await db.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "schedule_run.follow_up_dispatched",
                    AuditLogEntry.entity_id == str(first),
                )
            )
        ).scalar_one()

    audit = await _in_session(url, _audit)
    assert audit.after_state["trigger_reason"] == "follow_up"

    # Bound: with the follow-up in flight, a new deferred waits as the one
    # pending request; nothing else is dispatched.
    async def _again(db):
        found = await run_dispatch.find_in_flight_run(db, trigger_reason="priority_move")
        await db.commit()
        return found

    assert await _in_session(url, _again) == first
    assert await _in_session(url, run_dispatch.dispatch_follow_up_if_requested) is None
    assert len(delays) == 1
    assert (await _flag(url)).pending is True
    await _finish(url, first, ScheduleRunStatus.COMPLETED)
    assert await _in_session(url, run_dispatch.dispatch_follow_up_if_requested) is not None
    assert len(delays) == 2


async def _register_follow_up(url) -> None:
    async def _write(db):
        await db.execute(select(func.pg_advisory_xact_lock(run_dispatch.DISPATCH_LOCK_KEY)))
        await run_dispatch._set_follow_up(db, "priority_move")
        await db.commit()

    await _in_session(url, _write)


async def test_worker_failure_hands_over_to_follow_up(real_db, delays, monkeypatch):
    url = real_db
    await _reset(url)
    run_id = await _new_run(url, ScheduleRunStatus.QUEUED)
    await _register_follow_up(url)

    async def _boom(_db):
        raise RuntimeError("solver input exploded")

    monkeypatch.setattr(schedule_tasks, "build_schedule_input_from_db", _boom)
    with pytest.raises(RuntimeError, match="exploded"):
        await schedule_tasks._run_cp_sat_schedule_async(
            _FakeTask(), schedule_run_id=str(run_id), triggered_by_user_id=None,
            deterministic_time=None, activate=True, solver=SolverType.GREEDY,
        )

    async def _status(db):
        return (await db.get(ScheduleRun, run_id)).status

    assert await _in_session(url, _status) == ScheduleRunStatus.FAILED
    assert len(delays) == 1
    assert [r.id for r in await _runs(url, "follow_up")][-1] == uuid.UUID(delays[0][0][0])
    assert (await _flag(url)).pending is False


async def test_worker_success_hands_over_to_follow_up(real_db, delays):
    url = real_db
    await _reset(url)
    await _seed_project(url, HubName.PD_INDIA)
    run_id = await _new_run(url, ScheduleRunStatus.QUEUED)
    await _register_follow_up(url)

    result = await schedule_tasks._run_cp_sat_schedule_async(
        _FakeTask(), schedule_run_id=str(run_id), triggered_by_user_id=None,
        deterministic_time=None, activate=True, solver=SolverType.GREEDY,
    )
    assert result["status"] == "completed"

    async def _run(db):
        return await db.get(ScheduleRun, run_id)

    finished = await _in_session(url, _run)
    assert (finished.status, finished.is_active) == (ScheduleRunStatus.COMPLETED, True)
    assert len(delays) == 1
    assert (await _flag(url)).pending is False


async def test_worker_without_request_dispatches_nothing(real_db, delays):
    url = real_db
    await _reset(url)
    run_id = await _new_run(url, ScheduleRunStatus.CANCELLED)
    result = await schedule_tasks._run_cp_sat_schedule_async(
        _FakeTask(), schedule_run_id=str(run_id), triggered_by_user_id=None,
        deterministic_time=None, activate=True, solver=SolverType.GREEDY,
    )
    assert result["status"] == "cancelled"
    assert delays == []


async def test_sweep_hands_over_to_follow_up(real_db, delays, monkeypatch):
    url = real_db
    await _reset(url)
    tiny = SimpleNamespace(task_time_limit_seconds=1)
    monkeypatch.setattr(sweeper, "get_celery_settings", lambda: tiny)
    monkeypatch.setattr(run_dispatch, "get_celery_settings", lambda: tiny)
    stuck = await _new_run(url, ScheduleRunStatus.RUNNING, age_seconds=600)
    await _register_follow_up(url)

    result = await sweeper._sweep_stuck_schedule_runs_async()

    assert str(stuck) in result["schedule_run_ids"]
    assert result["follow_up_run_id"] is not None
    assert len(delays) == 1
    assert (await _flag(url)).pending is False
    # The next tick finds nothing to do (the follow-up is in flight, the
    # flag is clear).
    again = await sweeper._sweep_stuck_schedule_runs_async()
    assert (again["swept_count"], again["follow_up_run_id"]) == (0, None)
    assert len(delays) == 1


# --- Shared DB, through the API -------------------------------------------------------


async def _flag_row(db_session) -> ScheduleRunFollowUp:
    row = await db_session.get(ScheduleRunFollowUp, 1, populate_existing=True)
    assert row is not None
    return row


async def test_priority_move_deferred_sets_flag(db_session, delays):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await stepped_project(db_session, hub, name="Mover", priority=ProjectPriority.P3)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post(f"/projects/{project.id}/priority", json={"priority": "P2"})
    assert r.json()["recalc_status"] == "deferred"
    flag = await _flag_row(db_session)
    assert (flag.pending, flag.last_trigger_reason) == (True, "priority_move")


async def test_queued_auto_trigger_clears_a_pending_flag(db_session, delays):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True)
    project = await stepped_project(db_session, hub, name="Reporter")
    await plan_step(db_session, run, project, "PDD-E", 28, 34)
    await run_dispatch._set_follow_up(db_session, "priority_move")
    await db_session.flush()
    assert (await _flag_row(db_session)).pending is True
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={"entries": [{"project_id": str(project.id), "step_id": "PDD-E",
                               "status": "In Progress", "percent_complete": 10}]},
        )
    assert r.json()["recalc_status"] == "queued"
    assert (await _flag_row(db_session)).pending is False


async def test_explicit_recalculate_never_touches_the_flag(db_session, delays):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await stepped_project(db_session, hub, name="Explicit")
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post(f"/projects/{project.id}/recalculate")
    assert r.status_code == 409
    assert r.json()["code"] == "RUN_IN_PROGRESS"
    assert (await _flag_row(db_session)).pending is False


async def test_admin_cp_sat_dispatch_never_touches_the_flag(db_session, delays):
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        r = await client.post("/schedule-runs/cp-sat-dispatch", json={})
    assert r.status_code == 409
    assert (await _flag_row(db_session)).pending is False
