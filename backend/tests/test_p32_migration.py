"""P32-T03: migration `p32a_step_overlap` (ADR 0043) up / down / up, in its
own container (real DDL, like `tests/test_p30_migration.py`).

Up: `project_workflow_steps.overlap_weeks` exists as a nullable SMALLINT with
CHECK 1..104 (the CHECK's behaviour on real rows is in
`tests/test_p32_step_overlap.py`, against the migrated shared schema). Down: the column and
its CHECK are gone and `alembic_version` is `p30a_effort_types_hub_rename`.
Up again: the same facts.
"""

from __future__ import annotations

import asyncio
from typing import Any

import asyncpg
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

_CHECK = "ck_project_workflow_steps_overlap_weeks_range"


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _fetch(url: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    async def run() -> list[asyncpg.Record]:
        conn = await asyncpg.connect(_dsn(url))
        try:
            return await conn.fetch(sql, *args)
        finally:
            await conn.close()

    return asyncio.run(run())


def _column(url: str) -> list[asyncpg.Record]:
    return _fetch(
        url,
        "SELECT data_type, is_nullable FROM information_schema.columns "
        "WHERE table_name = 'project_workflow_steps' AND column_name = 'overlap_weeks'",
    )


def _check_exists(url: str) -> bool:
    return bool(_fetch(url, "SELECT 1 FROM pg_constraint WHERE conname = $1", _CHECK))


def _version(url: str) -> str:
    return _fetch(url, "SELECT version_num FROM alembic_version")[0]["version_num"]


def _assert_check_definition(url: str) -> None:
    definition = _fetch(
        url, "SELECT pg_get_constraintdef(oid) AS d FROM pg_constraint WHERE conname = $1", _CHECK
    )[0]["d"]
    assert "overlap_weeks IS NULL" in definition
    assert ">= 1" in definition and "<= 104" in definition


def _assert_upgraded(url: str) -> None:
    assert _version(url) == "p32a_step_overlap"
    (col,) = _column(url)
    assert (col["data_type"], col["is_nullable"]) == ("smallint", "YES")
    assert _check_exists(url)
    _assert_check_definition(url)


def test_p32a_up_down_up() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p30a_effort_types_hub_rename"], url)
        assert r.returncode == 0, r.stderr
        assert _column(url) == []

        r = run_alembic(["upgrade", "p32a_step_overlap"], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url)

        r = run_alembic(["downgrade", "p30a_effort_types_hub_rename"], url)
        assert r.returncode == 0, r.stderr
        assert _version(url) == "p30a_effort_types_hub_rename"
        assert _column(url) == []
        assert not _check_exists(url)

        r = run_alembic(["upgrade", "p32a_step_overlap"], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url)
