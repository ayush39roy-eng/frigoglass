"""P33-T12: `GET /gantt` and `GET /projects/{id}/workspace` field changes
(docs/API_CONTRACT_P33.md Part G; ADR 0046 §B, ADR 0048).

- Gantt step rows drop `timing_editable`, `duration_override_weeks`,
  `start_not_before_week` and `overlap_weeks`, and gain the read-only template
  copy: `plan_weeks`, the signed `gap_weeks` (`plan_gap_weeks`; negative =
  "parallel N wk", positive = "wait N wk") and `own_effort` (OR-1).
- Workspace stages gain the same three fields (nothing removed).
- I23 still holds with gaps on the copies: per hub, the Gantt's design weeks
  sum to the Capacity `design_load_booked_weeks` (a wait books nothing).
"""

from __future__ import annotations

from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    SolverType,
    WorkflowStepStatus,
)
from models.project import Project
from models.workflow import ProjectWorkflowStep
from scheduling import run_greedy_sgs
from seed import seed_demo_data
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_chamber, make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import (
    act_as,
    add_outcome,
    client_for,
    live_step,
    plan_step,
    set_progress,
    stepped_project,
)

CW = TEST_WEEK
RETIRED = {"timing_editable", "duration_override_weeks", "start_not_before_week", "overlap_weeks"}


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _world(db: AsyncSession) -> SimpleNamespace:
    greece = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    cats = [EngineerAllowedCategory(c) for c in ("A+", "A", "B", "C")]
    lead = await make_engineer(db, greece, name="Lead GR", allowed_categories=cats)
    await make_chamber(db, lab_region=LabRegion.GREECE, allowed_stages=["PDD-F", "PDD-H"])
    await db.flush()
    return SimpleNamespace(greece=greece, lead=lead)


async def _set_copy(db: AsyncSession, project: Project, step_id: str, **values: int) -> None:
    await db.execute(
        update(ProjectWorkflowStep)
        .where(
            ProjectWorkflowStep.project_id == project.id,
            ProjectWorkflowStep.step_template_id == step_id,
        )
        .values(**values)
    )
    await db.flush()


async def _projects(db: AsyncSession, w: SimpleNamespace) -> tuple[Project, Project]:
    """`own`: category B with a design figure 4 (design own effort: A1 E2 K1,
    D J M zeroed); `plain`: category B without a figure (follows its copy).
    Both carry a parallel gap on PDD-E (−2) and a wait on PDD-K (+3)."""

    own = await stepped_project(
        db,
        w.greece,
        name="Own",
        leader=w.lead,
        category=ProjectCategory.B,
        status=ProjectStatus.IN_DEVELOPMENT,
        certification_testing_required=True,
    )
    plain = await stepped_project(
        db,
        w.greece,
        name="Plain",
        leader=w.lead,
        category=ProjectCategory.B,
        status=ProjectStatus.IN_QUEUE,
        certification_testing_required=True,
    )
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        resp = await client.patch(f"/projects/{own.id}", json={"design_effort_weeks": 4})
        assert resp.status_code == 200, resp.text
    for p in (own, plain):
        await _set_copy(db, p, "PDD-E", plan_gap_weeks=-2)
        await _set_copy(db, p, "PDD-K", plan_gap_weeks=3)
    await _set_copy(db, plain, "PDD-E", plan_weeks=6)
    await set_progress(db, own, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=20, end=20)
    return own, plain


async def _plan_both(db: AsyncSession, own: Project, plain: Project) -> None:
    run = await make_schedule_run(db, is_active=True)
    for p in (own, plain):
        await plan_step(db, run, p, "PDD-A", 20, 20)
        await plan_step(db, run, p, "PDD-E", CW, CW + 3)
        await plan_step(db, run, p, "PDD-H", CW + 4, CW + 6)
        await plan_step(db, run, p, "PDD-K", CW + 10, CW + 10)
        await plan_step(db, run, p, "PDD-N", CW + 11, CW + 11)
        await add_outcome(db, run, p)


