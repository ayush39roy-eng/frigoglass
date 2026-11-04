"""P32-R01: greedy runs execute in the API process (`RPD_GREEDY_INLINE`).

Owner bug: after a Gantt step-timing drag the UI sat on "Solver queued"
forever, because greedy recalcs went to the Celery broker and neither the
local stack nor Render runs a worker. `services.run_dispatch.dispatch_greedy`
now runs the task body on a one-thread pool in-process by default.

Dedicated Postgres (the inline body opens its own engine on its own loop in
another thread, so it must see committed rows). No broker: `.delay` is
patched to raise in inline mode, and every `publish_progress` is a no-op.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import services.priority_move as priority_move
import services.run_dispatch as run_dispatch
import services.step_timing as step_timing
import workers.schedule_tasks as schedule_tasks
from core.celery_config import SolverDispatchSettings, get_solver_dispatch_settings
from models.checkin import ScheduleRunFollowUp
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.hub import Hub
from models.project import Project
from models.schedule import ScheduleRun
from services.priority_move import apply_priority_change
from services.project_steps import sync_project_steps
from services.schedule_persistence import create_queued_schedule_run
from services.step_timing import apply_step_timing
from tests.auth_helpers import make_principal
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_project, make_user
from workers.schedule_tasks import run_greedy_schedule

# --- fixtures ----------------------------------------------------------------------------


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


@pytest.fixture
def inline(monkeypatch):
    """Inline mode on, no broker, no Redis. Returns the progress events."""

    monkeypatch.setattr(
        run_dispatch,
        "get_solver_dispatch_settings",
        lambda: SolverDispatchSettings(greedy_inline=True),
    )

    def _no_broker(*_a, **_k):
        raise AssertionError("inline mode must not reach the broker")

    monkeypatch.setattr(run_greedy_schedule, "delay", _no_broker)
    events: list[tuple[str, str]] = []

    def _publish(run_id, *, status, **_k):
        events.append((str(run_id), status))

    for module in (run_dispatch, priority_move, step_timing, schedule_tasks):
        monkeypatch.setattr(module, "publish_progress", _publish)
    yield events
    assert run_dispatch.wait_for_inline_runs(60)


async def _wait_idle() -> None:
    assert await asyncio.to_thread(run_dispatch.wait_for_inline_runs, 60)


async def _in_session(url, fn):
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            return await fn(db)
    finally:
        await engine.dispose()


async def _reset(url) -> None:
    async def _write(db):
        for run in (
            await db.execute(
                select(ScheduleRun).where(
                    ScheduleRun.status.in_([ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING])
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

    await _in_session(url, _write)


async def _seed(url) -> tuple[uuid.UUID, uuid.UUID]:
    """One schedulable project with a leader and its 14 stage rows; a PM user."""

    async def _write(db):
        hub = (
            await db.execute(select(Hub).where(Hub.name == HubName.RD_GREECE))
        ).scalar_one_or_none()
        if hub is None:
            hub = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
        leader = await make_engineer(
            db, hub, name=f"Inline Leader {uuid.uuid4().hex[:6]}",
            allowed_categories=[EngineerAllowedCategory.A, EngineerAllowedCategory.B],
        )
        project = await make_project(
            db, hub, leader=leader, name=f"Inline {uuid.uuid4().hex[:6]}",
            status=ProjectStatus.IN_QUEUE, category=ProjectCategory.A,
            priority=ProjectPriority.P3, schedule_stale=False,
            certification_testing_required=True,
        )
        await sync_project_steps(db, project, hub_is_oem=False)
        user = await make_user(db, RoleName.PORTFOLIO_MANAGER)
        await db.commit()
        return project.id, user.id

    return await _in_session(url, _write)


async def _run(url, run_id) -> ScheduleRun:
    async def _read(db):
        return await db.get(ScheduleRun, run_id)

    return await _in_session(url, _read)


async def _runs(url, reason: str) -> list[ScheduleRun]:
    async def _read(db):
        return list(
            (
                await db.execute(select(ScheduleRun).where(ScheduleRun.trigger_reason == reason))
            ).scalars()
        )

    return await _in_session(url, _read)


# --- the setting -------------------------------------------------------------------------


def test_setting_defaults_to_inline_and_reads_the_env(monkeypatch):
    monkeypatch.delenv("RPD_GREEDY_INLINE", raising=False)
    get_solver_dispatch_settings.cache_clear()
    try:
        assert get_solver_dispatch_settings().greedy_inline is True
        monkeypatch.setenv("RPD_GREEDY_INLINE", "false")
        get_solver_dispatch_settings.cache_clear()
        assert get_solver_dispatch_settings().greedy_inline is False
    finally:
        get_solver_dispatch_settings.cache_clear()


def test_setting_false_keeps_broker_dispatch(monkeypatch):
    monkeypatch.setattr(
        run_dispatch, "get_solver_dispatch_settings",
        lambda: SolverDispatchSettings(greedy_inline=False),
    )
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id="celery-task-7")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)

    def _no_pool():
        raise AssertionError("broker mode must not use the inline pool")

    monkeypatch.setattr(run_dispatch, "_get_inline_executor", _no_pool)
    task_id = run_dispatch.dispatch_greedy(
        "run-1", db=None, triggered_by_user_id="u", activate=True, recalc_project_id="p"
    )
    assert task_id == "celery-task-7"
    assert calls == [
        (("run-1",), {"triggered_by_user_id": "u", "activate": True, "recalc_project_id": "p"})
    ]


# --- inline execution --------------------------------------------------------------------


async def test_priority_move_runs_inline_to_completed_and_active(real_db, inline):
    url = real_db
    await _reset(url)
    project_id, user_id = await _seed(url)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _move(db):
        project = await db.get(Project, project_id)
        return await apply_priority_change(db, project, ProjectPriority.P1, principal)

    result = await _in_session(url, _move)
    assert result.recalc_status == "queued"
    await _wait_idle()

    moves = await _runs(url, "priority_move")
    [run] = [r for r in moves if r.status != ScheduleRunStatus.CANCELLED]
    assert (run.status, run.is_active, run.solver_type) == (
        ScheduleRunStatus.COMPLETED, True, SolverType.GREEDY,
    )
    # The synthetic task id the dispatcher answered is the one recorded.
    uuid.UUID(run.celery_task_id)
    statuses = [s for rid, s in inline if rid == str(run.id)]
    assert statuses[0] == "queued" and statuses[-1] == "completed"

    async def _stale(db):
        return (await db.get(Project, project_id)).schedule_stale

    assert await _in_session(url, _stale) is False


async def test_step_timing_runs_inline_to_completed_and_active(real_db, inline):
    url = real_db
    await _reset(url)
    project_id, user_id = await _seed(url)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _drag(db):
        project = await db.get(Project, project_id)
        return await apply_step_timing(
            db, project, "PDD-E", {"duration_override_weeks": 9, "start_not_before_week": 40},
            principal,
        )

    result = await _in_session(url, _drag)
    assert result.recalc_status == "queued"
    assert result.schedule_run_id is not None and result.task_id is not None
    await _wait_idle()

    run = await _run(url, result.schedule_run_id)
    assert (run.status, run.is_active) == (ScheduleRunStatus.COMPLETED, True)
    assert run.celery_task_id == result.task_id


async def test_follow_up_coalesces_to_exactly_one_inline_run(real_db, inline):
    """I24 in inline mode: a burst of deferred moves while a run is queued,
    then that run executes inline; its end dispatches exactly one follow-up,
    which also runs inline (no deadlock on the dispatch lock, one thread).
    """

    url = real_db
    await _reset(url)
    project_id, user_id = await _seed(url)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _queued(db):
        run = await create_queued_schedule_run(
            db, solver_type=SolverType.GREEDY, trigger_reason="test_in_flight",
            triggered_by_user_id=None,
        )
        return run.id

    in_flight = await _in_session(url, _queued)
    answers = []
    for target in (ProjectPriority.P2, ProjectPriority.P1, ProjectPriority.P4):
        async def _move(db, target=target):
            project = await db.get(Project, project_id)
            return (await apply_priority_change(db, project, target, principal)).recalc_status

        answers.append(await _in_session(url, _move))
    assert answers == ["deferred"] * 3

    before = {r.id for r in await _runs(url, "follow_up")}
    run_dispatch.dispatch_greedy(
        str(in_flight), db=None, triggered_by_user_id=None, activate=True, recalc_project_id=None
    )
    await _wait_idle()

    assert (await _run(url, in_flight)).status == ScheduleRunStatus.COMPLETED
    follow_ups = [r for r in await _runs(url, "follow_up") if r.id not in before]
    assert len(follow_ups) == 1
    assert (follow_ups[0].status, follow_ups[0].is_active) == (ScheduleRunStatus.COMPLETED, True)

    async def _flag(db):
        return (await db.get(ScheduleRunFollowUp, 1)).pending

    assert await _in_session(url, _flag) is False


async def test_failing_body_marks_the_run_failed(real_db, inline, monkeypatch, caplog):
    url = real_db
    await _reset(url)
    project_id, user_id = await _seed(url)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _boom(_db):
        raise RuntimeError("secret-ish detail")

    monkeypatch.setattr(schedule_tasks, "build_schedule_input_from_db", _boom)

    async def _drag(db):
        project = await db.get(Project, project_id)
        return await apply_step_timing(
            db, project, "PDD-E", {"duration_override_weeks": 7}, principal
        )

    with caplog.at_level(logging.WARNING, logger=run_dispatch.logger.name):
        result = await _in_session(url, _drag)
        assert result.recalc_status == "queued"
        await _wait_idle()

    run = await _run(url, result.schedule_run_id)
    assert run.status == ScheduleRunStatus.FAILED
    assert run.is_active is False
    assert "secret-ish detail" in (run.error_message or "")
    assert "failed" in [s for rid, s in inline if rid == str(run.id)]
    ours = [r for r in caplog.records if r.name == run_dispatch.logger.name]
    assert any("RuntimeError" in r.getMessage() for r in ours)
    assert all("secret-ish" not in r.getMessage() for r in ours)


# --- Redis unreachable (Render / a laptop with no Redis) ----------------------------------


@pytest.fixture
def no_redis(monkeypatch):
    """Inline mode with the REAL `publish_progress` pointed at a closed port:
    every PUBLISH / SUBSCRIBE fails with a connection error. No broker either.
    """

    import core.celery_config as celery_config
    import workers.progress as progress_module

    monkeypatch.setenv("RPD_REDIS_URL", "redis://127.0.0.1:1/0")
    celery_config.get_redis_settings.cache_clear()
    monkeypatch.setattr(progress_module, "_redis_client", None)
    monkeypatch.setattr(
        run_dispatch,
        "get_solver_dispatch_settings",
        lambda: SolverDispatchSettings(greedy_inline=True),
    )

    def _no_broker(*_a, **_k):
        raise AssertionError("inline mode must not reach the broker")

    monkeypatch.setattr(run_greedy_schedule, "delay", _no_broker)
    yield
    assert run_dispatch.wait_for_inline_runs(60)
    progress_module._redis_client = None
    monkeypatch.undo()
    celery_config.get_redis_settings.cache_clear()


async def test_step_timing_completes_inline_with_redis_down(real_db, no_redis, caplog):
    url = real_db
    await _reset(url)
    project_id, user_id = await _seed(url)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _drag(db):
        project = await db.get(Project, project_id)
        return await apply_step_timing(
            db, project, "PDD-E", {"duration_override_weeks": 8}, principal
        )

    with caplog.at_level(logging.WARNING):
        # The API's own `queued` publish fails but must not fail the request.
        result = await _in_session(url, _drag)
        assert result.recalc_status == "queued"
        await _wait_idle()

    run = await _run(url, result.schedule_run_id)
    assert (run.status, run.is_active) == (ScheduleRunStatus.COMPLETED, True)
    assert run.error_message is None
    progress_logs = [r.getMessage() for r in caplog.records if r.name == "workers.progress"]
    # queued (API), running + completed (inline body): each logged by type only.
    assert len(progress_logs) >= 3
    assert all("ConnectionError" in m for m in progress_logs)
    assert all("127.0.0.1" not in m for m in progress_logs)


async def test_sse_follow_delivers_completed_with_redis_down(real_db, no_redis, monkeypatch):
    """The run-follow stream cannot subscribe, so it follows the run row and
    ends with `completed` once the inline run finishes.
    """

    from httpx import ASGITransport, AsyncClient

    import api.routers.schedule_runs as schedule_runs_module
    from api.db import get_db
    from api.main import app
    from tests.auth_helpers import clear_current_principal_override, override_current_principal

    url = real_db
    await _reset(url)
    await _seed(url)
    monkeypatch.setattr(schedule_runs_module, "_DB_POLL_SECONDS", 0.05)

    async def _queued(db):
        run = await create_queued_schedule_run(
            db, solver_type=SolverType.GREEDY, trigger_reason="step_timing",
            triggered_by_user_id=None,
        )
        return run.id

    run_id = await _in_session(url, _queued)

    engine = create_async_engine(url)
    factory = async_sessionmaker(engine, expire_on_commit=False)

    async def _override_get_db():
        async with factory() as db:
            yield db

    async def _read_row(rid):
        async with factory() as db:
            return await db.get(ScheduleRun, rid)

    monkeypatch.setattr(schedule_runs_module, "_read_run_for_stream", _read_row)
    app.dependency_overrides[get_db] = _override_get_db
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            request = asyncio.create_task(c.get(f"/schedule-runs/{run_id}/progress"))
            await asyncio.sleep(1.0)  # the stream is following the QUEUED row
            run_dispatch.dispatch_greedy(
                str(run_id), db=None, triggered_by_user_id=None, activate=True,
                recalc_project_id=None,
            )
            resp = await asyncio.wait_for(request, timeout=60)
    finally:
        app.dependency_overrides.pop(get_db, None)
        clear_current_principal_override()
        await engine.dispose()

    assert resp.status_code == 200
    events = [
        json.loads(line[len("data: "):])
        for line in resp.text.splitlines()
        if line.startswith("data: ")
    ]
    statuses = [e["status"] for e in events]
    assert statuses[0] == "queued"
    assert statuses[-1] == "completed"
    assert events[-1]["percent"] == 100.0
    run = await _run(url, run_id)
    assert (run.status, run.is_active) == (ScheduleRunStatus.COMPLETED, True)


async def test_follow_up_coalesces_inline_with_redis_down(real_db, no_redis):
    """The dispatch lock and the ADR 0023 follow-up are Postgres-only: with
    Redis unreachable a deferred burst still yields exactly one follow-up run.
    """

    url = real_db
    await _reset(url)
    project_id, user_id = await _seed(url)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _queued(db):
        run = await create_queued_schedule_run(
            db, solver_type=SolverType.GREEDY, trigger_reason="test_in_flight",
            triggered_by_user_id=None,
        )
        return run.id

    in_flight = await _in_session(url, _queued)
    for target in (ProjectPriority.P2, ProjectPriority.P4):
        async def _move(db, target=target):
            project = await db.get(Project, project_id)
            return (await apply_priority_change(db, project, target, principal)).recalc_status

        assert await _in_session(url, _move) == "deferred"

    before = {r.id for r in await _runs(url, "follow_up")}
    run_dispatch.dispatch_greedy(
        str(in_flight), db=None, triggered_by_user_id=None, activate=True, recalc_project_id=None
    )
    await _wait_idle()

    assert (await _run(url, in_flight)).status == ScheduleRunStatus.COMPLETED
    new = [r for r in await _runs(url, "follow_up") if r.id not in before]
    assert len(new) == 1
    assert (new[0].status, new[0].is_active) == (ScheduleRunStatus.COMPLETED, True)
