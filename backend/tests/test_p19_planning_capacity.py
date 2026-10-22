"""P19-T03 (docs/API_CONTRACT_P19.md): capacity figures for Capacity Planning
and the Capacity page's Weeks / Days toggle.

Hand-worked numbers (CURRENT_WEEK pinned to 31, so 21 weeks remain, fraction
21/52):

R&D-Greece calendar (5 weekdays, 12 + 0 + 0 + 25 days) -> deduction 37/5 = 7.4,
working 44.6, remaining working 21 - 7.4 * 21/52 = 18.011538...
- engineer Alpha fte 0.8: year 35.68, remaining 14.41; days (x5) 178.4, 72.05
- hub (fte 1.8):          year 80.28, remaining 32.42; days 401.4, 162.1

Greece lab region: R&D-Greece 12/5 = 2.4 holiday weeks beats OEM-HCK 13/6, so
the region calendar is R&D-Greece's (5 weekdays, not OEM-HCK's 6).
- chamber GR-1 (2 platforms, eff 0.5, downtime 2+3+1): working 52 - 2.4 - 6 =
  43.6, capacity 43.6 * 0.5 * 2 = 43.6, remaining 43.6 * 21/52 = 17.61;
  days 218.0, 88.05
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    ProjectType,
    RoleName,
)
from models.hub import HubWorkCalendar
from models.schedule import ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run
from tests.p12_helpers import act_as, client_for

SUMMARY = "/planning/capacity-summary"
LOAD = "/planning/resource-load"
OPTIONS = "/planning/resource-load/options"
ACTION = "planning.resource_load.read"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _chamber(code, region, platforms, efficiency, maintenance, breakdown, calibration):
    return Chamber(
        code=code,
        lab_region=region,
        max_concurrent=platforms,
        platforms=platforms,
        efficiency=efficiency,
        maintenance_weeks=maintenance,
        breakdown_weeks=breakdown,
        calibration_weeks=calibration,
        allowed_stages=[],
    )


async def _world(db_session, *, with_run: bool = True):
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.GREECE, is_oem=True)
    romania = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    for hub, (wd, nat, med, cas, ann) in (
        (greece, (5, 12, 0, 0, 25)),
        (oem, (6, 13, 7, 7, 20)),
        (romania, (5, 13, 7, 0, 20)),
    ):
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
    alpha = await make_engineer(db_session, greece, name="Alpha", fte=0.8)
    beta = await make_engineer(db_session, greece, name="Beta", fte=1.0)
    gamma = await make_engineer(db_session, romania, name="Gamma", fte=0.5)
    gr1 = _chamber("GR-1", LabRegion.GREECE, 2, 0.5, 2, 3, 1)
    # 52 - 2.4 - 49.6 = 0 working weeks: the zero-capacity chamber.
    grz = _chamber("GR-Z", LabRegion.GREECE, 1, 1.0, 49.6, 0, 0)
    ro1 = _chamber("RO-1", LabRegion.ROMANIA, 1, 1.0, 2, 0, 1)
    db_session.add_all([gr1, grz, ro1])
    await db_session.flush()

    pg1 = await make_project(
        db_session,
        greece,
        name="G1",
        category=ProjectCategory.A,
        type=ProjectType.NM,
        status=ProjectStatus.IN_DEVELOPMENT,
    )
    pg2 = await make_project(
        db_session,
        greece,
        name="G2",
        category=ProjectCategory.B,
        type=ProjectType.CO,
        status=ProjectStatus.IN_QUEUE,
    )
    pr = await make_project(
        db_session,
        romania,
        name="R1",
        category=ProjectCategory.A,
        type=ProjectType.NM,
        status=ProjectStatus.IN_DEVELOPMENT,
    )
    po = await make_project(
        db_session,
        oem,
        name="O1",
        category=ProjectCategory.A_OEM,
        type=ProjectType.RC,
        status=ProjectStatus.IN_DEVELOPMENT,
    )
    w = {
        "greece": greece,
        "oem": oem,
        "romania": romania,
        "alpha": alpha,
        "beta": beta,
        "gamma": gamma,
        "gr1": gr1,
        "grz": grz,
        "ro1": ro1,
    }
    if not with_run:
        return w
    run = await make_schedule_run(db_session, is_active=True)
    # (project, step, weeks, engineer, chamber, skipped)
    steps = [
        (pg1, "PDD-A", 3, alpha, None, False),
        (pg1, "PDD-F", 4, None, gr1, False),
        (pg2, "PDD-A", 2, beta, None, False),
        (pg2, "PDD-E", 5, alpha, None, False),
        (pg2, "PDD-B", 2, alpha, None, True),  # skipped: adds nothing
        (pg2, "PDD-H", 6, None, gr1, False),
        (pr, "PDD-A", 4, gamma, None, False),
        (pr, "PDD-F", 2, None, ro1, False),
        (po, "OEM-D", 2, beta, None, False),  # cross-hub leader
        (po, "OEM-E", 3, None, gr1, False),
    ]
    for i, (project, step_id, weeks, eng, ch, skipped) in enumerate(steps):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id,
                project_id=project.id,
                step_template_id=step_id,
                sequence_order=i + 1,
                duration_weeks=weeks,
                start_week=31,
                end_week=31 + weeks - 1,
                skipped=skipped,
                assigned_engineer_id=eng.id if eng else None,
                assigned_chamber_id=ch.id if ch else None,
            )
        )
        if not skipped:
            # ADR 0041 (P30): the hub table's load is DEMAND from the live
            # rows; mirror the run figure as the step's user override so the
            # demand equals this hand-built run.
            db_session.add(
                ProjectWorkflowStep(
                    project_id=project.id, step_template_id=step_id, sequence_order=i + 1,
                    duration_weeks=1, duration_override_weeks=weeks,
                )
            )
    await db_session.flush()
    return w


async def _get(client, path, **params):
    resp = await client.get(path, params=params)
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- §2 / §3 hand-worked engineer and chamber ----------------------------------------


async def test_engineer_and_chamber_hand_worked(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        engineers = {e["name"]: e for e in await _get(client, "/engineers")}
        chambers = {c["code"]: c for c in await _get(client, "/chambers")}
    alpha = engineers["Alpha"]
    assert alpha["weekdays_per_week"] == 5
    assert alpha["capacity_weeks"] == {"year": 35.68, "remaining": 14.41}
    assert alpha["capacity_days"] == {"year": 178.4, "remaining": 72.05}
    assert engineers["Gamma"]["capacity_weeks"] == {"year": 22.0, "remaining": 8.88}
    gr1 = chambers["GR-1"]
    assert gr1["weekdays_per_week"] == 5  # R&D-Greece's calendar, not OEM-HCK's 6
    assert gr1["working_weeks"] == gr1["working_weeks_per_chamber"] == 43.6
    assert gr1["capacity_weeks"] == {"year": 43.6, "remaining": 17.61}
    assert gr1["capacity_days"] == {"year": 218.0, "remaining": 88.05}
    assert chambers["GR-Z"]["capacity_weeks"] == {"year": 0.0, "remaining": 0.0}
    for row in [*engineers.values(), *chambers.values()]:
        for basis in ("year", "remaining"):
            assert row["capacity_days"][basis] == round(
                row["capacity_weeks"][basis] * row["weekdays_per_week"], 2
            )


# --- §1 hub-load days ------------------------------------------------------------------


async def test_hub_load_days_and_lab_region_rows(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, "/capacity/hub-load")
    rows = {r["hub"]: r for r in body["rows"]}
    g = rows["R&D-Greece"]
    assert g["weekdays_per_week"] == 5 and g["lab_weekdays_per_week"] == 5
    assert g["design_capacity_year"] == 80.28 and g["design_capacity_remaining"] == 32.42
    assert g["capacity_days"] == {"year": 401.4, "remaining": 162.1}
    assert g["design_load_weeks"] == 10
    assert g["load_days"] == {"year": 50.0, "remaining": 50.0}
    assert g["lab_capacity_days"] == {"year": 218.0, "remaining": 88.05}
    assert g["lab_load_days"] == {"year": 65.0, "remaining": 65.0}  # 13 lab weeks x 5
    oem = rows["OEM-HCK"]
    assert oem["weekdays_per_week"] == 6 and oem["lab_weekdays_per_week"] == 5
    assert oem["capacity_days"] == {"year": 0.0, "remaining": 0.0}  # no engineers
    for r in body["rows"]:
        assert r["capacity_days"]["year"] == round(
            r["design_capacity_year"] * r["weekdays_per_week"], 2
        )
        assert r["lab_capacity_days"]["remaining"] == round(
            r["lab_capacity_remaining"] * r["lab_weekdays_per_week"], 2
        )
    regions = body["lab_regions"]
    assert [r["lab_region"] for r in regions] == ["Greece", "Romania"]
    assert regions[0]["chamber_count"] == 2
    assert regions[0]["capacity_weeks"] == {"year": 43.6, "remaining": 17.61}
    assert regions[0]["load_weeks"] == 13.0
    t = body["totals"]
    assert t["design_capacity_days"]["year"] == round(
        sum(r["capacity_days"]["year"] for r in body["rows"]), 2
    )
    assert t["lab_capacity_days"]["year"] == round(
        sum(r["capacity_days"]["year"] for r in regions), 2
    )


# --- §4 capacity summary ---------------------------------------------------------------


async def test_summary_equals_hub_load_and_shares(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        summary = await _get(client, SUMMARY)
        cap = await _get(client, "/capacity/hub-load")
    rows = {r["hub"]: r for r in cap["rows"]}
    hubs = summary["design"]["hubs"]
    assert [h["hub"] for h in hubs] == [r["hub"] for r in cap["rows"]]
    for h in hubs:
        r = rows[h["hub"]]
        assert h["capacity_weeks"] == {
            "year": r["design_capacity_year"],
            "remaining": r["design_capacity_remaining"],
        }
        assert h["capacity_days"] == r["capacity_days"]
        assert h["fte_total"] == r["engineer_fte_total"]
    g = next(h for h in hubs if h["hub"] == "R&D-Greece")
    assert g["engineer_count"] == 2 and g["fte_total"] == 1.8
    total = summary["design"]["total"]
    assert total["engineer_count"] == 3 and total["fte_total"] == 2.3
    assert total["capacity_weeks"] == {
        "year": cap["totals"]["design_capacity_year"],
        "remaining": cap["totals"]["design_capacity_remaining"],
    }
    assert total["capacity_days"] == cap["totals"]["design_capacity_days"]
    # 80.28 / (80.28 + 22.0) = 78.49 %
    assert g["share_pct"]["year"] == 78.49
    oem = next(h for h in hubs if h["hub"] == "OEM-HCK")
    assert oem["share_pct"] == {"year": 0.0, "remaining": 0.0}
    for basis in ("year", "remaining"):
        assert abs(sum(h["share_pct"][basis] for h in hubs) - 100) <= 0.05
        assert abs(sum(r["share_pct"][basis] for r in summary["lab"]["regions"]) - 100) <= 0.05

    regions = summary["lab"]["regions"]
    assert [r["lab_region"] for r in regions] == ["Greece", "Romania"]
    for r in regions:
        hub_row = next(x for x in cap["rows"] if x["lab_region"] == r["lab_region"])
        assert r["capacity_weeks"] == {
            "year": hub_row["lab_capacity_year"],
            "remaining": hub_row["lab_capacity_remaining"],
        }
        assert r["capacity_days"] == hub_row["lab_capacity_days"]
        assert r["weekdays_per_week"] == hub_row["lab_weekdays_per_week"]
    assert regions[0]["chamber_count"] == 2
    assert summary["lab"]["total"]["chamber_count"] == 3
    assert summary["lab"]["total"]["capacity_weeks"] == {
        "year": cap["totals"]["lab_capacity_year"],
        "remaining": cap["totals"]["lab_capacity_remaining"],
    }


async def test_summary_zero_and_filters(db_session):
    w = await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        none = await _get(client, SUMMARY, hub_id=str(w["greece"].id), region="Romania")
        oem = await _get(client, SUMMARY, hub_id=str(w["oem"].id))
        india = await _get(client, SUMMARY, region="India")
    assert none["design"]["hubs"] == [] and none["lab"]["regions"] == []
    assert none["design"]["total"]["capacity_weeks"] == {"year": 0.0, "remaining": 0.0}
    assert none["lab"]["total"]["chamber_count"] == 0
    # A hub with no engineers: zero capacity, zero share (not a division by zero).
    assert oem["design"]["hubs"][0]["share_pct"] == {"year": 0.0, "remaining": 0.0}
    assert oem["lab"]["regions"][0]["share_pct"]["year"] == 100.0
    assert india["design"]["hubs"] == []


# --- scoping and roles -----------------------------------------------------------------


async def test_hub_planner_scope(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w["romania"].id])
    async with client_for(db_session) as client:
        summary = await _get(client, SUMMARY)
        engineers = await _get(client, "/engineers")
        chambers = await _get(client, "/chambers")
        load = await _get(client, LOAD)
        outside = await _get(client, LOAD, hub_id=str(w["greece"].id))
        options = await _get(client, OPTIONS)
    assert [h["hub"] for h in summary["design"]["hubs"]] == ["PD-Romania"]
    assert [r["lab_region"] for r in summary["lab"]["regions"]] == ["Romania"]
    assert summary["design"]["hubs"][0]["share_pct"]["year"] == 100.0
    assert [e["name"] for e in engineers] == ["Gamma"]
    assert [c["code"] for c in chambers] == ["RO-1"]
    assert [e["name"] for e in load["engineers"]] == ["Gamma"]
    assert [c["code"] for c in load["chambers"]] == ["RO-1"]
    assert outside["engineers"] == [] and outside["chambers"] == []
    assert outside["totals"]["engineers"]["capacity_weeks"] == 0.0
    assert [e["name"] for e in options["engineers"]] == ["Gamma"]
    assert options["hubs"] == ["PD-Romania"]


@pytest.mark.parametrize(
    ("role", "allowed"),
    [
        (RoleName.PORTFOLIO_MANAGER, True),
        (RoleName.HUB_PLANNER, True),
        (RoleName.ADMIN, True),
        (RoleName.SUPER_ADMIN, True),
        (RoleName.ENGINEER, False),
        (RoleName.EXECUTIVE_VIEWER, False),
        (RoleName.AUDITOR, False),
    ],
)
async def test_role_matrix(db_session, role, allowed):
    w = await _world(db_session, with_run=False)
    hub_ids = [w["greece"].id] if role == RoleName.HUB_PLANNER else None
    await act_as(db_session, role, hub_ids=hub_ids)
    async with client_for(db_session) as client:
        for path in (SUMMARY, LOAD, OPTIONS):
            resp = await client.get(path)
            assert resp.status_code == (200 if allowed else 403), (path, resp.text)


async def test_unauthenticated_is_401(db_session):
    async with client_for(db_session) as client:
        for path in (SUMMARY, LOAD, OPTIONS):
            assert (await client.get(path)).status_code == 401


# --- §5 resource load ------------------------------------------------------------------


def _by(rows, key):
    return {r[key]: r for r in rows}


async def test_resource_load_unfiltered_matches_engineer_utilization(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, LOAD)
        util = await _get(client, "/capacity/engineer-utilization")
        engineers = _by(await _get(client, "/engineers"), "name")
        chambers = _by(await _get(client, "/chambers"), "code")
    eng = _by(body["engineers"], "name")
    assert [e["name"] for e in body["engineers"]] == ["Alpha", "Beta", "Gamma"]
    assert {n: r["load_weeks"] for n, r in eng.items()} == {"Alpha": 8.0, "Beta": 4.0, "Gamma": 4.0}
    for u in util["engineers"]:
        assert eng[u["name"]]["load_weeks"] == u["total_booked"]
    a = eng["Alpha"]
    assert a["capacity_weeks"] == engineers["Alpha"]["capacity_weeks"]["year"] == 35.68
    assert a["utilization_pct"] == round(8 / 35.68 * 100, 2) == 22.42
    assert a["capacity_days"] == 178.4 and a["load_days"] == 40.0
    ch = _by(body["chambers"], "code")
    assert {c: r["load_weeks"] for c, r in ch.items()} == {"GR-1": 13.0, "GR-Z": 0.0, "RO-1": 2.0}
    assert ch["GR-1"]["capacity_weeks"] == chambers["GR-1"]["capacity_weeks"]["year"]
    assert ch["GR-Z"]["capacity_weeks"] == 0.0 and ch["GR-Z"]["utilization_pct"] is None
    t = body["totals"]
    assert t["engineers"]["load_weeks"] == 16.0
    assert t["engineers"]["capacity_weeks"] == round(
        sum(r["capacity_weeks"] for r in eng.values()), 2
    )
    assert t["engineers"]["utilization_pct"] == round(
        t["engineers"]["load_weeks"] / t["engineers"]["capacity_weeks"] * 100, 2
    )
    assert t["chambers"]["load_weeks"] == 15.0
    assert t["chambers"]["load_days"] == round(sum(r["load_days"] for r in ch.values()), 2)
    assert body["filters_applied"]["basis"] == "year"
    assert "tcogs" not in str(body).lower() and "customer" not in str(body).lower()


async def test_resource_load_remaining_basis(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, LOAD, basis="remaining")
        bad = await client.get(LOAD, params={"basis": "week"})
    assert bad.status_code == 422
    a = _by(body["engineers"], "name")["Alpha"]
    assert a["capacity_weeks"] == 14.41 and a["load_weeks"] == 8.0
    assert a["capacity_days"] == 72.05
    assert _by(body["chambers"], "code")["GR-1"]["capacity_weeks"] == 17.61


@pytest.mark.parametrize(
    ("params", "eng_loads", "ch_loads"),
    [
        ({"category": "A"}, {"Alpha": 3, "Beta": 0, "Gamma": 4}, {"GR-1": 4, "RO-1": 2}),
        (
            {"project_status": "In Queue"},
            {"Alpha": 5, "Beta": 2, "Gamma": 0},
            {"GR-1": 6, "RO-1": 0},
        ),
        ({"project_type": "CO"}, {"Alpha": 5, "Beta": 2, "Gamma": 0}, {"GR-1": 6, "RO-1": 0}),
        (
            {"project_type": ["CO", "RC"]},
            {"Alpha": 5, "Beta": 4, "Gamma": 0},
            {"GR-1": 9, "RO-1": 0},
        ),
        (
            {"requesting_department": "Marketing"},
            {"Alpha": 0, "Beta": 0, "Gamma": 0},
            {"GR-1": 0, "RO-1": 0},
        ),
    ],
)
async def test_resource_load_project_filters(db_session, params, eng_loads, ch_loads):
    await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, LOAD, **params)
    eng = {r["name"]: r["load_weeks"] for r in body["engineers"]}
    ch = {r["code"]: r["load_weeks"] for r in body["chambers"]}
    assert eng == {k: float(v) for k, v in eng_loads.items()}
    assert {k: ch[k] for k in ch_loads} == {k: float(v) for k, v in ch_loads.items()}
    # Capacity never depends on the project filters.
    assert _by(body["engineers"], "name")["Alpha"]["capacity_weeks"] == 35.68
    assert body["totals"]["engineers"]["load_weeks"] == float(sum(eng_loads.values()))


async def test_resource_load_engineer_and_hub_filters(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        beta = await _get(client, LOAD, engineer_id=str(w["beta"].id))
        greece = await _get(client, LOAD, hub_id=str(w["greece"].id))
        romania = await _get(client, LOAD, region="Romania")
    # Beta only; chamber load from Beta's projects G2 and O1.
    assert [r["name"] for r in beta["engineers"]] == ["Beta"]
    assert beta["engineers"][0]["load_weeks"] == 4.0
    assert {r["code"]: r["load_weeks"] for r in beta["chambers"]}["GR-1"] == 9.0
    assert beta["filters_applied"]["engineer_id"] == [str(w["beta"].id)]
    assert [r["name"] for r in greece["engineers"]] == ["Alpha", "Beta"]
    # A hub narrows the chambers to its lab region; their load stays region-wide.
    assert {r["code"]: r["load_weeks"] for r in greece["chambers"]} == {"GR-1": 13.0, "GR-Z": 0.0}
    assert [r["name"] for r in romania["engineers"]] == ["Gamma"]
    assert [r["code"] for r in romania["chambers"]] == ["RO-1"]


async def test_resource_load_no_active_run(db_session):
    await _world(db_session, with_run=False)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, LOAD)
    assert body["has_active_schedule_run"] is False
    assert all(r["load_weeks"] == 0.0 for r in body["engineers"] + body["chambers"])
    assert body["totals"]["engineers"]["capacity_weeks"] > 0


async def test_resource_load_list_bound(db_session):
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.get(LOAD, params={"requesting_department": ["x"] * 51})
    assert resp.status_code == 422


async def test_resource_load_audit_coalesced_no_figures(db_session):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)

    async def entries():
        return (
            (await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.action == ACTION)))
            .scalars()
            .all()
        )

    async with client_for(db_session) as client:
        for _ in range(3):
            await _get(client, LOAD)
        assert len(await entries()) == 1
        await _get(client, LOAD, hub_id=str(w["greece"].id))
        await _get(client, LOAD, category="A")
        await _get(client, OPTIONS)  # options are not audited
    rows = await entries()
    assert len(rows) == 3
    assert all(e.actor_user_id == user.id for e in rows)
    assert {e.hub_id for e in rows} == {None, w["greece"].id}
    first = next(
        e for e in rows if e.hub_id is None and '"category": []' in e.after_state["filter_key"]
    )
    assert first.after_state["engineer_rows"] == 3 and first.after_state["chamber_rows"] == 3
    text = str([e.after_state for e in rows])
    assert "load" not in text.replace("resource_load", "") and "35.68" not in text


# --- §6 options ------------------------------------------------------------------------


async def test_options(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, OPTIONS)
        greece = await _get(client, OPTIONS, hub_id=str(w["greece"].id))
    assert body["hubs"] == ["R&D-Greece", "PD-Romania", "OEM-HCK"]  # hub enum order
    assert body["lab_regions"] == ["Greece", "Romania"]
    assert body["project_types"] == ["NM", "CO", "RC"]
    assert body["project_statuses"] == ["In Development", "In Queue"]
    assert body["categories"] == ["A", "B", "A-OEM"]
    assert body["requesting_departments"] == []
    assert body["requesting_department_available"] is False
    assert [e["name"] for e in body["engineers"]] == ["Alpha", "Beta", "Gamma"]
    assert greece["project_types"] == ["NM", "CO"]
    assert greece["categories"] == ["A", "B"]
    assert [e["name"] for e in greece["engineers"]] == ["Alpha", "Beta"]
