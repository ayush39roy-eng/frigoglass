"""P20-T02 (ADR 0032 §6 follow-ups): FTE gates speed, load stays effort.

- `GET /capacity/engineer-utilization` spreads each design row's effort
  (`duration_weeks`) over its elapsed span; totals are unchanged.
- `services.workspace.stage_overrun` / `health_badge` judge a design step
  against its FTE-stretched planned span, so a sub-1.0 FTE leader is not
  "At Risk" by itself.
- The Priority board's remaining design weeks are effort.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.engineer import Engineer
from models.enums import HubName, LabRegion, RoleName, SolverType, WorkflowStepStatus
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from scheduling.greedy import run_greedy_sgs
from seed import seed_demo_data
from services.capacity_priority import remaining_run_load_by_project
from services.run_step_effort import effort_from, spread_effort
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.workspace import health_badge, planned_span_weeks, row_span_fte, stage_overrun
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import act_as, client_for, plan_step, set_progress, stepped_project

URL = "/capacity/engineer-utilization"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _get(client, path=URL, **params):
    resp = await client.get(path, params={k: str(v) for k, v in params.items()})
    assert resp.status_code == 200, resp.text
    return resp.json()


# --- spread_effort (pure) ------------------------------------------------------------


def test_spread_even_over_elapsed_span():
    cells = spread_effort(31, 38, 4)  # 4 effort weeks at 0.5 FTE = 8 elapsed
    assert list(cells) == list(range(31, 39))
    assert all(v == 0.5 for v in cells.values())
    assert sum(cells.values()) == 4


def test_spread_at_full_fte_is_one_per_week():
    assert spread_effort(10, 13, 4) == {10: 1.0, 11: 1.0, 12: 1.0, 13: 1.0}


def test_spread_tail_split_and_fallbacks():
    # In Progress: row W25..W38, duration 8, remaining 4 on the tail W31..W38.
    cells = spread_effort(25, 38, 8, tail_start_week=31, remaining_weeks=4)
    assert all(cells[w] == pytest.approx(4 / 6) for w in range(25, 31))
    assert all(cells[w] == 0.5 for w in range(31, 39))
    assert sum(cells.values()) == pytest.approx(8)
    assert effort_from(cells, 31) == pytest.approx(4)
    # Tail at the row start (no past weeks): even spread.
    assert spread_effort(31, 38, 4, tail_start_week=31, remaining_weeks=2) == spread_effort(
        31, 38, 4
    )
    # remaining >= duration (an override above the duration): even spread, total kept.
    over = spread_effort(25, 38, 8, tail_start_week=31, remaining_weeks=20)
    assert sum(over.values()) == pytest.approx(8)
    # A run stale against live progress (remaining 5, tail of 4 weeks at 1.0 FTE):
    # never more than one effort week per booked week; the excess stays done.
    stale = spread_effort(25, 34, 10, tail_start_week=31, remaining_weeks=5)
    assert all(stale[w] == 1.0 for w in range(25, 35))
    assert effort_from(stale, 31) == 4
    assert spread_effort(5, 5, 0) == {}
    assert spread_effort(6, 5, 3) == {}


# --- engineer utilization ------------------------------------------------------------


async def test_half_fte_bar_spreads_effort_and_keeps_total(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True, current_week=31)
    half = await make_engineer(db_session, hub, name="Half", fte=0.5)
    full = await make_engineer(db_session, hub, name="Full", fte=1.0)
    p1 = await stepped_project(db_session, hub, name="P1", leader=half)
    p2 = await stepped_project(db_session, hub, name="P2", leader=full)
    row = await plan_step(db_session, run, p1, "PDD-A", 31, 38, engineer=half)
    row.duration_weeks = 4  # effort; the 8-week span is ceil(4 / 0.5)
    await plan_step(db_session, run, p2, "PDD-A", 31, 34, engineer=full)
    await db_session.flush()

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client)
        load = await _get(client, "/planning/resource-load")
    rows = {r["name"]: r for r in body["engineers"]}
    h = rows["Half"]
    assert h["total_booked"] == 4.0
    by_week = {w["week"]: w["booked"] for w in h["weeks"]}
    assert all(by_week[w] == 0.5 for w in range(31, 39))
    assert by_week[30] == 0 and by_week[39] == 0
    assert sum(by_week.values()) == 4.0
    f = rows["Full"]
    assert f["total_booked"] == 4.0
    assert [w["booked"] for w in f["weeks"][30:34]] == [1.0, 1.0, 1.0, 1.0]
    # Same effort total as Resource load analytics (ADR 0032 §6).
    loads = {e["name"]: e["load_weeks"] for e in load["engineers"]}
    assert loads == {"Half": 4.0, "Full": 4.0}


async def test_in_progress_row_puts_remaining_effort_on_the_tail(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True, current_week=31)
    half = await make_engineer(db_session, hub, name="Half", fte=0.5)
    project = await stepped_project(db_session, hub, name="P", leader=half)
    # PDD-A In Progress since W25, 8 effort weeks, 50 % done: remaining 4 effort
    # = 8 elapsed at 0.5 FTE, booked W31..W38; the row is stored W25..W38.
    await set_progress(
        db_session, project, "PDD-A", WorkflowStepStatus.IN_PROGRESS, percent=50, start=25
    )
    row = await plan_step(db_session, run, project, "PDD-A", 25, 38, engineer=half)
    row.duration_weeks = 8
    await db_session.flush()

    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client)
    r = body["engineers"][0]
    by_week = {w["week"]: w["booked"] for w in r["weeks"]}
    assert r["total_booked"] == 8.0
    assert all(by_week[w] == 0.5 for w in range(31, 39))
    assert all(by_week[w] == 0.67 for w in range(25, 31))  # 4 done effort over 6 weeks
    assert sum(by_week[w] for w in range(31, 53)) == 4.0


async def test_seeded_half_fte_totals_unchanged(db_session):
    """Whole seed at 0.5 FTE: per-engineer totals equal Resource load analytics
    and the hub design load (I6); no cell from the current week on exceeds the
    engineer's speed."""

    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    for e in (await db_session.execute(select(Engineer))).scalars().all():
        e.fte = 0.5
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client)
        load = await _get(client, "/planning/resource-load")
        cap = await _get(client, "/capacity/hub-load")
    loads = {e["engineer_id"]: e["load_weeks"] for e in load["engineers"]}
    # Frozen projects are never stretched (I10), so their leaders can read 1.0.
    frozen_leaders = {
        str(p.leader_engineer_id)
        for p in (await db_session.execute(select(Project))).scalars().all()
        if p.frozen and p.leader_engineer_id is not None
    }
    assert frozen_leaders  # the seed has frozen projects; the exemption is exercised
    cw = body["current_week"]
    stretched = 0
    for row in body["engineers"]:
        assert row["total_booked"] == loads[row["id"]]
        for w in row["weeks"]:
            if w["week"] >= cw and row["id"] not in frozen_leaders:
                assert w["booked"] <= 0.5 + 1e-9
            if 0 < w["booked"] < 1:
                stretched += 1
    assert stretched > 0
    # ADR 0041 R12: engineer utilization reconciles with the run-BOOKED load.
    assert sum(r["total_booked"] for r in body["engineers"]) == sum(
        r["design_load_booked_weeks"] for r in cap["rows"]
    )


