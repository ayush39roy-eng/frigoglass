"""P33-T13: migration `p33c_clear_step_timing` (ADR 0048 §3) up / down / up, in
its own container (real DDL, like `tests/test_p33b_migration.py`).

The fixture mirrors the live data the owner counted (ADR 0048 Context; dev DB
2026-11-15): 4 projects, 5 step rows, 7 hand-set values — 2
`duration_override_weeks`, 3 `start_not_before_week`, 2 `overlap_weeks` —
plus a fifth project with none.

Up: every value is null; exactly 4 `project.step_timing_cleared` audit rows
(actor NULL, before = the stored values per step, after = nulls, reason
"ADR 0048"); exactly the 4 projects are stale; every other column is
unchanged; the CHECK rejects a write of each field. Down: the CHECK is gone
and the 7 values are back. Up again: the same facts (4 more audit rows: the
log is append-only).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import asyncpg  # type: ignore[import-untyped]
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic

_BEFORE = "p33b_template_copy"
_HEAD = "p33c_clear_step_timing"
_CHECK = "ck_project_workflow_steps_step_timing_retired"
_FIELDS = ("duration_override_weeks", "start_not_before_week", "overlap_weeks")

#: (project, step) -> (duration_override_weeks, start_not_before_week, overlap_weeks)
_HAND_SET: dict[tuple[str, str], tuple[int | None, int | None, int | None]] = {
    ("P1", "PDD-M"): (None, 49, 1),
    ("P2", "PDD-A"): (None, 69, None),
    ("P3", "PDD-H"): (8, None, None),
    ("P4", "PDD-K"): (3, None, None),
    ("P4", "PDD-L"): (None, 43, 1),
}


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


def _load(url: str) -> dict[str, uuid.UUID]:
    ids: dict[str, uuid.UUID] = {}

    async def go(conn: asyncpg.Connection) -> None:
        hub = uuid.uuid4()
        await conn.execute(
            "INSERT INTO hubs (id, name, lab_region, is_oem) "
            "VALUES ($1, 'R&D-Greece'::hub_name, 'Greece'::lab_region, false)",
            hub,
        )
        for name in ("P1", "P2", "P3", "P4", "P5"):
            pid = uuid.uuid4()
            ids[name] = pid
            await conn.execute(
                "INSERT INTO projects (id, name, hub_id, category, status, frozen, delay_weeks, "
                "carry_over, schedule_stale) VALUES ($1, $2, $3, 'B', 'On Hold'::project_status, "
                "false, 0, false, false)",
                pid,
                name,
                hub,
            )
            for seq, letter in enumerate("ABCDEFGHIJKLMN", start=1):
                sid = f"PDD-{letter}"
                d, s, o = _HAND_SET.get((name, sid), (None, None, None))
                await conn.execute(
                    "INSERT INTO project_workflow_steps (id, project_id, step_template_id, "
                    "sequence_order, duration_weeks, plan_weeks, plan_gap_weeks, status, "
                    "percent_complete, eng_conflict, chamber_overlap, duration_override_weeks, "
                    "start_not_before_week, overlap_weeks) VALUES ($1, $2, $3, $4, 2, 2, 0, "
                    "'Not Started', 0, false, false, $5, $6, $7)",
                    uuid.uuid4(),
                    pid,
                    sid,
                    seq,
                    d,
                    s,
                    o,
                )

    _run(url, go)
    return ids


def _timing(url: str) -> dict[tuple[str, str], tuple[Any, ...]]:
    return {
        (r["name"], r["step_template_id"]): (
            r["duration_override_weeks"],
            r["start_not_before_week"],
            r["overlap_weeks"],
        )
        for r in _fetch(
            url,
            "SELECT p.name, s.step_template_id, s.duration_override_weeks, "
            "s.start_not_before_week, s.overlap_weeks "
            "FROM project_workflow_steps s JOIN projects p ON p.id = s.project_id "
            "WHERE s.duration_override_weeks IS NOT NULL OR s.start_not_before_week IS NOT NULL "
            "OR s.overlap_weeks IS NOT NULL",
        )
    }


def _other_values(url: str) -> list[tuple[Any, ...]]:
    """Every other column the migration must leave alone."""

    return [
        tuple(r)
        for r in _fetch(
            url,
            "SELECT p.name, s.step_template_id, s.duration_weeks, s.plan_weeks, "
            "s.plan_gap_weeks, s.effort_weeks, s.status::text, s.percent_complete "
            "FROM project_workflow_steps s JOIN projects p ON p.id = s.project_id ORDER BY 1, 2",
        )
    ]


def _stale(url: str) -> set[str]:
    return {r["name"] for r in _fetch(url, "SELECT name FROM projects WHERE schedule_stale")}


def _audits(url: str) -> list[asyncpg.Record]:
    return _fetch(
        url,
        "SELECT entity_id, entity_type, actor_user_id, hub_id, before_state, after_state, notes "
        "FROM audit_log_entries WHERE action = 'project.step_timing_cleared' "
        "ORDER BY occurred_at, entity_id",
    )


def _has_check(url: str) -> bool:
    return bool(_fetch(url, "SELECT 1 FROM pg_constraint WHERE conname = $1", _CHECK))


def _assert_upgraded(url: str, ids: dict[str, uuid.UUID], others: list[Any], n_audit: int) -> None:
    assert _version(url) == _HEAD
    assert _timing(url) == {}
    assert _other_values(url) == others
    assert _stale(url) == {"P1", "P2", "P3", "P4"}
    assert _has_check(url)
    audits = _audits(url)
    assert len(audits) == n_audit
    latest = audits[-4:]
    by_project = {r["entity_id"]: r for r in latest}
    name_of = {str(v): k for k, v in ids.items()}
    assert {name_of[e] for e in by_project} == {"P1", "P2", "P3", "P4"}
    for entity_id, row in by_project.items():
        name = name_of[entity_id]
        assert row["entity_type"] == "Project" and row["actor_user_id"] is None
        assert row["hub_id"] is not None and "ADR 0048" in row["notes"]
        before = json.loads(row["before_state"])
        after = json.loads(row["after_state"])
        want = {
            sid: dict(zip(_FIELDS, vals, strict=True))
            for (p, sid), vals in _HAND_SET.items()
            if p == name
        }
        assert before["steps"] == want
        assert after["steps"] == {sid: dict.fromkeys(_FIELDS) for sid in want}
        assert after["reason"] == "ADR 0048" and after["schedule_stale"] is True

    for field, value in (
        ("duration_override_weeks", 5),
        ("start_not_before_week", 40),
        ("overlap_weeks", 1),
    ):

        async def write(conn: asyncpg.Connection, field: str = field, value: int = value) -> str:
            try:
                await conn.execute(
                    f"UPDATE project_workflow_steps SET {field} = $1 "  # noqa: S608 - test constant
                    "WHERE project_id = $2 AND step_template_id = 'PDD-E'",
                    value,
                    ids["P5"],
                )
            except asyncpg.CheckViolationError as exc:
                return str(exc.constraint_name)
            return "accepted"

        assert _run(url, write) == _CHECK, field


def test_p33c_clears_four_projects_seven_values_with_four_audit_rows() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        ids = _load(url)
        hand_set = _timing(url)
        assert hand_set == _HAND_SET
        assert sum(v is not None for vals in hand_set.values() for v in vals) == 7
        others = _other_values(url)
        assert _stale(url) == set()

        r = run_alembic(["upgrade", _HEAD], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, ids, others, n_audit=4)

        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        assert _version(url) == _BEFORE
        assert not _has_check(url)
        assert _timing(url) == _HAND_SET  # restored from the audit rows
        assert _other_values(url) == others
        assert len(_audits(url)) == 4  # append-only

        r = run_alembic(["upgrade", _HEAD], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, ids, others, n_audit=8)


def test_p33c_with_nothing_hand_set_writes_no_audit_row() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", _HEAD], url)
        assert r.returncode == 0, r.stderr
        assert _audits(url) == [] and _has_check(url)
