"""P11-T01: capacity booked % and areas (ADR 0016, docs/API_CONTRACT_P11.md §4,
I19).

1. Pure helpers: `booked_pct` / `booking_status` at the thresholds (84.99 /
   85 / 99.99 / 100), capacity 0 with and without load, and rounding.
2. API: every hub row satisfies I19 to 2 dp on its served figures; `area`;
   the summary thresholds; the Europe / India roll-up with each lab region
   counted once (India's three hubs share one region); a Hub-Planner-scoped
   area built from in-scope hubs only, with the out-of-scope area omitted.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.chamber import Chamber
from models.enums import HubName, LabRegion, ProjectCategory, RoleName
from models.hub import HubWorkCalendar
from models.schedule import ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.capacity_supply import (
    area_for_region,
    booked_pct,
    booking,
    booking_status,
    round2,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run

# --- 1. Pure helpers ------------------------------------------------------------------


def test_thresholds_are_the_adr_constants():
    assert dc.BOOKING_NEAR_FULL_PCT == 85
    assert dc.BOOKING_FULL_PCT == 100
    assert dc.AREA_ORDER == ("Europe", "India")


@pytest.mark.parametrize(
    ("load", "capacity", "pct", "status"),
    [
        (84.99, 100, 84.99, "available"),
        (85, 100, 85.0, "near_full"),
        (99.99, 100, 99.99, "near_full"),
        (100, 100, 100.0, "full"),
        (131.2, 100, 131.2, "full"),
        (0, 100, 0.0, "available"),
        # Capacity 0: no percentage; full only when there is load.
        (5, 0, None, "full"),
        (0, 0, None, "available"),
        # Status follows the *served* (rounded) percentage: 99.996 → 100.0 → full.
        (99.996, 100, 100.0, "full"),
        (84.994, 100, 84.99, "available"),
    ],
)
def test_booked_pct_and_status(load, capacity, pct, status):
    assert booked_pct(load, capacity) == pct
    assert booking_status(load, capacity, pct) == status
    assert booking(load, capacity) == (pct, status)


def test_booked_pct_is_the_reciprocal_of_completion():
    assert booked_pct(210, 289.9) == round2(210 / 289.9 * 100) == 72.44


def test_area_mapping():
    assert area_for_region(LabRegion.GREECE) == "Europe"
    assert area_for_region(LabRegion.ROMANIA) == "Europe"
    assert area_for_region(LabRegion.INDIA) == "India"


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


def _chamber(code, region, platforms, efficiency):
    return Chamber(
        code=code, lab_region=region, max_concurrent=platforms, platforms=platforms,
        efficiency=efficiency, maintenance_weeks=2, breakdown_weeks=3, calibration_weeks=1,
        allowed_stages=[],
    )


async def _world(db_session):
    """Five hubs over three regions, with design and lab load on most."""

    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    romania = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    pd_india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    rd_india = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    hubs = {"greece": greece, "romania": romania, "pd_india": pd_india, "rd_india": rd_india,
            "oem": oem}
    calendars = {
        "greece": (5, 12, 0, 0, 25),
        "romania": (5, 13, 7, 0, 20),
        "pd_india": (6, 13, 7, 7, 20),
        "rd_india": (6, 13, 7, 7, 20),
        "oem": (6, 13, 7, 7, 20),
    }
    for key, (wd, nat, med, cas, ann) in calendars.items():
        db_session.add(
            HubWorkCalendar(
                hub_id=hubs[key].id, weekdays_per_week=wd, national_holiday_days=nat,
                medical_leave_days=med, casual_leave_days=cas, annual_leave_days=ann,
            )
        )
    # OEM-HCK has no engineers: design capacity 0 with design load > 0.
    await make_engineer(db_session, greece, fte=1.0)
    await make_engineer(db_session, romania, fte=0.5)
    await make_engineer(db_session, pd_india, fte=1.0)
    await make_engineer(db_session, rd_india, fte=0.3)
    db_session.add_all(
        [
            _chamber("GR-1", LabRegion.GREECE, 1, 0.7),
            _chamber("RO-1", LabRegion.ROMANIA, 1, 0.33),
            _chamber("IN-1", LabRegion.INDIA, 2, 0.6),
            _chamber("IN-2", LabRegion.INDIA, 1, 0.5),
        ]
    )
    projects = {
        "greece": await make_project(db_session, greece, name="GR P"),
        "romania": await make_project(db_session, romania, name="RO P"),
        "pd_india": await make_project(db_session, pd_india, name="PDI P"),
        "rd_india": await make_project(db_session, rd_india, name="RDI P"),
        "oem": await make_project(db_session, oem, name="OEM P", category=ProjectCategory.A_OEM),
    }
    run = await make_schedule_run(db_session, is_active=True)
    # (project, step, weeks): PDD-A/E and OEM-D are design, PDD-F/H and OEM-E are lab.
    steps = [
        ("greece", "PDD-A", 30), ("greece", "PDD-F", 9),
        ("romania", "PDD-E", 21), ("romania", "PDD-H", 25),
        ("pd_india", "PDD-A", 17), ("pd_india", "PDD-F", 12),
        ("rd_india", "PDD-E", 12), ("rd_india", "PDD-H", 6),
        ("oem", "OEM-D", 2), ("oem", "OEM-E", 4),
    ]
    for i, (key, step_id, weeks) in enumerate(steps):
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id, project_id=projects[key].id, step_template_id=step_id,
                sequence_order=i + 1, duration_weeks=weeks, start_week=31,
                end_week=31 + weeks - 1,
            )
        )
        # ADR 0041 (P30): the hub table's load is DEMAND from the live rows.
        # The same step as a live row whose user override is the run's
        # figure, so demand (full year = remaining, all Not Started) equals
        # the booked load here.
        if key == "oem" and step_id == "OEM-E":
            # This world puts OEM-HCK in the India lab region; the scheduler's
            # mapping (and the demand load, I25) puts OEM lab work in Greece.
            # Keep the OEM lab step run-only so the India region is unambiguous.
            continue
        db_session.add(
            ProjectWorkflowStep(
                project_id=projects[key].id, step_template_id=step_id, sequence_order=i + 1,
                duration_weeks=1, duration_override_weeks=weeks,
            )
        )
    await db_session.flush()
    return hubs


#: I19 rev. (ADR 0041): year pairs the full-year demand, remaining pairs the
#: remaining demand.
_PAIRS = [
    ("design_booked_pct_year", "design_booking_status_year", "design_load_weeks",
     "design_capacity_year"),
    ("design_booked_pct_remaining", "design_booking_status_remaining",
     "design_load_remaining_weeks", "design_capacity_remaining"),
    ("lab_booked_pct_year", "lab_booking_status_year", "lab_load_weeks", "lab_capacity_year"),
    ("lab_booked_pct_remaining", "lab_booking_status_remaining", "lab_load_remaining_weeks",
     "lab_capacity_remaining"),
]


def _expected_status(load: float, capacity: float, pct: float | None) -> str:
    if pct is None:
        return "full" if capacity == 0 and load > 0 else "available"
    if pct >= 100:
        return "full"
    return "near_full" if pct >= 85 else "available"


def _assert_i19(row: dict) -> None:
    """I19 on the row's own served figures, to 2 dp, plus the threshold rule."""

    for pct_key, status_key, load_key, cap_key in _PAIRS:
        load, cap = row[load_key], row[cap_key]
        expected = None if cap == 0 else round(load / cap * 100, 2)
        assert row[pct_key] == expected, (row.get("hub") or row["area"], pct_key)
        assert row[status_key] == _expected_status(load, cap, row[pct_key]), (
            row.get("hub") or row["area"], status_key
        )