# --- stage overrun / health badge ----------------------------------------------------


def _row(start, end, duration, engineer_id=None):
    return ScheduleRunProjectStep(
        step_template_id="PDD-A",
        start_week=start,
        end_week=end,
        duration_weeks=duration,
        skipped=False,
        assigned_engineer_id=engineer_id,
    )


def test_planned_span_weeks():
    assert planned_span_weeks(4, None) == 4
    assert planned_span_weeks(4, 1.0) == 4
    assert planned_span_weeks(4, 0.5) == 8
    assert planned_span_weeks(4, 0.63) == 7
    assert planned_span_weeks(4, 0.0) == 4  # never divides; data_error upstream


def test_stage_overrun_at_full_and_half_fte():
    import uuid

    eng = uuid.uuid4()
    in_progress = ProjectWorkflowStep(status=WorkflowStepStatus.IN_PROGRESS)
    # 4 effort weeks from W31: at 1.0 FTE planned end W34, at 0.5 FTE W38.
    on_time_full = _row(31, 34, 4, eng)
    assert stage_overrun(on_time_full, in_progress, 1.0) == 0
    late_full = _row(31, 36, 4, eng)
    assert stage_overrun(late_full, in_progress, 1.0) == 2
    on_time_half = _row(31, 38, 4, eng)
    assert stage_overrun(on_time_half, in_progress, 0.5) == 0
    assert stage_overrun(on_time_half, in_progress, None) == 4  # the pre-ADR 0032 bug
    late_half = _row(31, 40, 4, eng)
    assert stage_overrun(late_half, in_progress, 0.5) == 2
    # Done past the stretched plan.
    done = ProjectWorkflowStep(status=WorkflowStepStatus.DONE, actual_end_week=39)
    assert stage_overrun(on_time_half, done, 0.5) == 1
    # Not Started: the run's own end_week is the plan, whatever the FTE now is.
    not_started = ProjectWorkflowStep(status=WorkflowStepStatus.NOT_STARTED)
    assert stage_overrun(on_time_half, not_started, None) == 0
    assert stage_overrun(on_time_half, not_started, 1.0) == 0


