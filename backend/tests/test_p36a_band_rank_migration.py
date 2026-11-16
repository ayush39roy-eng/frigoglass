"""P36-T03: migration `p36a_project_band_rank` (ADR 0050, R36-1, R36-8) in its
own container (real DDL and real commits: the unique constraint is deferred to
COMMIT, which the shared savepoint fixture never reaches).

- The client 2026 seed is loaded at head (its ranks come from the Python
  backfill rule, `services.band_rank.assign_default_band_ranks`), a few
  projects are VIP-pinned / frozen, a schedulable project loses its category
  and two live category ranks are swapped (R36-1(a): the live table, never
  the constant). Down to `p33a` (column and constraints gone; the later `p33b` goes too),
  up to head again: the
  SQL backfill equals the Python rule exactly, non-members are NULL, the
  uncategorised member is last in its band.
- Backfill identity (R36-1(e)): the `ScheduleInput` built from the DB after
  the migration, run through greedy, gives the identical outcomes and
  `scheduling_order` as the same input with every `band_rank` None (= the
  pre-P36 order), and CP-SAT's order (`prepare_run`, what it serves) is equal.
- Constraints: `band_rank >= 1`, the membership CHECK (immediate), and the
  deferred `(priority, band_rank)` unique (a transient duplicate inside one
  transaction commits once renumbered; a duplicate left at COMMIT fails).
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import pytest
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

from scheduling.greedy import prepare_run, run_greedy_sgs
from scheduling.invariants import check_i37b_band_ranks_dense
from scheduling.types import ScheduleInput
from services.band_rank import default_band_orders
from services.schedule_persistence import build_schedule_input_from_db
from tests._plan_week import TEST_WEEK
from tests.conftest import run_alembic

_BEFORE = "p33a_categories"
#: Upgrades go to "head": a later revision (`p33b_template_copy`) revises
#: p36a, and the ORM builder used for the identity check reads its columns.
_CONSTRAINTS = {
    "ck_projects_band_rank_positive",
    "ck_projects_band_rank_membership",
    "uq_projects_priority_band_rank",
}
_SCHEDULABLE = ("In Buyoff", "Under Industrialization", "In Development", "In Queue")


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


def _fetch(url: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    rows: list[asyncpg.Record] = _run(url, lambda c: c.fetch(sql, *args))
    return rows


def _ranks(url: str) -> dict[str, int | None]:
    return {
        str(r["id"]): r["band_rank"]
        for r in _fetch(url, "SELECT id, band_rank FROM projects ORDER BY id")
    }


def _constraint_names(url: str) -> set[str]:
    return {
        r["conname"]
        for r in _fetch(
            url,
            "SELECT conname FROM pg_constraint WHERE conrelid = 'projects'::regclass",
        )
    } & _CONSTRAINTS


def _has_column(url: str) -> bool:
    return bool(
        _fetch(
            url,
            "SELECT 1 FROM information_schema.columns "
            "WHERE table_name = 'projects' AND column_name = 'band_rank'",
        )
    )


async def _with_session(url: str, fn: Any) -> Any:
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            return await fn(session)
    finally:
        await engine.dispose()


def _python_rule(url: str) -> dict[str, int]:
    """The Python backfill rule on the live DB (what the seed / factories use)."""

    orders = asyncio.run(_with_session(url, default_band_orders))
    out: dict[str, int] = {}
    for order in orders.values():
        out.update({pid: i for i, pid in enumerate(order, start=1)})
    return out


def _schedule_input(url: str) -> ScheduleInput:
    result: ScheduleInput = asyncio.run(
        _with_session(
            url, lambda db: build_schedule_input_from_db(db, current_week=TEST_WEEK)
        )
    )
    return result


def _without_ranks(schedule_input: ScheduleInput) -> ScheduleInput:
    return dataclasses.replace(
        schedule_input,
        projects=tuple(dataclasses.replace(p, band_rank=None) for p in schedule_input.projects),
    )


def _drop(schedule_input: ScheduleInput, project_id: str) -> ScheduleInput:
    return dataclasses.replace(
        schedule_input,
        projects=tuple(p for p in schedule_input.projects if p.project_id != project_id),
    )


@pytest.fixture(scope="module")
def migrated_url(monkeypatch_module: pytest.MonkeyPatch) -> Any:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        monkeypatch_module.setenv("RPD_DATABASE_URL", url)
        seed = importlib.import_module("seed.seed_demo_data")
        importlib.reload(seed)
        counts = asyncio.run(seed.run(reset_first=False))
        assert counts["projects"] > 100
        yield url


@pytest.fixture(scope="module")
def monkeypatch_module() -> Any:
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


def _perturb(url: str) -> tuple[str, str]:
    """VIP pins and a frozen project spread over bands, two live category ranks
    swapped, and one schedulable banded project with no category. Returns the
    uncategorised project's id and band. Ranks are cleared and rewritten afterwards by
    the down/up cycle, so they need not stay consistent here beyond the CHECKs."""

    async def go(conn: asyncpg.Connection) -> tuple[str, str]:
        await conn.execute(
            "UPDATE projects SET is_vip = true WHERE id IN (SELECT id FROM projects "
            "WHERE priority IN ('P2', 'P3') AND status::text IN ('In Queue', 'In Development') "
            "ORDER BY id DESC LIMIT 4)"
        )
        async with conn.transaction():
            await conn.execute("SET CONSTRAINTS ALL DEFERRED")
            await conn.execute("UPDATE categories SET rank = 1000 WHERE code = 'A+'")
            await conn.execute(
                "UPDATE categories SET rank = (SELECT rank FROM categories WHERE code = 'C') "
                "WHERE code = 'A+'"
            )
            await conn.execute("UPDATE categories SET rank = 1 WHERE code = 'C'")
        row = await conn.fetchrow(
            "SELECT id, priority::text AS band FROM projects WHERE priority IS NOT NULL "
            "AND status::text IN ('In Queue', 'In Development') ORDER BY id LIMIT 1"
        )
        assert row is not None
        await conn.execute("UPDATE projects SET category = NULL WHERE id = $1", row["id"])
        return str(row["id"]), str(row["band"])

    result: tuple[str, str] = _run(url, go)
    return result


def test_p36a_backfill_down_up_and_identity(migrated_url: str) -> None:
    url = migrated_url
    # The seed ranked every band by the Python rule (R36-1(f)).
    seeded = _ranks(url)
    assert any(v is not None for v in seeded.values())
    assert seeded == {
        **dict.fromkeys(seeded),
        **_python_rule(url),
    }
    check_i37b_band_ranks_dense(_schedule_input(url).projects)

    uncategorised, uncategorised_band = _perturb(url)

    # --- down: column and constraints gone -------------------------------------
    r = run_alembic(["downgrade", _BEFORE], url)
    assert r.returncode == 0, r.stderr
    assert not _has_column(url)
    assert _constraint_names(url) == set()

    # --- up: the SQL backfill ----------------------------------------------------
    r = run_alembic(["upgrade", "head"], url)
    assert r.returncode == 0, r.stderr
    assert _constraint_names(url) == _CONSTRAINTS
    assert "ranked last in their band" in (r.stdout + r.stderr)
    migrated = _ranks(url)
    expected = _python_rule(url)  # live categories.rank, uncategorised last
    assert {pid: rank for pid, rank in migrated.items() if rank is not None} == expected
    members = {
        str(r["id"])
        for r in _fetch(
            url,
            "SELECT id FROM projects WHERE priority IS NOT NULL AND status::text = ANY($1)",
            list(_SCHEDULABLE),
        )
    }
    assert {pid for pid, rank in migrated.items() if rank is not None} == members
    band_size = _fetch(
        url,
        "SELECT count(*) AS n FROM projects WHERE band_rank IS NOT NULL "
        "AND priority::text = $1",
        uncategorised_band,
    )[0]["n"]
    assert migrated[uncategorised] == band_size
    # Non-members (On Hold / Cancelled / Commercialized / Draft / no priority)
    # stay NULL and exist in the seed.
    assert any(rank is None for rank in migrated.values())

    # --- identity (R36-1(e)) -----------------------------------------------------
    ranked = _drop(_schedule_input(url), uncategorised)  # cannot run (no category)
    unranked = _without_ranks(ranked)
    assert any(p.band_rank is not None for p in ranked.projects)
    assert any(p.is_vip for p in ranked.projects)
    out_ranked, out_unranked = run_greedy_sgs(ranked), run_greedy_sgs(unranked)
    assert out_ranked.scheduling_order == out_unranked.scheduling_order
    assert out_ranked.project_outcomes == out_unranked.project_outcomes
    # CP-SAT serves `prepare_run(...).ordered` as its scheduling order (R36-4).
    assert [p.project_id for p in prepare_run(ranked).ordered] == [
        p.project_id for p in prepare_run(unranked).ordered
    ]

    # --- down / up again: the same ranks -------------------------------------------
    r = run_alembic(["downgrade", _BEFORE], url)
    assert r.returncode == 0, r.stderr
    r = run_alembic(["upgrade", "head"], url)
    assert r.returncode == 0, r.stderr
    assert _ranks(url) == migrated


def test_p36a_constraints(migrated_url: str) -> None:
    url = migrated_url
    row = _fetch(
        url,
        "SELECT id, priority::text AS p FROM projects WHERE band_rank = 1 AND priority = 'P2'",
    )[0]
    pid, other = (
        row["id"],
        _fetch(url, "SELECT id FROM projects WHERE band_rank = 2 AND priority = 'P2'")[0]["id"],
    )

    async def positive(conn: asyncpg.Connection) -> str:
        try:
            await conn.execute("UPDATE projects SET band_rank = 0 WHERE id = $1", pid)
        except asyncpg.CheckViolationError as exc:
            return str(exc.constraint_name)
        return "accepted"

    async def membership_null(conn: asyncpg.Connection) -> str:
        try:
            await conn.execute("UPDATE projects SET band_rank = NULL WHERE id = $1", pid)
        except asyncpg.CheckViolationError as exc:
            return str(exc.constraint_name)
        return "accepted"

    async def membership_on_hold(conn: asyncpg.Connection) -> str:
        try:
            await conn.execute(
                "UPDATE projects SET status = 'On Hold'::project_status WHERE id = $1", pid
            )
        except asyncpg.CheckViolationError as exc:
            return str(exc.constraint_name)
        return "accepted"

    assert _run(url, positive) == "ck_projects_band_rank_positive"
    assert _run(url, membership_null) == "ck_projects_band_rank_membership"
    assert _run(url, membership_on_hold) == "ck_projects_band_rank_membership"

    async def swap(conn: asyncpg.Connection) -> None:
        # A transient duplicate inside one transaction is fine (deferred).
        async with conn.transaction():
            await conn.execute("UPDATE projects SET band_rank = 2 WHERE id = $1", pid)
            await conn.execute("UPDATE projects SET band_rank = 1 WHERE id = $1", other)

    _run(url, swap)
    assert _fetch(url, "SELECT band_rank FROM projects WHERE id = $1", pid)[0]["band_rank"] == 2

    async def duplicate(conn: asyncpg.Connection) -> str:
        try:
            async with conn.transaction():
                await conn.execute("UPDATE projects SET band_rank = 1 WHERE id = $1", pid)
        except asyncpg.UniqueViolationError as exc:
            return str(exc.constraint_name)
        return "accepted"

    assert _run(url, duplicate) == "uq_projects_priority_band_rank"
    # NULL ranks never collide (non-members, every band).
    assert _fetch(url, "SELECT count(*) AS n FROM projects WHERE band_rank IS NULL")[0]["n"] > 1
