"""P45-T01 (docs/IMPLEMENTATION_PLAN.md P45, D45-1..D45-2): hub demand cards.

`HubCapacityRow` (`GET /capacity/hub-load`) gains:
- `design_demand_by_priority` / `lab_demand_by_priority`: the full-year demand
  (I25) by live priority bucket, summing to `design_load_weeks` /
  `lab_load_weeks` (`split_to_total`);
- `design_remaining_by_priority` / `lab_remaining_by_priority`: the remaining
  demand by bucket, summing to `*_load_remaining_weeks`;
- `design_need_p1_weeks`, `design_need_p1_p2_weeks`, `lab_need_p1_weeks`,
  `lab_need_p1_p2_weeks`: D45-2 on the served remaining split and remaining
  capacity, 2 dp.

Design per capacity hub, lab per lab region (repeated on each hub of the
region). No new statement: the splits come from the same demand snapshot.
"""

from __future__ import annotations

from typing import Any

import pytest
from sqlalchemy import event, select

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, ProjectCategory, ProjectPriority, RoleName
from models.workflow import ProjectWorkflowStep
from services.capacity_priority import need_to_finish
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_chamber, make_engineer, make_hub
from tests.p12_helpers import act_as, client_for, stepped_project
from tests.test_p13_capacity_priority_board import _capacity_fixture, _seeded

# P57 (ADR 0067): "NA" = Not applicable (Commercialized / Cancelled).
BUCKETS = ["P1", "P2", "P3", "P4", "Queue", "NA"]
NEW_SPLITS = (
    "design_demand_by_priority",
    "lab_demand_by_priority",
    "design_remaining_by_priority",
    "lab_remaining_by_priority",
)
NEED_FIELDS = (
    "design_need_p1_weeks",
    "design_need_p1_p2_weeks",
    "lab_need_p1_weeks",
    "lab_need_p1_p2_weeks",
)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _hub_load(client: Any, **params: Any) -> dict:
    resp = await client.get("/capacity/hub-load", params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _total(split: dict) -> float:
    assert list(split) == BUCKETS
    return round(sum(split.values()), 2)


def _need(rem: dict, cap: float) -> tuple[float, float]:
    """D45-2 re-derived from the served figures."""
    return (
        round(max(0.0, rem["P1"] - cap), 2),
        round(max(0.0, rem["P1"] + rem["P2"] - cap), 2),
    )


def _assert_row_contract(row: dict) -> None:
    """Sums reconcile on both bases; need figures follow D45-2 on served values."""
    hub = row["hub"]
    assert row["design_demand_by_priority"] == row["design_load_by_priority"], hub
    assert row["lab_demand_by_priority"] == row["lab_load_by_priority"], hub
    assert _total(row["design_demand_by_priority"]) == row["design_load_weeks"], hub
    assert _total(row["lab_demand_by_priority"]) == row["lab_load_weeks"], hub
    assert _total(row["design_remaining_by_priority"]) == row["design_load_remaining_weeks"], hub
    assert _total(row["lab_remaining_by_priority"]) == row["lab_load_remaining_weeks"], hub
    for kind in ("design", "lab"):
        rem, cap = row[f"{kind}_remaining_by_priority"], row[f"{kind}_capacity_remaining"]
        need_p1, need_p1_p2 = row[f"{kind}_need_p1_weeks"], row[f"{kind}_need_p1_p2_weeks"]
        assert (need_p1, need_p1_p2) == _need(rem, cap), (hub, kind)
        assert need_p1_p2 >= need_p1 >= 0, (hub, kind)
        # Every value is 2 dp.
        for v in (need_p1, need_p1_p2, *rem.values()):
            assert round(v, 2) == v


async def _set_effort(db_session, project, planned: dict[str, int]) -> None:
    for row in (
        await db_session.execute(
            select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == project.id)
        )
    ).scalars():
        if row.duration_weeks > 0:
            row.effort_weeks = planned.get(row.step_template_id, 0)
    await db_session.flush()


# --- pure helper -----------------------------------------------------------------------------


def test_need_to_finish_pure():
    split = {"P1": 10.0, "P2": 20.0, "P3": 1.0, "P4": 0.0, "Queue": 0.0, "NA": 0.0}
    assert need_to_finish(split, 21.0) == (0.0, 9.0)
    assert need_to_finish(split, 5.25) == (4.75, 24.75)
    assert need_to_finish(split, 40.0) == (0.0, 0.0)
    assert need_to_finish(split, 0.0) == (10.0, 30.0)
    # 2 dp on the served capacity.
    assert need_to_finish({"P1": 1.0, "P2": 0.0}, 0.333) == (0.67, 0.67)


# --- hand-built fixture ----------------------------------------------------------------------


