"""P11-T01: priority move (ADR 0015, docs/API_CONTRACT_P11.md §1–§2, I20).

`POST /projects/{id}/priority` and `PATCH /projects/{id}` share
`services.priority_move.apply_priority_change`. Covered on both paths:
- each `recalc_status` (queued / deferred / not_needed / unchanged);
- 409 `HARD_GATE_FORCES_P1`, and a non-gated P1 → P2 succeeding;
- the `project.priority_move` audit row, and none on `unchanged`;
- the queued run: GREEDY, `trigger_reason="priority_move"`, `activate=True`,
  baseline = the run active before, and the worker's input carries the new
  priority (I20);
- the PATCH response headers and their CORS exposure;
- RBAC negatives on the POST (Engineer, Executive Viewer, out-of-hub Hub
  Planner, Viewer/Editor grants).

`run_greedy_schedule.delay` and `publish_progress` are patched the way the
Workspace recalc tests patch them; nothing reaches Celery or Redis.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HardGateReason,
    HubName,
    LabRegion,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.schedule import ScheduleRun
from services.schedule_persistence import build_schedule_input_from_db
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_project,
    make_schedule_run,
    make_user,
)
from workers.schedule_tasks import run_greedy_schedule

GATE = HardGateReason.REGULATORY_DEADLINE_6MO


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
        priority_move, "publish_progress", lambda *a, **k: published.append((a, k))
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
    priority: ProjectPriority = ProjectPriority.P1,
    active_run: bool = True,
    hard_gates: list[HardGateReason] | None = None,
):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="Move Leader")
    project = await make_project(
        db_session, hub, leader=leader, name="Move Me", status=status, priority=priority,
        schedule_stale=False,
    )
    if hard_gates is not None:
        await make_priority_score(db_session, project, dims=[3] * 13, hard_gates=hard_gates)
    run = await make_schedule_run(db_session, is_active=True) if active_run else None
    await db_session.flush()
    return SimpleNamespace(hub=hub, leader=leader, project=project, run=run)


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


# --- POST: each recalc_status ------------------------------------------------------------


async def test_post_queued_dispatches_one_greedy_activating_run(db_session, dispatch):
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    runs_before = await _run_count(db_session)

    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["project_id"] == str(w.project.id)
    assert body["priority_before"] == "P1" and body["priority_after"] == "P2"
    assert body["recalc_status"] == "queued"
    assert body["baseline_run_id"] == str(w.run.id)
    assert body["task_id"] == "celery-task-1"

    # I20: exactly one new run, greedy, queued, activating, for this project.
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
    assert run.trigger_reason == "priority_move"
    assert run.is_active is False
    assert run.celery_task_id == "celery-task-1"
    assert dispatch.published == [((body["schedule_run_id"],), {"status": "queued"})]

    await db_session.refresh(w.project)
    assert w.project.priority == ProjectPriority.P2
    assert w.project.schedule_stale is True
    # I20: the worker builds its input from the DB after this commit, and
    # that input carries the new priority.
    schedule_input = await build_schedule_input_from_db(db_session)
    moved = next(p for p in schedule_input.projects if p.project_id == str(w.project.id))
    assert moved.priority == "P2"

    (audit,) = await _audits(db_session, "project.priority_move", w.project)
    assert audit.actor_user_id == user.id and audit.hub_id == w.hub.id
    assert audit.before_state == {"project_id": str(w.project.id), "priority": "P1"}
    assert audit.after_state == {
        "project_id": str(w.project.id),
        "priority": "P2",
        "recalc_status": "queued",
        "baseline_run_id": str(w.run.id),
    }
    (requested,) = await _audits(db_session, "project.recalculate_requested", w.project)
    assert requested.after_state["schedule_run_id"] == body["schedule_run_id"]
    assert requested.after_state["trigger_reason"] == "priority_move"


async def test_post_queued_without_active_run_has_null_baseline(db_session, dispatch):
    w = await _world(db_session, active_run=False)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "Q"})
    body = resp.json()
    assert body["recalc_status"] == "queued"
    assert body["baseline_run_id"] is None
    assert body["schedule_run_id"] is not None


async def test_post_deferred_when_a_run_is_in_flight(db_session, dispatch):
    w = await _world(db_session)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await _act_as(db_session, RoleName.ADMIN)
    runs_before = await _run_count(db_session)

    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P3"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "deferred"
    assert body["schedule_run_id"] is None
    assert body["baseline_run_id"] is None
    assert body["task_id"] is None
    assert dispatch.calls == [] and dispatch.published == []
    assert await _run_count(db_session) == runs_before  # no second run
    await db_session.refresh(w.project)
    assert w.project.priority == ProjectPriority.P3  # still committed
    assert w.project.schedule_stale is True
    (audit,) = await _audits(db_session, "project.priority_move", w.project)
    assert audit.after_state["recalc_status"] == "deferred"


async def test_post_back_to_back_moves_queue_one_run_then_defer(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        first = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})
        second = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P3"})
    assert first.json()["recalc_status"] == "queued"
    assert second.json()["recalc_status"] == "deferred"
    assert len(dispatch.calls) == 1


@pytest.mark.parametrize(
    "status", [ProjectStatus.ON_HOLD, ProjectStatus.DRAFT, ProjectStatus.COMMERCIALIZED,
               ProjectStatus.CANCELLED]
)
async def test_post_not_needed_for_non_schedulable_status(db_session, dispatch, status):
    w = await _world(db_session, status=status)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P4"})
    body = resp.json()
    assert body["recalc_status"] == "not_needed"
    assert body["schedule_run_id"] is None and body["task_id"] is None
    assert dispatch.calls == []
    await db_session.refresh(w.project)
    assert w.project.priority == ProjectPriority.P4
    (audit,) = await _audits(db_session, "project.priority_move", w.project)
    assert audit.after_state["recalc_status"] == "not_needed"


async def test_post_unchanged_writes_nothing(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P1"})
    assert resp.status_code == 200
    assert resp.json() == {
        "project_id": str(w.project.id),
        "priority_before": "P1",
        "priority_after": "P1",
        "recalc_status": "unchanged",
        "schedule_run_id": None,
        "baseline_run_id": None,
        "task_id": None,
    }
    assert dispatch.calls == []
    assert await _audits(db_session, "project.priority_move", w.project) == []
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is False


# --- Hard gates pin P1 ----------------------------------------------------------------------


async def test_post_hard_gate_forces_p1(db_session, dispatch):
    w = await _world(db_session, hard_gates=[GATE])
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})
        same = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P1"})
    assert resp.status_code == 409
    assert resp.json()["code"] == "HARD_GATE_FORCES_P1"
    assert GATE.value in resp.json()["detail"]
    assert same.status_code == 200 and same.json()["recalc_status"] == "unchanged"
    await db_session.refresh(w.project)
    assert w.project.priority == ProjectPriority.P1
    assert w.project.schedule_stale is False
    assert dispatch.calls == []
    assert await _audits(db_session, "project.priority_move", w.project) == []


async def test_hard_gated_project_may_move_to_p1(db_session, dispatch):
    w = await _world(db_session, priority=ProjectPriority.P3, hard_gates=[GATE])
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P1"})
    assert resp.status_code == 200
    assert resp.json()["recalc_status"] == "queued"


async def test_empty_hard_gates_do_not_pin(db_session, dispatch):
    w = await _world(db_session, hard_gates=[])
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})
    assert resp.status_code == 200 and resp.json()["recalc_status"] == "queued"


# --- Request validation ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "payload",
    [{"priority": "P9"}, {"priority": None}, {"priority": 2}, {}, {"priority": "P2", "x": 1},
     {"priority": "p2"}],
)
async def test_post_rejects_bad_bodies(db_session, dispatch, payload):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json=payload)
    assert resp.status_code == 422
    assert dispatch.calls == []


# --- RBAC negatives on the POST -----------------------------------------------------------


async def test_post_rbac_engineer_and_executive_viewer(db_session, dispatch):
    w = await _world(db_session)
    url = f"/projects/{w.project.id}/priority"

    # An Engineer with no assignment on the project cannot even see it.
    await _act_as(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        unassigned = await client.post(url, json={"priority": "P2"})
    assert unassigned.status_code == 404

    # The project's own leader (Viewer through rule 6) sees it but may not move it.
    leader_user = await _act_as(db_session, RoleName.ENGINEER, email="leader.move@example.com")
    w.leader.user_id = leader_user.id
    await db_session.flush()
    async with _client(db_session) as client:
        leader = await client.post(url, json={"priority": "P2"})
    assert leader.status_code == 403

    await _act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with _client(db_session) as client:
        viewer = await client.post(url, json={"priority": "P2"})
    assert viewer.status_code == 403

    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        auditor = await client.post(url, json={"priority": "P2"})
    assert auditor.status_code in (403, 404)

    assert dispatch.calls == []
    await db_session.refresh(w.project)
    assert w.project.priority == ProjectPriority.P1


async def test_post_rbac_hub_planner_of_another_hub_gets_404(db_session, dispatch):
    w = await _world(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[other.id])
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})
    assert resp.status_code == 404
    assert dispatch.calls == []


@pytest.mark.parametrize("grant_role", ["viewer", "editor"])
async def test_post_rbac_viewer_and_editor_grants_get_403(db_session, dispatch, grant_role):
    w = await _world(db_session)
    granter = await make_user(db_session, RoleName.SUPER_ADMIN, email=f"g-{grant_role}@example.com")
    grantee = await _act_as(db_session, RoleName.ENGINEER)
    db_session.add(
        ProjectAccessGrant(
            project_id=w.project.id, user_id=grantee.id, project_role=grant_role,
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})
    assert resp.status_code == 403
    assert dispatch.calls == []


async def test_post_admin_grant_may_move(db_session, dispatch):
    w = await _world(db_session)
    granter = await make_user(db_session, RoleName.SUPER_ADMIN, email="g-admin@example.com")
    grantee = await _act_as(db_session, RoleName.ENGINEER)
    db_session.add(
        ProjectAccessGrant(
            project_id=w.project.id, user_id=grantee.id, project_role="admin",
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/priority", json={"priority": "P2"})
    assert resp.status_code == 200 and resp.json()["recalc_status"] == "queued"


# --- PATCH: the same logic, reported in headers ----------------------------------------


async def test_patch_queued_sets_headers_and_audits_the_move(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}", json={"priority": "P2"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["priority"] == "P2"  # body stays ProjectRead
    assert resp.json()["schedule_stale"] is True
    assert resp.headers["X-Schedule-Recalc"] == "queued"
    run_id = resp.headers["X-Schedule-Run-Id"]
    assert resp.headers["X-Schedule-Baseline-Run-Id"] == str(w.run.id)
    (args, kwargs), = dispatch.calls
    assert args == (run_id,) and kwargs["activate"] is True
    run = await db_session.get(ScheduleRun, uuid.UUID(run_id))
    assert run.trigger_reason == "priority_move" and run.solver_type == SolverType.GREEDY
    (audit,) = await _audits(db_session, "project.priority_move", w.project)
    assert audit.before_state["priority"] == "P1" and audit.after_state["priority"] == "P2"
    # A priority-only PATCH is audited by the move row alone.
    assert await _audits(db_session, "project.update", w.project) == []


async def test_patch_queued_without_active_run_omits_baseline_header(db_session, dispatch):
    w = await _world(db_session, active_run=False)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}", json={"priority": "P2"})
    assert resp.headers["X-Schedule-Recalc"] == "queued"
    assert "X-Schedule-Run-Id" in resp.headers
    assert "X-Schedule-Baseline-Run-Id" not in resp.headers


async def test_patch_deferred(db_session, dispatch):
    w = await _world(db_session)
    await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}", json={"priority": "P2"})
    assert resp.status_code == 200
    assert resp.headers["X-Schedule-Recalc"] == "deferred"
    assert "X-Schedule-Run-Id" not in resp.headers
    assert "X-Schedule-Baseline-Run-Id" not in resp.headers
    assert dispatch.calls == []
    assert resp.json()["priority"] == "P2"


async def test_patch_not_needed_including_a_status_change_in_the_same_body(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}", json={"priority": "P3", "status": "On Hold"}
        )
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Recalc"] == "not_needed"
    assert dispatch.calls == []
    # Both changes are audited: the status by project.update, the move by its own row.
    (update,) = await _audits(db_session, "project.update", w.project)
    assert update.before_state["status"] == "In Queue"
    assert update.after_state["status"] == "On Hold"
    assert update.after_state["priority"] == "P3"  # the snapshot shows the stored state
    (move,) = await _audits(db_session, "project.priority_move", w.project)
    assert move.after_state["recalc_status"] == "not_needed"


async def test_patch_unchanged_priority_has_no_recalc_headers(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        same = await client.patch(f"/projects/{w.project.id}", json={"priority": "P1"})
        other = await client.patch(f"/projects/{w.project.id}", json={"delay_weeks": 2})
    for resp in (same, other):
        assert resp.status_code == 200
        assert "X-Schedule-Recalc" not in resp.headers
        assert "X-Schedule-Run-Id" not in resp.headers
    assert dispatch.calls == []
    assert await _audits(db_session, "project.priority_move", w.project) == []
    assert len(await _audits(db_session, "project.update", w.project)) == 2


async def test_patch_hard_gate_forces_p1(db_session, dispatch):
    w = await _world(db_session, hard_gates=[GATE])
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}", json={"priority": "P2", "delay_weeks": 3}
        )
    assert resp.status_code == 409
    assert resp.json()["code"] == "HARD_GATE_FORCES_P1"
    await db_session.refresh(w.project)
    assert w.project.priority == ProjectPriority.P1
    assert w.project.delay_weeks == 0  # nothing else was written either
    assert dispatch.calls == []
    assert await _audits(db_session, "project.update", w.project) == []


async def test_patch_null_priority_on_schedulable_project_is_422(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}", json={"priority": None})
    assert resp.status_code == 422
    assert resp.json()["code"] == "NULL_NOT_ALLOWED"
    assert dispatch.calls == []


async def test_patch_null_priority_on_draft_is_not_needed(db_session, dispatch):
    w = await _world(db_session, status=ProjectStatus.DRAFT)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}", json={"priority": None})
    assert resp.status_code == 200, resp.text
    assert resp.json()["priority"] is None
    assert resp.headers["X-Schedule-Recalc"] == "not_needed"


async def test_patch_other_fields_and_priority_are_one_commit(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}", json={"priority": "P2", "delay_weeks": 4}
        )
    assert resp.status_code == 200
    assert resp.headers["X-Schedule-Recalc"] == "queued"
    body = resp.json()
    assert body["priority"] == "P2" and body["delay_weeks"] == 4
    (update,) = await _audits(db_session, "project.update", w.project)
    assert update.after_state["delay_weeks"] == 4
    assert update.after_state["priority"] == "P2"


async def test_patch_rbac_editor_grant_still_403(db_session, dispatch):
    w = await _world(db_session)
    granter = await make_user(db_session, RoleName.SUPER_ADMIN, email="g-patch@example.com")
    grantee = await _act_as(db_session, RoleName.ENGINEER)
    db_session.add(
        ProjectAccessGrant(
            project_id=w.project.id, user_id=grantee.id, project_role="editor",
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}", json={"priority": "P2"})
    assert resp.status_code == 403
    assert dispatch.calls == []


# --- CORS ----------------------------------------------------------------------------------


async def test_cors_exposes_the_priority_move_headers(db_session, dispatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}",
            json={"priority": "P2"},
            headers={"Origin": "http://localhost:5173"},
        )
    exposed = {h.strip().lower() for h in resp.headers["access-control-expose-headers"].split(",")}
    assert {
        "x-schedule-recalc",
        "x-schedule-run-id",
        "x-schedule-baseline-run-id",
        "x-schedule-stale-count",
    } <= exposed


def test_result_headers_carry_ids_and_status_only():
    rid, bid = uuid.uuid4(), uuid.uuid4()
    pid = uuid.uuid4()
    queued = priority_move.PriorityMoveResult(
        project_id=pid, priority_before=ProjectPriority.P1, priority_after=ProjectPriority.P2,
        recalc_status="queued", schedule_run_id=rid, baseline_run_id=bid, task_id="t",
    )
    assert queued.response_headers() == {
        "X-Schedule-Recalc": "queued",
        "X-Schedule-Run-Id": str(rid),
        "X-Schedule-Baseline-Run-Id": str(bid),
    }
    unchanged = priority_move.PriorityMoveResult(
        project_id=pid, priority_before=ProjectPriority.P1, priority_after=ProjectPriority.P1,
        recalc_status="unchanged",
    )
    assert unchanged.response_headers() == {}
