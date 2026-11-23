"""Owner 2026-11-23: a register Save "could not be saved" (HTTP 500) while a
schedule run was being persisted.

Postgres reported a deadlock: the register batch held its edited project
rows `FOR UPDATE` and renumbered band neighbours (`band_rank` is in a unique
constraint, so that UPDATE takes the key-update row lock), while the run's
persistence held `FOR KEY SHARE` on project rows through the FKs of its step /
outcome rows and needed it on the edited rows. Every band-rank writer takes
the band-rank advisory lock before any row lock; the run's persistence now
takes the same lock before its first write, so the two are serialised.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import create_async_engine

from models.enums import ProjectPriority, ProjectStatus, SolverType
from scheduling.greedy import run_greedy_sgs
from services.band_rank import BAND_RANK_LOCK_KEY
from services.schedule_apply import persist_solved_run
from services.schedule_persistence import build_schedule_input_from_db
from tests._plan_week import TEST_WEEK
from tests.factories import make_engineer, make_hub, make_project


async def _holds_band_lock(db_session) -> bool:
    return (
        await db_session.execute(
            text(
                "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' "
                "AND pid = pg_backend_pid() AND granted "
                "AND ((classid::bigint << 32) | objid::bigint) = :key"
            ),
            {"key": BAND_RANK_LOCK_KEY},
        )
    ).scalar_one() > 0


@asynccontextmanager
async def _band_lock_held_elsewhere(database_url: str):
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            await conn.execute(select(func.pg_advisory_xact_lock(BAND_RANK_LOCK_KEY)))
            try:
                yield
            finally:
                await trans.rollback()
    finally:
        await engine.dispose()


async def _world(db_session):
    hub = await make_hub(db_session)
    eng = await make_engineer(db_session, hub)
    for i in range(3):
        await make_project(
            db_session, hub, name=f"P{i}", status=ProjectStatus.IN_QUEUE,
            priority=ProjectPriority.P2, leader=eng,
        )
    await db_session.flush()
    return await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)


async def _persist(db_session, schedule_input):
    return await persist_solved_run(
        db_session,
        schedule_input,
        run_greedy_sgs(schedule_input),
        solver=SolverType.GREEDY,
        trigger_reason="manual",
        actor_user_id=None,
        activate=True,
    )


async def test_persisting_a_run_takes_the_band_rank_lock(db_session):
    schedule_input = await _world(db_session)
    assert not await _holds_band_lock(db_session)
    await _persist(db_session, schedule_input)
    assert await _holds_band_lock(db_session)


async def test_a_run_waits_for_a_band_rank_writer_before_any_write(db_session, database_url):
    """While a register batch (any band-rank writer) holds the lock, the run's
    persistence waits before writing a single row, so it never holds a
    project row lock the batch then waits on."""

    schedule_input = await _world(db_session)
    await db_session.commit()
    async with _band_lock_held_elsewhere(database_url):
        task = asyncio.ensure_future(_persist(db_session, schedule_input))
        await asyncio.sleep(0.5)
        assert not task.done()
        waiting = (
            await _probe_waiting(database_url)
        )
        assert waiting >= 1
    await asyncio.wait_for(task, timeout=30)
    assert await _holds_band_lock(db_session)


async def _probe_waiting(database_url: str) -> int:
    engine = create_async_engine(database_url)
    try:
        async with engine.connect() as conn:
            return (
                await conn.execute(
                    text(
                        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' "
                        "AND NOT granted AND ((classid::bigint << 32) | objid::bigint) = :key"
                    ),
                    {"key": BAND_RANK_LOCK_KEY},
                )
            ).scalar_one()
    finally:
        await engine.dispose()


pytestmark = pytest.mark.asyncio
