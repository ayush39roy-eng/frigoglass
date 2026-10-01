"""`workers/schedule_run_sweeper.py` (P9-F01, R04-L1) — the Celery-beat
sweeper for `ScheduleRun` rows stuck in `QUEUED`/`RUNNING`. Run directly
against a dedicated real Postgres 17 (the task opens its own engine — same
reason/pattern as `tests/test_workspace_recalc_worker.py`).
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import workers.schedule_run_sweeper as sweeper
from models.audit import AuditLogEntry
from models.enums import ScheduleRunStatus, SolverType
from models.schedule import ScheduleRun
from tests.conftest import run_alembic


@pytest.fixture(scope="module")
def postgres_url():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        result = run_alembic(["upgrade", "head"], url)
        assert result.returncode == 0, result.stderr
        yield url


@pytest.fixture(autouse=True)
def _patch(monkeypatch: pytest.MonkeyPatch, postgres_url: str) -> list[dict]:
    monkeypatch.setenv("RPD_DATABASE_URL", postgres_url)
    # A tiny `task_time_limit_seconds` (window = that + 120s) so the test
    # only needs `created_at` a few minutes in the past, not truly stale.
    monkeypatch.setattr(
        sweeper, "get_celery_settings", lambda: SimpleNamespace(task_time_limit_seconds=1)
    )
    published: list[dict] = []
    monkeypatch.setattr(
        sweeper,
        "publish_progress",
        lambda run_id, *, status, **kwargs: published.append(
            {"schedule_run_id": str(run_id), "status": status, **kwargs}
        ),
    )
    return published


async def _make_run(
    url: str, *, status: ScheduleRunStatus, created_at: datetime, version: int
) -> uuid.UUID:
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            run = ScheduleRun(
                version=version,
                solver_type=SolverType.CP_SAT,
                status=status,
                is_active=False,
                horizon_weeks=78,
                current_week=31,
                created_at=created_at,
            )
            db.add(run)
            await db.commit()
            return run.id
    finally:
        await engine.dispose()


async def _fetch_run(url: str, run_id: uuid.UUID) -> ScheduleRun:
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            run = await db.get(ScheduleRun, run_id)
            assert run is not None
            return run
    finally:
        await engine.dispose()


async def test_sweeps_a_stale_running_run(postgres_url, _patch):
    stale_created_at = datetime.now(UTC) - timedelta(seconds=200)  # > 1 + 120 window
    run_id = await _make_run(
        postgres_url, status=ScheduleRunStatus.RUNNING, created_at=stale_created_at, version=1
    )

    result = await sweeper._sweep_stuck_schedule_runs_async()

    assert result["swept_count"] == 1
    assert str(run_id) in result["schedule_run_ids"]

    swept = await _fetch_run(postgres_url, run_id)
    assert swept.status == ScheduleRunStatus.FAILED
    assert swept.error_message is not None
    assert swept.completed_at is not None

    assert any(p["schedule_run_id"] == str(run_id) and p["status"] == "failed" for p in _patch)


async def test_sweeps_a_stale_queued_run(postgres_url, _patch):
    stale_created_at = datetime.now(UTC) - timedelta(seconds=200)
    run_id = await _make_run(
        postgres_url, status=ScheduleRunStatus.QUEUED, created_at=stale_created_at, version=2
    )

    result = await sweeper._sweep_stuck_schedule_runs_async()

    assert str(run_id) in result["schedule_run_ids"]
    swept = await _fetch_run(postgres_url, run_id)
    assert swept.status == ScheduleRunStatus.FAILED


async def test_does_not_sweep_a_recent_running_run(postgres_url, _patch):
    recent_created_at = datetime.now(UTC)
    run_id = await _make_run(
        postgres_url, status=ScheduleRunStatus.RUNNING, created_at=recent_created_at, version=3
    )

    result = await sweeper._sweep_stuck_schedule_runs_async()

    assert str(run_id) not in result["schedule_run_ids"]
    untouched = await _fetch_run(postgres_url, run_id)
    assert untouched.status == ScheduleRunStatus.RUNNING
    assert untouched.completed_at is None


async def test_does_not_sweep_a_stale_completed_run(postgres_url, _patch):
    stale_created_at = datetime.now(UTC) - timedelta(seconds=200)
    run_id = await _make_run(
        postgres_url, status=ScheduleRunStatus.COMPLETED, created_at=stale_created_at, version=4
    )

    result = await sweeper._sweep_stuck_schedule_runs_async()

    assert str(run_id) not in result["schedule_run_ids"]
    untouched = await _fetch_run(postgres_url, run_id)
    assert untouched.status == ScheduleRunStatus.COMPLETED


async def test_sweep_writes_an_audit_row(postgres_url, _patch):
    stale_created_at = datetime.now(UTC) - timedelta(seconds=200)
    run_id = await _make_run(
        postgres_url, status=ScheduleRunStatus.RUNNING, created_at=stale_created_at, version=5
    )

    await sweeper._sweep_stuck_schedule_runs_async()

    engine = create_async_engine(postgres_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            rows = (
                (
                    await db.execute(
                        select(AuditLogEntry).where(
                            AuditLogEntry.entity_id == str(run_id),
                            AuditLogEntry.action == "schedule_run.swept_stuck",
                        )
                    )
                )
                .scalars()
                .all()
            )
    finally:
        await engine.dispose()

    assert len(rows) == 1
    assert rows[0].actor_user_id is None
    assert rows[0].before_state == {"status": "running"}
    assert rows[0].after_state == {"status": "failed"}
