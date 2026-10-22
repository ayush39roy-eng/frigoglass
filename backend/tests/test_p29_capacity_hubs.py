"""P29-T01 / P29-T06 (ADR 0042, docs/API_CONTRACT_P29.md): OEM-HCK and
OEM-Seitek are capacity children of R&D-Greece.

One small world on the shared savepoint-isolated DB (CURRENT_WEEK 31):

    R&D-Greece (calendar 5 / 12, 0, 0, 25 -> 44.60 working weeks)
        engineers Alpha 1.0, Beta 0.8 (counted), Theoni 1.0 (NOT counted)
        members OEM-HCK, OEM-Seitek (no calendar, no engineers)
    PD-India (calendar 6 / 13, 7, 7, 20 -> 44.17)
        engineers Gamma 1.0 (counted), Dipak 1.0 (NOT counted)

Active-run design load: R&D-Greece own 10 (G1), OEM-HCK 4 + 2 (H1, H2),
OEM-Seitek 4 (S1) -> Greece aggregate 20; PD-India 7 (I1).
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
)
from models.hub import HubWorkCalendar
from models.project import Project
from models.schedule import ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.capacity_supply import round2
from services.export_builder import build_capacity_sheets, csv_bytes
from services.schedule_persistence import build_schedule_input_from_db
from services.whatif_baseline import Scope
from tests.auth_helpers import clear_current_principal_override, make_principal
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_project,
    make_schedule_run,
)
from tests.p12_helpers import act_as, client_for

CW = dc.CURRENT_WEEK
GREECE_WWPE = 52 - 37 / 5  # 44.6
INDIA_WWPE = 52 - 47 / 6


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _remaining(wwpe: float) -> float:
    deduction = 52 - wwpe
    return (52 - CW) - deduction * (52 - CW) / 52


async def _world(db_session) -> SimpleNamespace:
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hck = await make_hub(
        db_session,
        name=HubName.OEM_HCK,
        lab_region=LabRegion.GREECE,
        is_oem=True,
        capacity_hub=greece,
    )
    seltek = await make_hub(
        db_session,
        name=HubName.OEM_SEITEK,
        lab_region=LabRegion.GREECE,
        is_oem=True,
        capacity_hub=greece,
    )
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    for hub, (wd, nat, med, cas, ann) in ((greece, (5, 12, 0, 0, 25)), (india, (6, 13, 7, 7, 20))):
        db_session.add(
            HubWorkCalendar(
                hub_id=hub.id,
                weekdays_per_week=wd,
                national_holiday_days=nat,
                medical_leave_days=med,
                casual_leave_days=cas,
                annual_leave_days=ann,
            )
        )
    oem_cats = [
        EngineerAllowedCategory.A,
        EngineerAllowedCategory.A_OEM,
        EngineerAllowedCategory.B_OEM,
    ]
    alpha = await make_engineer(db_session, greece, name="Alpha", allowed_categories=oem_cats)
    beta = await make_engineer(
        db_session, greece, name="Beta", fte=0.8, allowed_categories=oem_cats
    )
    theoni = await make_engineer(
        db_session, greece, name="Theoni", allowed_categories=oem_cats, counts_in_capacity=False
    )
    gamma = await make_engineer(db_session, india, name="Gamma")
    dipak = await make_engineer(db_session, india, name="Dipak", counts_in_capacity=False)
    db_session.add_all(
        [
            Chamber(
                code="GR-1",
                lab_region=LabRegion.GREECE,
                max_concurrent=1,
                platforms=1,
                efficiency=0.7,
                maintenance_weeks=2,
                breakdown_weeks=8,
                calibration_weeks=1,
                allowed_stages=[],
            ),
            Chamber(
                code="IN-1",
                lab_region=LabRegion.INDIA,
                max_concurrent=2,
                platforms=2,
                efficiency=0.6,
                maintenance_weeks=2,
                breakdown_weeks=7,
                calibration_weeks=1,
                allowed_stages=[],
            ),
        ]
    )
    await db_session.flush()
    oem = {"category": ProjectCategory.B_OEM, "status": ProjectStatus.IN_DEVELOPMENT}
    p = {
        "g1": await make_project(db_session, greece, leader=alpha, name="G1"),
        "h1": await make_project(db_session, hck, leader=beta, name="H1", **oem),
        "h2": await make_project(db_session, hck, leader=theoni, name="H2", **oem),
        "s1": await make_project(
            db_session, seltek, leader=alpha, name="S1", category=ProjectCategory.A_OEM
        ),
        "i1": await make_project(db_session, india, leader=gamma, name="I1"),
    }
    run = await make_schedule_run(db_session, is_active=True)
    steps = [
        ("g1", "PDD-A", 10, alpha),
        ("h1", "OEM-A", 4, beta),
        ("h2", "OEM-D", 2, theoni),
        ("s1", "OEM-G", 4, alpha),
        ("i1", "PDD-E", 7, gamma),
        ("i1", "PDD-F", 3, None),  # lab, India
    ]
    for i, (key, step_id, weeks, eng) in enumerate(steps):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id,
                project_id=p[key].id,
                step_template_id=step_id,
                sequence_order=i + 1,
                duration_weeks=weeks,
                start_week=CW,
                end_week=CW + weeks - 1,
                assigned_engineer_id=eng.id if eng is not None else None,
            )
        )
        # ADR 0041 (P30): the hub-load / capacity-fill load is DEMAND from the
        # live rows. Mirror each run figure as a Not Started live row whose
        # user override is that figure (OEM-D has lead 0 for B-OEM, so H2's
        # demand sits on OEM-B instead).
        live_step = "OEM-B" if (key, step_id) == ("h2", "OEM-D") else step_id
        db_session.add(
            ProjectWorkflowStep(
                project_id=p[key].id,
                step_template_id=live_step,
                sequence_order=i + 1,
                duration_weeks=1,
                duration_override_weeks=weeks,
            )
        )
    await db_session.flush()
    return SimpleNamespace(
        greece=greece,
        hck=hck,
        seltek=seltek,
        india=india,
        alpha=alpha,
        beta=beta,
        theoni=theoni,
        gamma=gamma,
        dipak=dipak,
        p=p,
        run=run,
    )


async def _get(client, path, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, resp.text
    return resp.json()


def _assert_i19(row: dict) -> None:
    for load_key, cap_key, pct_key in (
        ("design_load_weeks", "design_capacity_year", "design_booked_pct_year"),
        ("design_load_weeks", "design_capacity_remaining", "design_booked_pct_remaining"),
        ("lab_load_weeks", "lab_capacity_year", "lab_booked_pct_year"),
    ):
        cap = row[cap_key]
        assert row[pct_key] == (None if cap == 0 else round(row[load_key] / cap * 100, 2))


# --- GET /capacity/hub-load --------------------------------------------------------------


async def test_hub_load_serves_capacity_hubs_with_greece_aggregate(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/hub-load")
        alias = await _get(client, "/capacity/hubs")
    assert alias == body
    rows = {r["hub"]: r for r in body["rows"]}
    # No OEM row: the four capacity hubs only (two in this world).
    assert list(rows) == ["PD-India", "R&D-Greece"]

    gr = rows["R&D-Greece"]
    # Load = own + OEM-HCK + OEM-Seitek (ADR 0042 §3).
    assert gr["design_load_weeks"] == 10 + 4 + 2 + 4
    # ADR 0041 R12: members carry demand (full year, remaining) and booked.
    def _m(hub: str, own: bool, n: int, weeks: int) -> dict:
        return {
            "hub": hub, "own": own, "project_count": n, "design_load_weeks": weeks,
            "design_load_remaining_weeks": weeks, "design_load_booked_weeks": weeks,
            "booked_project_count": n,
        }  # fmt: skip

    assert gr["members"] == [
        _m("R&D-Greece", True, 1, 10),
        _m("OEM-HCK", False, 2, 6),
        _m("OEM-Seitek", False, 1, 4),
    ]
    assert sum(m["design_load_weeks"] for m in gr["members"]) == gr["design_load_weeks"]
    assert gr["selected_member"] is None
    # Supply: Greece's calendar x counted FTE only (Theoni 1.0 excluded).
    assert gr["engineer_fte_total"] == 1.8
    assert gr["working_weeks_per_engineer"] == 44.6
    assert gr["design_capacity_year"] == round2(GREECE_WWPE * 1.8)
    assert gr["design_capacity_remaining"] == round2(_remaining(GREECE_WWPE) * 1.8)
    assert gr["design_load_by_priority"]["P3"] == 20
    _assert_i19(gr)

    ind = rows["PD-India"]
    assert ind["members"] == [] and ind["selected_member"] is None
    assert ind["design_load_weeks"] == 7
    assert ind["engineer_fte_total"] == 1.0  # Dipak not counted
    assert ind["design_capacity_year"] == round2(INDIA_WWPE * 1.0)
    _assert_i19(ind)

    # Areas: Greece's aggregate counted once (ADR 0016 + ADR 0042).
    europe = next(a for a in body["areas"] if a["area"] == "Europe")
    assert europe["hubs"] == ["R&D-Greece"]
    assert europe["design_load_weeks"] == 20
    assert europe["design_capacity_year"] == gr["design_capacity_year"]
    _assert_i19(europe)
    assert body["totals"]["hubs"] == ["PD-India", "R&D-Greece"]
    assert body["totals"]["design_load_weeks"] == 27


async def test_oem_hub_filter_returns_the_greece_row_with_the_member_selected(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        unfiltered = await _get(client, "/capacity/hub-load")
        by_hck = await _get(client, "/capacity/hub-load", hub_id=w.hck.id)
        by_greece = await _get(client, "/capacity/hub-load", hub_id=w.greece.id)
        by_region = await _get(client, "/capacity/hub-load", region="Greece")
    (row,) = by_hck["rows"]
    assert row["hub"] == "R&D-Greece" and row["selected_member"] == "OEM-HCK"
    full = next(r for r in unfiltered["rows"] if r["hub"] == "R&D-Greece")
    # Same aggregate figures and members as the unfiltered row.
    assert {k: v for k, v in row.items() if k != "selected_member"} == {
        k: v for k, v in full.items() if k != "selected_member"
    }
    assert by_greece["rows"][0]["selected_member"] == "R&D-Greece"
    assert [r["hub"] for r in by_region["rows"]] == ["R&D-Greece"]
    assert by_region["rows"][0]["selected_member"] is None


async def test_rbac_member_scope_sees_the_aggregate_and_only_its_members(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        rows = (await _get(client, "/capacity/hub-load"))["rows"]
        full = next(r for r in rows if r["hub"] == "R&D-Greece")
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hck.id])
    async with client_for(db_session) as client:
        mine = await _get(client, "/capacity/hub-load")
        other_member = await _get(client, "/capacity/hub-load", hub_id=w.seltek.id)
        india = await _get(client, "/capacity/hub-load", hub_id=w.india.id)
        heat = await _get(client, "/capacity/engineer-utilization")
    (row,) = mine["rows"]
    assert row["hub"] == "R&D-Greece"
    # ADR 0042 §8: aggregate figures as everyone sees them ...
    for key in ("design_load_weeks", "design_capacity_year", "design_booked_pct_year"):
        assert row[key] == full[key]
    # ... but the members breakdown only lists the caller's hubs.
    assert [m["hub"] for m in row["members"]] == ["OEM-HCK"]
    # The filter never widens: an out-of-scope member or hub gives no row.
    assert other_member["rows"] == [] and india["rows"] == []
    # Engineer rows stay hub-scoped at row level (Greek engineers sit on R&D-Greece).
    assert heat["engineers"] == []


async def test_hub_scoped_to_pd_india_sees_only_its_row(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.india.id])
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/hub-load")
    assert [r["hub"] for r in body["rows"]] == ["PD-India"]


async def test_capacity_export_has_capacity_hub_rows_and_readable_members(db_session):
    await _world(db_session)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)
    sheets = await build_capacity_sheets(db_session, principal)
    headers, rows = sheets["Capacity"]
    assert [r["hub"] for r in rows] == ["PD-India", "R&D-Greece"]
    gr = rows[1]
    assert gr["members"] == (
        "R&D-Greece 1 project(s) 10 wk demand, 10 wk remaining, 10 wk booked; "
        "OEM-HCK 2 project(s) 6 wk demand, 6 wk remaining, 6 wk booked; "
        "OEM-Seitek 1 project(s) 4 wk demand, 4 wk remaining, 4 wk booked"
    )
    assert rows[0]["members"] == ""
    assert "members" in headers and "selected_member" in headers
    assert b"OEM-Seitek 1 project(s) 4 wk" in csv_bytes(headers, rows)


# --- P1 capacity fill on the aggregate ----------------------------------------------------


async def test_capacity_fill_walks_the_capacity_hub_set(db_session):
    """OEM-HCK alone has no engineer (capacity 0, nothing would be promoted);
    under ADR 0042 its projects are walked with Greece's capacity."""

    w = await _world(db_session)
    for key, pct in (("g1", 80), ("h1", 65), ("s1", 60), ("h2", 50), ("i1", 40)):
        await make_priority_score(
            db_session,
            w.p[key],
            dims=[3] * 13,
            weighted_score=float(pct),
            normalized_pct=pct,
            suggested_band=ProjectPriority("P1" if pct >= 70 else "P2" if pct >= 55 else "P3"),
        )
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        fill = await _get(client, "/priorities/capacity-fill")
        load = await _get(client, "/capacity/hub-load")
        rows = {r["project_name"]: r for r in await _get(client, "/priorities")}
        by_hck = await _get(client, "/priorities/capacity-fill", hub_id=w.hck.id)
    gr_fill = next(h for h in fill["hubs"] if h["hub"] == "R&D-Greece")
    gr_load = next(r for r in load["rows"] if r["hub"] == "R&D-Greece")
    assert [h["hub"] for h in fill["hubs"]] == ["PD-India", "R&D-Greece"]
    assert gr_fill["capacity_weeks"] == gr_load["design_capacity_remaining"]
    assert gr_fill["members"] == ["OEM-HCK", "OEM-Seitek"]
    assert gr_fill["base_load_weeks"] == 10.0
    # H1 (4) -> 14, S1 (4) -> 18, H2 (2) -> 20, all within ~32.4 weeks.
    assert gr_fill["filled_load_weeks"] == 20.0 and gr_fill["promoted_count"] == 3
    assert rows["H1"]["capacity_fill"] is True and rows["H1"]["suggested_band"] == "P1"
    assert rows["S1"]["capacity_fill"] is True and rows["H2"]["capacity_fill"] is True
    assert "of 32.42 weeks" in rows["H1"]["capacity_fill_reason"]
    (only,) = by_hck["hubs"]
    assert only["hub"] == "R&D-Greece" and only["selected_member"] == "OEM-HCK"


