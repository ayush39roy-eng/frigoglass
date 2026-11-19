"""P37-T04: the plan clock (ADR 0052 §1–§4, API_CONTRACT_P37 §1–§4).

Every date below is checked against the ISO calendar of 2026 (ADR 0052
"ISO facts"): W42 = 12–18 Oct, W47 = 16–22 Nov, W52 = 21–27 Dec,
W53 = Mon 28 Dec 2026 – Sun 3 Jan 2027, 2027-W01 starts Mon 4 Jan 2027.
Europe/Athens is UTC+2 in November–January.

The suite pins `RPD_CURRENT_WEEK=31` (conftest). Tests of the calendar
branch remove the pin with `monkeypatch.delenv` and inject "now" with
`plan_clock.override_now`, so nothing here depends on the real date.
"""

from __future__ import annotations

import ast
import pathlib
from datetime import UTC, date, datetime
from zoneinfo import ZoneInfo

import pytest
from fastapi.testclient import TestClient
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import (
    HubName,
    LabRegion,
    RoleName,
    ScheduleRunStatus,
    WorkflowStepStatus,
)
from services import plan_clock
from services.plan_clock import PlanClockConfigError, compute
from services.schedule_persistence import create_queued_schedule_run, persist_schedule_output
from services.tracking import due_stages_for, tracking_status_for
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_schedule_run
from tests.p12_helpers import act_as, plan_step, stepped_project

ATHENS = ZoneInfo("Europe/Athens")


def _athens(y: int, m: int, d: int, hh: int = 12, mm: int = 0) -> datetime:
    return datetime(y, m, d, hh, mm, tzinfo=ATHENS)


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def calendar(monkeypatch):
    """The calendar branch: no pin, default plan year."""

    monkeypatch.delenv("RPD_CURRENT_WEEK", raising=False)
    monkeypatch.delenv("RPD_PLAN_YEAR", raising=False)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --- the pure rule ------------------------------------------------------------------


def test_monday_16_nov_2026_is_w47_with_5_left():
    c = compute(_athens(2026, 11, 16, 9), pin=None)
    assert (c.week, c.weeks_left_in_year, c.source) == (47, 5, "calendar")
    assert (c.iso_year, c.iso_week, c.plan_year_closed) == (2026, 47, False)
    assert (c.plan_year, c.week_of_year) == (2026, 47)
    assert c.as_of_date == date(2026, 11, 16)
    assert c.week_ends_at == _athens(2026, 11, 23, 0)
    assert c.week_ends_at.isoformat() == "2026-11-23T00:00:00+02:00"


def test_sunday_23_30_athens_is_still_w46():
    c = compute(_athens(2026, 11, 15, 23, 30), pin=None)
    assert c.week == 46
    assert c.as_of_date == date(2026, 11, 15)
    assert c.week_ends_at == _athens(2026, 11, 16, 0)


def test_athens_midnight_edge_utc_sunday_is_athens_monday():
    # 22:30 UTC on Sun 15 Nov = 00:30 Mon 16 Nov in Athens.
    c = compute(datetime(2026, 11, 15, 22, 30, tzinfo=UTC), pin=None)
    assert c.week == 47
    assert c.as_of_date == date(2026, 11, 16)
    # One minute earlier in Athens is still Sunday, W46.
    c2 = compute(datetime(2026, 11, 15, 21, 59, tzinfo=UTC), pin=None)
    assert c2.week == 46


@pytest.mark.parametrize(
    "instant", [_athens(2026, 12, 28), _athens(2027, 1, 1), _athens(2027, 1, 3, 23, 59)]
)
def test_iso_w53_maps_to_52_not_closed(instant):
    c = compute(instant, pin=None)
    assert (c.iso_year, c.iso_week) == (2026, 53)
    assert (c.week, c.plan_year_closed, c.weeks_left_in_year) == (52, False, 0)


