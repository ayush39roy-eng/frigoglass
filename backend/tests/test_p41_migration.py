"""P41-T02: migration `p41a_import_format_and_scenarios` up / down / up (ADR 0055).

Own throwaway Postgres (it runs real DDL). Checks the two tables, the
single-row CHECK, the indexes and a clean downgrade.
"""

from __future__ import annotations

import asyncio
from typing import Any

import asyncpg  # type: ignore[import-untyped]
import pytest
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

_BEFORE = "p33c_clear_step_timing"
_REV = "p41a_import_format_and_scenarios"


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


def _tables(url: str) -> set[str]:
    rows = _run(
        url,
        lambda c: c.fetch(
            "SELECT table_name FROM information_schema.tables WHERE table_name = ANY($1::text[])",
            ["import_format_settings", "whatif_import_scenarios"],
        ),
    )
    return {r["table_name"] for r in rows}


def test_p41a_up_down_up() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        assert _tables(url) == set()
        r = run_alembic(["upgrade", _REV], url)
        assert r.returncode == 0, r.stderr
        assert _tables(url) == {"import_format_settings", "whatif_import_scenarios"}
        # No row: the built-in default.
        count = _run(url, lambda c: c.fetchval("SELECT count(*) FROM import_format_settings"))
        assert count == 0
        _run(
            url,
            lambda c: c.execute(
                "INSERT INTO import_format_settings (id, version, field_aliases) "
                "VALUES (1, 1, '{}'::jsonb)"
            ),
        )
        with pytest.raises(asyncpg.CheckViolationError):
            _run(
                url,
                lambda c: c.execute(
                    "INSERT INTO import_format_settings (id, version, field_aliases) "
                    "VALUES (2, 1, '{}'::jsonb)"
                ),
            )
        indexes = _run(
            url,
            lambda c: c.fetch(
                "SELECT indexname FROM pg_indexes WHERE tablename = 'whatif_import_scenarios'"
            ),
        )
        assert {
            "ix_whatif_import_scenarios_created_by",
            "ix_whatif_import_scenarios_source_file_sha256",
            "ix_whatif_import_scenarios_created_at",
        } <= {i["indexname"] for i in indexes}
        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        assert _tables(url) == set()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        assert _tables(url) == {"import_format_settings", "whatif_import_scenarios"}