async def test_splits_reconcile_and_exact_values(db_session):
    """_capacity_fixture (P13): Greece P1 design 10 / lab 4, Q design 5; PD-India P2
    design 7 / lab 3, null-priority design 2 / lab 6; R&D-India P4 design 3 / lab 1.
    All Not Started, non-frozen: the Q and P4 projects leave remaining demand (R42-6),
    the null-priority one stays in it (bucket Queue)."""

    await _capacity_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _hub_load(client)
    rows = {r["hub"]: r for r in body["rows"]}
    gr, pdi, rdi = rows["R&D-Greece"], rows["PD-India"], rows["R&D-India"]
    for row in body["rows"]:
        _assert_row_contract(row)
    zero = dict.fromkeys(BUCKETS, 0.0)
    assert gr["design_demand_by_priority"] == {**zero, "P1": 10.0, "Queue": 5.0}
    assert gr["design_remaining_by_priority"] == {**zero, "P1": 10.0}
    assert gr["lab_remaining_by_priority"] == {**zero, "P1": 4.0}
    assert pdi["design_remaining_by_priority"] == {**zero, "P2": 7.0, "Queue": 2.0}
    assert rdi["design_remaining_by_priority"] == zero  # P4, non-frozen
    # Lab is region-level, repeated on both India rows.
    india_rem = {**zero, "P2": 3.0, "Queue": 6.0}
    assert pdi["lab_remaining_by_priority"] == rdi["lab_remaining_by_priority"] == india_rem
    assert pdi["lab_demand_by_priority"] == rdi["lab_demand_by_priority"]
    assert pdi["lab_need_p1_weeks"] == rdi["lab_need_p1_weeks"] == 0.0
    assert pdi["lab_need_p1_p2_weeks"] == rdi["lab_need_p1_p2_weeks"] == 3.0
    # No engineers / chambers: capacity 0, so P1 does not fit anywhere it exists.
    assert (gr["design_capacity_remaining"], gr["lab_capacity_remaining"]) == (0.0, 0.0)
    assert (gr["design_need_p1_weeks"], gr["design_need_p1_p2_weeks"]) == (10.0, 10.0)
    assert (gr["lab_need_p1_weeks"], gr["lab_need_p1_p2_weeks"]) == (4.0, 4.0)
    assert (pdi["design_need_p1_weeks"], pdi["design_need_p1_p2_weeks"]) == (0.0, 7.0)
    assert (rdi["design_need_p1_weeks"], rdi["design_need_p1_p2_weeks"]) == (0.0, 0.0)


async def test_need_is_zero_when_p1_fits_and_positive_when_it_does_not(db_session):
    f = await _capacity_fixture(db_session)
    # A Greece P2 project with 20 design weeks: P1 (10) + P2 (20) = 30.
    p2 = await stepped_project(db_session, f.greece, name="GR P2", priority=ProjectPriority.P2)
    await _set_effort(db_session, p2, {"PDD-A": 20})
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        before = {r["hub"]: r for r in (await _hub_load(client))["rows"]}["R&D-Greece"]
    _assert_row_contract(before)
    assert before["design_remaining_by_priority"]["P2"] == 20.0
    assert before["design_capacity_remaining"] == 0.0
    assert (before["design_need_p1_weeks"], before["design_need_p1_p2_weeks"]) == (10.0, 30.0)

    # One 1.0 FTE engineer: remaining capacity at W31 is ~21 weeks, so P1 fits
    # and P1 + P2 does not.
    await make_engineer(db_session, f.greece, name="GR eng", fte=1.0)
    await make_chamber(db_session, lab_region=LabRegion.GREECE)
    async with client_for(db_session) as client:
        after = {r["hub"]: r for r in (await _hub_load(client))["rows"]}["R&D-Greece"]
    _assert_row_contract(after)
    cap = after["design_capacity_remaining"]
    assert 10.0 < cap < 30.0
    assert after["design_need_p1_weeks"] == 0.0
    assert after["design_need_p1_p2_weeks"] == round(30.0 - cap, 2) > 0
    # Lab: one Greece chamber (~50 × 1 platform × 21/52) covers the P1 lab (4).
    assert after["lab_capacity_remaining"] > 4.0
    assert (after["lab_need_p1_weeks"], after["lab_need_p1_p2_weeks"]) == (0.0, 0.0)


