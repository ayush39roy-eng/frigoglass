"""Scenario #1 — the migration up/down/up-again cycle, as an actual
repeatable pytest test rather than a memory of P1-T02's manual Docker
verification.

Spins up its own dedicated, throwaway Postgres 17 container (not the shared
session-scoped one in `tests/conftest.py`) because this test needs to run
real DDL (`alembic downgrade base`, which drops every table/type) — reusing
the shared container would break every other test module's assumption that
the schema is present and stable for the whole session.

`alembic upgrade head` / `alembic downgrade base` walk the *entire* chain,
which as of P1-T07 is two revisions (`419f196fd00b` initial schema, then
`ba3881d85b55` adding the audit-log TRUNCATE-protection trigger) — this test
was written against a single-revision chain but needs no changes to keep
covering both, since "head"/"base" are chain-relative, not
revision-count-relative. The trigger-name assertions below were extended to
cover both audit-log triggers once the second revision landed mid-session
(see `docs/MEMORY.md` P1-T06/P1-T07 entries).

P5-T02 note: a third revision (`7b540c00cea8`, adding `scenario_apply_runs`/
`scenario_apply_changes` + the `scenario_entity_type` enum) landed the same
way — `EXPECTED_TABLE_COUNT`/`EXPECTED_ENUM_TYPES` below updated accordingly,
same "chain-relative, not revision-count-relative" reasoning.

P5-T04 note: a fourth revision (`d113ff5e8e17`, adding `export_jobs` +
the `export_surface`/`export_format`/`export_job_status` enums) landed the
same way — `EXPECTED_TABLE_COUNT`/`EXPECTED_ENUM_TYPES` below updated
accordingly, same reasoning again.

P5-T06 note: a fifth revision (`2418c6385a72`, adding `notifications` + the
`notification_reason` enum) landed the same way —
`EXPECTED_TABLE_COUNT`/`EXPECTED_ENUM_TYPES` below updated accordingly, same
reasoning again.
"""

from __future__ import annotations

import asyncio

import asyncpg
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

# All 22 app tables from backend/models/__init__.py (20 + P5-T04's
# export_jobs + P5-T06's notifications), plus `alembic_version`.
EXPECTED_TABLE_COUNT = 23

EXPECTED_ENUM_TYPES = {
    "lab_region",
    "hub_name",
    "workflow_step_kind",
    "currency_code",
    "engineer_allowed_category",
    "solver_type",
    "schedule_run_status",
    "project_category",
    "project_type",
    "project_status",
    "project_priority",
    "hard_gate_reason",
    "scenario_entity_type",
    "export_surface",
    "export_format",
    "export_job_status",
    "notification_reason",
}


def _asyncpg_dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


def _query_scalar(url: str, sql: str):
    async def _run():
        conn = await asyncpg.connect(_asyncpg_dsn(url))
        try:
            return await conn.fetchval(sql)
        finally:
            await conn.close()

    return asyncio.run(_run())


def _query_all(url: str, sql: str):
    async def _run():
        conn = await asyncpg.connect(_asyncpg_dsn(url))
        try:
            return [r[0] for r in await conn.fetch(sql)]
        finally:
            await conn.close()

    return asyncio.run(_run())


def _table_count(url: str) -> int:
    return _query_scalar(
        url, "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'"
    )


def _enum_type_names(url: str) -> set[str]:
    return set(_query_all(url, "SELECT typname FROM pg_type WHERE typtype='e'"))


def _index_names(url: str) -> set[str]:
    return set(_query_all(url, "SELECT indexname FROM pg_indexes WHERE schemaname='public'"))


def _trigger_names(url: str) -> set[str]:
    return set(
        _query_all(
            url,
            "SELECT tgname FROM pg_trigger WHERE NOT tgisinternal",
        )
    )


def test_migration_up_down_up_down_cycle():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()

        # --- upgrade #1 -----------------------------------------------------
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"upgrade head (1st) failed:\n{r.stdout}\n{r.stderr}"
        assert _table_count(url) == EXPECTED_TABLE_COUNT
        assert _enum_type_names(url) == EXPECTED_ENUM_TYPES
        assert "ux_schedule_runs_one_active" in _index_names(url)
        assert "ux_priority_application_runs_one_active" in _index_names(url)
        assert "trg_audit_log_entries_append_only" in _trigger_names(url)
        assert "trg_audit_log_entries_append_only_truncate" in _trigger_names(url)

        # --- downgrade #1 -----------------------------------------------------
        r = run_alembic(["downgrade", "base"], url)
        assert r.returncode == 0, f"downgrade base (1st) failed:\n{r.stdout}\n{r.stderr}"
        # Only alembic_version itself remains (standard Alembic behaviour —
        # the bookkeeping table is not expected to be dropped by downgrade).
        assert _table_count(url) == 1
        assert _enum_type_names(url) == set()
        assert "ux_schedule_runs_one_active" not in _index_names(url)
        assert "ux_priority_application_runs_one_active" not in _index_names(url)
        assert "trg_audit_log_entries_append_only" not in _trigger_names(url)
        assert "trg_audit_log_entries_append_only_truncate" not in _trigger_names(url)

        # --- upgrade #2 (the "up-again" — catches anything that only breaks
        # on a second pass, e.g. leftover enum types blocking CREATE TYPE) ---
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"upgrade head (2nd) failed:\n{r.stdout}\n{r.stderr}"
        assert _table_count(url) == EXPECTED_TABLE_COUNT
        assert _enum_type_names(url) == EXPECTED_ENUM_TYPES
        assert "ux_schedule_runs_one_active" in _index_names(url)
        assert "ux_priority_application_runs_one_active" in _index_names(url)
        assert "trg_audit_log_entries_append_only" in _trigger_names(url)
        assert "trg_audit_log_entries_append_only_truncate" in _trigger_names(url)

        # --- downgrade #2 (repeat once more, per the task's "up/down/up-again"
        # wording — confirms determinism/idempotency of the whole cycle) -----
        r = run_alembic(["downgrade", "base"], url)
        assert r.returncode == 0, f"downgrade base (2nd) failed:\n{r.stdout}\n{r.stderr}"
        assert _table_count(url) == 1
        assert _enum_type_names(url) == set()
