"""P12-T02: Gantt drag step timing (ADR 0019, docs/API_CONTRACT_P12.md §0, §3).

Covered:
- `PATCH /projects/{id}/steps/{step_id}/timing`: each `recalc_status`
  (queued / deferred / not_needed / unchanged), every 409 and 422, explicit
  null clears, nothing written on an error or on `unchanged`;
- the audit row `project.step_timing` with before/after, the queued greedy run
  (`trigger_reason="step_timing"`, `activate=True`) and the worker's input
  carrying the new timing;
- RBAC: Engineer, Executive Viewer, Portfolio Manager, Auditor 403 (GANTT is
  read-only for them); Hub Planner of another hub 404; own-hub Hub Planner,
  Admin and Super Admin allowed;
- `GET /gantt` step rows: `lead_time_weeks`, the timing fields, the effective
  `duration_weeks` and `timing_editable` for each rule of ADR 0019 §4 and for
  readers without GANTT write;
- end to end through the real greedy scheduler: the run books the effective
  duration (I21), honours the floor (I22) and snapshots the timing;
- the Workspace roll-up and remaining duration use the effective duration;
- a workflow re-point clears the timing; the DB CHECK constraints.

`run_greedy_schedule.delay` and `publish_progress` are patched as in the P11
priority-move tests; nothing reaches Celery or Redis.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

import services.step_timing as step_timing_service
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
    ScheduleRunStatus,
    SolverType,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from scheduling.greedy import run_greedy_sgs
from scheduling.types import StepTimingInput
from services.project_steps import sync_project_steps
from services.run_dispatch import follow_up_pending
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.step_timing import timing_editable
from services.workflow_durations import effective_duration_weeks
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
)
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
    """Records `run_greedy_schedule.delay` calls and SSE publishes."""

    calls: list[tuple[tuple, dict]] = []
    published: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(
        step_timing_service, "publish_progress", lambda *a, **k: published.append((a, k))
    )
    return SimpleNamespace(calls=calls, published=published)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids=None, **user_kwargs):
    user_kwargs.setdefault("hub_scope_all", hub_ids is None and roles != (RoleName.ENGINEER,))
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], **user_kwargs)
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=user.hub_scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _world(
    db_session,
    *,
    status: ProjectStatus = ProjectStatus.IN_QUEUE,
    category: ProjectCategory = ProjectCategory.A,
    active_run: bool = True,
    cert: bool = True,
    frozen: bool = False,
):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(
        db_session, hub, name="Timing Leader",
        allowed_categories=[EngineerAllowedCategory.A, EngineerAllowedCategory.B],
    )
    project = await make_project(
        db_session, hub, leader=leader, name="Drag Me", status=status, category=category,
        priority=ProjectPriority.P1, schedule_stale=False, certification_testing_required=cert,
        frozen=frozen, actual_start_week=31 if frozen else None,
    )
    await sync_project_steps(db_session, project, hub_is_oem=False)
    run = await make_schedule_run(db_session, is_active=True) if active_run else None
    await db_session.flush()
    return SimpleNamespace(hub=hub, leader=leader, project=project, run=run)


async def _step(db_session, project: Project, step_id: str) -> ProjectWorkflowStep:
    return (
        await db_session.execute(
            select(ProjectWorkflowStep).where(
                ProjectWorkflowStep.project_id == project.id,
                ProjectWorkflowStep.step_template_id == step_id,
            )
        )
    ).scalar_one()


async def _audits(db_session, action: str, project: Project) -> list[AuditLogEntry]:
    return list(
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == action, AuditLogEntry.entity_id == str(project.id)
                )
            )
        ).scalars().all()
    )


async def _run_count(db_session) -> int:
    return (await db_session.execute(select(func.count(ScheduleRun.id)))).scalar_one()


def _url(project: Project, step_id: str = "PDD-E") -> str:
    return f"/projects/{project.id}/steps/{step_id}/timing"


async def _assert_nothing_written(db_session, w, step_id: str = "PDD-E", before=(None, None)):
    row = await _step(db_session, w.project, step_id)
    await db_session.refresh(row)
    assert (row.duration_override_weeks, row.start_not_before_week) == before
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is False
    assert await _audits(db_session, "project.step_timing", w.project) == []


# --- each recalc_status -------------------------------------------------------------------


async def test_queued_saves_audits_and_dispatches_one_greedy_run(db_session, dispatch):
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    runs_before = await _run_count(db_session)

    async with _client(db_session) as client:
        resp = await client.patch(
            _url(w.project), json={"duration_override_weeks": 9, "start_not_before_week": 40}
        )

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body == {
        "project_id": str(w.project.id),
        "step_id": "PDD-E",
        "duration_override_weeks": 9,
        "start_not_before_week": 40,
        "effective_duration_weeks": 9,
        "recalc_status": "queued",
        "schedule_run_id": body["schedule_run_id"],
        "baseline_run_id": str(w.run.id),
        "task_id": "celery-task-1",
    }
    assert await _run_count(db_session) == runs_before + 1
    (args, kwargs), = dispatch.calls
    assert args == (body["schedule_run_id"],)
    assert kwargs == {
        "triggered_by_user_id": str(user.id),
        "activate": True,
        "recalc_project_id": str(w.project.id),
    }
    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run.solver_type == SolverType.GREEDY
    assert run.status == ScheduleRunStatus.QUEUED
    assert run.trigger_reason == "step_timing"
    assert run.celery_task_id == "celery-task-1"
    assert dispatch.published == [((body["schedule_run_id"],), {"status": "queued"})]

    row = await _step(db_session, w.project, "PDD-E")
    assert (row.duration_override_weeks, row.start_not_before_week) == (9, 40)
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is True

    # The worker builds its input after this commit, and it carries the timing.
    schedule_input = await build_schedule_input_from_db(db_session)
    moved = next(p for p in schedule_input.projects if p.project_id == str(w.project.id))
    assert moved.step_timing == (StepTimingInput("PDD-E", 9, 40),)

    (audit,) = await _audits(db_session, "project.step_timing", w.project)
    assert audit.actor_user_id == user.id and audit.hub_id == w.hub.id
    assert audit.before_state == {
        "project_id": str(w.project.id), "step_id": "PDD-E",
        "duration_override_weeks": None, "start_not_before_week": None,
    }
    assert audit.after_state == {
        "project_id": str(w.project.id), "step_id": "PDD-E",
        "duration_override_weeks": 9, "start_not_before_week": 40,
        "recalc_status": "queued", "baseline_run_id": str(w.run.id),
    }
    (requested,) = await _audits(db_session, "project.recalculate_requested", w.project)
    assert requested.after_state["schedule_run_id"] == body["schedule_run_id"]
    assert requested.after_state["trigger_reason"] == "step_timing"


async def test_queued_without_active_run_has_null_baseline(db_session, dispatch):
    w = await _world(db_session, active_run=False)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 3})
    body = resp.json()
    assert body["recalc_status"] == "queued"
    assert body["baseline_run_id"] is None and body["schedule_run_id"] is not None


async def test_deferred_saves_without_a_second_run_and_requests_follow_up(db_session, dispatch):
    w = await _world(db_session)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await _act_as(db_session, RoleName.ADMIN)
    runs_before = await _run_count(db_session)

    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"start_not_before_week": 45})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "deferred"
    assert body["schedule_run_id"] is None and body["baseline_run_id"] is None
    assert body["task_id"] is None
    assert body["effective_duration_weeks"] == 6  # PDD / A lead time for PDD-E
    assert dispatch.calls == [] and dispatch.published == []
    assert await _run_count(db_session) == runs_before
    row = await _step(db_session, w.project, "PDD-E")
    assert row.start_not_before_week == 45
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is True
    (audit,) = await _audits(db_session, "project.step_timing", w.project)
    assert audit.after_state["recalc_status"] == "deferred"
    # ADR 0023: a deferred auto-trigger registers the coalesced follow-up.
    assert await follow_up_pending(db_session) is True


async def test_back_to_back_drags_queue_one_run_then_defer(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        first = await client.patch(_url(w.project), json={"duration_override_weeks": 7})
        second = await client.patch(_url(w.project, "PDD-D"), json={"duration_override_weeks": 2})
    assert first.json()["recalc_status"] == "queued"
    assert second.json()["recalc_status"] == "deferred"
    assert len(dispatch.calls) == 1


async def test_not_needed_for_a_lab_step_without_certification_testing(db_session, dispatch):
    w = await _world(db_session, cert=False)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project, "PDD-F"), json={"duration_override_weeks": 8})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "not_needed"
    # Skipped while certification testing is off: the override is kept for
    # later but never revives the step, so it books 0 weeks (P12-F04).
    assert body["duration_override_weeks"] == 8
    assert body["effective_duration_weeks"] == 0
    assert body["schedule_run_id"] is None and body["task_id"] is None
    assert dispatch.calls == []
    row = await _step(db_session, w.project, "PDD-F")
    assert row.duration_override_weeks == 8
    (audit,) = await _audits(db_session, "project.step_timing", w.project)
    assert audit.after_state["recalc_status"] == "not_needed"


async def test_cert_off_lab_step_reports_zero_effective_duration_when_unchanged(
    db_session, dispatch
):
    """P12-F04: the unchanged path answers 0 for a cert-off lab step too, and
    a design step on the same project keeps its effective duration.
    """

    w = await _world(db_session, cert=False)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        first = await client.patch(_url(w.project, "PDD-F"), json={"duration_override_weeks": 8})
        again = await client.patch(_url(w.project, "PDD-F"), json={"duration_override_weeks": 8})
    assert first.json()["effective_duration_weeks"] == 0
    assert again.status_code == 200, again.text
    assert again.json()["recalc_status"] == "unchanged"
    assert again.json()["effective_duration_weeks"] == 0
    assert dispatch.calls == []


async def test_unchanged_writes_nothing(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.duration_override_weeks = 5
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        same = await client.patch(
            _url(w.project), json={"duration_override_weeks": 5, "start_not_before_week": None}
        )
    assert same.status_code == 200, same.text
    assert same.json()["recalc_status"] == "unchanged"
    assert same.json()["effective_duration_weeks"] == 5
    assert same.json()["schedule_run_id"] is None
    assert dispatch.calls == []
    await _assert_nothing_written(db_session, w, before=(5, None))


async def test_explicit_null_clears_only_that_field(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.duration_override_weeks, row.start_not_before_week = 9, 40
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": None})
    body = resp.json()
    assert body["recalc_status"] == "queued"
    assert body["duration_override_weeks"] is None and body["start_not_before_week"] == 40
    assert body["effective_duration_weeks"] == 6
    await db_session.refresh(row)
    assert (row.duration_override_weeks, row.start_not_before_week) == (None, 40)


# --- 409s ------------------------------------------------------------------------------


async def test_frozen_project_is_409(db_session, dispatch):
    w = await _world(db_session, frozen=True)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 8})
    assert resp.status_code == 409
    assert resp.json()["code"] == "PROJECT_FROZEN"
    assert dispatch.calls == []
    await _assert_nothing_written(db_session, w)


@pytest.mark.parametrize(
    "status",
    [ProjectStatus.ON_HOLD, ProjectStatus.DRAFT, ProjectStatus.COMMERCIALIZED,
     ProjectStatus.CANCELLED],
)
async def test_non_schedulable_status_is_409_and_not_saved(db_session, dispatch, status):
    w = await _world(db_session, status=status)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 8})
    assert resp.status_code == 409
    assert resp.json()["code"] == "NOT_SCHEDULABLE"
    await _assert_nothing_written(db_session, w)


async def test_skipped_step_is_409(db_session, dispatch):
    # PDD / B: PDD-B (Feasibility Study) has lead time 0 → skipped.
    w = await _world(db_session, category=ProjectCategory.B)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project, "PDD-B"), json={"duration_override_weeks": 3})
    assert resp.status_code == 409
    assert resp.json()["code"] == "STEP_SKIPPED"
    await _assert_nothing_written(db_session, w, "PDD-B")


async def test_done_step_is_409_for_any_change(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-A")
    row.status, row.percent_complete = WorkflowStepStatus.DONE, 100
    row.actual_start_week, row.actual_end_week = 29, 30
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resize = await client.patch(_url(w.project, "PDD-A"), json={"duration_override_weeks": 2})
        move = await client.patch(_url(w.project, "PDD-A"), json={"start_not_before_week": 33})
        noop = await client.patch(_url(w.project, "PDD-A"), json={"start_not_before_week": None})
    assert resize.status_code == 409 and resize.json()["code"] == "STEP_DONE"
    assert move.status_code == 409 and move.json()["code"] == "STEP_DONE"
    # "Any change": a request equal to the stored values is not a change.
    assert noop.status_code == 200 and noop.json()["recalc_status"] == "unchanged"
    await _assert_nothing_written(db_session, w, "PDD-A")


@pytest.mark.parametrize(
    "step_status", [WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED]
)
async def test_started_step_may_resize_but_not_move(db_session, dispatch, step_status):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-A")
    row.status, row.percent_complete, row.actual_start_week = step_status, 50, 30
    if step_status == WorkflowStepStatus.BLOCKED:
        row.blocked_reason = "Waiting on supplier"
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        move = await client.patch(_url(w.project, "PDD-A"), json={"start_not_before_week": 35})
        both = await client.patch(
            _url(w.project, "PDD-A"),
            json={"duration_override_weeks": 3, "start_not_before_week": 35},
        )
        resize = await client.patch(_url(w.project, "PDD-A"), json={"duration_override_weeks": 3})
    assert move.status_code == 409 and move.json()["code"] == "STEP_STARTED"
    assert both.status_code == 409 and both.json()["code"] == "STEP_STARTED"
    assert resize.status_code == 200, resize.text
    assert resize.json()["recalc_status"] == "queued"
    await db_session.refresh(row)
    assert (row.duration_override_weeks, row.start_not_before_week) == (3, None)


async def test_started_step_may_clear_a_floor_set_before_it_started(db_session, dispatch):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-A")
    row.start_not_before_week = 33
    row.status, row.percent_complete, row.actual_start_week = (
        WorkflowStepStatus.IN_PROGRESS, 10, 33,
    )
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        reset = await client.patch(
            _url(w.project, "PDD-A"),
            json={"duration_override_weeks": None, "start_not_before_week": None},
        )
    assert reset.status_code == 200, reset.text
    assert reset.json()["start_not_before_week"] is None


# --- 422s ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [
        {"duration_override_weeks": 0},
        {"duration_override_weeks": 105},
        {"start_not_before_week": 0},
        {"start_not_before_week": 79},
        {},
    ],
)
async def test_range_and_empty_body_are_coded_422(db_session, dispatch, payload):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json=payload)
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"
    await _assert_nothing_written(db_session, w)


async def test_range_bounds_are_accepted(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        low = await client.patch(
            _url(w.project), json={"duration_override_weeks": 1, "start_not_before_week": 1}
        )
        high = await client.patch(
            _url(w.project), json={"duration_override_weeks": 104, "start_not_before_week": 78}
        )
    assert low.status_code == 200 and high.status_code == 200


@pytest.mark.parametrize("step_id", ["PDD-Z", "OEM-E", "pdd-e"])
async def test_unknown_step_for_the_workflow_is_coded_422(db_session, dispatch, step_id):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project, step_id), json={"duration_override_weeks": 4})
    assert resp.status_code == 422
    assert resp.json()["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    "payload",
    [
        {"duration_override_weeks": "6"},
        {"duration_override_weeks": 6.5},
        {"duration_override_weeks": True},
        {"duration_override_weeks": 6, "planned_start_week": 40},
    ],
)
async def test_bad_bodies_are_422(db_session, dispatch, payload):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json=payload)
    assert resp.status_code == 422
    await _assert_nothing_written(db_session, w)


async def test_unknown_project_is_404(db_session, dispatch):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{uuid.uuid4()}/steps/PDD-E/timing", json={"duration_override_weeks": 4}
        )
    assert resp.status_code == 404


# --- RBAC ------------------------------------------------------------------------------


@pytest.mark.parametrize(
    "role",
    [RoleName.ENGINEER, RoleName.EXECUTIVE_VIEWER, RoleName.PORTFOLIO_MANAGER, RoleName.AUDITOR],
)
async def test_roles_without_gantt_write_get_403(db_session, dispatch, role):
    w = await _world(db_session)
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 8})
    assert resp.status_code == 403
    assert dispatch.calls == []
    await _assert_nothing_written(db_session, w)


async def test_leader_engineer_still_gets_403(db_session, dispatch):
    w = await _world(db_session)
    leader_user = await _act_as(db_session, RoleName.ENGINEER, email="leader.timing@example.com")
    w.leader.user_id = leader_user.id
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 8})
    assert resp.status_code == 403


async def test_hub_planner_of_another_hub_gets_404(db_session, dispatch):
    w = await _world(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[other.id])
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 8})
    assert resp.status_code == 404
    await _assert_nothing_written(db_session, w)


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.SUPER_ADMIN])
async def test_admin_roles_may_drag(db_session, dispatch, role):
    w = await _world(db_session)
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        resp = await client.patch(_url(w.project), json={"duration_override_weeks": 8})
    assert resp.status_code == 200, resp.text


# --- GET /gantt extensions ---------------------------------------------------------------


async def _gantt_world(db_session):
    """A project with an active run whose step rows are written directly, so
    each ADR 0019 §4 case can be set up exactly.
    """

    w = await _world(db_session)
    rows = {
        r.step_template_id: r
        for r in (
            await db_session.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == w.project.id)
            )
        ).scalars()
    }
    rows["PDD-A"].status, rows["PDD-A"].percent_complete = WorkflowStepStatus.DONE, 100
    rows["PDD-A"].actual_start_week, rows["PDD-A"].actual_end_week = 29, 29
    rows["PDD-B"].status, rows["PDD-B"].percent_complete = WorkflowStepStatus.IN_PROGRESS, 25
    rows["PDD-B"].actual_start_week = 30
    rows["PDD-B"].duration_override_weeks = 5
    rows["PDD-C"].status, rows["PDD-C"].blocked_reason = WorkflowStepStatus.BLOCKED, "Waiting"
    rows["PDD-C"].actual_start_week = 30
    rows["PDD-E"].duration_override_weeks, rows["PDD-E"].start_not_before_week = 9, 44
    week = 29
    for row in sorted(rows.values(), key=lambda r: r.sequence_order):
        duration = effective_duration_weeks(row.duration_weeks, row.duration_override_weeks)
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=w.run.id, project_id=w.project.id,
                step_template_id=row.step_template_id, sequence_order=row.sequence_order,
                duration_weeks=duration, start_week=week, end_week=week + max(duration, 1) - 1,
                skipped=row.step_template_id == "PDD-G",
            )
        )
        week += max(duration, 1)
    await db_session.flush()
    return w


async def _gantt_steps(db_session, **params) -> dict[str, dict]:
    async with _client(db_session) as client:
        resp = await client.get("/gantt", params=params)
    assert resp.status_code == 200, resp.text
    (row,) = resp.json()["rows"]
    return {s["step_id"]: s for s in row["steps"]}


async def test_gantt_step_rows_carry_timing_and_editability_for_a_planner(db_session):
    w = await _gantt_world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    steps = await _gantt_steps(db_session)

    assert steps["PDD-A"]["timing_editable"] == "none"  # Done
    assert steps["PDD-B"]["timing_editable"] == "resize"  # In Progress
    assert steps["PDD-C"]["timing_editable"] == "resize"  # Blocked
    assert steps["PDD-D"]["timing_editable"] == "move_resize"  # Not Started
    assert steps["PDD-G"]["timing_editable"] == "none"  # skipped in the run

    e = steps["PDD-E"]
    assert e["lead_time_weeks"] == 6
    assert e["duration_override_weeks"] == 9
    assert e["start_not_before_week"] == 44
    assert e["duration_weeks"] == 9  # the effective duration the run booked
    assert e["timing_editable"] == "move_resize"
    assert steps["PDD-B"]["lead_time_weeks"] == 4 and steps["PDD-B"]["duration_weeks"] == 5
    assert steps["PDD-D"]["duration_override_weeks"] is None
    assert steps["PDD-D"]["start_not_before_week"] is None


@pytest.mark.parametrize(
    "role", [RoleName.PORTFOLIO_MANAGER, RoleName.EXECUTIVE_VIEWER]
)
async def test_gantt_readers_without_write_see_none_everywhere(db_session, role):
    await _gantt_world(db_session)
    await _act_as(db_session, role)
    steps = await _gantt_steps(db_session)
    assert {s["timing_editable"] for s in steps.values()} == {"none"}


async def test_gantt_frozen_project_is_not_editable(db_session):
    w = await _gantt_world(db_session)
    w.project.frozen, w.project.actual_start_week = True, 29
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    steps = await _gantt_steps(db_session)
    assert {s["timing_editable"] for s in steps.values()} == {"none"}


async def test_gantt_engineer_sees_own_rows_read_only(db_session):
    w = await _gantt_world(db_session)
    eng_user = await _act_as(db_session, RoleName.ENGINEER, email="own.timing@example.com")
    w.leader.user_id = eng_user.id
    step = (
        await db_session.execute(
            select(ScheduleRunProjectStep).where(
                ScheduleRunProjectStep.schedule_run_id == w.run.id,
                ScheduleRunProjectStep.step_template_id == "PDD-D",
            )
        )
    ).scalar_one()
    step.assigned_engineer_id = w.leader.id
    await db_session.flush()
    steps = await _gantt_steps(db_session)
    assert {s["timing_editable"] for s in steps.values()} == {"none"}


def test_timing_editable_rules():
    ns = WorkflowStepStatus.NOT_STARTED
    base = dict(can_write=True, frozen=False, schedulable=True, skipped=False)
    assert timing_editable(**base, step_status=ns) == "move_resize"
    assert timing_editable(**base, step_status=WorkflowStepStatus.IN_PROGRESS) == "resize"
    assert timing_editable(**base, step_status=WorkflowStepStatus.BLOCKED) == "resize"
    assert timing_editable(**base, step_status=WorkflowStepStatus.DONE) == "none"
    for flag, value in (("can_write", False), ("frozen", True), ("schedulable", False),
                        ("skipped", True)):
        assert timing_editable(**{**base, flag: value}, step_status=ns) == "none"


# --- End to end through the real greedy scheduler (I21, I22, snapshot) -------------------


async def test_greedy_run_books_effective_duration_and_floor_and_snapshots_timing(db_session):
    w = await _world(db_session, active_run=False)
    await make_chamber(
        db_session, lab_region=LabRegion.GREECE, max_concurrent=3,
        allowed_stages=["PDD-F", "PDD-H"],
    )
    e = await _step(db_session, w.project, "PDD-E")
    e.duration_override_weeks, e.start_not_before_week = 9, 50
    d = await _step(db_session, w.project, "PDD-D")
    d.duration_override_weeks = 3
    await db_session.flush()

    schedule_input = await build_schedule_input_from_db(db_session)
    output = run_greedy_sgs(schedule_input)
    run = await persist_schedule_output(
        db_session, schedule_input, output, solver_type=SolverType.GREEDY,
        trigger_reason="test", activate=True,
    )
    booked = {
        s.step_template_id: s
        for s in (
            await db_session.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == run.id,
                    ScheduleRunProjectStep.project_id == w.project.id,
                )
            )
        ).scalars()
    }
    # I21: the booked span equals the effective duration.
    assert booked["PDD-E"].duration_weeks == 9
    assert booked["PDD-E"].end_week - booked["PDD-E"].start_week + 1 == 9
    assert booked["PDD-D"].duration_weeks == 3
    assert booked["PDD-A"].duration_weeks == 1  # no override: the lead time
    # I22: a Not Started step with a floor starts at or after it.
    assert booked["PDD-E"].start_week >= 50
    assert run.workflow_snapshot["step_timing"] == [
        {"project_id": str(w.project.id), "step_id": "PDD-D",
         "duration_override_weeks": 3, "start_not_before_week": None},
        {"project_id": str(w.project.id), "step_id": "PDD-E",
         "duration_override_weeks": 9, "start_not_before_week": 50},
    ]


async def test_schedule_input_omits_steps_without_timing(db_session):
    w = await _world(db_session, active_run=False)
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [p for p in schedule_input.projects if p.project_id == str(w.project.id)]
    assert p.step_timing == ()


# --- Workspace uses the effective duration ---------------------------------------------


async def test_workspace_stage_and_rollup_use_the_effective_duration(db_session):
    w = await _world(db_session)
    rows = {
        r.step_template_id: r
        for r in (
            await db_session.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == w.project.id)
            )
        ).scalars()
    }
    # PDD / A lead times sum to 38 weeks. Make PDD-A (1 week) Done and give
    # it an override of 39 weeks: the roll-up is then 39 × 100 / (38 − 1 + 39).
    a = rows["PDD-A"]
    a.status, a.percent_complete, a.actual_start_week, a.actual_end_week = (
        WorkflowStepStatus.DONE, 100, 29, 30,
    )
    a.duration_override_weeks = 39
    b = rows["PDD-B"]
    b.status, b.percent_complete, b.actual_start_week = WorkflowStepStatus.IN_PROGRESS, 50, 31
    b.duration_override_weeks = 10
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.get(f"/projects/{w.project.id}/workspace")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    stages = {s["step_id"]: s for s in body["stages"]}
    assert stages["PDD-A"]["duration_weeks"] == 39
    assert stages["PDD-B"]["duration_weeks"] == 10
    assert stages["PDD-B"]["remaining_weeks"] == 5  # ceil(10 × (1 − 0.5))
    assert body["progress_pct"] == round((39 * 100 + 10 * 50) / (38 - 1 - 4 + 39 + 10))


def test_effective_duration_never_revives_a_skipped_step():
    assert effective_duration_weeks(0, 7) == 0
    assert effective_duration_weeks(4, None) == 4
    assert effective_duration_weeks(4, 9) == 9
    assert effective_duration_weeks(4, 9, skipped=True) == 4  # lab step, no cert testing


async def test_workspace_ignores_override_on_a_cert_skipped_lab_step(db_session):
    w = await _world(db_session, cert=False)
    f = await _step(db_session, w.project, "PDD-F")
    f.duration_override_weeks = 20
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.get(f"/projects/{w.project.id}/workspace")
    stages = {s["step_id"]: s for s in resp.json()["stages"]}
    assert stages["PDD-F"]["skipped"] is True
    assert stages["PDD-F"]["duration_weeks"] == 4 and stages["PDD-F"]["remaining_weeks"] == 0


async def test_ask_agent_context_uses_the_effective_duration(db_session):
    from services.ask_agent import build_agent_context

    w = await _world(db_session)
    a = await _step(db_session, w.project, "PDD-A")
    a.status, a.percent_complete, a.actual_start_week, a.actual_end_week = (
        WorkflowStepStatus.DONE, 100, 29, 30,
    )
    a.duration_override_weeks = 39
    b = await _step(db_session, w.project, "PDD-B")
    b.status, b.percent_complete, b.actual_start_week = WorkflowStepStatus.IN_PROGRESS, 50, 31
    b.duration_override_weeks = 10
    await db_session.flush()
    await db_session.refresh(w.project)  # load `workflow_id`, as the router's lookup does
    context = await build_agent_context(db_session, w.project)
    stages = {s["code"]: s for s in context["stages"]}
    assert stages["MKTG_BRF"]["duration_weeks"] == 39
    assert stages["FEAS_STD"]["duration_weeks"] == 10
    assert stages["FEAS_STD"]["remaining_weeks"] == 5
    assert context["progress_pct"] == round((39 * 100 + 10 * 50) / (38 - 1 - 4 + 39 + 10))


async def test_schedule_input_drops_timing_of_another_workflow(db_session):
    # A project moved to an OEM hub whose rows were not re-pointed yet: the
    # PDD-E timing must not reach the scheduler (unknown step → ValueError).
    w = await _world(db_session, active_run=False)
    row = await _step(db_session, w.project, "PDD-E")
    row.duration_override_weeks = 9
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    w.project.hub_id, w.project.category = oem.id, ProjectCategory.A_OEM
    await db_session.flush()
    db_session.expire_all()
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [p for p in schedule_input.projects if p.project_id == str(w.project.id)]
    assert p.workflow_id == "OEM" and p.step_timing == ()


# --- Workflow re-point and DB constraints ------------------------------------------------


async def test_workflow_repoint_clears_timing(db_session):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    row.duration_override_weeks, row.start_not_before_week = 9, 40
    await db_session.flush()
    oem = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    w.project.hub_id, w.project.category = oem.id, ProjectCategory.A_OEM
    await db_session.flush()
    await sync_project_steps(db_session, w.project, hub_is_oem=True)
    await db_session.refresh(row)
    assert row.step_template_id == "OEM-E"
    assert (row.duration_override_weeks, row.start_not_before_week) == (None, None)


@pytest.mark.parametrize(
    "field,value",
    [("duration_override_weeks", 0), ("duration_override_weeks", 105),
     ("start_not_before_week", 0), ("start_not_before_week", 79)],
)
async def test_db_check_constraints(db_session, field, value):
    w = await _world(db_session)
    row = await _step(db_session, w.project, "PDD-E")
    setattr(row, field, value)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()