def _steps(body: dict[str, Any], name: str) -> dict[str, dict[str, Any]]:
    row = next(r for r in body["rows"] if r["project_name"] == name)
    return {s["step_id"]: s for s in row["steps"]}


async def test_gantt_serves_the_copy_and_drops_the_timing_fields(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    own, plain = await _projects(db_session, w)
    await _plan_both(db_session, own, plain)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.greece.id])
    async with client_for(db_session) as client:
        resp = await client.get("/gantt")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    for name in ("Own", "Plain"):
        for step in _steps(body, name).values():
            assert RETIRED.isdisjoint(step), step
            assert {"plan_weeks", "gap_weeks", "own_effort", "predecessor_ids"} <= set(step)

    own_steps = _steps(body, "Own")
    # The design kind follows the figure (OR-1); lab and elapsed never do.
    assert own_steps["PDD-E"]["own_effort"] is True and own_steps["PDD-E"]["effort_weeks"] == 2
    assert own_steps["PDD-K"]["own_effort"] is True
    assert own_steps["PDD-H"]["own_effort"] is False  # lab
    assert own_steps["PDD-N"]["own_effort"] is False  # elapsed
    # Signed gaps from `plan_gap_weeks`: parallel 2 wk on E, wait 3 wk on K.
    assert own_steps["PDD-E"]["gap_weeks"] == -2
    assert own_steps["PDD-K"]["gap_weeks"] == 3
    assert own_steps["PDD-H"]["gap_weeks"] == 0
    # `plan_weeks` is the copy (B: E 4), also served as `lead_time_weeks`.
    assert own_steps["PDD-E"]["plan_weeks"] == 4 == own_steps["PDD-E"]["lead_time_weeks"]

    plain_steps = _steps(body, "Plain")
    assert {s["own_effort"] for s in plain_steps.values()} == {False}
    assert plain_steps["PDD-E"]["plan_weeks"] == 6 == plain_steps["PDD-E"]["lead_time_weeks"]
    assert plain_steps["PDD-E"]["gap_weeks"] == -2 and plain_steps["PDD-K"]["gap_weeks"] == 3


@pytest.mark.parametrize(
    "role", [RoleName.PORTFOLIO_MANAGER, RoleName.EXECUTIVE_VIEWER, RoleName.HUB_PLANNER]
)
async def test_gantt_copy_fields_are_the_same_for_every_reader(
    db_session: AsyncSession, role: RoleName
) -> None:
    w = await _world(db_session)
    own, plain = await _projects(db_session, w)
    await _plan_both(db_session, own, plain)
    await act_as(db_session, role, hub_ids=[w.greece.id] if role == RoleName.HUB_PLANNER else None)
    async with client_for(db_session) as client:
        body = (await client.get("/gantt")).json()
    steps = _steps(body, "Own")
    assert (steps["PDD-E"]["gap_weeks"], steps["PDD-E"]["own_effort"]) == (-2, True)


async def test_gantt_step_row_schema_matches_part_g() -> None:
    props = set(app.openapi()["components"]["schemas"]["GanttStepRow"]["properties"])
    assert RETIRED.isdisjoint(props)
    assert {"plan_weeks", "gap_weeks", "own_effort", "predecessor_ids"} <= props


