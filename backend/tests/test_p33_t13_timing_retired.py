"""P33-T13: per-project step timing retired (ADR 0048; docs/API_CONTRACT_P33.md
Part G / Part H, F4 "After p33c"; DOMAIN_RULES "Category templates" §F).

Replaces `tests/test_p12_step_timing.py` (P12-T02) and
`tests/test_p32_step_overlap.py` (P32-T03), whose subject (the drag PATCH and
the hand-set ADR 0019 / 0043 fields) no longer exists.

- `PATCH /projects/{id}/steps/{step_id}/timing` answers 410
  `STEP_TIMING_RETIRED` to every authenticated caller, whatever the body or the
  project; 401 without a session; it writes nothing and dispatches nothing.
- The CHECK `step_timing_retired` (p33c) rejects any value in the three
  fields.
- The live builder never carries a floor or a user override: the override is
  the effort share on an own-effort step, gaps come from `plan_gap_weeks`.
- Readers (Workspace, the ask-agent context) use the template copy.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun
from models.workflow import ProjectWorkflowStep
from services.project_steps import sync_project_steps
from services.schedule_persistence import build_schedule_input_from_db
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run
from tests.p12_helpers import act_as, client_for

MESSAGE = "Per-project step timing was retired; edit the category template on Workflow templates."

OLD_BODIES = [
    {"duration_override_weeks": 9},
    {"start_not_before_week": 40},
    {"overlap_weeks": 2},
    {"duration_override_weeks": None, "start_not_before_week": None, "overlap_weeks": None},
    {},
    {"nonsense": "x"},
]


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _world(
    db: AsyncSession, *, category: ProjectCategory = ProjectCategory.A
) -> SimpleNamespace:
    hub = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(
        db,
        hub,
        name="Timing Leader",
        allowed_categories=[EngineerAllowedCategory.A, EngineerAllowedCategory.B],
    )
    project = await make_project(
        db,
        hub,
        leader=leader,
        name="Was Draggable",
        status=ProjectStatus.IN_QUEUE,
        category=category,
        priority=ProjectPriority.P1,
        schedule_stale=False,
        certification_testing_required=True,
    )
    await sync_project_steps(db, project, hub_is_oem=False)
    run = await make_schedule_run(db, is_active=True)
    await db.flush()
    return SimpleNamespace(hub=hub, leader=leader, project=project, run=run)


async def _step(db: AsyncSession, project: Project, step_id: str) -> ProjectWorkflowStep:
    row: ProjectWorkflowStep = (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(
                ProjectWorkflowStep.project_id == project.id,
                ProjectWorkflowStep.step_template_id == step_id,
            )
        )
    ).scalar_one()
    return row


async def _counts(db: AsyncSession) -> tuple[int, int]:
    audits = (await db.execute(select(func.count()).select_from(AuditLogEntry))).scalar_one()
    runs = (await db.execute(select(func.count()).select_from(ScheduleRun))).scalar_one()
    return int(audits), int(runs)


# --- 410 -------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role",
    [
        RoleName.HUB_PLANNER,
        RoleName.ADMIN,
        RoleName.SUPER_ADMIN,
        RoleName.PORTFOLIO_MANAGER,
        RoleName.EXECUTIVE_VIEWER,
        RoleName.ENGINEER,
        RoleName.AUDITOR,
    ],
)
async def test_every_authenticated_role_gets_410(db_session: AsyncSession, role: RoleName) -> None:
    w = await _world(db_session)
    await act_as(db_session, role, hub_ids=[w.hub.id] if role == RoleName.HUB_PLANNER else None)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}/steps/PDD-E/timing", json={"duration_override_weeks": 9}
        )
    assert resp.status_code == 410, resp.text
    assert resp.json() == {"detail": MESSAGE, "code": "STEP_TIMING_RETIRED"}


@pytest.mark.parametrize("body", OLD_BODIES)
async def test_any_body_is_410_and_writes_nothing(
    db_session: AsyncSession, body: dict[str, Any]
) -> None:
    w = await _world(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    before_counts = await _counts(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    before_row = (row.plan_weeks, row.plan_gap_weeks, row.effort_weeks, row.updated_at)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}/steps/PDD-E/timing", json=body)
    assert resp.status_code == 410 and resp.json()["code"] == "STEP_TIMING_RETIRED"
    assert await _counts(db_session) == before_counts  # no audit row, no run
    row = await _step(db_session, w.project, "PDD-E")
    assert (row.plan_weeks, row.plan_gap_weeks, row.effort_weeks, row.updated_at) == before_row
    assert (row.duration_override_weeks, row.start_not_before_week, row.overlap_weeks) == (
        None,
        None,
        None,
    )
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is False


@pytest.mark.parametrize(
    "path",
    [
        f"/projects/{uuid.uuid4()}/steps/PDD-E/timing",  # unknown project: no 404 leak
        "/projects/not-a-uuid/steps/PDD-E/timing",
        f"/projects/{uuid.uuid4()}/steps/NOPE/timing",
    ],
)
async def test_unknown_or_malformed_targets_are_410_too(
    db_session: AsyncSession, path: str
) -> None:
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(path, json={"duration_override_weeks": 9})
    assert resp.status_code == 410 and resp.json()["code"] == "STEP_TIMING_RETIRED"


async def test_without_a_session_it_is_still_401(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}/steps/PDD-E/timing", json={"duration_override_weeks": 9}
        )
    assert resp.status_code == 401


def test_openapi_documents_the_retired_route() -> None:
    schema = app.openapi()
    op = schema["paths"]["/projects/{project_id}/steps/{step_id}/timing"]["patch"]
    assert op["deprecated"] is True
    assert "410" in op["responses"] and "requestBody" not in op
    components = schema["components"]["schemas"]
    assert "StepTimingRequest" not in components and "StepTimingResponse" not in components
    assert components["StepTimingRetiredError"]["properties"]["code"]["const"] == (
        "STEP_TIMING_RETIRED"
    )


# --- the CHECK (p33c) ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "field,value",
    [
        ("duration_override_weeks", 5),
        ("start_not_before_week", 40),
        ("overlap_weeks", 1),
    ],
)
async def test_db_check_rejects_any_hand_set_value(
    db_session: AsyncSession, field: str, value: int
) -> None:
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    setattr(row, field, value)
    with pytest.raises(IntegrityError) as exc:
        await db_session.flush()
    assert "ck_project_workflow_steps_step_timing_retired" in str(exc.value)
    await db_session.rollback()


# --- the live builder after p33c (contract F4) ------------------------------------------


async def test_schedule_input_omits_steps_without_timing(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [p for p in schedule_input.projects if p.project_id == str(w.project.id)]
    assert p.step_timing == ()


async def test_builder_carries_gaps_and_copies_but_never_a_floor_or_user_override(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session, category=ProjectCategory.B)
    e = await _step(db_session, w.project, "PDD-E")
    e.plan_weeks, e.plan_gap_weeks = 6, -2
    k = await _step(db_session, w.project, "PDD-K")
    k.plan_gap_weeks = 3
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [p for p in schedule_input.projects if p.project_id == str(w.project.id)]
    timing = {t.step_id: t for t in p.step_timing}
    assert set(timing) == {"PDD-E", "PDD-K"}
    assert (timing["PDD-E"].lead_weeks, timing["PDD-E"].overlap_weeks) == (6, 2)
    assert (timing["PDD-K"].wait_weeks, timing["PDD-K"].overlap_weeks) == (3, 0)
    for t in timing.values():
        assert t.start_not_before_week is None and t.duration_override_weeks is None


async def test_schedule_input_drops_timing_of_another_workflow(db_session: AsyncSession) -> None:
    # A project moved to an OEM hub whose rows were not re-pointed yet: its
    # PDD-E copy must not reach the scheduler (unknown step -> ValueError).
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.plan_weeks = 9
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    w.project.hub_id, w.project.category = oem.id, ProjectCategory.A_OEM
    await db_session.flush()
    db_session.expire_all()
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [p for p in schedule_input.projects if p.project_id == str(w.project.id)]
    assert p.workflow_id == "OEM" and p.step_timing == ()


# --- readers use the copy ----------------------------------------------------------------


async def test_workspace_and_agent_context_read_the_copy(db_session: AsyncSession) -> None:
    from services.ask_agent import build_agent_context

    w = await _world(db_session)
    a = await _step(db_session, w.project, "PDD-A")
    a.status, a.percent_complete, a.actual_start_week, a.actual_end_week = (
        WorkflowStepStatus.DONE,
        100,
        29,
        30,
    )
    a.plan_weeks = 39
    b = await _step(db_session, w.project, "PDD-B")
    b.status, b.percent_complete, b.actual_start_week = WorkflowStepStatus.IN_PROGRESS, 50, 31
    b.plan_weeks = 10
    await db_session.flush()
    await db_session.refresh(w.project)
    # PDD / A copies sum to 38; A 1 -> 39 and B 4 -> 10 on the copy.
    expected_pct = round((39 * 100 + 10 * 50) / (38 - 1 - 4 + 39 + 10))
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get(f"/projects/{w.project.id}/workspace")
    assert resp.status_code == 200, resp.text
    stages = {s["step_id"]: s for s in resp.json()["stages"]}
    assert stages["PDD-A"]["duration_weeks"] == 39 and stages["PDD-A"]["plan_weeks"] == 39
    assert stages["PDD-B"]["duration_weeks"] == 10 and stages["PDD-B"]["remaining_weeks"] == 5
    assert stages["PDD-B"]["duration_override_weeks"] is None
    assert resp.json()["progress_pct"] == expected_pct
    context = await build_agent_context(db_session, w.project)
    by_code = {s["code"]: s for s in context["stages"]}
    assert by_code["MKTG_BRF"]["duration_weeks"] == 39
    assert by_code["FEAS_STD"]["duration_weeks"] == 10
    assert context["progress_pct"] == expected_pct
