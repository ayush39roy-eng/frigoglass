"""P9-T03: capacity supply (DOMAIN_RULES "Capacity supply", ADR 0008, I17) and
the extended `GET /capacity/hub-load` / `/capacity/hubs` (contract §4).

1. Pure formula tests against the client workbook (docs/CLIENT_FORMULAS.md
   §2.1–2.2). Where the workbook is self-inconsistent (India medical leave /5
   while everything else is /6, and 2.6 India holiday weeks computed with
   /5), ADR 0008's normalisation is asserted, and the workbook figure is
   reproduced only when fed the workbook's own inputs.
2. API tests: load from the active run by the run's snapshotted kinds (I6/I7,
   elapsed and skipped steps add 0, lab × 1.0), estimated columns, region-level
   lab figures, gap / completion (null when load 0), deprecated aliases,
   hub scoping.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.chamber import Chamber
from models.enums import HubName, LabRegion, ProjectCategory, ProjectStatus, RoleName
from models.hub import HubWorkCalendar
from models.schedule import ScheduleRunProjectStep
from services.capacity_supply import (
    calendar_figures,
    chamber_figures,
    gap_and_completion,
    lab_remaining_fraction,
    region_holiday_weeks,
    round2,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run

# --- 1. Pure formulas ---------------------------------------------------------------


def _cal(weekdays, nat, med, cas, ann, weeks=52) -> HubWorkCalendar:
    return HubWorkCalendar(
        weekdays_per_week=weekdays,
        national_holiday_days=nat,
        medical_leave_days=med,
        casual_leave_days=cas,
        annual_leave_days=ann,
        weeks_in_year=weeks,
    )


def test_calendar_figures_match_workbook_for_greece_and_romania():
    greece = calendar_figures(_cal(5, 12, 0, 0, 25), current_week=17)
    romania = calendar_figures(_cal(5, 13, 7, 0, 20), current_week=17)
    assert round2(greece.working_weeks_per_engineer) == 44.60
    assert round2(romania.working_weeks_per_engineer) == 44.00
    # 124.9 man-weeks for Greece (Σ FTE 2.8), per the workbook.
    assert round(greece.working_weeks_per_engineer * 2.8, 1) == 124.9


def test_calendar_figures_india_normalised_per_adr_0008():
    # The workbook divides India medical leave by 5 (43.93); ADR 0008 divides
    # every deduction by the hub's own weekdays: 52 − 47/6 = 44.17.
    india = calendar_figures(_cal(6, 13, 7, 7, 20), current_week=31)
    assert round2(india.working_weeks_per_engineer) == 44.17
    assert round2(india.remaining_fraction) == round2(21 / 52)
    # remaining = (52 − 31) − deduction × (21/52)
    expected = 21 - (47 / 6) * (21 / 52)
    assert india.remaining_working_weeks == pytest.approx(expected)


def test_remaining_design_capacity_workbook_example():
    # Workbook India PD: 37 remaining weeks (current week 15), 5.75 FTE → 179.7
    # using its own 43.93 deduction (8.07 weeks). Feed the workbook's inputs.
    cal = calendar_figures(_cal(6, 13, 8.4, 7, 20), current_week=15)  # 13/6+8.4/6+7/6+20/6 = 8.07
    assert round(cal.working_weeks_per_engineer, 2) == 43.93
    assert round(cal.remaining_working_weeks * 5.75, 1) == 179.7


def test_no_calendar_means_no_deductions():
    fig = calendar_figures(None, current_week=31)
    assert fig.working_weeks_per_engineer == 52.0
    assert fig.remaining_working_weeks == 21.0


def _chamber(platforms, efficiency, maintenance, breakdown, calibration) -> Chamber:
    return Chamber(
        code="X",
        lab_region=LabRegion.INDIA,
        max_concurrent=platforms,
        platforms=platforms,
        efficiency=efficiency,
        maintenance_weeks=maintenance,
        breakdown_weeks=breakdown,
        calibration_weeks=calibration,
        allowed_stages=[],
    )


@pytest.mark.parametrize(
    "args,working,efficient",
    [
        ((1, 0.7, 2, 1, 1), 45.4, 31.78),
        ((4, 0.6, 2, 11, 1), 35.4, 84.96),
        ((2, 0.6, 2, 7, 1), 39.4, 47.28),
        ((1, 0.5, 2, 2, 1), 44.4, 22.20),
    ],
)
def test_chamber_figures_reproduce_workbook_with_its_holiday_weeks(args, working, efficient):
    fig = chamber_figures(_chamber(*args), region_holidays=2.6)
    assert round2(fig.working_weeks_per_chamber) == working
    assert round2(fig.efficient_lab_weeks) == efficient


def test_region_holiday_weeks_takes_the_largest():
    cals = {LabRegion.INDIA: [_cal(6, 13, 0, 0, 0), _cal(5, 13, 0, 0, 0)]}
    assert region_holiday_weeks(cals, LabRegion.INDIA) == pytest.approx(2.6)
    assert region_holiday_weeks(cals, LabRegion.GREECE) == 0.0


def test_gap_and_completion():
    assert gap_and_completion(100, 40) == (60, 0.4)
    assert gap_and_completion(0, 40) == (-40, None)
    assert lab_remaining_fraction(31) == pytest.approx(21 / 52)
    assert round2(-0.001) == 0.0 and str(round2(-0.001)) == "0.0"


# --- 2. API ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_hub_load_supply_and_load_figures(db_session):
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    for hub in (india, oem):
        db_session.add(
            HubWorkCalendar(
                hub_id=hub.id, weekdays_per_week=6, national_holiday_days=13,
                medical_leave_days=7, casual_leave_days=7, annual_leave_days=20,
            )
        )
    db_session.add(
        HubWorkCalendar(
            hub_id=greece.id, weekdays_per_week=5, national_holiday_days=12,
            medical_leave_days=0, casual_leave_days=0, annual_leave_days=25,
        )
    )
    await make_engineer(db_session, india, fte=1.0)
    await make_engineer(db_session, india, fte=0.75)
    db_session.add(_chamber_row("IN-A", LabRegion.INDIA, 4, 0.6, 2, 11, 1))
    db_session.add(_chamber_row("GR-A", LabRegion.GREECE, 1, 0.7, 2, 8, 1))

    p_india = await make_project(
        db_session, india, name="India P", estimated_design_weeks=10.5, estimated_lab_weeks=4
    )
    p_oem = await make_project(
        db_session, oem, name="OEM P", category=ProjectCategory.A_OEM, estimated_lab_weeks=6,
        certification_testing_required=False,
    )
    await make_project(
        db_session, india, name="Held", status=ProjectStatus.ON_HOLD, estimated_design_weeks=99
    )
    run = await make_schedule_run(
        db_session,
        is_active=True,
        # Snapshot says PDD-B is elapsed in THIS run (settings changed later).
        workflow_snapshot={
            "workflows": [
                {"id": "PDD", "steps": [{"step_id": "PDD-B", "kind": "elapsed"}]},
            ],
            "lead_times": [],
        },
    )
    steps = [
        (p_india, "PDD-A", 1, False),  # design → 1
        (p_india, "PDD-B", 8, False),  # elapsed in the run's snapshot → 0
        (p_india, "PDD-C", 4, False),  # elapsed → 0
        (p_india, "PDD-E", 6, False),  # design → 6
        (p_india, "PDD-F", 6, False),  # lab → 6 (region India)
        (p_india, "PDD-G", 0, True),  # skipped → 0
        (p_oem, "OEM-E", 2, False),  # lab → 2 (region India, hub OEM)
        (p_oem, "OEM-D", 2, False),  # design → 2 for OEM hub
    ]
    for i, (project, step_id, duration, skipped) in enumerate(steps):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id, project_id=project.id, step_template_id=step_id,
                sequence_order=i + 1, duration_weeks=duration, start_week=31,
                end_week=31 + max(duration, 1) - 1, skipped=skipped,
            )
        )
    await db_session.flush()

    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        resp = await client.get("/capacity/hub-load")
        alias = await client.get("/capacity/hubs")
    assert resp.status_code == 200, resp.text
    assert alias.json() == resp.json()
    body = resp.json()
    assert body["has_active_schedule_run"] is True
    rows = {r["hub"]: r for r in body["rows"]}

    pd = rows["PD-India"]
    assert pd["lab_region"] == "India"
    assert pd["design_load_weeks"] == 7
    assert pd["lab_load_weeks"] == 8.0  # region: 6 (PD) + 2 (OEM)
    assert pd["lab_load_units"] == 6.0  # deprecated: this hub's own lab load
    assert pd["design_load_estimated_weeks"] == 10.5  # On Hold project excluded
    assert pd["lab_load_estimated_weeks"] == 4.0  # OEM project has no cert testing
    assert pd["engineer_fte_total"] == 1.75
    assert pd["working_weeks_per_engineer"] == 44.17
    assert pd["design_capacity_year"] == round2((52 - 47 / 6) * 1.75)
    remaining = (21 - (47 / 6) * (21 / 52)) * 1.75
    assert pd["design_capacity_remaining"] == round2(remaining)
    assert pd["design_capacity_weeks"] == pd["design_capacity_remaining"]
    assert pd["remaining_fraction"] == round(21 / 52, 4)
    lab_year = (52 - 13 / 6 - 2 - 11 - 1) * 0.6 * 4
    assert pd["lab_capacity_year"] == round2(lab_year)
    assert pd["lab_capacity_remaining"] == round2(lab_year * 21 / 52)
    assert pd["lab_capacity_units"] == pd["lab_capacity_remaining"]
    assert pd["design_gap_year"] == round2(7 - (52 - 47 / 6) * 1.75)
    assert pd["design_completion_pct_year"] == round2((52 - 47 / 6) * 1.75 / 7)
    assert pd["lab_gap_remaining"] == round2(8 - lab_year * 21 / 52)
    assert [c["code"] for c in pd["chambers"]] == ["IN-A"]

    oem_row = rows["OEM-HCK"]
    assert oem_row["design_load_weeks"] == 2
    assert oem_row["lab_load_weeks"] == 8.0  # same region figure
    assert oem_row["engineer_fte_total"] == 0.0
    assert oem_row["design_completion_pct_year"] == 0.0

    gr = rows["R&D-Greece"]
    assert gr["design_load_weeks"] == 0
    assert gr["design_completion_pct_year"] is None
    assert gr["lab_completion_pct_remaining"] is None
    assert gr["working_weeks_per_engineer"] == 44.6
    assert gr["lab_capacity_year"] == round2((52 - 2.4 - 2 - 8 - 1) * 0.7)


def _chamber_row(code, region, platforms, efficiency, maintenance, breakdown, calibration):
    return Chamber(
        code=code, lab_region=region, max_concurrent=platforms, platforms=platforms,
        efficiency=efficiency, maintenance_weeks=maintenance, breakdown_weeks=breakdown,
        calibration_weeks=calibration, allowed_stages=[],
    )


async def test_hub_load_without_active_run_still_reports_supply(db_session):
    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    db_session.add(
        HubWorkCalendar(
            hub_id=hub.id, weekdays_per_week=5, national_holiday_days=13,
            medical_leave_days=7, casual_leave_days=0, annual_leave_days=20,
        )
    )
    await make_engineer(db_session, hub, fte=1.0)
    await db_session.flush()
    override_current_principal(make_principal(RoleName.ADMIN))
    async with _client(db_session) as client:
        resp = await client.get("/capacity/hub-load")
    body = resp.json()
    assert body["has_active_schedule_run"] is False
    row = body["rows"][0]
    assert row["design_load_weeks"] == 0
    assert row["design_capacity_year"] == 44.0
    assert row["design_completion_pct_year"] is None


async def test_hub_load_is_hub_scoped(db_session):
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    override_current_principal(
        make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[india.id])
    )
    async with _client(db_session) as client:
        resp = await client.get("/capacity/hubs")
    assert [r["hub"] for r in resp.json()["rows"]] == ["PD-India"]
