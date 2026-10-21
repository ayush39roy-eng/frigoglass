"""ADR 0024 / ADR 0035: the client's real 2026 dataset
(`seed/extract_client_2026.py` → `seed/client_2026_seed_data.json`), the
formula workbook's roster, and the derived seed inputs
(`seed/client_2026.py`). Pure tests: no database. The DB-backed seed run is in
`tests/test_seed_scripts.py`.
"""

from __future__ import annotations

import datetime as dt
import json
from collections import Counter
from pathlib import Path
from typing import Any

import pytest

import domain_constants as dc
from models.enums import ProjectCategory, ProjectStatus, ProjectType
from scheduling.greedy import run_greedy_sgs
from scheduling.invariants import validate_invariants
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    ProjectInput,
    ScheduleInput,
    StepProgressInput,
)
from seed import client_2026 as c26
from seed import extract_client_2026 as ex

DATA_PATH = Path(__file__).resolve().parent.parent / "seed" / "client_2026_seed_data.json"


@pytest.fixture(scope="module")
def data() -> dict[str, Any]:
    loaded: dict[str, Any] = json.loads(DATA_PATH.read_text(encoding="utf-8"))
    return loaded


def _project_ids(projects: list[dict[str, Any]]) -> list[str]:
    return [str(c26.project_uuid(p["external_code"])) for p in projects]


def _order(projects: list[dict[str, Any]]) -> list[int]:
    ids = _project_ids(projects)
    return sorted(range(len(projects)), key=lambda i: c26.scheduling_order_key(projects[i], ids[i]))


def _specs(project: dict[str, Any]) -> list[c26.StepSpec]:
    workflow = "OEM" if project["hub"] in dc.OEM_HUBS else "PDD"
    lead = {(wf, cat, sid): w for wf, cat, sid, w in dc.LEAD_TIME_SEED}
    out = []
    for wf, sid, _code, _name, kind, _seq, _preds in dc.WORKFLOW_STEP_TEMPLATE_SEED:
        if wf != workflow:
            continue
        weeks = lead[(wf, project["category"], sid)]
        if kind == "lab" and not project["certification_testing_required"]:
            weeks = 0
        out.append(c26.StepSpec(sid, kind, weeks))
    return out


def _derive_all(
    projects: list[dict[str, Any]], leaders: list[str | None], current_week: int
) -> dict[int, list[c26.StepProgress]]:
    """As `seed_demo_data.seed_client_2026`: a project with no leader books
    nothing, so it uses a private ledger."""

    ledger = c26.ResourceLedger()
    progress: dict[int, list[c26.StepProgress]] = {}
    for i in _order(projects):
        p = projects[i]
        shared = c26.is_open(p) and leaders[i] is not None
        progress[i] = c26.derive_progress(
            p,
            _specs(p),
            leader=leaders[i],
            lab_region=dc.HUB_LAB_REGION[p["hub"]],
            current_week=current_week,
            ledger=ledger if shared else c26.ResourceLedger(),
        )
    return progress


#: ADR 0035: the formula workbook's roster (`RPD Capacity!I42:T50`).
WORKBOOK_ROSTER = {
    "Rishi": ("PD-India", 1.0),
    "Lokesh": ("PD-India", 1.0),
    "Zakir": ("PD-India", 1.0),
    "Pawan": ("PD-India", 1.0),
    "Nikhil": ("PD-India", 0.75),
    "Atul": ("PD-India", 0.5),
    "Rahul-Contractual": ("PD-India", 0.5),
    "Ashish": ("R&D-India", 1.0),
    "Praveer Kumar Singh": ("R&D-India", 0.5),
    "Ayush Kumar": ("R&D-India", 0.5),
    "Dimopoulou": ("R&D-Greece", 1.0),
    "Lioumis": ("R&D-Greece", 1.0),
    "Kanarios": ("R&D-Greece", 0.8),
    "Stef Marius": ("PD-Romania", 1.0),
    "Alin Boboc": ("PD-Romania", 1.0),
    "Adrian Bortoc": ("PD-Romania", 1.0),
    "Bianca": ("PD-Romania", 0.75),
}
#: ADR 0035: workbook project leaders who are not on the roster.
PROVISIONAL = {
    "Dipak": "R&D-India",
    "Elena Micu": "PD-Romania",
    "Theoni": "OEM-HCK",
    "Marian": "PD-Romania",
    "Sailesh": "PD-India",
    "Antonis": "PD-India",
}


