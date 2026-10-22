"""ADR 0040 (2026-10-22): VIP is a manual pin and a scheduling input.

- `PUT /projects/{id}/vip` follows the committed-priority-change path
  (`services.priority_move.decide_auto_recalc` + `dispatch_auto_recalc`):
  `schedule_stale`, then queued (one greedy activating run on the worker) /
  deferred (run in flight, ADR 0023 follow-up flag) / not_needed
  (non-schedulable status), reported in the PATCH-path `X-Schedule-*`
  headers; the audit row is kept; an unchanged value writes nothing.
- The worker's input builder carries `projects.is_vip` as
  `ProjectInput.is_vip`.

`run_greedy_schedule.delay` and `publish_progress` are patched as in the
P11 priority-move tests; nothing reaches Celery or Redis.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp
from models.enums import (
    HubName,
    LabRegion,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.project import Project
from models.schedule import ScheduleRun
from services.schedule_persistence import build_schedule_input_from_db
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run
from tests.p12_helpers import act_as, client_for
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
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


async def _world(db_session, *, status=ProjectStatus.IN_QUEUE, active_run=True):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(db_session, hub, name="Pin Leader")
    project = await make_project(
        db_session, hub, leader=leader, name="Pin Me", status=status,
        priority=ProjectPriority.P3, schedule_stale=False,
    )
    run = await make_schedule_run(db_session, is_active=True) if active_run else None
    await db_session.flush()
    return SimpleNamespace(hub=hub, project=project, run=run)


async def _runs(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(ScheduleRun)) or 0


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


async def test_pin_marks_stale_and_queues_one_greedy_activating_run(db_session, dispatch):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    runs_before = await _runs(db_session)

    async with client_for(db_session) as client:
        resp = await client.put(f"/projects/{w.project.id}/vip", json={"is_vip": True})

    assert resp.status_code == 200, resp.text
    # Body unchanged (exact frontend mirror); the outcome is in the headers.
    assert resp.json() == {"project_id": str(w.project.id), "is_vip": True}
    assert resp.headers["X-Schedule-Recalc"] == "queued"
    assert resp.headers["X-Schedule-Baseline-Run-Id"] == str(w.run.id)
    run_id = resp.headers["X-Schedule-Run-Id"]

    assert await _runs(db_session) == runs_before + 1
    (args, kwargs), = dispatch.calls
    assert args == (run_id,)
    assert kwargs == {
        "triggered_by_user_id": str(user.id),
        "activate": True,
        "recalc_project_id": str(w.project.id),
    }
    run = await db_session.get(ScheduleRun, uuid.UUID(run_id))
    assert run.solver_type == SolverType.GREEDY
    assert run.status == ScheduleRunStatus.QUEUED
    assert run.trigger_reason == "vip_pin"
    assert run.celery_task_id == "celery-task-1"
    assert dispatch.published == [((run_id,), {"status": "queued"})]

    await db_session.refresh(w.project)
    assert w.project.is_vip is True and w.project.schedule_stale is True
    # The worker's input carries the pin (ADR 0040 sort key 2).
    schedule_input = await build_schedule_input_from_db(db_session)
    pinned = next(p for p in schedule_input.projects if p.project_id == str(w.project.id))
    assert pinned.is_vip is True

    (audit,) = await _audits(db_session, "project.vip_pin", w.project)
    assert audit.actor_user_id == user.id and audit.hub_id == w.hub.id
    assert audit.before_state == {"project_id": str(w.project.id), "is_vip": False}
    assert audit.after_state == {
        "project_id": str(w.project.id),
        "is_vip": True,
        "recalc_status": "queued",
        "baseline_run_id": str(w.run.id),
    }
    (requested,) = await _audits(db_session, "project.recalculate_requested", w.project)
    assert requested.after_state["schedule_run_id"] == run_id
    assert requested.after_state["trigger_reason"] == "vip_pin"


async def test_unpin_also_recalculates(db_session, dispatch):
    w = await _world(db_session, active_run=False)
    w.project.is_vip = True
    await db_session.flush()
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        resp = await client.put(f"/projects/{w.project.id}/vip", json={"is_vip": False})
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Recalc"] == "queued"
    assert "X-Schedule-Baseline-Run-Id" not in resp.headers
    assert len(dispatch.calls) == 1
    (audit,) = await _audits(db_session, "project.vip_unpin", w.project)
    assert audit.after_state["recalc_status"] == "queued"
    schedule_input = await build_schedule_input_from_db(db_session)
    row = next(p for p in schedule_input.projects if p.project_id == str(w.project.id))
    assert row.is_vip is False


async def test_pin_deferred_while_a_run_is_in_flight(db_session, dispatch):
    w = await _world(db_session)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    await act_as(db_session, RoleName.ADMIN)
    runs_before = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.put(f"/projects/{w.project.id}/vip", json={"is_vip": True})
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Recalc"] == "deferred"
    assert "X-Schedule-Run-Id" not in resp.headers
    assert dispatch.calls == [] and dispatch.published == []
    assert await _runs(db_session) == runs_before
    await db_session.refresh(w.project)
    assert w.project.is_vip is True and w.project.schedule_stale is True
    # ADR 0023: the one coalesced follow-up run is requested.
    follow_up = await db_session.get(ScheduleRunFollowUp, 1, populate_existing=True)
    assert follow_up is not None and follow_up.pending is True
    assert follow_up.last_trigger_reason == "vip_pin"
    (audit,) = await _audits(db_session, "project.vip_pin", w.project)
    assert audit.after_state["recalc_status"] == "deferred"


async def test_pin_not_needed_for_a_non_schedulable_project(db_session, dispatch):
    w = await _world(db_session, status=ProjectStatus.ON_HOLD)
    await act_as(db_session, RoleName.ADMIN)
    runs_before = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.put(f"/projects/{w.project.id}/vip", json={"is_vip": True})
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Recalc"] == "not_needed"
    assert dispatch.calls == []
    assert await _runs(db_session) == runs_before
    await db_session.refresh(w.project)
    assert w.project.is_vip is True and w.project.schedule_stale is True


async def test_unchanged_pin_writes_nothing_and_has_no_recalc_headers(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    runs_before = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.put(f"/projects/{w.project.id}/vip", json={"is_vip": False})
    assert resp.status_code == 200, resp.text
    assert "X-Schedule-Recalc" not in resp.headers
    assert dispatch.calls == []
    assert await _runs(db_session) == runs_before
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is False
    assert await _audits(db_session, "project.vip_pin", w.project) == []

