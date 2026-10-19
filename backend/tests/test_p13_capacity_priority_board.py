"""P13-T11 / P13-T12 backend (docs/API_CONTRACT_P13.md §6).

- `HubCapacityRow.design_load_by_priority` / `lab_load_by_priority`: exact
  per-bucket values, and on the real-scheduler seed they sum exactly to the
  served `design_load_weeks` / `lab_load_weeks` on every row, unfiltered and
  under every region and hub.
- `ClassBreakdownRow.deliverable_by_priority` / `left_out_by_priority` /
  `by_hub`: each sums to the row's counts; `by_hub` lists only in-filter hubs.
- `PriorityBoardColumn.design_weeks` / `lab_weeks`: the remaining run load of
  the column's cards; the new board filters (q, category, type, status_,
  leader_engineer_id) AND with scope / hub / region and the totals follow.
- No engineer-level figure is added (OQ #8).
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    RoleName,
    SolverType,
    WorkflowStepStatus,
)
from models.hub import Hub
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.capacity_priority import PRIORITY_BUCKETS, priority_bucket, split_to_total
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import (
    act_as,
    add_outcome,
    client_for,
    plan_step,
    set_progress,
    stepped_project,
)

BUCKETS = ["P1", "P2", "P3", "P4", "Queue"]
REGIONS = ("Greece", "India", "Romania")


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _get(client, path: str, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, (path, resp.text)
    return resp.json()


def _total(split: dict) -> float:
    assert list(split) == BUCKETS
    return round(sum(split.values()), 2)


# --- pure helpers ----------------------------------------------------------------------------


def test_priority_bucket_mapping():
    assert [priority_bucket(p) for p in ProjectPriority] == ["P1", "P2", "P3", "P4", "Queue"]
    assert priority_bucket(None) == "Queue"
    assert PRIORITY_BUCKETS == tuple(BUCKETS)


def test_split_to_total_puts_rounding_residual_on_largest_bucket():
    split = split_to_total({"P1": 1 / 3, "P2": 1 / 3, "Queue": 1 / 3}, 1.0)
    assert round(sum(split.values()), 2) == 1.0
    assert split["P4"] == 0.0 and split["P3"] == 0.0
    assert split["P1"] == 0.34 and split["P2"] == split["Queue"] == 0.33
    assert split_to_total({}, 0) == dict.fromkeys(BUCKETS, 0.0)


# --- hand-built fixture: exact values --------------------------------------------------------


async def _capacity_fixture(db_session) -> SimpleNamespace:
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    pd_india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    rd_india = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    run = await make_schedule_run(db_session, is_active=True)  # current_week 31
    gr_p1 = await stepped_project(db_session, greece, name="GR P1", priority=ProjectPriority.P1)
    gr_q = await stepped_project(db_session, greece, name="GR Q", priority=ProjectPriority.Q)
    pdi_p2 = await stepped_project(db_session, pd_india, name="PDI P2", priority=ProjectPriority.P2)
    pdi_none = await stepped_project(
        db_session, pd_india, name="PDI none", priority=None, category=ProjectCategory.B
    )
    rdi_p4 = await stepped_project(db_session, rd_india, name="RDI P4", priority=ProjectPriority.P4)
    # PDD-A/E design, PDD-F/H lab.
    await plan_step(db_session, run, gr_p1, "PDD-A", 31, 40)  # design 10
    await plan_step(db_session, run, gr_p1, "PDD-F", 41, 44)  # lab 4
    await plan_step(db_session, run, gr_q, "PDD-A", 31, 35)  # design 5
    await plan_step(db_session, run, gr_q, "PDD-F", 36, 37, skipped=True)  # skipped → 0
    await plan_step(db_session, run, pdi_p2, "PDD-E", 31, 37)  # design 7
    await plan_step(db_session, run, pdi_p2, "PDD-H", 38, 40)  # lab 3
    await plan_step(db_session, run, pdi_none, "PDD-A", 31, 32)  # design 2
    await plan_step(db_session, run, pdi_none, "PDD-F", 33, 38)  # lab 6
    await plan_step(db_session, run, rdi_p4, "PDD-E", 31, 33)  # design 3
    await plan_step(db_session, run, rdi_p4, "PDD-H", 34, 34)  # lab 1
    await add_outcome(db_session, run, gr_p1, within_year=True)
    await add_outcome(db_session, run, gr_q, within_year=False, left_out=True, projected=None)
    await add_outcome(db_session, run, pdi_p2, within_year=True)
    await add_outcome(db_session, run, pdi_none, within_year=False, left_out=True, projected=None)
    await add_outcome(db_session, run, rdi_p4, within_year=True)
    return SimpleNamespace(greece=greece, pd_india=pd_india, rd_india=rd_india, run=run)


async def test_hub_rows_priority_split_exact(db_session):
    f = await _capacity_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/hubs")
    rows = {r["hub"]: r for r in body["rows"]}
    gr, pdi, rdi = rows["R&D-Greece"], rows["PD-India"], rows["R&D-India"]
    assert gr["design_load_by_priority"] == {"P1": 10.0, "P2": 0.0, "P3": 0.0, "P4": 0.0,
                                             "Queue": 5.0}
    assert gr["lab_load_by_priority"] == {"P1": 4.0, "P2": 0.0, "P3": 0.0, "P4": 0.0,
                                          "Queue": 0.0}
    assert pdi["design_load_by_priority"] == {"P1": 0.0, "P2": 7.0, "P3": 0.0, "P4": 0.0,
                                              "Queue": 2.0}
    assert rdi["design_load_by_priority"] == {"P1": 0.0, "P2": 0.0, "P3": 0.0, "P4": 3.0,
                                              "Queue": 0.0}
    # Lab is region-level (India = PD-India + R&D-India), repeated on both rows.
    india_lab = {"P1": 0.0, "P2": 3.0, "P3": 0.0, "P4": 1.0, "Queue": 6.0}
    assert pdi["lab_load_by_priority"] == rdi["lab_load_by_priority"] == india_lab
    for row in body["rows"]:
        assert _total(row["design_load_by_priority"]) == row["design_load_weeks"]
        assert _total(row["lab_load_by_priority"]) == row["lab_load_weeks"]
    assert (gr["design_load_weeks"], pdi["lab_load_weeks"]) == (15, 10.0)
    # Served totals: design per hub (15 + 9 + 3); lab per region ONCE (Greece 4 + India 10,
    # not 4 + 10 + 10 as summing the hub rows would give).
    t = body["totals"]
    assert (t["design_load_weeks"], t["lab_load_weeks"]) == (27, 14.0)
    assert t["design_load_by_priority"] == {"P1": 10.0, "P2": 7.0, "P3": 0.0, "P4": 3.0,
                                            "Queue": 7.0}
    assert t["lab_load_by_priority"] == {"P1": 4.0, "P2": 3.0, "P3": 0.0, "P4": 1.0,
                                         "Queue": 6.0}
    assert t["lab_regions"] == ["Greece", "India"]
    # No engineers / chambers in this fixture: capacity 0 with load > 0 → null, full.
    assert (t["design_booked_pct_year"], t["design_booking_status_year"]) == (None, "full")
    _assert_totals_reconcile(body)
    # The utilization matrix gains no engineer-level priority figure (OQ #8).
    async with client_for(db_session) as client:
        matrix = await _get(client, "/capacity/utilization-matrix")
    assert set(matrix) == {"has_active_schedule_run", "schedule_run_version", "engineers",
                           "chambers"}
    assert f.run.id


async def test_class_breakdown_priority_and_hub_split_exact(db_session):
    await _capacity_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/class-breakdown")
        india = await _get(client, "/capacity/class-breakdown", region="India")
    rows = {r["category"]: r for r in body["rows"]}
    a, b = rows["A"], rows["B"]
    assert (a["deliverable_count"], a["left_out_count"]) == (3, 1)
    assert a["deliverable_by_priority"] == {"P1": 1, "P2": 1, "P3": 0, "P4": 1, "Queue": 0}
    assert a["left_out_by_priority"] == {"P1": 0, "P2": 0, "P3": 0, "P4": 0, "Queue": 1}
    assert a["by_hub"] == [
        {"hub": "PD-India", "deliverable": 1, "left_out": 0},
        {"hub": "R&D-Greece", "deliverable": 1, "left_out": 1},
        {"hub": "R&D-India", "deliverable": 1, "left_out": 0},
    ]
    # A null-priority project is in the Queue bucket.
    assert b["left_out_by_priority"]["Queue"] == 1 and b["left_out_count"] == 1
    assert b["by_hub"] == [{"hub": "PD-India", "deliverable": 0, "left_out": 1}]
    assert rows["C"]["by_hub"] == [] and _total(rows["C"]["deliverable_by_priority"]) == 0
    # Region narrowing: Greece's projects vanish from every split.
    india_a = {r["category"]: r for r in india["rows"]}["A"]
    assert india_a["left_out_count"] == 0 and india_a["left_out_by_priority"]["Queue"] == 0
    assert [h["hub"] for h in india_a["by_hub"]] == ["PD-India", "R&D-India"]


async def test_class_breakdown_excludes_non_schedulable_statuses(db_session):
    """P13-F06: Commercialized, On Hold and Cancelled projects in the active run are counted
    in neither Deliverable nor Left out, nor in the priority splits, `by_hub` or the total."""
    f = await _capacity_fixture(db_session)
    excluded = (
        ProjectStatus.COMMERCIALIZED,
        ProjectStatus.ON_HOLD,
        ProjectStatus.CANCELLED,
    )
    for i, status in enumerate(excluded):
        p = await stepped_project(
            db_session, f.greece, name=f"GR {status.value}", status=status,
            priority=ProjectPriority.P1,
        )
        await add_outcome(db_session, f.run, p, within_year=True)
        q = await stepped_project(
            db_session, f.rd_india, name=f"RDI {status.value} {i}", status=status,
            priority=ProjectPriority.P3,
        )
        await add_outcome(db_session, f.run, q, within_year=False, left_out=True, projected=None)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/class-breakdown")
    a = {r["category"]: r for r in body["rows"]}["A"]
    # Identical to the fixture without the six non-schedulable projects.
    assert (a["deliverable_count"], a["left_out_count"], a["total_count"]) == (3, 1, 4)
    assert a["deliverable_by_priority"] == {"P1": 1, "P2": 1, "P3": 0, "P4": 1, "Queue": 0}
    assert a["left_out_by_priority"] == {"P1": 0, "P2": 0, "P3": 0, "P4": 0, "Queue": 1}
    assert a["by_hub"] == [
        {"hub": "PD-India", "deliverable": 1, "left_out": 0},
        {"hub": "R&D-Greece", "deliverable": 1, "left_out": 1},
        {"hub": "R&D-India", "deliverable": 1, "left_out": 0},
    ]
    _assert_class_reconciles(body)


async def test_class_breakdown_no_active_run_has_empty_splits(db_session):
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/class-breakdown")
    assert body["has_active_schedule_run"] is False
    for row in body["rows"]:
        assert row["deliverable_by_priority"] == dict.fromkeys(BUCKETS, 0)
        assert row["left_out_by_priority"] == dict.fromkeys(BUCKETS, 0)
        assert row["by_hub"] == []


# --- real-scheduler seed: reconciliation -----------------------------------------------------


async def _seeded(db_session) -> SimpleNamespace:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    return SimpleNamespace(hubs=hubs, run=run)


def _assert_capacity_reconciles(body: dict) -> None:
    for row in body["rows"]:
        assert _total(row["design_load_by_priority"]) == row["design_load_weeks"], row["hub"]
        assert _total(row["lab_load_by_priority"]) == row["lab_load_weeks"], row["hub"]
    _assert_totals_reconcile(body)


def _booked(load: float, cap: float) -> float | None:
    return None if cap == 0 else round(load / cap * 100, 2)


def _assert_totals_reconcile(body: dict) -> None:
    """`totals`: design Σ over hub rows; lab Σ over distinct lab regions (once each)."""

    rows, t = body["rows"], body["totals"]
    assert t["hubs"] == [r["hub"] for r in rows]
    one_per_region = {}
    for r in rows:
        one_per_region.setdefault(r["lab_region"], r)
    assert t["lab_regions"] == sorted(one_per_region)
    lab_rows = list(one_per_region.values())
    assert t["design_load_weeks"] == sum(r["design_load_weeks"] for r in rows)
    for key in ("design_capacity_year", "design_capacity_remaining"):
        assert t[key] == round(sum(r[key] for r in rows), 2), key
    for key in ("lab_load_weeks", "lab_capacity_year", "lab_capacity_remaining"):
        assert t[key] == round(sum(r[key] for r in lab_rows), 2), key
    for bucket in BUCKETS:
        assert t["design_load_by_priority"][bucket] == round(
            sum(r["design_load_by_priority"][bucket] for r in rows), 2
        )
        assert t["lab_load_by_priority"][bucket] == round(
            sum(r["lab_load_by_priority"][bucket] for r in lab_rows), 2
        )
    assert _total(t["design_load_by_priority"]) == t["design_load_weeks"]
    assert _total(t["lab_load_by_priority"]) == t["lab_load_weeks"]
    for kind in ("design", "lab"):
        for basis in ("year", "remaining"):
            load, cap = t[f"{kind}_load_weeks"], t[f"{kind}_capacity_{basis}"]
            pct = t[f"{kind}_booked_pct_{basis}"]
            assert pct == _booked(load, cap), (kind, basis)
            status = t[f"{kind}_booking_status_{basis}"]
            if pct is None:
                assert status == ("full" if load > 0 else "available")
            else:
                assert status == (
                    "full" if pct >= 100 else "near_full" if pct >= 85 else "available"
                )


def _assert_class_reconciles(body: dict) -> None:
    for row in body["rows"]:
        assert row["total_count"] == row["deliverable_count"] + row["left_out_count"]
        assert _total(row["deliverable_by_priority"]) == row["deliverable_count"]
        assert _total(row["left_out_by_priority"]) == row["left_out_count"]
        assert sum(h["deliverable"] for h in row["by_hub"]) == row["deliverable_count"]
        assert sum(h["left_out"] for h in row["by_hub"]) == row["left_out_count"]
        assert [h["hub"] for h in row["by_hub"]] == sorted(h["hub"] for h in row["by_hub"])
        assert all(h["deliverable"] + h["left_out"] > 0 for h in row["by_hub"])


async def test_seeded_splits_reconcile_unfiltered_by_region_and_by_hub(db_session):
    await _seeded(db_session)
    region_of = {
        h.name.value: h.lab_region.value
        for h in (await db_session.execute(select(Hub))).scalars()
    }
    hub_ids = {h.name.value: h.id for h in (await db_session.execute(select(Hub))).scalars()}
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        cap = await _get(client, "/capacity/hubs")
        klass = await _get(client, "/capacity/class-breakdown")
        _assert_capacity_reconciles(cap)
        _assert_class_reconciles(klass)
        assert sum(_total(r["design_load_by_priority"]) for r in cap["rows"]) > 0
        # Lab is counted once per region: a multi-hub region makes the naive row sum larger.
        naive_lab = round(sum(r["lab_load_weeks"] for r in cap["rows"]), 2)
        assert cap["totals"]["lab_load_weeks"] < naive_lab
        # by_hub totals per hub equal the hub-filtered class breakdown.
        for hub_name, hub_id in hub_ids.items():
            _assert_capacity_reconciles(await _get(client, "/capacity/hubs", hub_id=hub_id))
            one = await _get(client, "/capacity/class-breakdown", hub_id=hub_id)
            _assert_class_reconciles(one)
            for full_row, hub_row in zip(klass["rows"], one["rows"], strict=True):
                entry = next((h for h in full_row["by_hub"] if h["hub"] == hub_name), None)
                expected = (0, 0) if entry is None else (entry["deliverable"], entry["left_out"])
                assert (hub_row["deliverable_count"], hub_row["left_out_count"]) == expected
        for region in REGIONS:
            rcap = await _get(client, "/capacity/hubs", region=region)
            rklass = await _get(client, "/capacity/class-breakdown", region=region)
            _assert_capacity_reconciles(rcap)
            _assert_class_reconciles(rklass)
            # Region narrowing: the same rows as unfiltered, restricted to the region.
            full = {r["hub"]: r for r in cap["rows"]}
            for row in rcap["rows"]:
                assert region_of[row["hub"]] == region
                assert row["design_load_by_priority"] == full[row["hub"]]["design_load_by_priority"]
                assert row["lab_load_by_priority"] == full[row["hub"]]["lab_load_by_priority"]
            for row in rklass["rows"]:
                assert all(region_of[h["hub"]] == region for h in row["by_hub"])
            # Σ over regions = unfiltered, per category and bucket.
        per_region = [
            await _get(client, "/capacity/class-breakdown", region=r) for r in REGIONS
        ]
        for i, row in enumerate(klass["rows"]):
            for key in ("deliverable_by_priority", "left_out_by_priority"):
                for bucket in BUCKETS:
                    assert sum(b["rows"][i][key][bucket] for b in per_region) == row[key][bucket]


async def test_out_of_scope_region_zeroes_splits(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    run = await make_schedule_run(db_session, is_active=True)
    p = await stepped_project(db_session, gr, name="Greek", priority=ProjectPriority.P1)
    await plan_step(db_session, run, p, "PDD-A", 31, 34)
    await add_outcome(db_session, run, p)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        cap = await _get(client, "/capacity/hubs", region="India")
        klass = await _get(client, "/capacity/class-breakdown", region="India")
        board = await _get(client, "/priority-board", region="India")
        own = await _get(client, "/priority-board", region="Greece")
    assert cap["rows"] == []
    t = cap["totals"]
    assert (t["hubs"], t["lab_regions"], t["design_load_weeks"], t["lab_load_weeks"]) == (
        [], [], 0, 0.0
    )
    assert (t["design_booked_pct_year"], t["lab_booking_status_remaining"]) == (
        None, "available"
    )
    assert t["design_load_by_priority"] == dict.fromkeys(BUCKETS, 0.0)
    assert all(r["by_hub"] == [] and r["deliverable_count"] == 0 for r in klass["rows"])
    assert all(
        (c["count"], c["design_weeks"], c["lab_weeks"]) == (0, 0.0, 0.0) for c in board["columns"]
    )
    assert own["columns"][0]["design_weeks"] == 4.0


# --- Priority board: weeks and filters -------------------------------------------------------


async def _board_fixture(db_session) -> SimpleNamespace:
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    pdi = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    leader = await make_engineer(db_session, gr, name="Lead")
    run = await make_schedule_run(db_session, is_active=True)  # current_week 31
    alpha = await stepped_project(
        db_session, gr, name="Alpha 100%", priority=ProjectPriority.P1, leader=leader,
        external_code="24-00221_1", category=ProjectCategory.A, type=ProjectType.CO,
    )
    beta = await stepped_project(
        db_session, gr, name="Beta", priority=ProjectPriority.P1,
        category=ProjectCategory.B, type=ProjectType.NM, status=ProjectStatus.IN_QUEUE,
    )
    gamma = await stepped_project(
        db_session, pdi, name="Gamma", priority=ProjectPriority.Q, category=ProjectCategory.A,
        type=ProjectType.CO,
    )
    await stepped_project(
        db_session, gr, name="Unplanned", priority=ProjectPriority.P2, category=ProjectCategory.C
    )
    # Alpha: PDD-A Done (window in the past) → 0; PDD-E In Progress 25..34 → 31..34 = 4;
    # PDD-F lab 35..38 → 4; PDD-H lab skipped → 0.
    await set_progress(db_session, alpha, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=20, end=24)
    await set_progress(db_session, alpha, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=50,
                       start=25)
    await plan_step(db_session, run, alpha, "PDD-A", 20, 24)
    await plan_step(db_session, run, alpha, "PDD-E", 25, 34)
    await plan_step(db_session, run, alpha, "PDD-F", 35, 38)
    await plan_step(db_session, run, alpha, "PDD-H", 39, 39, skipped=True)
    # Beta: design 40..45 = 6, lab 46..47 = 2.
    await plan_step(db_session, run, beta, "PDD-A", 40, 45)
    await plan_step(db_session, run, beta, "PDD-F", 46, 47)
    # Gamma: a Done step whose window reaches the current week still adds 0.
    await set_progress(db_session, gamma, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=28, end=31)
    await plan_step(db_session, run, gamma, "PDD-A", 28, 31)
    await plan_step(db_session, run, gamma, "PDD-E", 32, 34)  # 3
    return SimpleNamespace(gr=gr, pdi=pdi, leader=leader, run=run)


def _cols(body: dict) -> dict[str, dict]:
    return {c["priority"]: c for c in body["columns"]}


async def test_board_column_weeks(db_session):
    await _board_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/priority-board")
    cols = _cols(body)
    assert (cols["P1"]["count"], cols["P1"]["design_weeks"], cols["P1"]["lab_weeks"]) == (
        2, 10.0, 6.0
    )
    # A card not in the active run adds 0.
    assert (cols["P2"]["count"], cols["P2"]["design_weeks"], cols["P2"]["lab_weeks"]) == (
        1, 0.0, 0.0
    )
    assert (cols["Q"]["design_weeks"], cols["Q"]["lab_weeks"]) == (3.0, 0.0)
    assert (cols["P3"]["design_weeks"], cols["P4"]["lab_weeks"]) == (0.0, 0.0)


async def test_board_weeks_zero_without_active_run(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await stepped_project(db_session, gr, name="Solo", priority=ProjectPriority.P3)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        body = await _get(client, "/priority-board")
    assert body["run_id"] is None
    assert all((c["design_weeks"], c["lab_weeks"]) == (0.0, 0.0) for c in body["columns"])
    assert _cols(body)["P3"]["count"] == 1


async def test_board_filters_and_totals_follow(db_session):
    f = await _board_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)

    async def names(client, **params) -> tuple[dict[str, list[str]], dict[str, dict]]:
        body = await _get(client, "/priority-board", **params)
        cols = _cols(body)
        for c in body["columns"]:
            assert c["count"] == len(c["cards"])
        return {p: [card["name"] for card in c["cards"]] for p, c in cols.items()}, cols

    async with client_for(db_session) as client:
        by_q, cols = await names(client, q="  beta ")
        assert by_q["P1"] == ["Beta"] and sum(len(v) for v in by_q.values()) == 1
        assert (cols["P1"]["design_weeks"], cols["P1"]["lab_weeks"]) == (6.0, 2.0)
        by_code, _ = await names(client, q="00221")
        assert by_code["P1"] == ["Alpha 100%"]
        # `%` and `_` are literal, not wildcards.
        by_pct, _ = await names(client, q="100%")
        assert by_pct["P1"] == ["Alpha 100%"]
        none_pct, _ = await names(client, q="a%a")
        assert sum(len(v) for v in none_pct.values()) == 0
        # As a wildcard `a_1` would match "Alpha 100%" ("a 1"); literally nothing has it.
        underscore, _ = await names(client, q="a_1")
        assert sum(len(v) for v in underscore.values()) == 0
        literal_us, _ = await names(client, q="1_1")
        assert literal_us["P1"] == ["Alpha 100%"]
        by_cat, cols = await names(client, category="A")
        assert (by_cat["P1"], by_cat["Q"], by_cat["P2"]) == (["Alpha 100%"], ["Gamma"], [])
        assert (cols["P1"]["design_weeks"], cols["P1"]["lab_weeks"]) == (4.0, 4.0)
        by_type, _ = await names(client, type="NM")
        assert by_type["P1"] == ["Beta"] and by_type["Q"] == []
        by_status, _ = await names(client, status_="In Queue")
        assert by_status["P1"] == ["Beta"] and by_status["Q"] == []
        by_leader, cols = await names(client, leader_engineer_id=f.leader.id)
        assert by_leader["P1"] == ["Alpha 100%"] and cols["P1"]["design_weeks"] == 4.0
        # ANDed with each other and with region.
        both, _ = await names(client, category="A", region="India")
        assert (both["P1"], both["Q"]) == ([], ["Gamma"])
        nothing, cols = await names(client, type="CO", status_="In Queue")
        assert all(v == [] for v in nothing.values())
        assert all(c["design_weeks"] == 0.0 for c in cols.values())

        assert (await client.get("/priority-board", params={"q": "x" * 101})).status_code == 422
        assert (await client.get("/priority-board", params={"type": "XX"})).status_code == 422
        assert (await client.get("/priority-board", params={"status_": "Nope"})).status_code == 422
        assert (
            await client.get("/priority-board", params={"category": "Z"})
        ).status_code == 422


async def test_board_filters_never_widen_scope(db_session):
    f = await _board_fixture(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[f.gr.id])
    async with client_for(db_session) as client:
        body = await _get(client, "/priority-board", q="Gamma")
        other = await _get(client, "/priority-board", hub_id=f.pdi.id, category="A")
    assert all(c["count"] == 0 for c in body["columns"])
    assert all(c["count"] == 0 and c["design_weeks"] == 0.0 for c in other["columns"])