# --- Capacity Planning ------------------------------------------------------------------


async def test_planning_summary_and_resource_load(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        summary = await _get(client, "/planning/capacity-summary")
        load = await _get(client, "/capacity/hub-load")
        res = await _get(client, "/planning/resource-load")
        res_hck = await _get(client, "/planning/resource-load", hub_id=w.hck.id)
        options = await _get(client, "/planning/resource-load/options", hub_id=w.hck.id)
    rows = {r["hub"]: r for r in summary["design"]["hubs"]}
    assert list(rows) == ["PD-India", "R&D-Greece"]
    gr = rows["R&D-Greece"]
    assert gr["engineer_count"] == 2 and gr["not_counted_engineer_count"] == 1
    assert gr["fte_total"] == 1.8
    assert gr["members"] == ["OEM-HCK", "OEM-Seitek"]
    cap_row = next(r for r in load["rows"] if r["hub"] == "R&D-Greece")
    assert gr["capacity_weeks"]["year"] == cap_row["design_capacity_year"]
    assert summary["design"]["total"]["engineer_count"] == 3

    by_name = {e["name"]: e for e in res["engineers"]}
    assert by_name["Theoni"]["counts_in_capacity"] is False
    assert by_name["Alpha"]["counts_in_capacity"] is True
    counted = [e for e in res["engineers"] if e["counts_in_capacity"]]
    assert res["totals"]["engineers"]["capacity_weeks"] == round2(
        sum(e["capacity_weeks"] for e in counted)
    )
    assert res["totals"]["engineers"]["load_weeks"] == round2(
        sum(e["load_weeks"] for e in res["engineers"])
    )
    # A member-hub filter lists the capacity hub's engineers.
    assert {e["name"] for e in res_hck["engineers"]} == {"Alpha", "Beta", "Theoni"}
    assert {e["name"] for e in options["engineers"]} == {"Alpha", "Beta", "Theoni"}


async def test_engineer_heatmap_marks_counted_and_resolves_member_filter(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/engineer-utilization", hub_id=w.seltek.id)
        matrix = await _get(client, "/capacity/utilization-matrix", hub_id=w.hck.id)
    assert {r["name"]: r["counts_in_capacity"] for r in body["engineers"]} == {
        "Alpha": True,
        "Beta": True,
        "Theoni": False,
    }
    assert all(r["hub"] == "R&D-Greece" for r in body["engineers"])
    assert {e["engineer_id"] for e in matrix["engineers"]} == {
        str(w.alpha.id),
        str(w.beta.id),
        str(w.theoni.id),
    }


# --- Reference, engineers, projects -------------------------------------------------------


async def test_get_hubs_serves_the_capacity_hub(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ENGINEER)
    async with client_for(db_session) as client:
        hubs = {h["name"]: h for h in await _get(client, "/hubs")}
        types = await _get(client, "/reference/project-types")
    assert hubs["OEM-HCK"]["capacity_hub_id"] == str(w.greece.id)
    assert hubs["OEM-HCK"]["capacity_hub_name"] == "R&D-Greece"
    assert hubs["OEM-Seitek"]["capacity_hub_name"] == "R&D-Greece"
    assert hubs["R&D-Greece"]["capacity_hub_id"] is None
    assert hubs["R&D-Greece"]["capacity_hub_name"] is None
    assert {t["code"]: t["label"] for t in types}["RC"] == "Regulatory / Business Compliance"
    assert [t["code"] for t in types] == ["NM", "CO", "RC", "NO", "IMP", "AC", "SER"]


async def test_counts_in_capacity_is_admin_only_and_audited(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.greece.id])
    async with client_for(db_session) as client:
        listed = await _get(client, "/engineers")
        denied = await client.patch(f"/engineers/{w.alpha.id}", json={"counts_in_capacity": False})
        same = await client.patch(f"/engineers/{w.alpha.id}", json={"counts_in_capacity": True})
        fte_ok = await client.patch(f"/engineers/{w.alpha.id}", json={"fte": 0.9})
    assert {e["name"]: e["counts_in_capacity"] for e in listed} == {
        "Alpha": True,
        "Beta": True,
        "Theoni": False,
    }
    assert denied.status_code == 403 and denied.json()["code"] == "COUNTS_IN_CAPACITY_ADMIN_ONLY"
    assert same.status_code == 403
    assert fte_ok.status_code == 200, fte_ok.text

    admin = await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        ok = await client.patch(f"/engineers/{w.alpha.id}", json={"counts_in_capacity": False})
        null = await client.patch(f"/engineers/{w.alpha.id}", json={"counts_in_capacity": None})
        load = await _get(client, "/capacity/hub-load")
    assert ok.status_code == 200 and ok.json()["counts_in_capacity"] is False
    assert null.status_code == 422
    assert next(r for r in load["rows"] if r["hub"] == "R&D-Greece")["engineer_fte_total"] == 0.8
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "engineer.update",
                AuditLogEntry.actor_user_id == admin.id,
            )
        )
    ).scalar_one()
    assert audit.before_state["counts_in_capacity"] is True
    assert audit.after_state["counts_in_capacity"] is False


