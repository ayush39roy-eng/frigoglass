"""P62-T04: migration `p71a_lab_hold_weeks` (ADR 0071; `docs/API_CONTRACT_P62.md`
§1), in its own container (never the shared test DB, never a dev DB).

The seeded demo DB (with one persisted run) is taken down to
`p70a_effort_weight_revive` and put in its pre-P62 hosted shape: Pr. Pr /
Pilot are `lab` (the 2026-11-22 Super Admin edit), C/PDD-J is 1 week, a B
project's lab figure is spread over H / J / L. Then:

- upgrade to p71a: the five data steps do exactly what the contract says
  (template defaults + versions + audits; hold copies on every project;
  C/PDD-J 1 -> 0 on ¬never copies only; the R62-1 re-split; stale; no run),
  and nothing else changes (row checksums of every other table and of the
  untouched columns);
- a second pass of the data steps writes nothing (idempotent);
- the I65 CHECKs reject an out-of-range hold;
- downgrade drops the columns, upgrade again succeeds (up / down / up).
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.util
import json
from pathlib import Path
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

_BEFORE = "p70a_effort_weight_revive"
_P71 = "p71a_lab_hold_weeks"
_MIGRATION = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "p71a_lab_hold_weeks.py"

#: (table, order-by, columns p71a may change) — everything else must be
#: byte-identical across the upgrade.
_TABLES: tuple[tuple[str, str, tuple[str, ...]], ...] = (
    ("schedule_runs", "id", ()),
    ("schedule_run_project_steps", "id", ("lab_hold_weeks",)),
    ("schedule_run_project_outcomes", "id", ()),
    ("stage_checkins", "id", ()),
    ("engineers", "id", ()),
    ("chambers", "id", ()),
    ("hubs", "id", ()),
    ("projects", "id", ("schedule_stale",)),
    (
        "project_workflow_steps",
        "id",
        ("plan_lab_hold_weeks", "plan_weeks", "effort_weeks", "template_change_id"),
    ),
    ("workflow_lead_times", "workflow_id, category, step_id", ("lab_hold_weeks", "weeks")),
    ("categories", "code", ("template_version",)),
)


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


def _q(url: str, sql: str, *args: Any) -> list[Any]:
    return list(_run(url, lambda c: c.fetch(sql, *args)))


def _v(url: str, sql: str, *args: Any) -> Any:
    return _run(url, lambda c: c.fetchval(sql, *args))


def _x(url: str, sql: str, *args: Any) -> None:
    _run(url, lambda c: c.execute(sql, *args))


def _checksums(url: str) -> dict[str, tuple[int, str]]:
    async def go(conn: asyncpg.Connection) -> dict[str, tuple[int, str]]:
        out: dict[str, tuple[int, str]] = {}
        for table, order, changed in _TABLES:
            strip = "".join(f" - '{c}'" for c in (*changed, "updated_at"))
            # Table / column names are the constants above, never input.
            row = await conn.fetchrow(
                f"SELECT count(*) AS n, coalesce(md5(string_agg((to_jsonb(t){strip})::text, "
                f"'|' ORDER BY {', '.join('t.' + o.strip() for o in order.split(','))})), '') "
                f"AS h FROM {table} t"
            )
            out[table] = (int(row["n"]), str(row["h"]))
        return out

    result: dict[str, tuple[int, str]] = _run(url, go)
    return result


async def _persist_one_run(url: str) -> None:
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


def _load_migration() -> Any:
    spec = importlib.util.spec_from_file_location("p71a_under_test", _MIGRATION)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _data_steps_again(url: str) -> Any:
    """One more pass of the data steps in a transaction that is rolled back."""

    module = _load_migration()

    async def go() -> Any:
        engine = create_async_engine(url)
        try:
            async with engine.connect() as conn:
                trans = await conn.begin()
                result = await conn.run_sync(module.run_data_steps)
                await trans.rollback()
                return result
        finally:
            await engine.dispose()

    return asyncio.run(go())


@pytest.fixture(scope="module")
def monkeypatch_module() -> Any:
    mp = pytest.MonkeyPatch()
    yield mp
    mp.undo()


@pytest.fixture(scope="module")
def world(monkeypatch_module: pytest.MonkeyPatch) -> Any:
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
        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr
        yield _pre_p62(url)


def _pre_p62(url: str) -> dict[str, Any]:
    """The hosted shape before ADR 0071 (see the module docstring)."""

    _x(url, "UPDATE workflow_step_templates SET kind = 'lab' WHERE id IN ('PDD-J', 'PDD-L')")
    _x(
        url,
        "UPDATE workflow_lead_times SET weeks = 1 "
        "WHERE workflow_id = 'PDD' AND category = 'C' AND step_id = 'PDD-J'",
    )
    pdd_c = (
        "SELECT p.id FROM projects p JOIN hubs h ON h.id = p.hub_id "
        "WHERE NOT h.is_oem AND p.category = 'C' "
    )
    _x(
        url,
        "UPDATE project_workflow_steps SET plan_weeks = 1 WHERE step_template_id = 'PDD-J' "
        f"AND project_id IN ({pdd_c})",
    )
    open_ids = [
        r["id"]
        for r in _q(
            url,
            pdd_c + "AND NOT p.frozen AND p.status::text NOT IN ('Cancelled', 'Commercialized') "
            "AND NOT EXISTS (SELECT 1 FROM project_workflow_steps s WHERE s.project_id = p.id "
            "AND s.status::text <> 'Not Started') ORDER BY p.id",
        )
    ]
    assert len(open_ids) >= 2, "the seed needs two open category-C PDD projects"
    c_open, c_reached = open_ids[0], open_ids[1]
    # J reached through a started successor (K In Progress).
    _x(
        url,
        "UPDATE project_workflow_steps SET status = 'In Progress', percent_complete = 10, "
        "actual_start_week = 30 WHERE project_id = $1 AND step_template_id = 'PDD-K'",
        c_reached,
    )
    closed = [
        r["id"]
        for r in _q(
            url,
            pdd_c + "AND (p.frozen OR p.status::text IN ('Cancelled', 'Commercialized')) "
            "ORDER BY p.id",
        )
    ]
    b_own = _v(
        url,
        "SELECT p.id FROM projects p JOIN hubs h ON h.id = p.hub_id WHERE NOT h.is_oem "
        "AND p.category = 'B' AND NOT p.frozen AND p.certification_testing_required "
        "AND p.status::text NOT IN ('Cancelled', 'Commercialized') "
        "AND NOT EXISTS (SELECT 1 FROM project_workflow_steps s WHERE s.project_id = p.id "
        "AND s.status::text <> 'Not Started') ORDER BY p.id LIMIT 1",
    )
    assert b_own is not None
    # The 2026-11-22 shape: the lab figure spread over H / J / L by weight.
    _x(url, "UPDATE projects SET lab_effort_weeks = 10, design_effort_weeks = NULL WHERE id = $1",
       b_own)  # fmt: skip
    _x(url, "UPDATE project_workflow_steps SET effort_weeks = NULL WHERE project_id = $1", b_own)
    for sid, eff in (("PDD-H", 8), ("PDD-J", 1), ("PDD-L", 1)):
        _x(
            url,
            "UPDATE project_workflow_steps SET effort_weeks = $2 "
            "WHERE project_id = $1 AND step_template_id = $3",
            b_own, eff, sid,
        )  # fmt: skip
    _x(url, "UPDATE projects SET schedule_stale = false")
    return {"url": url, "c_open": c_open, "c_reached": c_reached, "closed": closed,
            "b_own": b_own}  # fmt: skip


#: Audit rows written before the upgrade under test (the empty-DB head
#: upgrade of the fixture wrote some; the log is append-only).
_OLD: list[Any] = []


def _new_audits(url: str, action: str, entity_id: str | None = None) -> list[Any]:
    sql = (
        "SELECT entity_id, after_state FROM audit_log_entries WHERE action = $1 "
        "AND NOT (id = ANY($2::uuid[]))"
    )
    args: list[Any] = [action, _OLD]
    if entity_id is not None:
        sql += " AND entity_id = $3"
        args.append(entity_id)
    return _q(url, sql, *args)


def _audit_count(url: str, action: str) -> int:
    return len(_new_audits(url, action))


def test_p71a_up_idempotent_down_up(world: dict[str, Any]) -> None:
    url = world["url"]
    before = _checksums(url)
    versions_before = {r["code"]: r["template_version"] for r in _q(
        url, "SELECT code, template_version FROM categories")}  # fmt: skip
    audits_before = int(_v(url, "SELECT count(*) FROM audit_log_entries"))
    _OLD[:] = [r["id"] for r in _q(url, "SELECT id FROM audit_log_entries")]

    r = run_alembic(["upgrade", _P71], url)
    assert r.returncode == 0, r.stderr

    # --- nothing else changed --------------------------------------------------------
    assert _checksums(url) == before

    # --- step 1: template --------------------------------------------------------------
    lead = {
        (r["category"], r["step_id"]): (r["weeks"], r["lab_hold_weeks"])
        for r in _q(
            url,
            "SELECT category, step_id, weeks, lab_hold_weeks FROM workflow_lead_times "
            "WHERE workflow_id = 'PDD'",
        )  # fmt: skip
    }
    for cat in ("A+", "A", "B"):
        for sid in ("PDD-J", "PDD-L"):
            weeks, hold = lead[(cat, sid)]
            assert hold == min(1, weeks), (cat, sid)
    assert lead[("C", "PDD-J")] == (0, 0)
    assert lead[("C", "PDD-L")] == (0, 0)
    assert all(h is None for (c, s), (_w, h) in lead.items() if s not in ("PDD-J", "PDD-L"))
    oem_holds = _v(url, "SELECT count(*) FROM workflow_lead_times WHERE workflow_id = 'OEM' "
                        "AND lab_hold_weeks IS NOT NULL")  # fmt: skip
    assert oem_holds == 0  # OEM-J / OEM-L are not lab here
    versions = {r["code"]: r["template_version"] for r in _q(
        url, "SELECT code, template_version FROM categories")}  # fmt: skip
    for code in ("A+", "A", "B", "C"):
        assert versions[code] == versions_before[code] + 1
    assert all(
        versions[c] == versions_before[c] for c in versions if c not in ("A+", "A", "B", "C")
    )
    applied = _new_audits(url, "workflow_template.applied")
    states = [json.loads(a["after_state"]) for a in applied]
    assert sorted(s["changes"][0]["category"] for s in states) == ["A", "A+", "B", "C"]
    assert all(s["reason"] == "p62_lab_hold_defaults" for s in states)
    c_state = next(s for s in states if s["changes"][0]["category"] == "C")
    assert "p62_c_no_pr_pr" in c_state["reasons"]
    assert {"step_id": "PDD-J", "weeks": [1, 0], "lab_hold_weeks": [None, 0]} in (
        c_state["changes"][0]["steps"]
    )
    # One `template_changes` row per pass (the fixture's empty-DB head upgrade
    # wrote the first).
    assert len({s["template_change_id"] for s in states}) == 1
    assert int(_v(url, "SELECT count(*) FROM template_changes "
                       "WHERE reason = 'p62_lab_hold_defaults'")) == 2  # fmt: skip

    # --- step 2: every project's copy (closed / frozen included) -------------------------
    bad = _v(
        url,
        "SELECT count(*) FROM project_workflow_steps s JOIN projects p ON p.id = s.project_id "
        "JOIN hubs h ON h.id = p.hub_id JOIN workflow_lead_times lt ON lt.category = p.category "
        "AND lt.workflow_id = CASE WHEN h.is_oem THEN 'OEM' ELSE 'PDD' END "
        "AND lt.step_id = s.step_template_id "
        "WHERE s.plan_lab_hold_weeks IS DISTINCT FROM "
        "CASE WHEN lt.lab_hold_weeks IS NULL THEN NULL "
        "ELSE LEAST(lt.lab_hold_weeks, s.plan_weeks) END",
    )
    assert bad == 0
    with_hold = int(_v(url, "SELECT count(DISTINCT project_id) FROM project_workflow_steps "
                            "WHERE plan_lab_hold_weeks IS NOT NULL"))  # fmt: skip
    assert with_hold > 0
    assert _audit_count(url, "project.lab_hold_backfilled") == with_hold
    for pid in world["closed"]:
        assert (
            _v(
                url,
                "SELECT plan_lab_hold_weeks FROM project_workflow_steps "
                "WHERE project_id = $1 AND step_template_id = 'PDD-J'",
                pid,
            )
            == 0
        )

    # --- step 3: C/PDD-J 1 -> 0 on ¬never pairs only -------------------------------------
    def j_weeks(pid: Any) -> int:
        sql = (
            "SELECT plan_weeks FROM project_workflow_steps "
            "WHERE project_id = $1 AND step_template_id = 'PDD-J'"
        )
        return int(_v(url, sql, pid))

    assert j_weeks(world["c_open"]) == 0
    assert j_weeks(world["c_reached"]) == 1
    for pid in world["closed"]:
        assert j_weeks(pid) == 1
    c_audits = _new_audits(url, "project.template_applied")
    assert str(world["c_open"]) in {a["entity_id"] for a in c_audits}
    assert str(world["c_reached"]) not in {a["entity_id"] for a in c_audits}
    assert all(json.loads(a["after_state"])["weeks"] == {"PDD-J": [1, 0]} for a in c_audits)

    # --- step 4: the R62-1 re-split ------------------------------------------------------
    eff = {
        r["step_template_id"]: r["effort_weeks"]
        for r in _q(
            url,
            "SELECT step_template_id, effort_weeks FROM project_workflow_steps "
            "WHERE project_id = $1",
            world["b_own"],
        )  # fmt: skip
    }
    assert (eff["PDD-H"], eff["PDD-J"], eff["PDD-L"]) == (10, None, None)
    rederived = _new_audits(url, "project.effort_rederived", str(world["b_own"]))
    assert len(rederived) == 1
    assert json.loads(rederived[0]["after_state"])["trigger"] == "lab_hold_default"

    # --- step 5: stale, no run -----------------------------------------------------------
    assert _v(url, "SELECT count(*) FROM projects WHERE NOT schedule_stale AND status::text "
                   "NOT IN ('Commercialized', 'On Hold', 'Cancelled', 'Draft')") == 0  # fmt: skip
    assert _v(url, "SELECT count(*) FROM schedule_runs") == 1
    assert _v(url, "SELECT count(*) FROM schedule_run_project_steps "
                   "WHERE lab_hold_weeks IS NOT NULL") == 0  # fmt: skip

    # --- a second pass writes nothing ----------------------------------------------------
    audits_after = int(_v(url, "SELECT count(*) FROM audit_log_entries"))
    assert audits_after > audits_before
    again = _data_steps_again(url)
    assert not again.changed
    assert again.categories == [] and again.rederived_projects == 0
    assert int(_v(url, "SELECT count(*) FROM audit_log_entries")) == audits_after

    # --- the I65 CHECKs ------------------------------------------------------------------
    with pytest.raises(asyncpg.CheckViolationError):
        _x(url, "UPDATE workflow_lead_times SET lab_hold_weeks = weeks + 1 "
                "WHERE workflow_id = 'PDD' AND category = 'B' AND step_id = 'PDD-L'")  # fmt: skip
    with pytest.raises(asyncpg.CheckViolationError):
        _x(
            url,
            "UPDATE project_workflow_steps SET plan_lab_hold_weeks = plan_weeks + 1 "
            "WHERE project_id = $1 AND step_template_id = 'PDD-L'",
            world["b_own"],
        )
    with pytest.raises(asyncpg.CheckViolationError):
        _x(url, "UPDATE schedule_run_project_steps SET lab_hold_weeks = end_week - start_week + 2 "
                "WHERE id = (SELECT id FROM schedule_run_project_steps LIMIT 1)")  # fmt: skip

    # --- down / up -----------------------------------------------------------------------
    r = run_alembic(["downgrade", _BEFORE], url)
    assert r.returncode == 0, r.stderr
    cols = _v(url, "SELECT count(*) FROM information_schema.columns WHERE column_name IN "
                   "('lab_hold_weeks', 'plan_lab_hold_weeks')")  # fmt: skip
    assert cols == 0
    # Not restored (documented): C/PDD-J stays 0.
    assert lead[("C", "PDD-J")][0] == _v(url, "SELECT weeks FROM workflow_lead_times WHERE "
                                              "workflow_id='PDD' AND category='C' AND "
                                              "step_id='PDD-J'")  # fmt: skip
    r = run_alembic(["upgrade", "head"], url)
    assert r.returncode == 0, r.stderr
    assert not _data_steps_again(url).changed