def test_4_jan_2027_is_53_plan_year_2027_never_closed():
    """P53 (R53-1, I41): the week line continues; no closed year."""

    c = compute(_athens(2027, 1, 4, 0, 0), pin=None)
    assert (c.iso_year, c.iso_week) == (2027, 1)
    assert (c.week, c.plan_year, c.week_of_year, c.plan_year_closed, c.source) == (
        53, 2027, 1, False, "calendar"
    )
    assert (c.plan_year_start_week, c.plan_year_end_week, c.weeks_left_in_year) == (53, 104, 51)


@pytest.mark.parametrize(
    ("instant", "week", "year"),
    [
        (_athens(2027, 12, 31), 104, 2027),
        (_athens(2028, 1, 2), 104, 2027),  # ISO 2027-W52 ends Sun 2 Jan 2028
        (_athens(2028, 1, 3), 105, 2028),
        (_athens(2032, 12, 27), 364, 2032),  # ISO 2032-W53 → 52 of 2032
        (_athens(2033, 1, 2), 364, 2032),
        (_athens(2033, 1, 3), 365, 2033),
        (_athens(2025, 12, 1), 1, 2026),  # before the base year
    ],
)
def test_absolute_week_line(instant, week, year):
    c = compute(instant, pin=None)
    assert (c.week, c.plan_year, c.plan_year_closed) == (week, year, False)


def test_w52_dates():
    assert compute(_athens(2026, 12, 21), pin=None).week == 52
    assert compute(_athens(2026, 10, 12), pin=None).week == 42


def test_pin_wins_and_never_closes():
    for instant in (_athens(2026, 11, 16), _athens(2027, 3, 1)):
        c = compute(instant, pin=31)
        assert (c.week, c.source, c.plan_year_closed, c.weeks_left_in_year) == (
            31, "pinned", False, 21
        )
    # P53: a pin is absolute; 60 is W8 of 2027.
    c = compute(_athens(2026, 11, 16), pin=60)
    assert (c.week, c.plan_year, c.week_of_year, c.weeks_left_in_year) == (60, 2027, 8, 44)


def test_naive_datetime_is_rejected():
    with pytest.raises(ValueError):
        compute(datetime(2026, 11, 16, 9), pin=None)


def test_week_ends_at_across_the_dst_change():
    # EU summer time ends Sun 25 Oct 2026 03:00 → 02:00; the next Monday
    # midnight is at +02:00 (EET) while "now" (Sat 24 Oct) is at +03:00.
    c = compute(_athens(2026, 10, 24), pin=None)
    assert c.week == 43
    assert c.week_ends_at.isoformat() == "2026-10-26T00:00:00+02:00"


# --- the environment ----------------------------------------------------------------


def test_suite_pin_reduces_to_test_week():
    """Conftest pins 31; `TEST_WEEK` (the fixture constant) agrees."""

    c = plan_clock.now()
    assert (c.week, c.source) == (TEST_WEEK, "pinned")


@pytest.mark.parametrize("raw", ["0", "5201", "x", "31.0", "-1"])
def test_bad_pin_is_rejected(raw):
    with pytest.raises(PlanClockConfigError, match="RPD_CURRENT_WEEK"):
        plan_clock.validate_environment({"RPD_CURRENT_WEEK": raw})


@pytest.mark.parametrize("raw", ["1999", "2027", "2101", "abc"])
def test_retired_plan_year_other_than_2026_is_rejected(raw):
    """P53 (R53-1): `RPD_PLAN_YEAR` is retired; any value but 2026 stops startup."""

    with pytest.raises(PlanClockConfigError, match="RPD_PLAN_YEAR"):
        plan_clock.validate_environment({"RPD_PLAN_YEAR": raw})


def test_good_values_and_blank_pin():
    plan_clock.validate_environment({"RPD_CURRENT_WEEK": "1", "RPD_PLAN_YEAR": "2026"})
    plan_clock.validate_environment({"RPD_CURRENT_WEEK": "53"})
    plan_clock.validate_environment({"RPD_CURRENT_WEEK": "5200", "RPD_PLAN_YEAR": ""})
    assert plan_clock.read_pin({"RPD_CURRENT_WEEK": ""}) is None