async def test_engineer_hub_must_be_a_capacity_hub(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        created = await client.post(
            "/engineers", json={"name": "New", "hub_id": str(w.hck.id), "fte": 1.0}
        )
        moved = await client.patch(f"/engineers/{w.alpha.id}", json={"hub_id": str(w.seltek.id)})
    # Workflow Settings are Super Admin only (ADR 0010).
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        calendar = await client.put(
            f"/workflow-settings/hub-calendars/{w.hck.id}",
            json={
                "weekdays_per_week": 5,
                "national_holiday_days": 1,
                "medical_leave_days": 0,
                "casual_leave_days": 0,
                "annual_leave_days": 0,
            },
        )
    for resp in (created, moved, calendar):
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "HUB_NOT_CAPACITY_HUB"


async def test_provisional_leader_flag_served_and_cleared_on_leader_change(db_session):
    w = await _world(db_session)
    project = w.p["h1"]
    project.leader_is_provisional = True
    await db_session.flush()
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        read = await _get(client, f"/projects/{project.id}")
        renamed = await client.patch(f"/projects/{project.id}", json={"name": "H1 renamed"})
        same_leader = await client.patch(
            f"/projects/{project.id}", json={"leader_engineer_id": str(w.beta.id)}
        )
        changed = await client.patch(
            f"/projects/{project.id}", json={"leader_engineer_id": str(w.alpha.id)}
        )
    assert read["leader_is_provisional"] is True
    assert renamed.json()["leader_is_provisional"] is True
    assert same_leader.json()["leader_is_provisional"] is True
    assert changed.status_code == 200, changed.text
    assert changed.json()["leader_is_provisional"] is False


# --- Scheduler input (P29-T02 / P29-T06) ---------------------------------------------------


async def test_schedule_input_carries_capacity_hub_and_counted_flag(db_session):
    w = await _world(db_session)
    si = await build_schedule_input_from_db(db_session)
    by_name = {p.name: p for p in si.projects}
    assert by_name["H1"].hub == "OEM-HCK" and by_name["H1"].capacity_hub == "R&D-Greece"
    assert by_name["S1"].capacity_hub == "R&D-Greece"
    assert by_name["S1"].workflow_id == "OEM"  # workflow stays by hub
    assert by_name["G1"].capacity_hub == "R&D-Greece"
    assert by_name["I1"].capacity_hub == "PD-India"
    engineers = {e.name: e for e in si.engineers}
    assert engineers["Theoni"].hub == "R&D-Greece"
    assert engineers["Theoni"].counts_in_capacity is False
    assert engineers["Dipak"].counts_in_capacity is False
    assert engineers["Alpha"].counts_in_capacity is True
    assert w.alpha.id  # world used


# --- What-if (P29-T06) ------------------------------------------------------------------


def test_whatif_capacity_rows_are_capacity_hubs_only():
    everyone = Scope(True, frozenset(dc.HUB_LAB_REGION), frozenset({"Greece", "India", "Romania"}))
    assert everyone.capacity_row_ok("R&D-Greece")
    assert not everyone.capacity_row_ok("OEM-HCK")
    assert not everyone.capacity_row_ok("OEM-Seitek")
    member_only = Scope(False, frozenset({"OEM-Seitek"}), frozenset({"Greece"}))
    assert member_only.capacity_row_ok("R&D-Greece")
    assert not member_only.capacity_row_ok("PD-India")
    assert not member_only.capacity_row_ok("OEM-Seitek")


async def test_whatif_refuses_designers_on_a_member_hub(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/whatif/estimate",
            json={"scenario": {"add_engineers": [{"hub": "OEM-HCK", "count": 1}]}},
        )
    assert resp.status_code == 422, resp.text
    assert "R&D-Greece" in resp.json()["detail"]


async def test_whatif_estimate_serves_no_oem_row(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/whatif/estimate",
            json={
                "scenario": {"add_projects": [{"hub": "OEM-HCK", "category": "B-OEM", "count": 2}]}
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    hubs = {r["hub"] for r in body["design"]}
    assert "OEM-HCK" not in hubs and "OEM-Seitek" not in hubs
    assert "R&D-Greece" in hubs
    assert "OEM-HCK" not in body["touched_hubs"]
    assert not any(ln.startswith("OEM-") for ln in body["workings"])


async def test_project_ids_are_untouched_by_reads(db_session):
    """Reads never write: no leader, flag or stale change from a capacity read."""

    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    before = {
        p.id: (p.leader_engineer_id, p.leader_is_provisional, p.schedule_stale)
        for p in (await db_session.execute(select(Project))).scalars()
    }
    async with client_for(db_session) as client:
        for path in (
            "/capacity/hub-load",
            "/priorities/capacity-fill",
            "/planning/capacity-summary",
        ):
            await _get(client, path, hub_id=w.hck.id)
    after = {
        p.id: (p.leader_engineer_id, p.leader_is_provisional, p.schedule_stale)
        for p in (await db_session.execute(select(Project))).scalars()
    }
    assert before == after
    assert uuid.UUID(str(w.greece.id))


# --- P30-R01 (S30-I1): scope check on the REQUESTED hub before member resolution -------

#: Every engineer list that resolves a member-hub filter to its capacity hub,
#: with the key holding its engineer rows and the field naming an engineer.
_ENGINEER_LISTS = (
    ("/engineers", None, "name"),
    ("/capacity/engineer-utilization", "engineers", "name"),
    ("/capacity/utilization-matrix", "engineers", "engineer_id"),
    ("/planning/resource-load", "engineers", "name"),
    ("/planning/resource-load/options", "engineers", "name"),
)


def _engineer_rows(body: Any, key: str | None) -> Any:
    return body if key is None else body[key]


@pytest.mark.parametrize(("path", "key", "_field"), _ENGINEER_LISTS)
async def test_out_of_scope_member_filter_is_empty_not_the_capacity_hub(
    db_session, path, key, _field
):
    """ADR 0020 §3: a Greece-only planner filtering on OEM-HCK (outside their
    scope) gets an empty list, not their own Greek engineers via the
    OEM-HCK → R&D-Greece resolution."""

    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.greece.id])
    async with client_for(db_session) as client:
        unfiltered = await _get(client, path)
        by_hck = await _get(client, path, hub_id=w.hck.id)
        by_seitek = await _get(client, path, hub_id=w.seltek.id)
    # Sanity: the caller does see Greek engineers without a filter.
    assert _engineer_rows(unfiltered, key)
    assert _engineer_rows(by_hck, key) == []
    assert _engineer_rows(by_seitek, key) == []
    if key is not None:
        # Same shape as any other out-of-scope filter.
        assert set(by_hck) == set(unfiltered)


@pytest.mark.parametrize(("path", "key", "field"), _ENGINEER_LISTS)
async def test_in_scope_member_filter_still_resolves_to_the_capacity_hub(
    db_session, path, key, field
):
    """P29 behaviour kept: a caller holding R&D-Greece and OEM-HCK who filters
    on OEM-HCK gets the capacity hub's (Greek) engineers."""

    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.greece.id, w.hck.id])
    async with client_for(db_session) as client:
        by_hck = await _get(client, path, hub_id=w.hck.id)
    greek = (
        {str(w.alpha.id), str(w.beta.id), str(w.theoni.id)}
        if field == "engineer_id"
        else {"Alpha", "Beta", "Theoni"}
    )
    assert {e[field] for e in _engineer_rows(by_hck, key)} == greek