def test_row_span_fte():
    import uuid

    eng = uuid.uuid4()
    ftes = {eng: 0.5}
    assert row_span_fte(_row(1, 8, 4, eng), ftes, frozen=False) == 0.5
    assert row_span_fte(_row(1, 8, 4, eng), ftes, frozen=True) is None
    assert row_span_fte(_row(1, 4, 4, None), ftes, frozen=False) is None  # lab / elapsed
    assert row_span_fte(_row(1, 8, 4, eng), None, frozen=False) is None
    # The run's stored FTE wins over the engineer's current one.
    stored = _row(1, 8, 4, eng)
    stored.span_fte = 0.5
    assert row_span_fte(stored, {eng: 1.0}, frozen=False) == 0.5
    assert row_span_fte(stored, None, frozen=False) == 0.5
    assert row_span_fte(stored, None, frozen=True) is None


def test_health_badge_half_fte_on_track_and_overrun():
    import uuid

    eng = uuid.uuid4()
    ok = ScheduleRunProjectOutcome(left_out=False, last_step_end_week=50, delay_weeks_applied=0)
    live = {"PDD-A": ProjectWorkflowStep(status=WorkflowStepStatus.IN_PROGRESS)}
    on_time = _row(31, 38, 4, eng)
    late = _row(31, 40, 4, eng)
    assert health_badge(ok, [on_time], live, 31, fte_by_engineer={eng: 0.5}) == "on_track"
    assert health_badge(ok, [late], live, 31, fte_by_engineer={eng: 0.5}) == "at_risk"
    # At 1.0 FTE the same 8-week bar for 4 effort weeks is an overrun.
    assert health_badge(ok, [on_time], live, 31, fte_by_engineer={eng: 1.0}) == "at_risk"
    # Frozen projects are never stretched (I10).
    assert (
        health_badge(ok, [on_time], live, 31, fte_by_engineer={eng: 0.5}, frozen=True)
        == "at_risk"
    )


async def test_workspace_health_badge_half_fte_not_at_risk(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True, current_week=31)
    half = await make_engineer(db_session, hub, name="Half", fte=0.5)
    project = await stepped_project(db_session, hub, name="P", leader=half)
    await set_progress(
        db_session, project, "PDD-A", WorkflowStepStatus.IN_PROGRESS, percent=0, start=31
    )
    row = await plan_step(db_session, run, project, "PDD-A", 31, 38, engineer=half)
    row.duration_weeks = 4
    db_session.add(
        ScheduleRunProjectOutcome(
            schedule_run_id=run.id,
            project_id=project.id,
            left_out=False,
            within_year=True,
            last_step_end_week=38,
            delay_weeks_applied=0,
        )
    )
    await db_session.flush()
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        body = await _get(client, f"/projects/{project.id}/workspace")
    assert body["health"] == "on_track"
    stage = next(s for s in body["stages"] if s["step_id"] == "PDD-A")
    assert stage["overrun_weeks"] == 0


# --- priority board remaining design weeks -------------------------------------------


async def test_remaining_design_weeks_are_effort(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True, current_week=31)
    half = await make_engineer(db_session, hub, name="Half", fte=0.5)
    project = await stepped_project(db_session, hub, name="P", leader=half)
    row = await plan_step(db_session, run, project, "PDD-A", 31, 38, engineer=half)
    row.duration_weeks = 4
    await db_session.flush()
    result = await remaining_run_load_by_project(db_session, run, [project.id])
    assert result[project.id] == (4.0, 0.0)  # not the 8 elapsed weeks