@pytest.mark.parametrize("raw", ["0", "5201", "x"])
def test_bad_pin_stops_the_app_at_startup(monkeypatch, raw):
    monkeypatch.setenv("RPD_CURRENT_WEEK", raw)
    with pytest.raises(PlanClockConfigError, match="RPD_CURRENT_WEEK"):
        with TestClient(app):
            pass


def test_override_now_and_env_are_read_per_call(calendar, monkeypatch):
    with plan_clock.override_now(_athens(2026, 11, 16)):
        assert plan_clock.now().week == 47
        monkeypatch.setenv("RPD_CURRENT_WEEK", "20")
        assert plan_clock.now().week == 20
    assert plan_clock.current_week() == 20


def test_no_module_reads_the_pin_or_a_module_level_week():
    """ADR 0052 §1: only `services/plan_clock.py` reads `RPD_CURRENT_WEEK`;
    `domain_constants` has no `CURRENT_WEEK`; no application code reads
    `dc.CURRENT_WEEK`; no function parameter `current_week` has a default
    (a default is bound at import). Tests and the scheduling self-tests'
    fixture week are out of scope (fixtures)."""

    import domain_constants as dc

    assert not hasattr(dc, "CURRENT_WEEK")
    root = pathlib.Path(__file__).resolve().parents[1]
    skip_dirs = {"tests", ".venv", "alembic", "__pycache__"}
    offenders: list[str] = []
    for path in root.rglob("*.py"):
        rel = path.relative_to(root)
        if rel.parts[0] in skip_dirs or any(p.startswith(".") for p in rel.parts):
            continue
        if rel.name.startswith("_selftest"):
            continue  # scheduling self-test fixtures (algorithm-engineer, P37-T03)
        text = path.read_text()
        if str(rel) != "services/plan_clock.py" and (
            'environ.get("RPD_CURRENT_WEEK"' in text or 'environ["RPD_CURRENT_WEEK"' in text
        ):
            offenders.append(f"{rel}: reads RPD_CURRENT_WEEK")
        if "dc.CURRENT_WEEK" in text.replace("`dc.CURRENT_WEEK`", ""):
            offenders.append(f"{rel}: dc.CURRENT_WEEK")
        tree = ast.parse(text)
        for node in ast.walk(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                args = node.args
                positional = args.posonlyargs + args.args
                defaults = dict(
                    zip([a.arg for a in positional[len(positional) - len(args.defaults):]],
                        args.defaults, strict=True)
                )
                for a, d in zip(args.kwonlyargs, args.kw_defaults, strict=True):
                    if d is not None:
                        defaults[a.arg] = d
                default = defaults.get("current_week")
                if default is not None and not (
                    isinstance(default, ast.Constant) and default.value is None
                ):
                    offenders.append(f"{rel}:{node.lineno} {node.name}(current_week=...)")
    assert offenders == []


# --- GET /me --------------------------------------------------------------------------


async def test_me_pinned_without_active_run(db_session):
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        body = (await client.get("/me")).json()
    assert (body["current_week"], body["weeks_left_in_year"]) == (31, 21)
    assert (body["week_source"], body["plan_year"], body["plan_year_closed"]) == (
        "pinned", 2026, False
    )
    assert body["plan_week"] is None  # R37-7
    date.fromisoformat(body["as_of_date"])
    assert datetime.fromisoformat(body["week_ends_at"]).utcoffset() is not None


async def test_me_calendar_week_47(db_session, calendar):
    override_current_principal(make_principal(RoleName.ENGINEER))
    with plan_clock.override_now(_athens(2026, 11, 16, 9)):
        async with _client(db_session) as client:
            body = (await client.get("/me")).json()
    assert (body["current_week"], body["weeks_left_in_year"]) == (47, 5)
    assert body["as_of_date"] == "2026-11-16"
    assert body["week_ends_at"] == "2026-11-23T00:00:00+02:00"
    assert (body["week_source"], body["plan_year_closed"]) == ("calendar", False)


async def test_me_4_jan_2027_is_week_53_of_2027(db_session, calendar):
    """P53 (R53-1, R53-6): no closed year; the served week line goes on."""

    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    with plan_clock.override_now(_athens(2027, 1, 4, 8)):
        async with _client(db_session) as client:
            body = (await client.get("/me")).json()
    assert (body["current_week"], body["weeks_left_in_year"], body["plan_year_closed"]) == (
        53, 51, False
    )
    assert (body["plan_year"], body["week_base_year"]) == (2027, 2026)
    assert (body["plan_year_start_week"], body["plan_year_end_week"]) == (53, 104)
    assert (body["horizon_years"], body["horizon_weeks"]) == (5, 53 + 260)


async def test_me_plan_week_status(db_session, monkeypatch):
    run = await make_schedule_run(db_session, is_active=True, current_week=31)
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        current = (await client.get("/me")).json()["plan_week"]
        assert current == {"run_week": 31, "run_version": run.version, "status": "current"}
        # R37-6: a pin lowered (or raised) away from the run's week is behind.
        monkeypatch.setenv("RPD_CURRENT_WEEK", "29")
        assert (await client.get("/me")).json()["plan_week"]["status"] == "pending"
        await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED, current_week=29)
        assert (await client.get("/me")).json()["plan_week"]["status"] == "recalculating"


