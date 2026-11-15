"""P33-T08: migration `p33b_template_copy` (ADR 0046 §A/§B) up / down / up, in
its own container (real DDL, like `tests/test_p33a_migration.py`).

Up: `template_changes` exists; every template row gets `gap_weeks = 0` and
`effort_weight_weeks = weeks`; every project step gets `plan_weeks` = the
table in force for its project's workflow and category (0 without a
category) and `plan_gap_weeks = 0`; every pre-existing value is unchanged;
the weights are immutable. Down: the columns, the trigger and the table are
gone and every other value is unchanged. Up again: the same facts.
"""

from __future__ import annotations

import asyncio
import uuid
from typing import Any

import asyncpg  # type: ignore[import-untyped]
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

_BEFORE = "p36a_project_band_rank"
_HEAD = "p33b_template_copy"


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
    """Every pre-p33b value of the two touched tables, in a stable order."""

    return {
        "lead_times": [
            tuple(r)
            for r in _fetch(
                url,
                "SELECT workflow_id, category, step_id, weeks FROM workflow_lead_times "
                "ORDER BY 1, 2, 3",
            )
        ],
        "steps": [
            tuple(r)
            for r in _fetch(
                url,
                "SELECT p.name, s.step_template_id, s.duration_weeks, s.effort_weeks, "
                "s.duration_override_weeks, s.overlap_weeks, s.status::text "
                "FROM project_workflow_steps s JOIN projects p ON p.id = s.project_id "
                "ORDER BY 1, 2",
            )
        ],
    }


def _columns(url: str) -> set[str]:
    return {
        f"{r['t']}.{r['c']}"
        for r in _fetch(
            url,
            "SELECT table_name AS t, column_name AS c FROM information_schema.columns "
            "WHERE (table_name, column_name) IN (('workflow_lead_times', 'gap_weeks'), "
            "('workflow_lead_times', 'effort_weight_weeks'), "
            "('project_workflow_steps', 'plan_weeks'), "
            "('project_workflow_steps', 'plan_gap_weeks'), "
            "('project_workflow_steps', 'template_change_id'))",
        )
    }


def _has_table(url: str) -> bool:
    return bool(_fetch(url, "SELECT 1 FROM pg_class WHERE relname = 'template_changes'"))


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
        for name, hub, cat, wf in (
            ("P1", pdd, "A+", "PDD"),
            ("P2", pdd, "B", "PDD"),
            ("P3", oem, "B-OEM", "OEM"),
            ("P4", pdd, None, "PDD"),
        ):
            pid = uuid.uuid4()
            # On Hold without a priority: not a P36 band member (no band_rank).
            await conn.execute(
                "INSERT INTO projects (id, name, hub_id, category, status, frozen, delay_weeks, "
                "carry_over, schedule_stale) VALUES ($1, $2, $3, $4, 'On Hold'::project_status, "
                "false, 0, false, false)",
                pid,
                name,
                hub,
                cat,
            )
            for seq, letter in enumerate("ABCDEFGHIJKLMN", start=1):
                # A stale `duration_weeks` (99) on P2's E: the backfill reads
                # the table, as the live builder does, not this mirror.
                await conn.execute(
                    "INSERT INTO project_workflow_steps (id, project_id, step_template_id, "
                    "sequence_order, duration_weeks, effort_weeks, status, percent_complete, "
                    "eng_conflict, chamber_overlap) VALUES ($1, $2, $3, $4, $5, $6, "
                    "'Not Started', 0, false, false)",
                    uuid.uuid4(),
                    pid,
                    f"{wf}-{letter}",
                    seq,
                    99 if (name, letter) == ("P2", "E") else 0,
                    2 if (name, letter) == ("P2", "E") else None,
                )

    _run(url, go)


def _assert_upgraded(url: str, before: dict[str, Any]) -> None:
    assert _version(url) == _HEAD
    assert _values(url) == before
    assert _has_table(url)
    assert len(_columns(url)) == 5
    bad = _fetch(
        url,
        "SELECT count(*) AS n FROM workflow_lead_times "
        "WHERE gap_weeks <> 0 OR effort_weight_weeks <> weeks",
    )
    assert bad[0]["n"] == 0
    copies = {
        (r["name"], r["step_template_id"]): (r["plan_weeks"], r["plan_gap_weeks"], r["want"])
        for r in _fetch(
            url,
            "SELECT p.name, s.step_template_id, s.plan_weeks, s.plan_gap_weeks, "
            "COALESCE(lt.weeks, 0) AS want "
            "FROM project_workflow_steps s JOIN projects p ON p.id = s.project_id "
            "JOIN hubs h ON h.id = p.hub_id LEFT JOIN workflow_lead_times lt "
            "ON lt.category = p.category AND lt.step_id = s.step_template_id "
            "AND lt.workflow_id = CASE WHEN h.is_oem THEN 'OEM' ELSE 'PDD' END",
        )
    }
    assert len(copies) == 56
    assert all(plan == want and gap == 0 for plan, gap, want in copies.values())
    assert copies[("P2", "PDD-E")][0] == 4  # the table, not the stale mirror
    assert copies[("P1", "PDD-B")][0] == 8
    assert copies[("P3", "OEM-H")][0] == 6
    assert all(v[0] == 0 for (name, _), v in copies.items() if name == "P4")

    async def change_weight(conn: asyncpg.Connection) -> str:
        try:
            await conn.execute(
                "UPDATE workflow_lead_times SET effort_weight_weeks = 9 "
                "WHERE workflow_id = 'PDD' AND category = 'B' AND step_id = 'PDD-E'"
            )
        except asyncpg.CheckViolationError as exc:
            return str(exc.constraint_name)
        return "accepted"

    assert _run(url, change_weight) == "ck_workflow_lead_times_effort_weight_immutable"


def test_p33b_up_down_up_preserves_every_value() -> None:
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

        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        assert _version(url) == _BEFORE
        assert _values(url) == before
        assert _columns(url) == set()
        assert not _has_table(url)
        assert not _fetch(
            url,
            "SELECT 1 FROM pg_trigger WHERE tgname = 'trg_workflow_lead_times_effort_weight'",
        )

        r = run_alembic(["upgrade", _HEAD], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, before)