# --- The committed JSON ------------------------------------------------------


def test_dataset_is_the_253_projects_requested_in_2026(data: dict[str, Any]) -> None:
    projects = data["projects"]
    assert data["project_count"] == len(projects) == 253
    assert all(dt.date.fromisoformat(p["request_date"]).year == 2026 for p in projects)
    assert len({p["external_code"] for p in projects}) == 253
    statuses = Counter(p["status"] for p in projects)
    assert set(statuses) <= {s.value for s in ProjectStatus}
    # Closed statuses are kept (displayed, not scheduled).
    assert statuses["Cancelled"] and statuses["Commercialized"] and statuses["On Hold"]


def test_every_project_maps_onto_the_app_vocabulary(data: dict[str, Any]) -> None:
    for p in data["projects"]:
        assert p["hub"] in dc.HUB_LAB_REGION
        ProjectCategory(p["category"])
        assert p["type"] is None or p["type"] in {t.value for t in ProjectType}
        assert p["priority"] in dc.PRIORITY_ORDER
        assert len(p["name"]) <= 300
        assert p["development_step"] is None or p["development_step"][:4] in ("PDD-", "OEM-")


def test_oem_category_rule_holds(data: dict[str, Any]) -> None:
    for p in data["projects"]:
        if p["hub"] in dc.OEM_HUBS:
            assert p["category"] in dc.OEM_CATEGORIES, p["external_code"]
        else:
            assert p["category"] in dc.NON_OEM_CATEGORIES, p["external_code"]


def test_priority_follows_marketing_rank_then_status(data: dict[str, Any]) -> None:
    for p in data["projects"]:
        rank = p["marketing_priority"]
        if rank is not None and rank <= 5:
            assert p["priority"] == "P1"
        elif rank is not None and rank <= 13:
            assert p["priority"] == "P2"
        elif p["status"] in ("Under Industrialization", "In Development"):
            assert p["priority"] == "P3"
        else:
            assert p["priority"] == "P4"


def test_charter_fields_spillover_and_end_dates(data: dict[str, Any]) -> None:
    """ADR 0035: plant (253), requesting department (237), product type (250),
    `Spillover '25` (17) and the end dates (22, of which 15 are in the plan)."""

    projects = data["projects"]
    assert sum(p["plant"] is not None for p in projects) == 253
    assert sum(p["requesting_department"] is not None for p in projects) == 237
    assert sum(p["product_type"] is not None for p in projects) == 250
    assert sum(p["spillover_2025"] for p in projects) == 17
    assert sum(p["end_date"] is not None for p in projects) == 22
    weeks = [p["target_end_week"] for p in projects if p["target_end_week"] is not None]
    assert len(weeks) == 15 and all(1 <= w <= dc.WITHIN_YEAR_WEEK for w in weeks)
    for p in projects:
        if p["end_date"] is not None:
            assert p["target_end_week"] == ex.plan_week(dt.date.fromisoformat(p["end_date"]))
    # Vocabulary: the workbook lists, plus the one department it does not list.
    assert {p["plant"] for p in projects} <= set(dc.PLANT_OPTIONS)
    assert {p["product_type"] for p in projects} - {None} <= set(dc.PRODUCT_TYPE_OPTIONS)
    departments = {p["requesting_department"] for p in projects} - {None}
    assert departments - set(dc.REQUESTING_DEPARTMENT_OPTIONS) == {"Development"}


