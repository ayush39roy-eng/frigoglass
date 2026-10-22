"""P30-T02: migration `p30a_effort_types_hub_rename` (ADR 0041) up / down / up
on data, in its own container.

World at `p29b_bc_type_regulatory`:

    hubs      R&D-Greece (Greece), OEM-Seltek (OEM, member of R&D-Greece)
    project   S1 on OEM-Seltek, B-OEM, In Development, one step OEM-A (lead 1)
    chambers  IN-CH1 {F, H} (pre-ADR), IN-CH2 {F} (pre-ADR), GR-CH2 edited by an
              admin to {F} (not the pre-ADR value, so it is left alone)
    run       v1, completed + active, one step row for S1 and a
              `workflow_snapshot` mentioning "OEM-Seltek" (stored string, I14)

Up: the new columns and CHECKs exist (effort 0..104 accepted, 105 refused;
negative figures refused), the hub reads `OEM-Seitek`, the stored run and its
snapshot are byte-identical and still join to the (renamed) hub, the two
pre-ADR chambers move to the client mapping with one audited
`chamber.update` each and every schedulable project is marked stale,
`AC` / `SER` are usable. Down: the hub reads `OEM-Seltek` again, chambers are
restored (audited), an `AC` project is un-typed (audited), the columns are
gone. Up again: the same facts, nothing doubled.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import asyncpg
import pytest
from testcontainers.postgres import PostgresContainer

from tests.conftest import run_alembic


def _dsn(url: str) -> str:
    return url.replace("postgresql+asyncpg://", "postgresql://")


async def _q(url: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    conn = await asyncpg.connect(_dsn(url))
    try:
        return await conn.fetch(sql, *args)
    finally:
        await conn.close()


def _rows(url: str, sql: str, *args: Any) -> list[asyncpg.Record]:
    return asyncio.run(_q(url, sql, *args))


def _exec(url: str, sql: str, *args: Any) -> None:
    async def run() -> None:
        conn = await asyncpg.connect(_dsn(url))
        try:
            await conn.execute(sql, *args)
        finally:
            await conn.close()

    asyncio.run(run())


_SNAPSHOT = {"workflows": [], "note": "projects on OEM-Seltek", "step_timing": []}


async def _load_world(url: str) -> dict[str, uuid.UUID]:
    conn = await asyncpg.connect(_dsn(url))
    ids: dict[str, uuid.UUID] = {}
    try:
        ids["greece"], ids["seltek"] = uuid.uuid4(), uuid.uuid4()
        await conn.execute(
            "INSERT INTO hubs (id, name, lab_region, is_oem) "
            "VALUES ($1, 'R&D-Greece'::hub_name, 'Greece'::lab_region, false)",
            ids["greece"],
        )
        await conn.execute(
            "INSERT INTO hubs (id, name, lab_region, is_oem, capacity_hub_id) "
            "VALUES ($1, 'OEM-Seltek'::hub_name, 'Greece'::lab_region, true, $2)",
            ids["seltek"],
            ids["greece"],
        )
        ids["s1"] = uuid.uuid4()
        await conn.execute(
            "INSERT INTO projects (id, name, hub_id, category, status, frozen, delay_weeks, "
            "carry_over, priority, schedule_stale) VALUES ($1, 'S1', $2, "
            "'B-OEM'::project_category, 'In Development'::project_status, false, 0, false, "
            "'P2'::project_priority, false)",
            ids["s1"],
            ids["seltek"],
        )
        await conn.execute(
            "INSERT INTO project_workflow_steps (id, project_id, step_template_id, "
            "sequence_order, duration_weeks, status, percent_complete, eng_conflict, "
            "chamber_overlap) VALUES ($1, $2, 'OEM-A', 1, 1, 'Not Started', 0, false, false)",
            uuid.uuid4(),
            ids["s1"],
        )
        for code, region, stages in (
            ("IN-CH1", "India", ["PDD-F", "PDD-H"]),
            ("IN-CH2", "India", ["PDD-F"]),
            ("GR-CH2", "Greece", ["PDD-F"]),  # an admin edit: not the pre-ADR value
        ):
            ids[code] = uuid.uuid4()
            await conn.execute(
                "INSERT INTO chambers (id, code, lab_region, max_concurrent, platforms, "
                "efficiency, allowed_stages) VALUES ($1, $2, $3::lab_region, 1, 1, 0.7, $4)",
                ids[code],
                code,
                region,
                stages,
            )
        ids["run"] = uuid.uuid4()
        await conn.execute(
            "INSERT INTO schedule_runs (id, version, solver_type, status, is_active, "
            "horizon_weeks, current_week, workflow_snapshot) VALUES ($1, 1, "
            "'greedy'::solver_type, 'completed'::schedule_run_status, true, 78, 42, $2::jsonb)",
            ids["run"],
            json.dumps(_SNAPSHOT),
        )
        await conn.execute(
            "INSERT INTO schedule_run_project_steps (id, schedule_run_id, project_id, "
            "step_template_id, sequence_order, duration_weeks, start_week, end_week, "
            "eng_conflict, chamber_overlap, skipped) VALUES ($1, $2, $3, 'OEM-A', 1, 1, 42, "
            "42, false, false, false)",
            uuid.uuid4(),
            ids["run"],
            ids["s1"],
        )
    finally:
        await conn.close()
    return ids


def _hub_names(url: str) -> set[str]:
    return {r["name"] for r in _rows(url, "SELECT CAST(name AS text) AS name FROM hubs")}


def _enum_labels(url: str, typname: str) -> list[str]:
    return [
        r["enumlabel"]
        for r in _rows(
            url,
            "SELECT e.enumlabel FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid "
            "WHERE t.typname = $1 ORDER BY e.enumsortorder",
            typname,
        )
    ]


def _stages(url: str) -> dict[str, list[str]]:
    return {
        r["code"]: list(r["stages"])
        for r in _rows(
            url, "SELECT code, CAST(allowed_stages AS text[]) AS stages FROM chambers"
        )
    }


def _run_state(url: str) -> tuple[Any, ...]:
    run = _rows(url, "SELECT workflow_snapshot::text AS snap FROM schedule_runs")
    steps = _rows(
        url,
        "SELECT s.duration_weeks, s.start_week, s.end_week, CAST(h.name AS text) AS hub "
        "FROM schedule_run_project_steps s JOIN projects p ON p.id = s.project_id "
        "JOIN hubs h ON h.id = p.hub_id",
    )
    return (
        json.loads(run[0]["snap"]),
        [(r["duration_weeks"], r["start_week"], r["end_week"]) for r in steps],
        [r["hub"] for r in steps],
    )


def _columns(url: str, table: str) -> set[str]:
    return {
        r["column_name"]
        for r in _rows(
            url,
            "SELECT column_name FROM information_schema.columns WHERE table_name = $1",
            table,
        )
    }


_NEW_PROJECT_COLUMNS = {
    "design_effort_weeks",
    "lab_effort_weeks",
    "safety_lab_weeks",
    "actual_design_weeks",
    "actual_testing_weeks",
    "safety_certification_required",
    "capacity_flag",
}


def _assert_upgraded(url: str, ids: dict[str, uuid.UUID]) -> None:
    assert _hub_names(url) == {"R&D-Greece", "OEM-Seitek"}
    assert "OEM-Seltek" not in _enum_labels(url, "hub_name")
    assert {"AC", "SER"} <= set(_enum_labels(url, "project_type"))
    assert _NEW_PROJECT_COLUMNS <= _columns(url, "projects")
    assert "effort_weeks" in _columns(url, "project_workflow_steps")
    assert _stages(url) == {
        "IN-CH1": ["PDD-F"],
        "IN-CH2": ["PDD-F", "PDD-H"],
        "GR-CH2": ["PDD-F"],  # admin-edited: untouched
    }
    # The stored run is byte-stable (I14); its rows join to the renamed hub.
    snapshot, steps, hubs = _run_state(url)
    assert snapshot == _SNAPSHOT
    assert steps == [(1, 42, 42)]
    assert hubs == ["OEM-Seitek"]


def test_p30a_up_down_up_on_data() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p29b_bc_type_regulatory"], url)
        assert r.returncode == 0, r.stderr
        ids = asyncio.run(_load_world(url))
        assert _hub_names(url) == {"R&D-Greece", "OEM-Seltek"}

        # --- up --------------------------------------------------------------------
        r = run_alembic(["upgrade", "p30a_effort_types_hub_rename"], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, ids)
        audits = _rows(
            url,
            "SELECT entity_id, before_state, after_state FROM audit_log_entries "
            "WHERE action = 'chamber.update' ORDER BY entity_id",
        )
        assert sorted(json.loads(a["after_state"])["code"] for a in audits) == ["IN-CH1", "IN-CH2"]
        assert all(
            json.loads(a["after_state"])["source"] == "chamber_stages_adr_0041" for a in audits
        )
        assert _rows(url, "SELECT schedule_stale FROM projects")[0]["schedule_stale"] is True

        # The CHECKs: effort 0..104 on steps; figures >= 0 on projects.
        _exec(url, "UPDATE project_workflow_steps SET effort_weeks = 0")
        _exec(url, "UPDATE project_workflow_steps SET effort_weeks = 104")
        with pytest.raises(asyncpg.CheckViolationError):
            _exec(url, "UPDATE project_workflow_steps SET effort_weeks = 105")
        with pytest.raises(asyncpg.CheckViolationError):
            _exec(url, "UPDATE projects SET design_effort_weeks = -1")
        _exec(url, "UPDATE projects SET design_effort_weeks = 4.5, lab_effort_weeks = 70")
        # The user's override keeps its ADR 0019 domain (R4): 0 is refused.
        with pytest.raises(asyncpg.CheckViolationError):
            _exec(url, "UPDATE project_workflow_steps SET duration_override_weeks = 0")
        # The new types are usable (committed by the autocommit block).
        _exec(url, "UPDATE projects SET type = 'AC'::project_type")

        # --- down ------------------------------------------------------------------
        r = run_alembic(["downgrade", "p29b_bc_type_regulatory"], url)
        assert r.returncode == 0, r.stderr
        assert _hub_names(url) == {"R&D-Greece", "OEM-Seltek"}
        assert not (_NEW_PROJECT_COLUMNS & _columns(url, "projects"))
        assert "effort_weeks" not in _columns(url, "project_workflow_steps")
        assert _stages(url) == {
            "IN-CH1": ["PDD-F", "PDD-H"],
            "IN-CH2": ["PDD-F"],
            "GR-CH2": ["PDD-F"],
        }
        assert _rows(url, "SELECT CAST(type AS text) AS t FROM projects")[0]["t"] is None
        down = _rows(
            url,
            "SELECT after_state->>'source' AS source, count(*) AS n FROM audit_log_entries "
            "WHERE notes LIKE 'migration p30a downgrade%' GROUP BY 1 ORDER BY 1",
        )
        assert {d["source"]: d["n"] for d in down} == {
            "chamber_stages_adr_0041": 2,
            "type_downgrade_adr_0041": 1,
        }
        snapshot, steps, hubs = _run_state(url)
        assert snapshot == _SNAPSHOT and steps == [(1, 42, 42)] and hubs == ["OEM-Seltek"]

        # --- up again ----------------------------------------------------------------
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        _assert_upgraded(url, ids)
        n = _rows(
            url,
            "SELECT count(*) AS n FROM audit_log_entries WHERE action = 'chamber.update' "
            "AND notes LIKE 'migration p30a:%'",
        )
        assert n[0]["n"] == 4  # two per upgrade, nothing doubled within one
