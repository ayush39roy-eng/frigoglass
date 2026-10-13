"""ADR 0024: the client's real 2026 dataset (`seed/extract_client_2026.py` →
`seed/client_2026_seed_data.json`) and its derived seed inputs
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
    projects: list[dict[str, Any]], leaders: list[str], current_week: int
) -> dict[int, list[c26.StepProgress]]:
    ledger = c26.ResourceLedger()
    progress: dict[int, list[c26.StepProgress]] = {}
    for i in _order(projects):
        p = projects[i]
        progress[i] = c26.derive_progress(
            p,
            _specs(p),
            leader=leaders[i],
            lab_region=dc.HUB_LAB_REGION[p["hub"]],
            current_week=current_week,
            ledger=ledger if c26.is_open(p) else c26.ResourceLedger(),
        )
    return progress


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


def test_leaders_are_assigned_to_their_majority_hub(data: dict[str, Any]) -> None:
    for leader in data["leaders"]:
        counts = leader["hub_counts"]
        best = max(counts.values())
        assert counts[leader["hub"]] == best
        assert leader["hub"] == sorted(h for h, n in counts.items() if n == best)[0]


# --- The extractor's mapping rules (synthetic rows) -------------------------


def _row(**cells: object) -> tuple[object, ...]:
    row: list[object] = [None] * (ex.COL_DEV_STEP + 1)
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


def test_every_project_gets_a_valid_leader_within_the_cap(data: dict[str, Any]) -> None:
    projects = data["projects"]
    leaders, roster = c26.assign_leaders(projects, data["leaders"], _order(projects))
    by_name = {e.name: e for e in roster}
    assert len(by_name) == len(roster)
    assert all(name in by_name for name in leaders)
    open_load = Counter(leaders[i] for i, p in enumerate(projects) if c26.is_open(p))
    assert max(open_load.values()) <= c26.MAX_OPEN_PROJECTS_PER_ENGINEER
    for hub in dc.HUB_LAB_REGION:
        assert any(e.hub == hub for e in roster), hub
    for i, p in enumerate(projects):
        if p["leader"] and not c26.is_open(p):
            assert leaders[i] == p["leader"]
        if not p["leader"]:
            assert by_name[leaders[i]].hub == p["hub"]
        if leaders[i] != p["leader"] and p["leader"]:
            # Delegated overflow: a capacity engineer of the project's own hub.
            assert not by_name[leaders[i]].from_workbook
            assert by_name[leaders[i]].hub == p["hub"]
    workbook = {str(lead["name"]): str(lead["hub"]) for lead in data["leaders"]}
    for name, hub in workbook.items():
        assert by_name[name].hub == hub and by_name[name].from_workbook


def test_derived_dims_land_in_the_projects_band(data: dict[str, Any]) -> None:
    for p in data["projects"]:
        dims = c26.derive_dims(p["external_code"], p["priority"], p["marketing_priority"])
        assert len(dims) == 13 and all(1 <= d <= 5 for d in dims)
        assert c26.band_for(dims)[2] == p["priority"]
    assert c26.derive_dims("X", "P1", 1) == c26.derive_dims("X", "P1", 1)  # deterministic


@pytest.mark.parametrize("current_week", [31, 42])
def test_derived_progress_is_consistent(data: dict[str, Any], current_week: int) -> None:
    projects = data["projects"]
    leaders, _roster = c26.assign_leaders(projects, data["leaders"], _order(projects))
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
                if spec.kind == "design":
                    busy_design[leaders[i]] += 1
                elif spec.kind == "lab":
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


def test_tune_fte_books_each_hub_at_or_just_above_its_target() -> None:
    roster = [
        c26.EngineerSeed("A", "R&D-India", 1.0, c26.ALL_CATEGORIES, True),
        c26.EngineerSeed("B", "R&D-India", 1.0, c26.ALL_CATEGORIES, False),
        c26.EngineerSeed("C", "PD-Romania", 1.0, c26.ALL_CATEGORIES, True),
    ]
    load = {"R&D-India": 40, "PD-Romania": 130}
    c26.tune_fte(roster, load)
    for hub, target in (("R&D-India", 60.0), ("PD-Romania", 100.0)):
        fte = sum(e.fte for e in roster if e.hub == hub)
        booked = load[hub] / (c26.working_weeks_per_engineer(hub) * fte) * 100
        assert target <= booked < target + 2, (hub, booked)
    # PD-Romania needed ~2.95 FTE: capacity-only engineers were added.
    assert sum(1 for e in roster if e.hub == "PD-Romania") == 3
    assert all(0 < e.fte <= c26.MAX_FTE for e in roster)


def test_tune_efficiency_books_each_region_at_or_just_above_100() -> None:
    chambers = [
        ("G1", "Greece", 0.7, 38.6, 1),
        ("G2", "Greece", 0.6, 38.6, 2),
        ("I1", "India", 0.7, 45.0, 1),
    ]
    load = {"Greece": 22.0, "India": 40.0}
    eff = c26.tune_efficiency(chambers, load)
    for region in ("Greece", "India"):
        supply = sum(w * eff[c] * pl for c, r, _e, w, pl in chambers if r == region)
        assert 100 <= load[region] / supply * 100 < 101, region
    assert all(0 < e <= c26.MAX_EFFICIENCY for e in eff.values())
    # Never above 1.0: a region whose load exceeds the maximum supply stays capped.
    capped = c26.tune_efficiency([("X", "India", 0.5, 10.0, 1)], {"India": 100.0})
    assert capped == {"X": 1.0}


def test_seed_inputs_schedule_without_invariant_violations(data: dict[str, Any]) -> None:
    """The derived inputs are a valid scheduler input at the pinned test week:
    no data errors, no engineer/chamber conflicts, every invariant holds."""

    projects = data["projects"]
    current_week = dc.CURRENT_WEEK
    leaders, roster = c26.assign_leaders(projects, data["leaders"], _order(projects))
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
                leader_engineer_id=str(c26.engineer_uuid(leaders[i])),
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
    assert not any(o.eng_conflict or o.overlap or o.cat_not_allowed for o in outcomes)
    assert sum(o.excluded for o in output.project_outcomes) == 61
    assert validate_invariants(schedule_input, output, check_determinism=False) == ()