# --- engineer FTE bounds -------------------------------------------------------------


@pytest.mark.parametrize("bad", [0, -0.5, 0.004, 10, float("inf"), float("nan")])
def test_engineer_fte_bounds_refuse_values_the_scheduler_cannot_use(bad):
    import uuid

    from pydantic import ValidationError

    from schemas.engineer import EngineerCreateRequest, EngineerUpdateRequest

    with pytest.raises(ValidationError):
        EngineerCreateRequest(name="E", hub_id=uuid.uuid4(), fte=bad)
    with pytest.raises(ValidationError):
        EngineerUpdateRequest(fte=bad)


@pytest.mark.parametrize("good", [0.01, 0.5, 0.63, 1.0, 1.25])
def test_engineer_fte_bounds_accept_real_values(good):
    import uuid

    from schemas.engineer import EngineerCreateRequest, EngineerUpdateRequest

    assert EngineerCreateRequest(name="E", hub_id=uuid.uuid4(), fte=good).fte == good
    assert EngineerUpdateRequest(fte=good).fte == good


# --- GanttStepRow.span_fte (P20-T02 add-on) ------------------------------------------

GANTT_STEP_ROW_FIELDS = {
    "step_id", "step_name", "kind", "sequence_order", "skipped", "status",
    "percent_complete", "duration_weeks", "planned_start_week", "planned_end_week",
    "actual_start_week", "actual_end_week", "assigned_engineer_name",
    "assigned_chamber_code", "eng_conflict", "chamber_overlap", "lead_time_weeks",
    "duration_override_weeks", "start_not_before_week", "timing_editable", "span_fte",
    "effort_weeks",  # ADR 0041 R4 (P30-T02)
}


def test_gantt_step_row_contract():
    """The exact backend contract row (the TS mirror is the frontend's follow-up)."""

    schema = app.openapi()["components"]["schemas"]["GanttStepRow"]
    assert set(schema["properties"]) == GANTT_STEP_ROW_FIELDS
    assert "span_fte" in schema["required"]
    types = {t.get("type") for t in schema["properties"]["span_fte"]["anyOf"]}
    assert types == {"number", "null"}


def test_run_step_span_fte_rules():
    from scheduling.types import ProjectInput, StepProgressInput, StepSchedule
    from services.schedule_persistence import run_step_span_fte

    def proj(frozen=False, progress=()):
        return ProjectInput(
            project_id="p", name="P", hub="R&D-Greece", status="In Development",
            category="A", priority="P1", frozen=frozen, leader_engineer_id="e",
            actual_start_week=1 if frozen else None, step_progress=progress,
        )

    def step(kind="design", eng="e", skipped=False, sid="PDD-A"):
        return StepSchedule(
            step_id=sid, sequence_order=1, kind=kind, start_week=31, end_week=38,
            duration_weeks=4, assigned_engineer_id=eng,
            assigned_chamber_id="c" if kind == "lab" else None, skipped=skipped,
        )

    ftes = {"e": 0.5, "f": 1.0}
    assert run_step_span_fte(proj(), step(), ftes) == 0.5
    assert run_step_span_fte(proj(), step(eng="f"), ftes) == 1.0
    assert run_step_span_fte(proj(), step(kind="lab", eng=None), ftes) is None
    assert run_step_span_fte(proj(), step(kind="elapsed", eng=None), ftes) is None
    assert run_step_span_fte(proj(), step(skipped=True), ftes) is None
    assert run_step_span_fte(proj(frozen=True), step(), ftes) is None
    assert run_step_span_fte(proj(), step(eng=None), ftes) is None  # no leader
    done = (StepProgressInput(step_id="PDD-A", status="Done", percent_complete=100,
                              actual_start_week=20, actual_end_week=24,
                              remaining_weeks_override=None),)
    assert run_step_span_fte(proj(progress=done), step(), ftes) is None
    assert run_step_span_fte(proj(), step(eng="x"), ftes) is None  # unknown engineer
    assert run_step_span_fte(proj(), step(), {"e": 0.0}) is None  # invalid FTE