def test_committed_roster_is_the_formula_workbook_roster(data: dict[str, Any]) -> None:
    roster = data["roster"]
    assert len(roster) == 19
    real = {r["name"]: (r["hub"], r["fte"]) for r in roster if r["fte"] > 0}
    assert real == WORKBOOK_ROSTER
    zero = sorted(r["name"] for r in roster if r["fte"] == 0)
    assert zero == ["New Hiring", "New engineer-Contractual"]
    totals: Counter[str] = Counter()
    for r in roster:
        totals[r["hub"]] += r["fte"]
    assert {h: round(v, 2) for h, v in totals.items()} == {
        "PD-India": 5.75,
        "R&D-India": 2.0,
        "R&D-Greece": 2.8,
        "PD-Romania": 3.75,
    }


def test_leaders_are_assigned_to_their_majority_hub(data: dict[str, Any]) -> None:
    for leader in data["leaders"]:
        counts = leader["hub_counts"]
        best = max(counts.values())
        assert counts[leader["hub"]] == best
        assert leader["hub"] == sorted(h for h, n in counts.items() if n == best)[0]


# --- The extractor's mapping rules (synthetic rows) -------------------------


def _row(**cells: object) -> tuple[object, ...]:
    row: list[object] = [None] * (ex.COL_LAST + 1)
    defaults = {
        ex.COL_SNO: 7,
        ex.COL_REQUEST: dt.datetime(2026, 3, 1),
        ex.COL_CATEGORY: "B",
        ex.COL_TYPE: "CO",
        ex.COL_PD_CODE: "TBD",
        ex.COL_RM_CODE: "N/A",
        ex.COL_NAME: "  A   project\n",
        ex.COL_HUB: "PD-India",
        ex.COL_STATUS: "In Que",
        ex.COL_LEADER: "Pawan",
    }
    for col, value in {**defaults, **{int(k[1:]): v for k, v in cells.items()}}.items():
        row[col] = value
    return tuple(row)


def test_extract_maps_hubs_categories_statuses_and_leaders() -> None:
    rows = [
        (6, _row(c10="OEM-Seitek", c4="B")),
        (7, _row(c10="OEM-SEITEK", c4="A-OEM", c34="Lokesh/Rahul")),
        (8, _row(c10="PD-India", c4="B-OEM", c32="Development", c52="PDD-H")),
        (9, _row(c32="Industrialization", c2=3, c18="Yes", c44="All")),
        (10, _row(c1=dt.datetime(2025, 12, 1))),  # not 2026: dropped
        (11, _row(c5="BC", c52="Not Started", c34=None)),
    ]
    out = ex.extract(rows)["projects"]
    assert [p["excel_row"] for p in out] == [6, 7, 8, 9, 11]
    assert out[0]["hub"] == "OEM-Seltek" and out[0]["category"] == "B-OEM"
    assert out[1]["hub"] == "OEM-Seltek" and out[1]["leader"] == "Lokesh"
    assert out[2]["category"] == "B" and out[2]["status"] == "In Development"
    assert out[2]["development_step"] == "PDD-H" and out[2]["priority"] == "P3"
    assert out[3]["status"] == "Under Industrialization" and out[3]["priority"] == "P1"
    assert out[3]["certification_testing_required"] is True and out[3]["customer"] == "ALL"
    assert out[0]["certification_testing_required"] is False  # blank → false
    assert out[4]["type"] is None and out[4]["excel_type"] == "BC"
    assert out[4]["development_step"] is None and out[4]["leader"] is None
    assert out[0]["name"] == "A project" and out[0]["priority"] == "P4"


def test_extract_charter_fields_end_date_and_spillover() -> None:
    rows = [
        (6, _row(c9=" OEM-Seitek ", c11="ICM", c12="Marketing/Sales", c45=dt.datetime(2026, 8, 1))),
        (7, _row(c45=45992, c56="Yes")),  # Excel serial 2025-12-01: not imported
        (8, _row(c45=dt.datetime(2025, 12, 30), c56="y")),  # ISO 2026-W01
        (9, _row(c56="No")),
    ]
    out = ex.extract(rows)["projects"]
    assert out[0]["plant"] == "OEM-Seitek" and out[0]["product_type"] == "ICM"
    assert out[0]["requesting_department"] == "Marketing/Sales"
    assert out[0]["end_date"] == "2026-08-01" and out[0]["target_end_week"] == 31
    assert out[0]["spillover_2025"] is False
    assert out[1]["end_date"] == "2025-12-01" and out[1]["target_end_week"] is None
    assert out[1]["spillover_2025"] is True
    assert out[2]["target_end_week"] == 1 and out[2]["spillover_2025"] is True
    assert out[3]["end_date"] is None and out[3]["spillover_2025"] is False
    assert out[3]["plant"] is None and out[3]["requesting_department"] is None