async def test_lab_is_repeated_per_region_with_greece_members(db_session):
    """ADR 0042: OEM-HCK is a member of R&D-Greece; its design joins the Greece row,
    and the lab figures stay region-level."""

    f = await _capacity_fixture(db_session)
    hck = await make_hub(
        db_session,
        name=HubName.OEM_HCK,
        lab_region=LabRegion.GREECE,
        is_oem=True,
        capacity_hub=f.greece,
    )
    oem = await stepped_project(
        db_session,
        hck,
        name="HCK P1",
        priority=ProjectPriority.P1,
        category=ProjectCategory.A_OEM,
    )
    await _set_effort(db_session, oem, {"OEM-D": 6})  # OEM-D is design-kind
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _hub_load(client)
        india = await _hub_load(client, region="India")
    for row in body["rows"]:
        _assert_row_contract(row)
    by_hub = {r["hub"]: r for r in body["rows"]}
    assert "OEM-HCK" not in by_hub
    gr = by_hub["R&D-Greece"]
    # Design: own P1 (10) + OEM-HCK P1 (6); lab P1 is the Greece region's (4).
    assert gr["design_remaining_by_priority"]["P1"] == 16.0
    assert gr["lab_remaining_by_priority"]["P1"] == 4.0
    assert gr["design_need_p1_weeks"] == 16.0  # no engineers: capacity 0
    # Every hub of a region carries identical lab figures.
    by_region: dict[str, list[dict]] = {}
    for r in body["rows"]:
        by_region.setdefault(r["lab_region"], []).append(r)
    for region_rows in by_region.values():
        first = region_rows[0]
        for r in region_rows[1:]:
            for key in (
                "lab_demand_by_priority",
                "lab_remaining_by_priority",
                "lab_need_p1_weeks",
                "lab_need_p1_p2_weeks",
            ):
                assert r[key] == first[key], (r["hub"], key)
    assert len(by_region["India"]) == 2
    # A region filter keeps the same figures.
    for r in india["rows"]:
        for key in (*NEW_SPLITS, *NEED_FIELDS):
            assert r[key] == by_hub[r["hub"]][key], (r["hub"], key)


async def test_hub_scoping(db_session):
    f = await _capacity_fixture(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[f.pd_india.id])
    async with client_for(db_session) as client:
        body = await _hub_load(client)
        greece = await _hub_load(client, region="Greece")
        gr_filter = await _hub_load(client, hub_id=f.greece.id)
    assert [r["hub"] for r in body["rows"]] == ["PD-India"]
    pdi = body["rows"][0]
    _assert_row_contract(pdi)
    zero = dict.fromkeys(BUCKETS, 0.0)
    # Design: PD-India's own projects only.
    assert pdi["design_remaining_by_priority"] == {**zero, "P2": 7.0, "Queue": 2.0}
    # Lab: the region aggregate (R&D-India's lab is in it); only the aggregate leaves.
    assert pdi["lab_demand_by_priority"] == {**zero, "P2": 3.0, "P4": 1.0, "Queue": 6.0}
    # Out-of-scope hub / region: no row, so no Greece P1 figure leaks.
    assert greece["rows"] == [] and gr_filter["rows"] == []


async def test_executive_viewer_reads_hub_load(db_session):
    """OQ #87 / D45-4: Executive Viewer has Capacity R (all hubs) in core.rbac; reported,
    not changed."""

    await _capacity_fixture(db_session)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        body = await _hub_load(client)
    assert sorted(r["hub"] for r in body["rows"]) == ["PD-India", "R&D-Greece", "R&D-India"]
    for row in body["rows"]:
        _assert_row_contract(row)
        # Hub-level only: no engineer-level field rides along (OQ #8).
        assert not any("engineer_id" in k for k in row)


async def test_statement_count_is_constant(db_session):
    """No N+1: the new splits add no statement; 5 or 25 projects cost the same."""

    f = await _capacity_fixture(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    statements: list[str] = []

    def _count(_conn, _cursor, statement, *_args):
        statements.append(statement)

    engine = db_session.bind.sync_engine
    async with client_for(db_session) as client:
        await _hub_load(client)  # warm any lazy caches
        event.listen(engine, "before_cursor_execute", _count)
        try:
            await _hub_load(client)
            n_small = len(statements)
            event.remove(engine, "before_cursor_execute", _count)
            for i in range(20):
                p = await stepped_project(
                    db_session,
                    f.pd_india if i % 2 else f.greece,
                    name=f"N{i}",
                    priority=list(ProjectPriority)[i % 5],
                )
                await _set_effort(db_session, p, {"PDD-A": 1 + i % 4, "PDD-F": i % 3})
            statements.clear()
            event.listen(engine, "before_cursor_execute", _count)
            body = await _hub_load(client)
            n_large = len(statements)
        finally:
            if event.contains(engine, "before_cursor_execute", _count):
                event.remove(engine, "before_cursor_execute", _count)
    assert n_small == n_large
    for row in body["rows"]:
        _assert_row_contract(row)


# --- real-scheduler seed ---------------------------------------------------------------------


async def test_seeded_rows_reconcile(db_session):
    await _seeded(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _hub_load(client)
        for region in ("Greece", "India", "Romania"):
            for row in (await _hub_load(client, region=region))["rows"]:
                _assert_row_contract(row)
    assert body["rows"]
    for row in body["rows"]:
        _assert_row_contract(row)
    assert sum(r["design_remaining_by_priority"]["P1"] for r in body["rows"]) > 0