async def test_every_hub_row_and_area_satisfies_i19(db_session):
    await _world(db_session)
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        resp = await client.get("/capacity/hubs")
        alias = await client.get("/capacity/hub-load")
    assert resp.status_code == 200, resp.text
    assert alias.json() == resp.json()
    body = resp.json()
    assert body["near_full_threshold_pct"] == 85
    assert body["full_threshold_pct"] == 100

    rows = {r["hub"]: r for r in body["rows"]}
    assert len(rows) == 5
    for row in rows.values():
        _assert_i19(row)
        assert row["area"] == ("Europe" if row["lab_region"] in ("Greece", "Romania") else "India")
    for area in body["areas"]:
        _assert_i19(area)

    # Capacity 0 with load: null pct and "full" (OEM-HCK has no engineers).
    oem = rows["OEM-HCK"]
    assert oem["design_capacity_year"] == 0.0 and oem["design_load_weeks"] == 2
    assert oem["design_booked_pct_year"] is None
    assert oem["design_booking_status_year"] == "full"
    assert oem["design_booking_status_remaining"] == "full"
    # Booked % is the reciprocal of the workbook's completion %.
    gr = rows["R&D-Greece"]
    assert gr["design_booked_pct_year"] == round2(
        gr["design_load_weeks"] / gr["design_capacity_year"] * 100
    )


