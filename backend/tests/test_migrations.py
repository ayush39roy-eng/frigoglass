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

P9-T01 note: a sixth revision (`5c9e1f2a7b3d`) adds five tables, two enums,
recreates four existing enums with new labels, seeds the workflow reference
data and adds two triggers — `EXPECTED_TABLE_COUNT`/`EXPECTED_ENUM_TYPES`/
`P9_TRIGGERS` updated; the cycle below additionally walks `downgrade -1`
(just that revision) before the full `downgrade base`, since its downgrade is
the first in this chain that has to map *data* back (OEM categories, the
`elapsed` kind, Cancelled) before an enum can be recreated.

P10-T01 note: a ninth revision (`d451acccb1ab`) adds `project_access_grants`
(+ the `project_access_role` enum) and `users.manager_id` — one new table, no
new triggers — `EXPECTED_TABLE_COUNT`/`EXPECTED_ENUM_TYPES` updated
accordingly; the P9-T01 downgrade-midpoint check below (`2418c6385a72`) now
subtracts 6, not 5, since that downgrade also undoes this revision (it is
after `2418c6385a72` in the chain too) — the absolute table count at that
older revision is unchanged (23), only the offset from the new head total.
"""

from __future__ import annotations

import asyncio

import asyncpg
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

# All 28 app tables from backend/models/__init__.py (20 + P5-T04's
# export_jobs + P5-T06's notifications + P9-T01's workflows,
# workflow_lead_times, hub_work_calendars, project_files, project_comments +
# P10-T01's project_access_grants), plus `alembic_version`.
EXPECTED_TABLE_COUNT = 29

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
    # P9-T01 (`5c9e1f2a7b3d`): per-stage progress status + workspace file category.
    "workflow_step_status",
    "project_file_category",
    # P10-T01 (`d451acccb1ab`): project-level access grant role.
    "project_access_role",
}

# P9-T01: the OEM-category-matches-hub guard on `projects` and the
# never-hard-delete guard on `project_comments`, both plain triggers like the
# audit-log ones — must appear after upgrade and vanish after downgrade.
P9_TRIGGERS = ("trg_projects_category_matches_hub", "trg_project_comments_no_delete")


_STAGE_BLOCKED_SQL = (
    "SELECT count(*) FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
    "WHERE t.typname = 'notification_reason' AND e.enumlabel = 'stage_blocked'"
)
_SOLVER_STATUS_SQL = (
    "SELECT count(*) FROM information_schema.columns "
    "WHERE table_name = 'schedule_runs' AND column_name = 'solver_status'"
)
_RUN_ID_NULLABLE_SQL = (
    "SELECT is_nullable FROM information_schema.columns "
    "WHERE table_name = 'notifications' AND column_name = 'schedule_run_id'"
)
_MANAGER_ID_COLUMN_SQL = (
    "SELECT count(*) FROM information_schema.columns "
    "WHERE table_name = 'users' AND column_name = 'manager_id'"
)
_ACCESS_GRANTS_TABLE_SQL = (
    "SELECT count(*) FROM information_schema.tables "
    "WHERE table_name = 'project_access_grants'"
)


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
        assert set(P9_TRIGGERS) <= _trigger_names(url)

        # --- P10-T01 (`d451acccb1ab`, new head): project_access_grants +
        # users.manager_id; downgrade just it, then re-apply. This must run
        # BEFORE the P9-R02 `downgrade -1` block below, since "-1" is
        # chain-relative to whatever the CURRENT head is — this revision is
        # now that head.
        assert _query_scalar(url, _ACCESS_GRANTS_TABLE_SQL) == 1
        assert _query_scalar(url, _MANAGER_ID_COLUMN_SQL) == 1
        r = run_alembic(["downgrade", "-1"], url)
        assert r.returncode == 0, f"downgrade -1 (P10-T01) failed:\n{r.stdout}\n{r.stderr}"
        assert _query_scalar(url, _ACCESS_GRANTS_TABLE_SQL) == 0
        assert _query_scalar(url, _MANAGER_ID_COLUMN_SQL) == 0
        assert _table_count(url) == EXPECTED_TABLE_COUNT - 1
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"upgrade head after P10-T01 -1 failed:\n{r.stderr}"
        assert _query_scalar(url, _ACCESS_GRANTS_TABLE_SQL) == 1
        assert _query_scalar(url, _MANAGER_ID_COLUMN_SQL) == 1

        # --- P9-R02 (`c41f7e9a2b58`, formerly head): solver_status column +
        # comments TRUNCATE guard; downgrade just it, then re-apply.
        # Explicit target (not "-1": that is chain-relative to head, which is
        # now P10-T01's `d451acccb1ab`, not this revision any more).
        assert _query_scalar(url, _SOLVER_STATUS_SQL) == 1
        assert "trg_project_comments_no_truncate" in _trigger_names(url)
        r = run_alembic(["downgrade", "8e2d4b6a1c90"], url)
        assert r.returncode == 0, (
            f"downgrade to 8e2d4b6a1c90 (P9-R02) failed:\n{r.stdout}\n{r.stderr}"
        )
        assert _query_scalar(url, _SOLVER_STATUS_SQL) == 0
        assert "trg_project_comments_no_truncate" not in _trigger_names(url)
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"upgrade head after P9-R02 -1 failed:\n{r.stderr}"

        # --- P9-T03 follow-up (`8e2d4b6a1c90`): downgrade to just before it
        # (this also undoes P9-R02 AND P10-T01, both table-count-neutral
        # except P10-T01 itself, which removes `project_access_grants`) —
        # the `stage_blocked` label goes, schedule_run_id is NOT NULL again —
        # then re-apply.
        assert _query_scalar(url, _STAGE_BLOCKED_SQL) == 1
        assert _query_scalar(url, _RUN_ID_NULLABLE_SQL) == "YES"
        r = run_alembic(["downgrade", "5c9e1f2a7b3d"], url)
        assert r.returncode == 0, f"downgrade to 5c9e1f2a7b3d failed:\n{r.stdout}\n{r.stderr}"
        assert _query_scalar(url, _STAGE_BLOCKED_SQL) == 0
        assert _query_scalar(url, _RUN_ID_NULLABLE_SQL) == "NO"
        assert _table_count(url) == EXPECTED_TABLE_COUNT - 1
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"upgrade head after P9-T03 -1 failed:\n{r.stdout}\n{r.stderr}"
        assert _query_scalar(url, _STAGE_BLOCKED_SQL) == 1

        # --- P9-T01: downgrade to just before `5c9e1f2a7b3d`, then re-apply --
        r = run_alembic(["downgrade", "2418c6385a72"], url)
        assert r.returncode == 0, f"downgrade to 2418c6385a72 failed:\n{r.stdout}\n{r.stderr}"
        assert _table_count(url) == EXPECTED_TABLE_COUNT - 6
        assert not (set(P9_TRIGGERS) & _trigger_names(url))
        assert "workflow_step_status" not in _enum_type_names(url)
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, f"upgrade head after -1 failed:\n{r.stdout}\n{r.stderr}"
        assert _table_count(url) == EXPECTED_TABLE_COUNT
        assert set(P9_TRIGGERS) <= _trigger_names(url)

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