async def test_persisted_span_fte_matches_the_run_input(db_session):
    """A real greedy run over the seed with mixed FTE: every stretched design row
    stores its leader's FTE; lab / elapsed / skipped rows and frozen projects
    store null."""

    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    all_eng = (await db_session.execute(select(Engineer).order_by(Engineer.name))).scalars().all()
    for i, e in enumerate(all_eng):
        e.fte = 0.5 if i % 2 == 0 else 1.0
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    fte_of = {e.id: float(e.fte) for e in all_eng}
    frozen = {
        p.id for p in (await db_session.execute(select(Project))).scalars().all() if p.frozen
    }
    rows = (
        await db_session.execute(
            select(ScheduleRunProjectStep).where(ScheduleRunProjectStep.schedule_run_id == run.id)
        )
    ).scalars().all()
    seen = {0.5: 0, 1.0: 0}
    for r in rows:
        if r.span_fte is None:
            continue
        assert not r.skipped and r.project_id not in frozen
        assert r.assigned_engineer_id is not None and r.assigned_chamber_id is None
        assert float(r.span_fte) == fte_of[r.assigned_engineer_id]
        seen[float(r.span_fte)] += 1
    assert seen[0.5] > 0 and seen[1.0] > 0
    assert all(r.span_fte is None for r in rows if r.assigned_chamber_id is not None)
    assert all(r.span_fte is None for r in rows if r.project_id in frozen)


async def _gantt_fixture(db_session):
    from tests.p12_helpers import add_outcome

    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    run = await make_schedule_run(db_session, is_active=True, current_week=31)
    half = await make_engineer(db_session, gr, name="Half", fte=0.5)
    full = await make_engineer(db_session, gr, name="Full", fte=1.0)
    p_half = await stepped_project(db_session, gr, name="Half-led", leader=half)
    p_full = await stepped_project(db_session, gr, name="Full-led", leader=full)
    a = await plan_step(db_session, run, p_half, "PDD-A", 31, 38, engineer=half)
    a.duration_weeks, a.span_fte = 4, 0.5
    await plan_step(db_session, run, p_half, "PDD-F", 39, 42)  # lab: never stretched
    b = await plan_step(db_session, run, p_full, "PDD-A", 31, 34, engineer=full)
    b.span_fte = 1.0
    await add_outcome(db_session, run, p_half)
    await add_outcome(db_session, run, p_full)
    await db_session.flush()
    return gr


def _span_by_project_step(body) -> dict[tuple[str, str], float | None]:
    return {
        (row["project_name"], s["step_id"]): s["span_fte"]
        for row in body["rows"]
        for s in row["steps"]
    }


async def test_gantt_span_fte_for_hub_planner_of_that_hub(db_session):
    gr = await _gantt_fixture(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        body = await _get(client, "/gantt")
    spans = _span_by_project_step(body)
    assert spans[("Half-led", "PDD-A")] == 0.5
    assert spans[("Full-led", "PDD-A")] == 1.0
    assert spans[("Half-led", "PDD-F")] is None  # lab


@pytest.mark.parametrize(
    "roles", [(RoleName.EXECUTIVE_VIEWER,), (RoleName.PORTFOLIO_MANAGER,), (RoleName.ENGINEER,)]
)
async def test_gantt_span_fte_null_for_read_only_roles(db_session, roles):
    await _gantt_fixture(db_session)
    await act_as(db_session, *roles, hub_scope_all=True)
    async with client_for(db_session) as client:
        body = await _get(client, "/gantt")
    spans = _span_by_project_step(body)
    if RoleName.ENGINEER not in roles:
        assert spans  # the rows are visible, only the FTE is withheld
    assert all(v is None for v in spans.values())


async def test_gantt_span_fte_null_when_done_or_frozen(db_session):
    gr = await _gantt_fixture(db_session)
    p_half = (
        await db_session.execute(select(Project).where(Project.name == "Half-led"))
    ).scalar_one()
    p_full = (
        await db_session.execute(select(Project).where(Project.name == "Full-led"))
    ).scalar_one()
    await set_progress(db_session, p_half, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=31, end=38)
    p_full.frozen = True
    p_full.actual_start_week = 31
    await db_session.flush()
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[gr.id])
    async with client_for(db_session) as client:
        body = await _get(client, "/gantt")
    spans = _span_by_project_step(body)
    assert spans[("Half-led", "PDD-A")] is None
    assert spans[("Full-led", "PDD-A")] is None
