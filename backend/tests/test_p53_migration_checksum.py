"""P53-T03: migration `p53a_week_line` is additive only (ADR 0063 R53-7, I57,
I62), in its own container.

The seeded DB (with its persisted runs) is taken down to `p35b_step_excluded`
and every existing row of the tables holding a stored week is checksummed
(the whole row, so any UPDATE shows; the row count, so any DELETE shows).
Then: upgrade to `p53a` → identical checksums (the new columns excluded);
a pin past W52 and a scenario year end of 156 are accepted; downgrade →
identical checksums again and the post-upgrade rows are still there (the
restored CHECKs are NOT VALID). Upgrade once more for the next module.
"""

from __future__ import annotations

import asyncio
import importlib
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from models.enums import SolverType
from scheduling import run_greedy_sgs
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests._plan_week import TEST_WEEK
from tests.conftest import run_alembic

_BEFORE = "p35b_step_excluded"
_P53 = "p53a_week_line"

#: (table, order-by) of every table that stores a week (R53-7 list).
_TABLES: tuple[tuple[str, str], ...] = (
    ("schedule_runs", "id"),
    ("schedule_run_project_steps", "id"),
    ("schedule_run_project_outcomes", "id"),
    ("projects", "id"),
    ("project_workflow_steps", "id"),
    ("stage_checkins", "id"),
    ("engineers", "id"),
    ("engineer_inactive_periods", "id"),
    ("project_leader_history", "id"),
    ("whatif_import_scenarios", "id"),
)
#: Columns p53a adds; excluded so "before" and "after" compare like for like.
_NEW_COLUMNS = ("rules_epoch", "priority_at_run", "left_out_reason")


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _run(url: str, fn: Any) -> Any:
    async def go() -> Any:
        conn = await asyncpg.connect(_dsn(url))
        try:
            return await fn(conn)
        finally:
            await conn.close()

    return asyncio.run(go())


def _checksums(url: str) -> dict[str, tuple[int, str]]:
    strip = "".join(f" - '{c}'" for c in _NEW_COLUMNS)

    async def go(conn: asyncpg.Connection) -> dict[str, tuple[int, str]]:
        out: dict[str, tuple[int, str]] = {}
        for table, order in _TABLES:
            # Table / column names are the constants above, never input.
            row = await conn.fetchrow(
                f"SELECT count(*) AS n, coalesce(md5(string_agg((to_jsonb(t){strip})::text, "
                f"'|' ORDER BY t.{order})), '') AS h FROM {table} t"
            )
            out[table] = (int(row["n"]), str(row["h"]))
        return out

    result: dict[str, tuple[int, str]] = _run(url, go)
    return result


def _scalar(url: str, sql: str) -> Any:
    return _run(url, lambda c: c.fetchval(sql))


async def _persist_one_run(url: str) -> None:
    """One persisted greedy run, so runs, run steps and outcomes are covered."""

    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            schedule_input = await build_schedule_input_from_db(db, current_week=TEST_WEEK)
            await persist_schedule_output(
                db,
                schedule_input,
                run_greedy_sgs(schedule_input),
                solver_type=SolverType.GREEDY,
                trigger_reason="test",
                activate=True,
            )
            await db.commit()
    finally:
        await engine.dispose()


@pytest.fixture(scope="module")
def monkeypatch_module() -> Any:
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def seeded_url(monkeypatch_module: pytest.MonkeyPatch) -> Any:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        monkeypatch_module.setenv("RPD_DATABASE_URL", url)
        seed = importlib.import_module("seed.seed_demo_data")
        importlib.reload(seed)
        counts = asyncio.run(seed.run(reset_first=False))
        assert counts["projects"] > 100
        asyncio.run(_persist_one_run(url))
        yield url


def test_p53a_changes_no_existing_row(seeded_url: str) -> None:
    url = seeded_url
    r = run_alembic(["downgrade", _BEFORE], url)
    assert r.returncode == 0, r.stderr
    before = _checksums(url)
    assert before["schedule_runs"][0] >= 1
    assert before["schedule_run_project_outcomes"][0] > 100
    assert before["project_workflow_steps"][0] > 100

    # --- upgrade: nothing existing changes ----------------------------------------
    r = run_alembic(["upgrade", _P53], url)
    assert r.returncode == 0, r.stderr
    assert _checksums(url) == before
    assert _scalar(url, "SELECT count(*) FROM schedule_runs WHERE rules_epoch IS NOT NULL") == 0
    assert (
        _scalar(
            url,
            "SELECT count(*) FROM schedule_run_project_outcomes "
            "WHERE priority_at_run IS NOT NULL OR left_out_reason IS NOT NULL",
        )
        == 0
    )
    assert _scalar(url, "SELECT scheduling_horizon_years FROM scheduling_settings") == 5

    # --- the two relaxed CHECKs accept the P53 values -------------------------------
    step_id = _scalar(
        url,
        "SELECT id FROM project_workflow_steps WHERE status = 'Not Started' "
        "AND manual_start_week IS NULL ORDER BY id LIMIT 1",
    )
    assert step_id is not None

    async def pin(conn: asyncpg.Connection) -> None:
        await conn.execute(
            "UPDATE project_workflow_steps SET manual_start_week = 60, manual_end_week = 70 "
            "WHERE id = $1",
            step_id,
        )

    _run(url, pin)
    with pytest.raises(asyncpg.CheckViolationError):

        async def bad(conn: asyncpg.Connection) -> None:
            await conn.execute(
                "UPDATE project_workflow_steps SET manual_start_week = 5, "
                "manual_end_week = 4 WHERE id = $1",
                step_id,
            )

        _run(url, bad)

    after_pin = _checksums(url)

    # --- downgrade: the post-upgrade rows stay, nothing else changes --------------
    r = run_alembic(["downgrade", _BEFORE], url)
    assert r.returncode == 0, r.stderr
    assert _checksums(url) == after_pin
    assert (
        _run(
            url,
            lambda c: c.fetchval(
                "SELECT manual_end_week FROM project_workflow_steps WHERE id = $1", step_id
            ),
        )
        == 70
    )
    # The restored pre-P53 CHECK is NOT VALID (existing rows are kept).
    assert (
        _scalar(
            url,
            "SELECT convalidated FROM pg_constraint "
            "WHERE conname = 'ck_project_workflow_steps_step_pin_range'",
        )
        is False
    )

    # Undo the test pin so the round trip leaves the seed as it was.
    async def unpin(conn: asyncpg.Connection) -> None:
        await conn.execute(
            "UPDATE project_workflow_steps SET manual_start_week = NULL, "
            "manual_end_week = NULL WHERE id = $1",
            step_id,
        )

    _run(url, unpin)
    assert _checksums(url) == before

    # P62: up to the revision before p71a, whose owner-approved data steps
    # change existing rows on purpose (checked by tests/test_p62_migration.py).
    r = run_alembic(["upgrade", "p70a_effort_weight_revive"], url)
    assert r.returncode == 0, r.stderr
    assert _checksums(url) == before
    r = run_alembic(["upgrade", "head"], url)
    assert r.returncode == 0, r.stderr