async def test_areas_count_each_lab_region_once(db_session):
    await _world(db_session)
    override_current_principal(make_principal(RoleName.ADMIN))
    async with _client(db_session) as client:
        body = (await client.get("/capacity/hubs")).json()
    rows = {r["hub"]: r for r in body["rows"]}
    assert [a["area"] for a in body["areas"]] == ["Europe", "India"]
    europe, india = body["areas"]

    assert set(europe["hubs"]) == {"R&D-Greece", "PD-Romania"}
    assert europe["lab_regions"] == ["Greece", "Romania"]
    assert set(india["hubs"]) == {"PD-India", "R&D-India", "OEM-HCK"}
    assert india["lab_regions"] == ["India"]

    # Design: Σ over the area's hub rows.
    for area, hubs in ((europe, ("R&D-Greece", "PD-Romania")),
                       (india, ("PD-India", "R&D-India", "OEM-HCK"))):
        assert area["design_load_weeks"] == sum(rows[h]["design_load_weeks"] for h in hubs)
        for key in ("design_capacity_year", "design_capacity_remaining"):
            assert area[key] == round2(sum(rows[h][key] for h in hubs))

    # Lab, India: the region figure ONCE, although three hub rows repeat it.
    pd = rows["PD-India"]
    assert pd["lab_load_weeks"] == 12 + 6  # region-level demand, on every India row
    assert pd["lab_load_booked_weeks"] == 12 + 6 + 4  # the run also booked OEM-E
    for key in ("lab_load_weeks", "lab_capacity_year", "lab_capacity_remaining"):
        assert rows["R&D-India"][key] == rows["OEM-HCK"][key] == pd[key]
        assert india[key] == pd[key]
        assert india[key] != round2(3 * pd[key])
    # Lab, Europe: two distinct regions, summed.
    for key in ("lab_load_weeks", "lab_capacity_year", "lab_capacity_remaining"):
        assert europe[key] == round2(rows["R&D-Greece"][key] + rows["PD-Romania"][key])
    assert europe["lab_load_weeks"] == 9 + 25


async def test_hub_planner_area_is_built_from_in_scope_hubs_only(db_session):
    hubs = await _world(db_session)
    override_current_principal(
        make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hubs["pd_india"].id])
    )
    async with _client(db_session) as client:
        body = (await client.get("/capacity/hubs")).json()
    assert [r["hub"] for r in body["rows"]] == ["PD-India"]
    (india,) = body["areas"]  # Europe has no in-scope hub: omitted
    assert india["area"] == "India"
    assert india["hubs"] == ["PD-India"]
    assert india["lab_regions"] == ["India"]
    row = body["rows"][0]
    assert india["design_load_weeks"] == row["design_load_weeks"] == 17
    assert india["design_capacity_year"] == row["design_capacity_year"]
    # Lab stays region-level (shared chambers), counted once.
    assert india["lab_load_weeks"] == row["lab_load_weeks"]
    _assert_i19(india)


async def test_two_hub_planner_scope_gives_two_partial_areas(db_session):
    hubs = await _world(db_session)
    override_current_principal(
        make_principal(
            RoleName.HUB_PLANNER, hub_scope_all=False,
            hub_ids=[hubs["greece"].id, hubs["rd_india"].id],
        )
    )
    async with _client(db_session) as client:
        body = (await client.get("/capacity/hubs")).json()
    europe, india = body["areas"]
    assert europe["hubs"] == ["R&D-Greece"] and europe["lab_regions"] == ["Greece"]
    assert india["hubs"] == ["R&D-India"] and india["lab_regions"] == ["India"]
    assert "PD-Romania" not in str(body["areas"]) and "PD-India" not in str(body["areas"])


async def test_no_active_run_still_serves_booked_fields(db_session):
    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    await make_engineer(db_session, hub, fte=1.0)
    await db_session.flush()
    override_current_principal(make_principal(RoleName.ADMIN))
    async with _client(db_session) as client:
        body = (await client.get("/capacity/hubs")).json()
    row = body["rows"][0]
    assert row["design_booked_pct_year"] == 0.0
    assert row["design_booking_status_year"] == "available"
    # No chambers: lab capacity 0 and no load → null pct, available.
    assert row["lab_booked_pct_year"] is None
    assert row["lab_booking_status_year"] == "available"
    (europe,) = body["areas"]
    assert europe["area"] == "Europe" and europe["hubs"] == ["PD-Romania"]