async def test_workspace_stages_gain_the_copy_fields(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    own, plain = await _projects(db_session, w)
    await _plan_both(db_session, own, plain)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        own_ws = await client.get(f"/projects/{own.id}/workspace")
        plain_ws = await client.get(f"/projects/{plain.id}/workspace")
    assert own_ws.status_code == 200 and plain_ws.status_code == 200
    own_stages = {s["step_id"]: s for s in own_ws.json()["stages"]}
    plain_stages = {s["step_id"]: s for s in plain_ws.json()["stages"]}

    e = own_stages["PDD-E"]
    assert (e["plan_weeks"], e["gap_weeks"], e["own_effort"]) == (4, -2, True)
    assert e["duration_weeks"] == 2  # the own figure's share, not the copy
    assert own_stages["PDD-K"]["gap_weeks"] == 3
    assert own_stages["PDD-H"]["own_effort"] is False
    # Nothing removed from the Workspace (Part G); the retired override is null.
    assert e["duration_override_weeks"] is None

    pe = plain_stages["PDD-E"]
    assert (pe["plan_weeks"], pe["gap_weeks"], pe["own_effort"]) == (6, -2, False)
    assert pe["duration_weeks"] == 6 == pe["lead_time_weeks"]


async def test_lab_without_certification_is_not_own_effort_and_keeps_its_copy(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    p = await stepped_project(
        db_session,
        w.greece,
        name="NoCert",
        leader=w.lead,
        category=ProjectCategory.B,
        certification_testing_required=False,
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        ws = (await client.get(f"/projects/{p.id}/workspace")).json()
    stages = {s["step_id"]: s for s in ws["stages"]}
    h = stages["PDD-H"]
    row = await live_step(db_session, p, "PDD-H")
    assert h["own_effort"] is False and h["skipped"] is True
    assert h["plan_weeks"] == row.plan_weeks and h["gap_weeks"] == 0


# --- I23 with gaps on the copies (fresh greedy run on the seed) -----------------------


async def test_i23_gantt_design_weeks_equal_capacity_booked_with_gaps(
    db_session: AsyncSession,
) -> None:
    data = seed_demo_data._load_prototype_data()
    hubs = await seed_demo_data.seed_hubs(db_session)
    engineers = await seed_demo_data.seed_engineers(db_session, data, hubs)
    await seed_demo_data.seed_chambers(db_session)
    await seed_demo_data.seed_projects(db_session, data, hubs, engineers)
    await db_session.flush()
    # A wait on K and a parallel E on every Not Started PDD row of a few
    # projects (the template apply's writes, P33-T10).
    ids = list(
        (
            await db_session.execute(
                select(Project.id)
                .where(Project.status == ProjectStatus.IN_QUEUE)
                .order_by(Project.id)
                .limit(12)
            )
        ).scalars()
    )
    assert ids
    await db_session.execute(
        update(ProjectWorkflowStep)
        .where(
            ProjectWorkflowStep.project_id.in_(ids),
            ProjectWorkflowStep.step_template_id == "PDD-K",
        )
        .values(plan_gap_weeks=3)
    )
    await db_session.execute(
        update(ProjectWorkflowStep)
        .where(
            ProjectWorkflowStep.project_id.in_(ids),
            ProjectWorkflowStep.step_template_id == "PDD-E",
        )
        .values(plan_gap_weeks=-1)
    )
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    run = await persist_schedule_output(
        db_session,
        schedule_input,
        run_greedy_sgs(schedule_input),
        solver_type=SolverType.GREEDY,
        trigger_reason="test",
        activate=True,
    )
    snapshot = run.workflow_snapshot
    assert snapshot is not None
    kinds = {s["step_id"]: s["kind"] for wf in snapshot["workflows"] for s in wf["steps"]}
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        capacity = (await client.get("/capacity/hubs")).json()
        served_gaps = 0
        checked = 0
        for name, hub in hubs.items():
            gantt = (
                await client.get("/gantt", params={"hub_id": str(hub.id), "limit": "500"})
            ).json()
            for p in gantt["rows"]:
                served_gaps += sum(1 for s in p["steps"] if s["gap_weeks"] != 0)
                # The served per-project total equals the step sum (no wait in it).
                design = sum(
                    s["duration_weeks"]
                    for s in p["steps"]
                    if not s["skipped"] and kinds.get(s["step_id"]) == "design"
                )
                assert p["design_weeks"] in (None, design)
            gantt_design = sum(p["design_weeks"] or 0 for p in gantt["rows"])
            capacity_name = dc.capacity_hub_name(name)
            row = next((r for r in capacity["rows"] if r["hub"] == capacity_name), None)
            if row is None:
                assert gantt_design == 0
                continue
            member_load = {m["hub"]: m["design_load_booked_weeks"] for m in row["members"]}
            assert gantt_design == member_load.get(name, row["design_load_booked_weeks"]), name
            checked += 1
    assert checked >= 2
    assert served_gaps >= len(ids)