def test_plan_week_rule() -> None:
    assert ex.plan_week(dt.date(2026, 1, 5)) == 2
    assert ex.plan_week(dt.date(2026, 12, 31)) == 52  # ISO 2026-W53 → 52
    assert ex.plan_week(dt.date(2027, 3, 1)) == 52 + 9
    assert ex.plan_week(dt.date(2027, 9, 1)) is None  # past W78
    assert ex.plan_week(dt.date(2025, 6, 1)) is None  # before the plan year
    assert ex.plan_week(None) is None


def test_extract_roster_reads_the_four_blocks() -> None:
    def row(**cells: object) -> tuple[object, ...]:
        values: list[object] = [None] * 20
        for letter, value in cells.items():
            values[ord(letter) - ord("A")] = value
        return tuple(values)

    rows = {
        39: row(I="India (PD)", L="India (R&D)", O="Greece (R&D)", R="Romania (PD)"),
        41: row(
            **{
                col: text
                for start in "ILOR"
                for col, text in zip(
                    (start, chr(ord(start) + 1), chr(ord(start) + 2)),
                    ("Engineer Name", "Resource Count", "Remarks"),
                    strict=True,
                )
            }
        ),
        42: row(I="Rishi", J=1, L="Ashish", M=1.0, O="Kanarios", P=0.8, Q="Sourcing "),
        43: row(I="New Hiring", J=0, K="To be hired"),
    }
    out = ex.extract_roster(rows)
    assert [(r["name"], r["hub"], r["fte"]) for r in out] == [
        ("Rishi", "PD-India", 1.0),
        ("New Hiring", "PD-India", 0.0),
        ("Ashish", "R&D-India", 1.0),
        ("Kanarios", "R&D-Greece", 0.8),
    ]
    assert out[3]["remark"] == "Sourcing" and out[0]["cell"] == "I42:J42"
    with pytest.raises(ValueError, match="roster block"):
        ex.extract_roster({**rows, 39: row(I="Somewhere")})
    with pytest.raises(ValueError, match="Resource Count"):
        ex.extract_roster({**rows, 42: row(I="Rishi", J="one")})


def test_extract_external_codes_are_unique_and_fall_back() -> None:
    rows = [
        (6, _row(c6="26-00412")),
        (7, _row(c6="26-00412", c7="26ROM005")),  # duplicate PD code → RM code
        (8, _row(c6="TBA", c7="26ROM005")),  # duplicate RM code → generated
        (9, _row(c6="TBA", c7="Missing")),  # same S.No. 7 → suffixed
    ]
    out = ex.extract(rows)["projects"]
    assert [p["external_code"] for p in out] == ["26-00412", "26ROM005", "26-S0007", "26-S0007-2"]
    assert [p["code_source"] for p in out] == [
        "pd_database",
        "rm_saving",
        "generated",
        "generated",
    ]


def test_extract_rejects_unknown_hub_and_status() -> None:
    with pytest.raises(ValueError, match="RPDO hub"):
        ex.extract([(6, _row(c10="Atlantis"))])
    with pytest.raises(ValueError, match="Project Status"):
        ex.extract([(6, _row(c32="Paused"))])


# --- Derived seed inputs -----------------------------------------------------


