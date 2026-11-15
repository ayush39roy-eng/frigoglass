"""P33-T07: migration `p33a_categories` (ADR 0047) up / down / up, in its own
container (real DDL, like `tests/test_p32_migration.py`).

Up: the `categories` table is seeded with the seven codes at ranks 1..7;
`projects.category`, `workflow_lead_times.category` and
`engineers.allowed_categories` become `text` / `text[]` with every stored
value preserved; the two enum types are gone; the triggers are in place.
Down: refused while a non-seeded category is in use (nothing changes); once
it is gone, the enums, the enum-typed columns and the P9 trigger body come
back with every value preserved. Up again: the same facts.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import asyncpg  # type: ignore[import-untyped]
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

_BEFORE = "p35a_project_actual_end_week"
_HEAD = "p33a_categories"
_SEED = ["A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM"]


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


def _version(url: str) -> str:
    return str(_fetch(url, "SELECT version_num FROM alembic_version")[0]["version_num"])


def _values(url: str) -> dict[str, Any]:
    """Every category value, as text, in a stable order."""

    return {
        "projects": [
            (r["name"], r["c"])
            for r in _fetch(url, "SELECT name, category::text AS c FROM projects ORDER BY name")
        ],
        "engineers": [
            (r["name"], r["c"])
            for r in _fetch(
                url, "SELECT name, allowed_categories::text[] AS c FROM engineers ORDER BY name"
            )
        ],
        "lead_times": [
            tuple(r)
            for r in _fetch(
                url,
                "SELECT workflow_id, category::text, step_id, weeks FROM workflow_lead_times "
                "ORDER BY 1, 2, 3",
            )
        ],
    }


def _types(url: str) -> dict[str, str]:
    return {
        f"{r['t']}.{r['c']}": r["u"]
        for r in _fetch(
            url,
            "SELECT table_name AS t, column_name AS c, udt_name AS u FROM "
            "information_schema.columns WHERE (table_name, column_name) IN "
            "(('projects', 'category'), ('workflow_lead_times', 'category'), "
            "('engineers', 'allowed_categories'))",
        )
    }


def _enums(url: str) -> set[str]:
    return {
        r["typname"]
        for r in _fetch(
            url,
            "SELECT typname FROM pg_type WHERE typname IN "
            "('project_category', 'engineer_allowed_category')",
        )
    }


def _triggers(url: str) -> set[str]:
    return {
        r["tgname"]
        for r in _fetch(
            url,
            "SELECT tgname FROM pg_trigger WHERE tgname IN "
            "('trg_projects_category_matches_hub', 'trg_engineers_allowed_categories_known')",
        )
    }


def _load(url: str) -> None:
    async def go(conn: asyncpg.Connection) -> None:
        pdd, oem = uuid.uuid4(), uuid.uuid4()
        await conn.execute(
            "INSERT INTO hubs (id, name, lab_region, is_oem) "
            "VALUES ($1, 'R&D-Greece'::hub_name, 'Greece'::lab_region, false)",
            pdd,
        )
        await conn.execute(
            "INSERT INTO hubs (id, name, lab_region, is_oem, capacity_hub_id) "
            "VALUES ($1, 'OEM-HCK'::hub_name, 'India'::lab_region, true, $2)",
            oem,
            pdd,
        )
        for name, cats in (
            ("E1", ["A+", "B", "OEM"]),
            ("E2", ["C", "B-OEM", "A-OEM"]),
            ("E3", []),
        ):
            await conn.execute(
                "INSERT INTO engineers (id, name, hub_id, fte, allowed_categories) "
                "VALUES ($1, $2, $3, 1.0, $4::text[]::engineer_allowed_category[])",
                uuid.uuid4(),
                name,
                pdd,
                cats,
            )
        for name, hub, cat in (
            ("P1", pdd, "A+"),
            ("P2", pdd, "C"),
            ("P3", oem, "B-OEM"),
            ("P4", pdd, None),
        ):
            await conn.execute(
                "INSERT INTO projects (id, name, hub_id, category, status, frozen, delay_weeks, "
                "carry_over, priority, schedule_stale) VALUES ($1, $2, $3, "
                "$4::text::project_category, 'In Queue'::project_status, false, 0, false, "
                "'P2'::project_priority, false)",
                uuid.uuid4(),
                name,
                hub,
                cat,
            )

    _run(url, go)


def _assert_upgraded(url: str, before: dict[str, Any]) -> None:
    assert _version(url) == _HEAD
    assert _values(url) == before
    assert _types(url) == {
        "projects.category": "text",
        "workflow_lead_times.category": "text",
        "engineers.allowed_categories": "_text",
    }
    assert _enums(url) == set()
    assert _triggers(url) == {
        "trg_projects_category_matches_hub",
        "trg_engineers_allowed_categories_known",
    }
    rows = _fetch(url, "SELECT code, label, workflow_id, rank FROM categories ORDER BY rank")
    assert [tuple(r) for r in rows] == [
        (c, c, "OEM" if c.endswith("-OEM") else "PDD", i) for i, c in enumerate(_SEED, start=1)
    ]


def _assert_downgraded(url: str, before: dict[str, Any]) -> None:
    assert _version(url) == _BEFORE
    assert _values(url) == before
    assert _types(url) == {
        "projects.category": "project_category",
        "workflow_lead_times.category": "project_category",
        "engineers.allowed_categories": "_engineer_allowed_category",
    }
    assert _enums(url) == {"project_category", "engineer_allowed_category"}
    assert _triggers(url) == {"trg_projects_category_matches_hub"}
    assert not _fetch(url, "SELECT 1 FROM pg_class WHERE relname = 'categories'")
    labels = [
        r["enumlabel"]
        for r in _fetch(
            url,
            "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
            "WHERE t.typname = 'engineer_allowed_category' ORDER BY e.enumsortorder",
        )
    ]
    assert labels == ["A+", "A", "B", "C", "OEM", "A-OEM", "B-OEM", "C-OEM"]


def test_p33a_up_down_up_preserves_every_value() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        _load(url)
        before = _values(url)
        assert len(before["lead_times"]) == 98

        r = run_alembic(["upgrade", _HEAD], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, before)

        # The rewritten hub trigger keeps the P9 behaviour on the seeded codes.
        async def mismatch(conn: asyncpg.Connection) -> str:
            hub = await conn.fetchval("SELECT id FROM hubs WHERE NOT is_oem")
            try:
                await conn.execute(
                    "INSERT INTO projects (id, name, hub_id, category, status, frozen, "
                    "delay_weeks, carry_over, schedule_stale) VALUES ($1, 'bad', $2, 'A-OEM', "
                    "'In Queue'::project_status, false, 0, false, false)",
                    uuid.uuid4(),
                    hub,
                )
            except asyncpg.CheckViolationError as exc:
                return str(exc.constraint_name)
            return "accepted"

        assert _run(url, mismatch) == "ck_projects_category_matches_hub"

        # A non-seeded category in use: the downgrade refuses and changes nothing.
        async def add_b2(conn: asyncpg.Connection) -> None:
            await conn.execute(
                "INSERT INTO categories (code, label, workflow_id, rank) "
                "VALUES ('B2', 'B2', 'PDD', 8)"
            )
            await conn.execute(
                "INSERT INTO workflow_lead_times (workflow_id, category, step_id, weeks) "
                "SELECT workflow_id, 'B2', step_id, weeks FROM workflow_lead_times "
                "WHERE category = 'B'"
            )

        _run(url, add_b2)
        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode != 0
        assert "downgrade refused" in (r.stdout + r.stderr)
        assert _version(url) == _HEAD
        assert _fetch(url, "SELECT count(*) AS n FROM categories")[0]["n"] == 8

        async def drop_b2(conn: asyncpg.Connection) -> None:
            await conn.execute("DELETE FROM workflow_lead_times WHERE category = 'B2'")
            await conn.execute("DELETE FROM categories WHERE code = 'B2'")

        _run(url, drop_b2)
        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        _assert_downgraded(url, before)

        r = run_alembic(["upgrade", _HEAD], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, before)
