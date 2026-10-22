"""P29-T01 / P29-T04: the data migrations `p29a_capacity_hubs` (ADR 0042) and
`p29b_bc_type_regulatory` (ADR 0038 amendment 2026-10-22), on real data in
their own throwaway Postgres container, up, down and up again.

Plus pure pins: the frozen facts and the frozen formulas inside the two
migrations equal the live code they copy (`seed.client_2026`,
`domain_constants`, `services.priority_scoring.compute_score`).

World loaded at `p27a_project_scoring_tags` (pre-P29):

    hubs        R&D-Greece, R&D-India, OEM-HCK (OEM), OEM-Seltek (OEM)
    calendars   R&D-Greece 5/12/0/0/25; OEM-HCK and OEM-Seltek India's 6/13/7/7/20
    engineers   Theoni (OEM-HCK, A-OEM B-OEM C-OEM), Dimopoulou (Greece, A+ A OEM),
                Lioumis (Greece, A+ A), Kanarios (Greece, A+ A), Dipak (R&D-India, A)
    projects    design effort = Σ design-kind step durations
      G1  Greece  A      In Development  Lioumis   effort 8
      G2  Greece  A      Commercialized  Kanarios  effort 20 (not schedulable: no load)
      G3  Greece  B      In Queue        Kanarios  effort 1, In Progress design stage
      T1  HCK     B-OEM  In Queue        Theoni    (workbook leader: kept)
      L1  HCK     A-OEM  P1 In Development  no leader  effort 3, In Progress design stage
      L4  Seltek  C-OEM  P1 In Development  no leader  effort 1, In Progress design stage
      L2  Seltek  B-OEM  P2 In Queue        no leader  effort 2
      L3  HCK     C-OEM  P3 Commercialized  no leader  effort 5
      R1  India   A      In Queue        no leader  (not a member hub: stays blank)
      B1  India   type NULL, external code 26-00383 (BC), scored 13 x 1
      B2  India   type NULL, external code 26-S0221 (BC), unscored
      B3  India   type NM,   external code 26-S0222 (BC, retyped by a person: untouched)

Hand-derived ADR 0042 §7 walk (candidates = Greece's counted engineers;
starting loads Dimopoulou 0, Kanarios 1 (G3), Lioumis 8 (G1); scheduling
order L1, L4, L2, L3):

    L1 -> Dimopoulou (0 < 1 < 8)                                    D = 3
    L4 -> Kanarios (1 < 3 < 8)                                      K = 2
          L4's In Progress design stage is reset: Kanarios already has G3's
    L2 -> Kanarios (2 < 3)                                          K = 4
    L3 -> Dimopoulou (3 < 4); Commercialized, so no load added
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import uuid
from pathlib import Path
from types import ModuleType
from typing import Any

import asyncpg
from testcontainers.postgres import PostgresContainer

import domain_constants as dc
from seed import client_2026 as c26
from seed.initial_scoring_rubric import initial_rubric
from services.priority_scoring import compute_score
from tests.conftest import run_alembic

_BACKEND = Path(__file__).resolve().parent.parent


def _load(name: str) -> ModuleType:
    path = _BACKEND / f"alembic/versions/{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


# --- pure pins -----------------------------------------------------------------------


def test_p29a_frozen_facts_equal_the_live_rules():
    p29a = _load("p29a_capacity_hubs")
    assert p29a._CAPACITY_HUB_OF == dict(dc.HUB_CAPACITY_HUB)
    assert set(p29a._NOT_IN_CAPACITY_ROSTER) == set(c26.NOT_IN_CAPACITY_ROSTER)
    assert p29a._OEM_CATEGORIES == tuple(sorted(dc.OEM_CATEGORIES))
    for name in p29a._OEM_ELIGIBLE_GREEKS:
        assert set(p29a._OEM_CATEGORIES) <= set(c26.CLIENT_APP_ALLOWED_CATEGORIES[name])
    # The retired member calendar is India's seed row (P9-T01).
    india = next(r for r in dc.HUB_WORK_CALENDAR_SEED if r[0] == "R&D-India")
    assert p29a._RETIRED_OEM_CALENDAR == india[1:]
    assert p29a._SOURCE_LEADER == c26.PROVISIONAL_LEADER_SOURCE


def test_p29b_codes_are_the_seed_bc_rows_and_formula_matches_service():
    p29b = _load("p29b_bc_type_regulatory")
    data = json.loads((_BACKEND / "seed/client_2026_seed_data.json").read_text())
    bc_codes = {
        p["external_code"]
        for p in data["projects"]
        if (p.get("excel_type") or "").strip().upper()
        in {"BC", "BUSINESS CONTINUITY", "BUSINESS CONTINIUTY", "BUSINESS CONTINUATION"}
    }
    assert set(p29b._BC_EXTERNAL_CODES) == bc_codes
    assert len(p29b._BC_EXTERNAL_CODES) == len(bc_codes) == 59
    assert p29b._TYPE == "RC"
    assert dc.PROJECT_TYPE_SCORING_TAG["RC"] == p29b._TAG
    assert dc.SCORING_TAG_DIMENSION_KEY[p29b._TAG] == p29b._DIMENSION_KEY

    rubric = initial_rubric()
    dims = [(uuid.uuid4(), d.weight, d.active) for d in rubric.dimensions]
    keys = [d.key for d in rubric.dimensions]
    for scores in ([1] * 13, [5] * 13, [0] * 13, [3, 4, 5, 0, 1, 2, 3, 4, 5, 0, 1, 2, 3]):
        by_id = {dim_id: s for (dim_id, _w, _a), s in zip(dims, scores, strict=True)}
        raw, pct, band = p29b._compute(dims, by_id)
        expected = compute_score(rubric, dict(zip(keys, scores, strict=True)))
        assert raw is not None
        assert (p29b._2dp(raw), pct, band) == (
            float(expected.weighted_score),
            expected.normalized_pct,
            expected.band,
        )
    # Only one dimension scored (the unscored-project pre-fill case).
    only = {dims[keys.index("regulatory_compliance")][0]: 5}
    raw, pct, band = p29b._compute(dims, only)
    expected = compute_score(rubric, {"regulatory_compliance": 5})
    assert (p29b._2dp(raw), pct, band) == (
        float(expected.weighted_score),
        expected.normalized_pct,
        expected.band,
    )


def test_p29a_walk_equals_the_seed_rule():
    """The migration's frozen walk and `client_2026.assign_provisional_leaders`
    agree on the world below (the container test asserts the DB result)."""

    candidates = [
        c26.LeaderCandidate("Dimopoulou", ("A+", "A", "OEM", "A-OEM", "B-OEM", "C-OEM"), 0),
        c26.LeaderCandidate("Kanarios", ("A+", "A", "A-OEM", "B-OEM", "C-OEM"), 1),
        c26.LeaderCandidate("Lioumis", ("A+", "A", "A-OEM", "B-OEM", "C-OEM"), 8),
    ]
    walk = [
        c26.LeaderlessProject("L1", "A-OEM", True, 3),
        c26.LeaderlessProject("L4", "C-OEM", True, 1),
        c26.LeaderlessProject("L2", "B-OEM", True, 2),
        c26.LeaderlessProject("L3", "C-OEM", False, 5),
    ]
    assert c26.assign_provisional_leaders(walk, candidates) == _EXPECTED_LEADERS


_EXPECTED_LEADERS = {"L1": "Dimopoulou", "L4": "Kanarios", "L2": "Kanarios", "L3": "Dimopoulou"}


# --- the migrations on data (own container) -----------------------------------------


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


#: name -> (hub, category, status, priority, leader, design steps [(step, weeks, in_progress)],
#:          type, external_code)
_PROJECTS: dict[str, tuple[Any, ...]] = {
    "G1": ("R&D-Greece", "A", "In Development", "P2", "Lioumis", [("PDD-B", 8, False)], None, None),
    "G2": ("R&D-Greece", "A", "Commercialized", "P2", "Kanarios", [("PDD-E", 20, False)], None,
           None),
    "G3": ("R&D-Greece", "B", "In Queue", "P3", "Kanarios", [("PDD-A", 1, True)], None, None),
    "T1": ("OEM-HCK", "B-OEM", "In Queue", "P2", "Theoni", [("OEM-A", 1, False)], None, None),
    "L1": ("OEM-HCK", "A-OEM", "In Development", "P1", None, [("OEM-A", 3, True)], None, None),
    "L4": ("OEM-Seltek", "C-OEM", "In Development", "P1", None, [("OEM-G", 1, True)], None, None),
    "L2": ("OEM-Seltek", "B-OEM", "In Queue", "P2", None, [("OEM-A", 2, False)], None, None),
    "L3": ("OEM-HCK", "C-OEM", "Commercialized", "P3", None, [("OEM-G", 5, False)], None, None),
    "R1": ("R&D-India", "A", "In Queue", "P2", None, [("PDD-A", 1, False)], None, None),
    "B1": ("R&D-India", "A", "In Queue", "P4", "Dipak", [], None, "26-00383"),
    "B2": ("R&D-India", "A", "In Queue", "P4", "Dipak", [], None, "26-S0221"),
    "B3": ("R&D-India", "A", "In Queue", "P4", "Dipak", [], "NM", "26-S0222"),
}  # fmt: skip

_ENGINEERS = {
    "Theoni": ("OEM-HCK", ["A-OEM", "B-OEM", "C-OEM"]),
    "Dimopoulou": ("R&D-Greece", ["A+", "A", "OEM"]),
    "Lioumis": ("R&D-Greece", ["A+", "A"]),
    "Kanarios": ("R&D-Greece", ["A+", "A"]),
    "Dipak": ("R&D-India", ["A"]),
}


async def _load_world(url: str) -> None:
    conn = await asyncpg.connect(_dsn(url))
    try:
        hubs: dict[str, uuid.UUID] = {}
        for name, region, oem in (
            ("R&D-Greece", "Greece", False),
            ("R&D-India", "India", False),
            ("OEM-HCK", "Greece", True),
            ("OEM-Seltek", "Greece", True),
        ):
            hubs[name] = uuid.uuid4()
            await conn.execute(
                "INSERT INTO hubs (id, name, lab_region, is_oem) "
                "VALUES ($1, $2::hub_name, $3::lab_region, $4)",
                hubs[name],
                name,
                region,
                oem,
            )
        for name, cal in (
            ("R&D-Greece", (5, 12, 0, 0, 25)),
            ("OEM-HCK", (6, 13, 7, 7, 20)),
            ("OEM-Seltek", (6, 13, 7, 7, 20)),
        ):
            await conn.execute(
                "INSERT INTO hub_work_calendars (id, hub_id, weekdays_per_week, "
                "national_holiday_days, medical_leave_days, casual_leave_days, "
                "annual_leave_days) VALUES ($1, $2, $3, $4, $5, $6, $7)",
                uuid.uuid4(),
                hubs[name],
                *cal,
            )
        engineers: dict[str, uuid.UUID] = {}
        for name, (hub, cats) in _ENGINEERS.items():
            engineers[name] = uuid.uuid4()
            await conn.execute(
                "INSERT INTO engineers (id, name, hub_id, fte, allowed_categories) "
                "VALUES ($1, $2, $3, 1.0, $4::engineer_allowed_category[])",
                engineers[name],
                name,
                hubs[hub],
                cats,
            )
        dims = await conn.fetch("SELECT id FROM scoring_dimensions")
        for name, (hub, cat, status, prio, leader, steps, type_, code) in _PROJECTS.items():
            pid = uuid.uuid4()
            await conn.execute(
                "INSERT INTO projects (id, name, external_code, hub_id, category, status, "
                "frozen, delay_weeks, carry_over, type, priority, schedule_stale, "
                "leader_engineer_id) VALUES ($1, $2, $3, $4, $5::project_category, "
                "$6::project_status, false, 0, false, $7::project_type, "
                "$8::project_priority, false, $9)",
                pid,
                name,
                code,
                hubs[hub],
                cat,
                status,
                type_,
                prio,
                engineers[leader] if leader else None,
            )
            for seq, (step, weeks, in_progress) in enumerate(steps, start=1):
                await conn.execute(
                    "INSERT INTO project_workflow_steps (id, project_id, step_template_id, "
                    "sequence_order, duration_weeks, status, percent_complete, "
                    "actual_start_week, eng_conflict, chamber_overlap) VALUES ($1, $2, $3, "
                    "$4, $5, $6::workflow_step_status, $7, $8, false, false)",
                    uuid.uuid4(),
                    pid,
                    step,
                    seq,
                    weeks,
                    "In Progress" if in_progress else "Not Started",
                    40 if in_progress else 0,
                    30 if in_progress else None,
                )
            if name == "B1":
                sid = uuid.uuid4()
                await conn.execute(
                    "INSERT INTO priority_scores (id, project_id, hard_gates, weighted_score, "
                    "normalized_pct, suggested_band, rubric_version) "
                    "VALUES ($1, $2, '{}', 59, 20, 'P4', 1)",
                    sid,
                    pid,
                )
                for d in dims:
                    await conn.execute(
                        "INSERT INTO priority_dimension_scores VALUES ($1, $2, 1)", sid, d["id"]
                    )
    finally:
        await conn.close()


def _projects(url: str) -> dict[str, asyncpg.Record]:
    return {
        r["name"]: r
        for r in _rows(
            url,
            "SELECT p.name, e.name AS leader, p.leader_is_provisional AS provisional, "
            "p.schedule_stale AS stale, CAST(p.type AS text) AS type, "
            "CAST(p.scoring_tags AS text[]) AS tags FROM projects p "
            "LEFT JOIN engineers e ON e.id = p.leader_engineer_id",
        )
    }


def test_migrations_p29a_p29b_up_down_up_on_data():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "p27a_project_scoring_tags"], url)
        assert r.returncode == 0, r.stderr
        asyncio.run(_load_world(url))

        r = run_alembic(["upgrade", "p29b_bc_type_regulatory"], url)
        assert r.returncode == 0, r.stderr
        assert (
            "p29a: 2 member hub(s) under their capacity hub; 5 engineer(s) changed; "
            "2 member calendar row(s) deleted; 4 provisional leader(s) assigned; "
            "1 In Progress design stage(s) reset" in r.stderr
        ), r.stderr
        assert "p29b: retyped 2 BC project(s) to RC; created 1 score row(s)" in r.stderr

        # --- 1. capacity hubs ---------------------------------------------------------
        hubs = {
            r["name"]: r["parent"]
            for r in _rows(
                url,
                "SELECT CAST(h.name AS text) AS name, CAST(p.name AS text) AS parent "
                "FROM hubs h LEFT JOIN hubs p ON p.id = h.capacity_hub_id",
            )
        }
        assert hubs == {
            "R&D-Greece": None,
            "R&D-India": None,
            "OEM-HCK": "R&D-Greece",
            "OEM-Seltek": "R&D-Greece",
        }

        # --- 2.-4. engineers ----------------------------------------------------------
        engs = {
            r["name"]: (r["hub"], r["counts"], list(r["cats"]))
            for r in _rows(
                url,
                "SELECT e.name, CAST(h.name AS text) AS hub, e.counts_in_capacity AS counts, "
                "CAST(e.allowed_categories AS text[]) AS cats FROM engineers e "
                "JOIN hubs h ON h.id = e.hub_id",
            )
        }
        assert engs == {
            "Theoni": ("R&D-Greece", False, ["A-OEM", "B-OEM", "C-OEM"]),
            "Dimopoulou": ("R&D-Greece", True, ["A+", "A", "OEM", "A-OEM", "B-OEM", "C-OEM"]),
            "Lioumis": ("R&D-Greece", True, ["A+", "A", "A-OEM", "B-OEM", "C-OEM"]),
            "Kanarios": ("R&D-Greece", True, ["A+", "A", "A-OEM", "B-OEM", "C-OEM"]),
            "Dipak": ("R&D-India", False, ["A"]),
        }

        # --- 5. member calendars retired ----------------------------------------------
        cals = _rows(
            url,
            "SELECT CAST(h.name AS text) AS name FROM hub_work_calendars c "
            "JOIN hubs h ON h.id = c.hub_id",
        )
        assert {c["name"] for c in cals} == {"R&D-Greece"}

        # --- 6. provisional leaders (= the seed rule, test_p29a_walk_equals_the_seed_rule)
        projects = _projects(url)
        assert {n: projects[n]["leader"] for n in _EXPECTED_LEADERS} == _EXPECTED_LEADERS
        assert {n for n, p in projects.items() if p["provisional"]} == set(_EXPECTED_LEADERS)
        assert projects["T1"]["leader"] == "Theoni" and not projects["T1"]["provisional"]
        assert projects["R1"]["leader"] is None  # not a member hub: stays blank

        # --- 7. one In Progress design stage per leader --------------------------------
        stages = {
            r["name"]: (r["status"], r["pct"], r["start"])
            for r in _rows(
                url,
                "SELECT p.name, CAST(s.status AS text) AS status, s.percent_complete AS pct, "
                "s.actual_start_week AS start FROM project_workflow_steps s "
                "JOIN projects p ON p.id = s.project_id WHERE p.name IN ('L1', 'L4', 'G3')",
            )
        }
        assert stages == {
            "L1": ("In Progress", 40, 30),  # Dimopoulou's first
            "L4": ("Not Started", 0, None),  # Kanarios already has G3's
            "G3": ("In Progress", 40, 30),
        }

        # --- 8. stale: schedulable projects of Greece and its members ------------------
        stale = {n for n, p in projects.items() if p["stale"]}
        assert stale == {"G1", "G3", "T1", "L1", "L4", "L2"}

        # --- p29b: BC -> RC, tag, score 5 ----------------------------------------------
        assert (projects["B1"]["type"], list(projects["B1"]["tags"])) == (
            "RC",
            ["regulatory_compliance"],
        )
        assert (projects["B2"]["type"], list(projects["B2"]["tags"])) == (
            "RC",
            ["regulatory_compliance"],
        )
        assert (projects["B3"]["type"], list(projects["B3"]["tags"])) == ("NM", [])
        scores = {
            r["name"]: (r["rc"], float(r["ws"]), r["pct"], r["band"])
            for r in _rows(
                url,
                "SELECT p.name, pds.score AS rc, ps.weighted_score AS ws, "
                "ps.normalized_pct AS pct, CAST(ps.suggested_band AS text) AS band "
                "FROM projects p JOIN priority_scores ps ON ps.project_id = p.id "
                "JOIN priority_dimension_scores pds ON pds.priority_score_id = ps.id "
                "JOIN scoring_dimensions d ON d.id = pds.dimension_id "
                "WHERE d.key = 'regulatory_compliance'",
            )
        }
        # B1: 12 x 1 + 25 at 5 = 79 of 295 -> 27 %; B2: 25 of 295 -> 8 %.
        assert scores == {"B1": (5, 79.0, 27, "P4"), "B2": (5, 25.0, 8, "P4")}

        # --- audit rows (actor null, source tagged; no financial value) ----------------
        audits = _rows(
            url,
            "SELECT action, entity_type, actor_user_id, after_state->>'source' AS source, "
            "after_state::text AS after_text FROM audit_log_entries",
        )
        by_source: dict[tuple[str, str | None], int] = {}
        for a in audits:
            assert a["actor_user_id"] is None
            key = (a["action"], a["source"])
            by_source[key] = by_source.get(key, 0) + 1
        assert by_source == {
            ("hub.update", "capacity_hubs_adr_0042"): 2,
            ("engineer.update", "capacity_hubs_adr_0042"): 5,
            ("workflow_settings.hub_calendar_delete", "capacity_hubs_adr_0042"): 2,
            ("project.update", "provisional_leader_adr_0042"): 4,
            ("project_stage.update", "provisional_leader_adr_0042"): 1,
            ("project.update", "bc_type_regulatory_adr_0038"): 2,
            ("priority_score.update", "registration_tag_backfill"): 1,
            ("priority_score.create", "registration_tag_backfill"): 1,
        }
        leader_audits = _rows(
            url,
            "SELECT before_state, after_state FROM audit_log_entries "
            "WHERE after_state->>'source' = 'provisional_leader_adr_0042' "
            "AND action = 'project.update'",
        )
        for a in leader_audits:
            before, after = json.loads(a["before_state"]), json.loads(a["after_state"])
            assert before["leader_engineer_id"] is None and not before["leader_is_provisional"]
            assert after["leader_engineer_id"] and after["leader_is_provisional"]
            for secret in ("customer_name", "tcogs_eur", "selling_price_eur", "gross_margin_pct"):
                assert secret not in before and secret not in after

        # --- the flat-capacity-hub guard -----------------------------------------------
        async def _chain_refused() -> None:
            conn = await asyncpg.connect(_dsn(url))
            try:
                for sql in (
                    # a member of a member
                    "UPDATE hubs SET capacity_hub_id = (SELECT id FROM hubs WHERE "
                    "name = 'OEM-HCK') WHERE name = 'R&D-India'",
                    # a capacity hub with members becoming a member
                    "UPDATE hubs SET capacity_hub_id = (SELECT id FROM hubs WHERE "
                    "name = 'R&D-India') WHERE name = 'R&D-Greece'",
                    # itself
                    "UPDATE hubs SET capacity_hub_id = id WHERE name = 'R&D-India'",
                ):
                    try:
                        await conn.execute(sql)
                    except asyncpg.CheckViolationError:
                        continue
                    raise AssertionError(f"not refused: {sql}")
            finally:
                await conn.close()

        asyncio.run(_chain_refused())

        # --- downgrade to p27a ----------------------------------------------------------
        r = run_alembic(["downgrade", "p27a_project_scoring_tags"], url)
        assert r.returncode == 0, r.stderr
        cols = _rows(
            url,
            "SELECT count(*) AS n FROM information_schema.columns WHERE "
            "(table_name = 'hubs' AND column_name = 'capacity_hub_id') OR "
            "(table_name = 'engineers' AND column_name = 'counts_in_capacity') OR "
            "(table_name = 'projects' AND column_name = 'leader_is_provisional')",
        )
        assert cols[0]["n"] == 0
        projects = {
            r["name"]: r
            for r in _rows(
                url,
                "SELECT p.name, e.name AS leader, CAST(p.type AS text) AS type, "
                "CAST(p.scoring_tags AS text[]) AS tags FROM projects p "
                "LEFT JOIN engineers e ON e.id = p.leader_engineer_id",
            )
        }
        assert all(projects[n]["leader"] is None for n in _EXPECTED_LEADERS)
        assert projects["T1"]["leader"] == "Theoni"
        assert (projects["B1"]["type"], list(projects["B1"]["tags"])) == (None, [])
        assert (projects["B2"]["type"], list(projects["B2"]["tags"])) == (None, [])
        assert projects["B3"]["type"] == "NM"
        engs = {
            r["name"]: (r["hub"], list(r["cats"]))
            for r in _rows(
                url,
                "SELECT e.name, CAST(h.name AS text) AS hub, "
                "CAST(e.allowed_categories AS text[]) AS cats FROM engineers e "
                "JOIN hubs h ON h.id = e.hub_id",
            )
        }
        assert engs["Theoni"] == ("OEM-HCK", ["A-OEM", "B-OEM", "C-OEM"])
        assert engs["Dimopoulou"] == ("R&D-Greece", ["A+", "A", "OEM"])
        assert engs["Lioumis"] == ("R&D-Greece", ["A+", "A"])
        cals = _rows(
            url,
            "SELECT CAST(h.name AS text) AS name, c.weekdays_per_week AS wd, "
            "c.annual_leave_days AS ann FROM hub_work_calendars c JOIN hubs h ON h.id = c.hub_id",
        )
        assert {(c["name"], c["wd"], float(c["ann"])) for c in cals} == {
            ("R&D-Greece", 5, 25.0),
            ("OEM-HCK", 6, 20.0),
            ("OEM-Seltek", 6, 20.0),
        }
        down = _rows(
            url,
            "SELECT after_state->>'source' AS source, count(*) AS n FROM audit_log_entries "
            "WHERE after_state->>'source' LIKE '%downgrade' GROUP BY 1",
        )
        assert {d["source"]: d["n"] for d in down} == {
            "provisional_leader_adr_0042_downgrade": 4,
            "bc_type_regulatory_adr_0038_downgrade": 2,
        }
        # Scores are ordinary scores now: kept on downgrade (as p27a).
        kept = _rows(url, "SELECT count(*) AS n FROM priority_scores")
        assert kept[0]["n"] == 2

        # --- and up again: idempotent facts, nothing doubled -----------------------------
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        projects = _projects(url)
        assert {n: projects[n]["leader"] for n in _EXPECTED_LEADERS}.keys() == set(
            _EXPECTED_LEADERS
        )
        assert all(projects[n]["provisional"] for n in _EXPECTED_LEADERS)
        cats = _rows(
            url,
            "SELECT CAST(allowed_categories AS text[]) AS cats FROM engineers "
            "WHERE name = 'Dimopoulou'",
        )
        assert list(cats[0]["cats"]) == ["A+", "A", "OEM", "A-OEM", "B-OEM", "C-OEM"]