def test_roster_is_the_workbook_roster_plus_provisional_leaders(data: dict[str, Any]) -> None:
    """ADR 0035: the 17 roster people with the workbook's hub and FTE, the two
    0-FTE placeholders not created, and the 6 workbook leaders who are not on
    the roster added as provisional engineers at FTE 1.0. No synthetic one."""

    build = c26.build_roster(data)
    by_name = {e.name: e for e in build.engineers}
    assert len(by_name) == len(build.engineers) == 23
    real = {n: (e.hub, e.fte) for n, e in by_name.items() if not e.provisional}
    assert real == WORKBOOK_ROSTER
    provisional = {n: e.hub for n, e in by_name.items() if e.provisional}
    assert provisional == PROVISIONAL
    assert all(by_name[n].fte == c26.PROVISIONAL_LEADER_FTE for n in PROVISIONAL)
    assert sorted(str(r["name"]) for r in build.placeholders) == [
        "New Hiring",
        "New engineer-Contractual",
    ]
    assert all(e.fte >= c26.MIN_FTE for e in build.engineers)
    assert not any("Engineer " in n for n in by_name)
    for name in WORKBOOK_ROSTER:
        assert by_name[name].allowed_categories == c26.CLIENT_APP_ALLOWED_CATEGORIES[name]
    # A provisional leader may lead every category of the projects they lead.
    for name in PROVISIONAL:
        led = {p["category"] for p in data["projects"] if c26.canonical_leader(p["leader"]) == name}
        assert set(by_name[name].allowed_categories) == led


def test_leaders_are_the_workbook_leaders_never_reassigned(data: dict[str, Any]) -> None:
    projects = data["projects"]
    build = c26.build_roster(data)
    leaders = c26.project_leaders(projects, build.engineers)
    for p, leader in zip(projects, leaders, strict=True):
        assert leader == c26.LEADER_ALIASES.get(p["leader"], p["leader"])
    blank = [p for p, leader in zip(projects, leaders, strict=True) if leader is None]
    assert len(blank) == 20
    assert Counter(p["hub"] for p in blank) == {
        "OEM-HCK": 9,
        "OEM-Seltek": 8,
        "PD-India": 1,
        "PD-Romania": 1,
        "R&D-Greece": 1,
    }
    assert sum(c26.is_open(p) for p in blank) == 18


def test_carry_over_and_reg_year(data: dict[str, Any]) -> None:
    pairs = [c26.carry_over_and_reg_year(p) for p in data["projects"]]
    assert Counter(pairs) == {(True, 2025): 17, (False, 2026): 236}


def test_derived_dims_land_in_the_projects_band(data: dict[str, Any]) -> None:
    for p in data["projects"]:
        dims = c26.derive_dims(p["external_code"], p["priority"], p["marketing_priority"])
        assert len(dims) == 13 and all(1 <= d <= 5 for d in dims)
        assert c26.band_for(dims)[2] == p["priority"]
    assert c26.derive_dims("X", "P1", 1) == c26.derive_dims("X", "P1", 1)  # deterministic


@pytest.mark.parametrize("current_week", [31, 42])
def test_derived_progress_is_consistent(data: dict[str, Any], current_week: int) -> None:
    projects = data["projects"]
    leaders = c26.project_leaders(projects, c26.build_roster(data).engineers)
    progress = _derive_all(projects, leaders, current_week)
    busy_design: Counter[str] = Counter()
    lab_tails: Counter[str] = Counter()
    for i, p in enumerate(projects):
        specs = _specs(p)
        steps = progress[i]
        assert len(steps) == len(specs) == dc.STEPS_PER_WORKFLOW
        previous_end = 0
        for spec, sp in zip(specs, steps, strict=True):
            if spec.duration == 0:
                assert sp == c26.NOT_STARTED  # skipped steps carry no progress
                continue
            if sp.status == "Done":
                assert sp.percent_complete == 100
                assert sp.actual_start_week is not None and sp.actual_end_week is not None
                assert 1 <= sp.actual_start_week <= sp.actual_end_week < current_week
                assert sp.actual_start_week > previous_end  # back to back, in order
                previous_end = sp.actual_end_week
            elif sp.status == "In Progress":
                assert sp.percent_complete == c26.IN_PROGRESS_PERCENT
                assert sp.actual_end_week is None
                assert sp.actual_start_week is not None
                assert previous_end < sp.actual_start_week <= current_week
                previous_end = current_week
                if spec.kind == "design" and leaders[i] is not None:
                    busy_design[str(leaders[i])] += 1
                elif spec.kind == "lab" and leaders[i] is not None:
                    lab_tails[dc.HUB_LAB_REGION[p["hub"]]] += 1
            else:
                assert sp == c26.NOT_STARTED
        statuses = {sp.status for spec, sp in zip(specs, steps, strict=True) if spec.duration}
        if p["status"] in ("In Queue", "On Hold", "Cancelled"):
            assert statuses == {"Not Started"}
        elif p["status"] == "Commercialized":
            assert statuses == {"Done"}
        else:
            assert "Done" in statuses
    # One In Progress design step per leader; lab tails fit the platforms.
    assert all(n == 1 for n in busy_design.values())
    platforms: Counter[str] = Counter()
    for _code, region, plat, *_rest, stages in dc.CHAMBER_SEED:
        if stages:
            platforms[region] += plat
    assert all(lab_tails[r] <= platforms[r] for r in lab_tails)


