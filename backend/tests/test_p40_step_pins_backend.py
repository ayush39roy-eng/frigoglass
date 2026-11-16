"""P40-T03b: manual step pins, non-HTTP parts (ADR 0054 R40-1 / R40-3 /
R40-12; docs/DOMAIN_RULES.md "Manual step weeks").

- the DB CHECK `step_pin_range` (both null, or 1 <= ms <= me <= 52);
- persistence of the run flags (`pinned`, `manual_overlap`, `pin_lapsed`) and
  `span_fte = NULL` on a pinned row;
- the per-week readers spread a pinned row's effort over its window, lab
  included (`weekly_effort_for_rows`, `remaining_run_load_by_project`,
  `row_span_fte`);
- plan import `PIN_DROPPED`;
- the migration up / down / up on its own throwaway container.
"""

from __future__ import annotations

import asyncio
import dataclasses
from types import SimpleNamespace

import asyncpg
import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from testcontainers.postgres import PostgresContainer

import domain_constants as dc
from models.enums import HubName, LabRegion, SolverType, WorkflowStepKind, WorkflowStepStatus
from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
from scheduling.greedy import run_greedy_sgs
from scheduling.types import StepPinInput
from schemas.whatif_import import SimIssueOut
from services.active_run import step_kinds_for_run
from services.capacity_priority import remaining_run_load_by_project
from services.run_step_effort import weekly_effort_for_rows
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.whatif_import import PIN_DROPPED, pin_dropped_issues
from services.workspace import row_span_fte
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import CW, live_step, plan_step, set_progress, stepped_project

# --- the CHECK ----------------------------------------------------------------------


@pytest.mark.parametrize(
    ("start", "end", "ok"),
    [
        (None, None, True),
        (1, 1, True),
        (40, 52, True),
        (40, None, False),
        (None, 40, False),
        (41, 40, False),
        (0, 3, False),
        (50, 53, False),
    ],
)
async def test_db_check_step_pin_range(db_session, start, end, ok):
    hub = await make_hub(db_session)
    project = await stepped_project(db_session, hub, name="Check")
    row = await live_step(db_session, project, "PDD-E")
    row.manual_start_week, row.manual_end_week = start, end
    if ok:
        await db_session.flush()
        return
    with pytest.raises(IntegrityError):
        async with db_session.begin_nested():
            await db_session.flush()


# --- persistence ----------------------------------------------------------------------


async def test_persist_writes_pin_flags_and_null_span_fte(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="Half", fte=0.5)
    project = await stepped_project(db_session, hub, name="Persist", leader=leader)
    schedule_input = await build_schedule_input_from_db(db_session, current_week=CW)
    output = run_greedy_sgs(schedule_input)
    outcome = next(o for o in output.project_outcomes if o.project_id == str(project.id))
    design = next(s for s in outcome.steps if s.kind == "design" and not s.skipped)
    other = next(s for s in outcome.steps if s.kind == "design" and s is not design)
    # Stand-in: mark one placed design row as a pin (the scheduler's own
    # placement is tested in backend/scheduling/).
    steps = tuple(
        dataclasses.replace(s, pinned=True, manual_overlap=True) if s is design else s
        for s in outcome.steps
    )
    patched = dataclasses.replace(outcome, steps=steps, manual_overlap=True, pin_lapsed=True)
    output = dataclasses.replace(
        output,
        project_outcomes=tuple(
            patched if o is outcome else o for o in output.project_outcomes
        ),
    )
    run = await persist_schedule_output(
        db_session, schedule_input, output,
        solver_type=SolverType.GREEDY, trigger_reason="step_pin", activate=True,
    )
    rows = {
        r.step_template_id: r
        for r in (
            await db_session.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == run.id,
                    ScheduleRunProjectStep.project_id == project.id,
                )
            )
        ).scalars()
    }
    pinned = rows[design.step_id]
    assert pinned.pinned is True and pinned.manual_overlap is True
    assert pinned.span_fte is None  # R40-3: the pin replaces the FTE span
    unpinned = rows[other.step_id]
    assert unpinned.pinned is False and unpinned.manual_overlap is False
    if not unpinned.skipped and unpinned.assigned_engineer_id is not None:
        assert float(unpinned.span_fte) == 0.5
    stored = (
        await db_session.execute(
            select(ScheduleRunProjectOutcome).where(
                ScheduleRunProjectOutcome.schedule_run_id == run.id,
                ScheduleRunProjectOutcome.project_id == project.id,
            )
        )
    ).scalar_one()
    assert stored.manual_overlap is True and stored.pin_lapsed is True


async def test_input_without_pins_has_default_step_pins_and_valid_pin_input(db_session):
    hub = await make_hub(db_session)
    project = await stepped_project(db_session, hub, name="Plain")
    si = await build_schedule_input_from_db(db_session, current_week=CW)
    p = next(p for p in si.projects if p.project_id == str(project.id))
    assert p.step_pins == ()
    row = await live_step(db_session, project, "PDD-E")
    row.manual_start_week, row.manual_end_week = 40, 41
    await db_session.flush()
    si = await build_schedule_input_from_db(db_session, current_week=CW)
    p = next(p for p in si.projects if p.project_id == str(project.id))
    assert p.step_pins == (StepPinInput(step_id="PDD-E", start_week=40, end_week=41),)


# --- per-week readers -------------------------------------------------------------------