# --- I40: one served week across surfaces --------------------------------------------


async def test_one_week_across_me_capacity_and_checkins(db_session, calendar):
    run = await make_schedule_run(db_session, is_active=True, current_week=42)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    with plan_clock.override_now(_athens(2026, 11, 18)):
        async with _client(db_session) as client:
            me = (await client.get("/me")).json()
            hub_load = (await client.get("/capacity/hub-load")).json()
            util = (await client.get("/capacity/engineer-utilization")).json()
            due = (await client.get("/check-ins/due")).json()
    assert me["current_week"] == 47 == due["week"] == util["current_week"]
    assert hub_load["remaining_weeks"] == 52 - 47 == me["weeks_left_in_year"]
    assert util["run_week"] == run.current_week == 42
    assert me["plan_week"]["status"] == "pending"


async def test_workflow_settings_and_resource_load_serve_the_calendar_week(db_session, calendar):
    await make_schedule_run(db_session, is_active=True, current_week=42)
    await act_as(db_session, RoleName.ADMIN)
    with plan_clock.override_now(_athens(2026, 11, 18)):
        async with _client(db_session) as client:
            settings = await client.get("/workflow-settings")
            load = await client.get("/planning/resource-load")
            summary = await client.get("/planning/capacity-summary")
    assert settings.status_code == 200, settings.text
    assert settings.json()["current_week"] == 47
    assert load.status_code == 200, load.text
    assert (load.json()["current_week"], load.json()["run_week"]) == (47, 42)
    assert summary.json()["current_week"] == 47


# --- check-ins: R37-1 and R37-10 -------------------------------------------------------


async def test_r37_1_stage_planned_w43_is_still_due_at_w47(db_session):
    hub = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    run = await make_schedule_run(db_session, is_active=True, current_week=42)
    project = await stepped_project(db_session, hub, name="Behind")
    await plan_step(db_session, run, project, "PDD-E", 43, 44)
    await plan_step(db_session, run, project, "PDD-F", 49, 50)
    stages = (await due_stages_for(db_session, [project.id], current_week=47))[project.id]
    assert [(s.step_id, s.status, s.due_since_week, s.plan_percent) for s in stages] == [
        ("PDD-E", WorkflowStepStatus.NOT_STARTED, 43, 100)
    ]
    # Due since W43, no check-in in W46 or W47 → overdue.
    status = await tracking_status_for(db_session, [project.id], current_week=47)
    assert status[project.id] == "overdue"


async def test_r37_1_reduces_to_the_old_rule_when_weeks_match(db_session):
    """Run week == calendar week: a Not Started step never starts before it,
    so only the window that contains the week is due (the pre-P37 rule)."""

    hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    run = await make_schedule_run(db_session, is_active=True, current_week=TEST_WEEK)
    project = await stepped_project(db_session, hub, name="Current")
    await plan_step(db_session, run, project, "PDD-E", TEST_WEEK, TEST_WEEK + 3)
    await plan_step(db_session, run, project, "PDD-F", TEST_WEEK + 4, TEST_WEEK + 6)
    stages = (await due_stages_for(db_session, [project.id], current_week=TEST_WEEK))[
        project.id
    ]
    assert [(s.step_id, s.due_since_week) for s in stages] == [("PDD-E", TEST_WEEK)]