def test_seed_inputs_schedule_without_invariant_violations(data: dict[str, Any]) -> None:
    """The derived inputs are a valid scheduler input at the pinned test week:
    no data errors, no engineer/chamber conflicts, every invariant holds. The
    18 open projects with a blank leader are left out with `no_leader`
    (ADR 0035). CAT_NOT_ALLOWED may be raised now (the client app's
    categories); it is a warning, not a block."""

    projects = data["projects"]
    current_week = dc.CURRENT_WEEK
    roster = c26.build_roster(data).engineers
    leaders = c26.project_leaders(projects, roster)
    progress = _derive_all(projects, leaders, current_week)
    ids = _project_ids(projects)
    schedule_input = ScheduleInput(
        projects=tuple(
            ProjectInput(
                project_id=ids[i],
                name=p["name"],
                hub=p["hub"],
                status=p["status"],
                category=p["category"],
                priority=p["priority"],
                frozen=False,
                leader_engineer_id=(
                    str(c26.engineer_uuid(leaders[i])) if leaders[i] is not None else None
                ),
                workflow_id="OEM" if p["hub"] in dc.OEM_HUBS else "PDD",
                certification_testing_required=p["certification_testing_required"],
                step_progress=tuple(
                    StepProgressInput(
                        step_id=spec.step_id,
                        status=sp.status,
                        percent_complete=sp.percent_complete,
                        actual_start_week=sp.actual_start_week,
                        actual_end_week=sp.actual_end_week,
                        remaining_weeks_override=None,
                    )
                    for spec, sp in zip(_specs(p), progress[i], strict=True)
                ),
            )
            for i, p in enumerate(projects)
        ),
        engineers=tuple(
            EngineerInput(
                engineer_id=str(c26.engineer_uuid(e.name)),
                name=e.name,
                hub=e.hub,
                allowed_categories=e.allowed_categories,
                fte=e.fte,
            )
            for e in roster
        ),
        chambers=tuple(
            ChamberInput(
                chamber_id=str(c26.chamber_uuid(code)),
                code=code,
                lab_region=region,
                max_concurrent=platforms,
                allowed_stages=stages,
                efficiency=eff,
            )
            for code, region, platforms, eff, _m, _b, _c, stages in dc.CHAMBER_SEED
        ),
        current_week=current_week,
    )
    output = run_greedy_sgs(schedule_input)
    assert not any(o.data_error for o in output.project_outcomes)
    outcomes = output.project_outcomes
    assert not any(o.eng_conflict or o.overlap for o in outcomes)
    assert sum(o.excluded for o in output.project_outcomes) == 61
    no_leader = {o.project_id for o in outcomes if o.no_leader}
    assert len(no_leader) == 18
    assert all(o.left_out for o in outcomes if o.no_leader)
    assert no_leader == {
        ids[i] for i, p in enumerate(projects) if leaders[i] is None and c26.is_open(p)
    }
    assert validate_invariants(schedule_input, output, check_determinism=False) == ()