async def test_pinned_rows_spread_evenly_lab_included(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="Lead")
    project = await stepped_project(db_session, hub, name="Spread", leader=leader)
    run = await make_schedule_run(db_session, is_active=True, current_week=CW)
    kinds = await step_kinds_for_run(db_session, run)
    lab_step = next(sid for sid, k in sorted(kinds.items()) if k == WorkflowStepKind.LAB)

    # A squeezed design pin: effort 6 over a 2-week window, live In Progress
    # (the run row predates the start); spread evenly, no tail split.
    design = await plan_step(db_session, run, project, "PDD-E", CW, CW + 1, engineer=leader)
    design.duration_weeks = 6
    design.pinned = True
    await set_progress(
        db_session, project, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=50, start=CW
    )
    # A stretched lab pin: effort 2 over a 4-week window starting before CW.
    lab = await plan_step(db_session, run, project, lab_step, CW - 2, CW + 1)
    lab.duration_weeks = 2
    lab.pinned = True
    await db_session.flush()

    weekly = await weekly_effort_for_rows(db_session, run, [design, lab])
    assert weekly[design.id] == {CW: 3.0, CW + 1: 3.0}
    assert weekly[lab.id] == {CW - 2: 0.5, CW - 1: 0.5, CW: 0.5, CW + 1: 0.5}

    load = await remaining_run_load_by_project(db_session, run, [project.id])
    _design, lab_load = load[project.id]
    # Two of the four window weeks are at or after CW: 2 × 0.5 effort.
    assert lab_load == pytest.approx(1.0 * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK)

    lab.pinned = False
    await db_session.flush()
    load = await remaining_run_load_by_project(db_session, run, [project.id])
    assert load[project.id][1] == pytest.approx(2 * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK)


async def test_row_span_fte_is_none_for_a_pinned_row():
    row = SimpleNamespace(
        assigned_engineer_id="e1", pinned=True, span_fte=None, start_week=1, end_week=2
    )
    assert row_span_fte(row, {"e1": 0.5}, frozen=False) is None  # type: ignore[arg-type]
    row.pinned = False
    assert row_span_fte(row, {"e1": 0.5}, frozen=False) == 0.5  # type: ignore[arg-type]


# --- plan import PIN_DROPPED --------------------------------------------------------------


def _ctx(pinned: bool):
    project = SimpleNamespace(
        project_id="p1", step_pins=(StepPinInput("PDD-E", 40, 41),) if pinned else ()
    )
    return SimpleNamespace(
        baseline=SimpleNamespace(schedule=SimpleNamespace(projects=(project,))),
        project_hub={"p1": "R&D-Greece"},
        scope=SimpleNamespace(hub_ok=lambda hub: hub == "R&D-Greece"),
    )


def _body(*, mode="merge", status="In Development", include=True, matched="p1"):
    return SimpleNamespace(
        mode=mode,
        rows=[
            SimpleNamespace(
                key="r1", include=include, status=status, matched_project_id=matched
            )
        ],
    )


def test_pin_dropped_listed_for_a_replaced_pinned_project():
    (issue,) = pin_dropped_issues(_ctx(True), _body(), [])  # type: ignore[arg-type]
    assert (issue.ref, issue.code, issue.severity) == ("r1", PIN_DROPPED, "info")
    assert "40" not in issue.message  # no pin weeks disclosed


@pytest.mark.parametrize(
    "kwargs",
    [
        {"mode": "file_only"},
        {"include": False},
        {"status": "On Hold"},
        {"matched": None},
    ],
)
def test_pin_dropped_not_listed_otherwise(kwargs):
    assert pin_dropped_issues(_ctx(True), _body(**kwargs), []) == []  # type: ignore[arg-type]
    assert pin_dropped_issues(_ctx(False), _body(), []) == []  # type: ignore[arg-type]


def test_pin_dropped_not_repeated_when_engine_reported_it():
    existing = [SimIssueOut(ref="r1", severity="info", code=PIN_DROPPED, message="x")]
    assert pin_dropped_issues(_ctx(True), _body(), existing) == []  # type: ignore[arg-type]


# --- migration up / down / up ------------------------------------------------------------

_PIN_COLUMNS_SQL = """
SELECT count(*) FROM information_schema.columns
WHERE (table_name = 'project_workflow_steps'
       AND column_name IN ('manual_start_week', 'manual_end_week'))
   OR (table_name = 'schedule_run_project_steps'
       AND column_name IN ('pinned', 'manual_overlap'))
   OR (table_name = 'schedule_run_project_outcomes'
       AND column_name IN ('manual_overlap', 'pin_lapsed'))
"""
_FLAG_DEFAULTS_SQL = """
SELECT count(*) FROM information_schema.columns
WHERE column_name IN ('pinned', 'manual_overlap', 'pin_lapsed')
  AND table_name IN ('schedule_run_project_steps', 'schedule_run_project_outcomes')
  AND is_nullable = 'NO' AND column_default = 'false'
"""
_CHECK_SQL = """
SELECT count(*) FROM pg_constraint
WHERE conname = 'ck_project_workflow_steps_step_pin_range'
"""


def _scalar(url: str, sql: str):
    async def _run():
        conn = await asyncpg.connect(url.replace("postgresql+asyncpg://", "postgresql://"))
        try:
            return await conn.fetchval(sql)
        finally:
            await conn.close()

    return asyncio.run(_run())


def test_migration_p40a_up_down_up():
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        assert _scalar(url, _PIN_COLUMNS_SQL) == 6
        assert _scalar(url, _FLAG_DEFAULTS_SQL) == 4
        assert _scalar(url, _CHECK_SQL) == 1

        r = run_alembic(["downgrade", "p41a_import_format_and_scenarios"], url)
        assert r.returncode == 0, r.stderr
        assert _scalar(url, _PIN_COLUMNS_SQL) == 0
        assert _scalar(url, _CHECK_SQL) == 0

        r = run_alembic(["upgrade", "head"], url)
        assert r.returncode == 0, r.stderr
        assert _scalar(url, _PIN_COLUMNS_SQL) == 6
        assert _scalar(url, _CHECK_SQL) == 1