async def test_p53_check_in_in_2027_is_never_refused_as_closed(db_session, calendar):
    """P53 (R53-1): `PLAN_YEAR_CLOSED` is retired; on 4 Jan 2027 the
    calendar week is 53 and check-ins stamp it."""

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await stepped_project(db_session, hub, name="Next year")
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    entry = {"project_id": str(project.id), "step_id": "PDD-A", "status": "In Progress",
             "percent_complete": 10}
    with plan_clock.override_now(_athens(2027, 1, 4, 10)):
        async with _client(db_session) as client:
            submitted = await client.post("/check-ins", json={"entries": [entry]})
            due = await client.get("/check-ins/due")
    assert submitted.status_code != 409, submitted.text
    assert "PLAN_YEAR_CLOSED" not in submitted.text
    assert due.status_code == 200 and due.json()["week"] == 53


# --- runs: R37-2, I38, R37-4 -----------------------------------------------------------


async def test_queued_row_stores_the_week_read_at_creation(db_session, calendar):
    with plan_clock.override_now(_athens(2026, 11, 15, 23, 59)):
        run = await create_queued_schedule_run(
            db_session, solver_type=_greedy(), trigger_reason="test", triggered_by_user_id=None
        )
    assert run.current_week == 46


async def test_persist_refuses_an_input_at_another_week(db_session):
    from scheduling.types import ScheduleInput, ScheduleOutput

    queued = await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING, current_week=46)
    with pytest.raises(ValueError, match="current_week"):
        await persist_schedule_output(
            db_session,
            ScheduleInput(projects=(), engineers=(), chambers=(), current_week=47),
            ScheduleOutput(project_outcomes=(), scheduling_order=()),
            solver_type=_greedy(),
            trigger_reason="test",
            existing_run=queued,
            activate=False,
            sync_live_workflow_steps=False,
        )


async def test_changes_serve_baseline_and_run_weeks(db_session):
    base = await make_schedule_run(db_session, current_week=42)
    new = await make_schedule_run(db_session, is_active=True, current_week=47)
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        resp = await client.get(f"/schedule-runs/{new.id}/changes?against={base.id}")
        same = await client.get(f"/schedule-runs/{new.id}/changes?against={new.id}")
    assert resp.status_code == 200, resp.text
    assert (resp.json()["baseline_week"], resp.json()["run_week"]) == (42, 47)
    assert (same.json()["baseline_week"], same.json()["run_week"]) == (47, 47)


def _greedy():
    from models.enums import SolverType

    return SolverType.GREEDY


@pytest.mark.parametrize("module", ["workers.celery_app", "workers.worker_app"])
def test_bad_pin_stops_a_celery_worker_at_init(monkeypatch, module):
    import importlib

    from celery import signals

    mod = importlib.import_module(module)
    monkeypatch.setenv("RPD_PLAN_YEAR", "abc")
    with pytest.raises(PlanClockConfigError, match="RPD_PLAN_YEAR"):
        mod._validate_plan_clock_env()
    # Connected to the worker_init signal (strong reference).
    receivers = [r[1] for r in signals.worker_init.receivers]
    assert any(r is mod._validate_plan_clock_env for r in receivers)


@pytest.mark.parametrize("week", [0, 5201])
async def test_builder_and_queued_row_reject_a_non_plan_week(db_session, week):
    """I41 (amended at P53) via `scheduling.require_plan_week`: the live
    builder and a QUEUED row never accept a week outside 1..5200 (53 is
    2027 W1 and is valid)."""

    from services.schedule_persistence import build_schedule_input_from_db

    with pytest.raises(ValueError, match="I41"):
        await build_schedule_input_from_db(db_session, current_week=week)
    with pytest.raises(ValueError, match="I41"):
        await create_queued_schedule_run(
            db_session, solver_type=_greedy(), trigger_reason="test",
            triggered_by_user_id=None, current_week=week,
        )
