"""P14-T01: priority move preview and in-process confirm (ADR 0026,
docs/API_CONTRACT_P14.md §1).

The world is small and real: one leader shared by several category-C
projects (no lab steps), so their design steps contend for one engineer and
moving a project's priority moves the others. The baseline is a real greedy
run persisted and activated with the worker's own code
(`services.schedule_apply.persist_solved_run`).

Covered:
- the preview writes nothing (priority, stale flag, runs, audit rows, the
  follow-up flag);
- the confirmed result equals the preview (changes, summary, moved, hidden);
- a stale token is 409 `PREVIEW_STALE` and writes nothing;
- hard gate 409 on the preview; `unchanged` and `not_needed` on both;
- `hidden_count` for a hub-scoped user;
- the reaper fails an old queued row (`ABANDONED`, audited) and the move
  then applies; a fresh queued row makes the confirm `deferred`;
- the time cap (503) and the rate limit (429);
- the token is deterministic.
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select

import api.routers.projects as projects_router
import services.priority_preview as priority_preview
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp
from models.enums import (
    EngineerAllowedCategory,
    HardGateReason,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.project import Project
from models.schedule import ScheduleRun
from scheduling.greedy import run_greedy_sgs
from services.project_steps import sync_project_steps
from services.run_dispatch import ABANDONED_ERROR, in_flight_window
from services.schedule_apply import persist_solved_run
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


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setattr(priority_preview, "publish_progress", lambda *a, **k: None)
    projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
    yield
    projects_router.PRIORITY_PREVIEW_RATE_LIMIT.reset()
    projects_router.PRIORITY_CONFIRM_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids=None):
    scope_all = hub_ids is None
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=scope_all)
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _activate_baseline(db_session) -> ScheduleRun:
    """A real greedy run over the current DB inputs, persisted and activated
    exactly as the worker does it."""

    schedule_input = await build_schedule_input_from_db(db_session)
    run = await persist_solved_run(
        db_session, schedule_input, run_greedy_sgs(schedule_input),
        solver=SolverType.GREEDY, trigger_reason="manual", actor_user_id=None, activate=True,
    )
    await db_session.flush()
    return run


async def _world(db_session, *, other_hub: bool = False, baseline: bool = True):
    """Four category-C projects sharing one leader (P1, P2, P3, P4). With
    `other_hub`, the P2 project is registered in a second hub (same leader),
    so a hub-A planner's move changes a project they cannot see."""

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = (
        await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
        if other_hub
        else hub
    )
    leader = await make_engineer(
        db_session, hub, name="Shared Leader", allowed_categories=[EngineerAllowedCategory.C]
    )
    projects = []
    for i, prio in enumerate(
        (ProjectPriority.P1, ProjectPriority.P2, ProjectPriority.P3, ProjectPriority.P4)
    ):
        p = await make_project(
            db_session, hub_b if (other_hub and i == 1) else hub, leader=leader,
            name=f"Contender {i + 1}", category=ProjectCategory.C, priority=prio,
            status=ProjectStatus.IN_QUEUE, schedule_stale=False,
            certification_testing_required=False,
        )
        await sync_project_steps(db_session, p, False)
        projects.append(p)
    await db_session.flush()
    run = await _activate_baseline(db_session) if baseline else None
    return SimpleNamespace(hub=hub, hub_b=hub_b, leader=leader, projects=projects, run=run)


async def _queued_run(db_session, **kwargs) -> ScheduleRun:
    """A QUEUED row whose version cannot collide with the persisted runs."""

    top = (await db_session.execute(select(func.max(ScheduleRun.version)))).scalar_one() or 0
    return await make_schedule_run(
        db_session, status=ScheduleRunStatus.QUEUED, version=top + 1, **kwargs
    )


async def _count(db_session, model) -> int:
    return (await db_session.execute(select(func.count()).select_from(model))).scalar_one()


async def _follow_up_pending(db_session) -> bool:
    return bool(
        (
            await db_session.execute(
                select(ScheduleRunFollowUp.pending).where(ScheduleRunFollowUp.id == 1)
            )
        ).scalar_one_or_none()
    )


async def _preview(client, project_id, priority: str):
    return await client.post(
        f"/projects/{project_id}/priority/preview", json={"priority": priority}
    )


async def _confirm(client, project_id, priority: str, token: str):
    return await client.post(
        f"/projects/{project_id}/priority", json={"priority": priority, "preview_token": token}
    )


# --- preview ------------------------------------------------------------------------------


async def test_preview_lists_knock_on_changes_and_writes_nothing(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    last = w.projects[3]
    runs, audits, pending = (
        await _count(db_session, ScheduleRun), await _count(db_session, AuditLogEntry),
        await _follow_up_pending(db_session),
    )

    async with _client(db_session) as client:
        resp = await _preview(client, last.id, "P1")

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["result"] == "preview"
    assert body["from_priority"] == "P4" and body["to_priority"] == "P1"
    assert body["baseline_run_id"] == str(w.run.id)
    assert len(body["preview_token"]) == 64
    assert body["elapsed_ms"] is not None and body["elapsed_ms"] >= 0
    moved = body["moved"]
    assert moved["end_week_after"] < moved["end_week_before"]  # jumps the queue
    # The other three are delayed; the moved project is never listed.
    ids = [c["project_id"] for c in body["changes"]]
    assert str(last.id) not in ids
    # P2 and P3 are certainly pushed back. The P1 project ties on priority
    # with the moved one, and greedy breaks that tie by a key that includes
    # the (random) id, so it may or may not move.
    assert {str(w.projects[1].id), str(w.projects[2].id)} <= set(ids)
    assert set(ids) <= {str(p.id) for p in w.projects[:3]}
    assert all(c["end_week_after"] > c["end_week_before"] for c in body["changes"])
    pushed = [c["within_year_before"] and not c["within_year_after"] for c in body["changes"]]
    # Ordered: pushed out of year first, then the largest delay.
    assert pushed == sorted(pushed, reverse=True)
    for group in (True, False):
        delays = [
            c["end_week_after"] - c["end_week_before"]
            for c, out in zip(body["changes"], pushed, strict=True)
            if out is group
        ]
        assert delays == sorted(delays, reverse=True)
    assert body["summary"]["affected"] == len(ids) == body["summary"]["delayed"]
    assert body["summary"]["earlier"] == 0
    assert body["hidden_count"] == 0

    # Nothing written.
    await db_session.refresh(last)
    assert last.priority == ProjectPriority.P4 and last.schedule_stale is False
    assert await _count(db_session, ScheduleRun) == runs
    assert await _count(db_session, AuditLogEntry) == audits
    assert await _follow_up_pending(db_session) is pending
    assert (await db_session.get(ScheduleRun, w.run.id)).is_active is True


async def test_preview_equals_confirm(db_session):
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    last = w.projects[3]

    async with _client(db_session) as client:
        preview = (await _preview(client, last.id, "P1")).json()
        resp = await _confirm(client, last.id, "P1", preview["preview_token"])

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "applied"
    assert body["priority_before"] == "P4" and body["priority_after"] == "P1"
    assert body["baseline_run_id"] == str(w.run.id) and body["task_id"] is None
    assert body["changes"] == preview["changes"]
    assert body["summary"] == preview["summary"]
    assert body["moved"] == preview["moved"]
    assert body["hidden_count"] == preview["hidden_count"] == 0

    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run.is_active is True and run.status == ScheduleRunStatus.COMPLETED
    assert run.solver_type == SolverType.GREEDY and run.trigger_reason == "priority_move"
    assert run.triggered_by_user_id == user.id
    assert run.started_at is not None and run.completed_at is not None
    assert (await db_session.get(ScheduleRun, w.run.id)).is_active is False
    await db_session.refresh(last)
    assert last.priority == ProjectPriority.P1
    assert last.schedule_stale is False  # cleared by the activation

    def _audits(action):
        return select(AuditLogEntry).where(
            AuditLogEntry.action == action, AuditLogEntry.entity_id == str(last.id)
        )

    (move,) = (await db_session.execute(_audits("project.priority_move"))).scalars().all()
    assert move.after_state == {
        "project_id": str(last.id), "priority": "P1", "recalc_status": "applied",
        "baseline_run_id": str(w.run.id), "schedule_run_id": str(run.id),
    }
    (recalc,) = (await db_session.execute(_audits("project.schedule_recalculated"))).scalars().all()
    assert recalc.after_state["projected_end_week"] == preview["moved"]["end_week_after"]
    assert recalc.before_state["projected_end_week"] == preview["moved"]["end_week_before"]


async def test_stale_token_is_409_and_writes_nothing(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    last = w.projects[3]
    async with _client(db_session) as client:
        token = (await _preview(client, last.id, "P1")).json()["preview_token"]
        # Another input changes after the preview.
        w.projects[0].delay_weeks = 3
        await db_session.flush()
        runs = await _count(db_session, ScheduleRun)
        audits = await _count(db_session, AuditLogEntry)
        resp = await _confirm(client, last.id, "P1", token)
        wrong = await _confirm(client, last.id, "P1", "0" * 64)

    assert resp.status_code == 409, resp.text
    assert resp.json()["code"] == "PREVIEW_STALE"
    assert wrong.status_code == 409 and wrong.json()["code"] == "PREVIEW_STALE"
    await db_session.refresh(last)
    assert last.priority == ProjectPriority.P4
    assert await _count(db_session, ScheduleRun) == runs
    assert await _count(db_session, AuditLogEntry) == audits


async def test_token_for_another_target_is_stale(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        token = (await _preview(client, w.projects[3].id, "P1")).json()["preview_token"]
        resp = await _confirm(client, w.projects[3].id, "P2", token)
    assert resp.status_code == 409 and resp.json()["code"] == "PREVIEW_STALE"


async def test_hard_gate_preview_is_409(db_session):
    w = await _world(db_session)
    gated = w.projects[0]
    await make_priority_score(
        db_session, gated, dims=[3] * 13, hard_gates=[HardGateReason.REGULATORY_DEADLINE_6MO]
    )
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await _preview(client, gated.id, "P3")
    assert resp.status_code == 409
    assert resp.json()["code"] == "HARD_GATE_FORCES_P1"


async def test_unchanged_on_preview_and_confirm(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    p = w.projects[2]
    audits = await _count(db_session, AuditLogEntry)
    async with _client(db_session) as client:
        preview = (await _preview(client, p.id, "P3")).json()
        confirm = await _confirm(client, p.id, "P3", "a" * 64)
    assert preview["result"] == "unchanged"
    assert preview["preview_token"] is None and preview["moved"] is None
    assert preview["changes"] == [] and preview["summary"]["affected"] == 0
    assert confirm.status_code == 200 and confirm.json()["recalc_status"] == "unchanged"
    assert await _count(db_session, AuditLogEntry) == audits


async def test_not_needed_on_preview_and_confirm(db_session):
    w = await _world(db_session)
    held = await make_project(
        db_session, w.hub, leader=w.leader, name="Held", category=ProjectCategory.C,
        priority=ProjectPriority.P4, status=ProjectStatus.ON_HOLD, schedule_stale=False,
    )
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    runs = await _count(db_session, ScheduleRun)
    async with _client(db_session) as client:
        preview = (await _preview(client, held.id, "P1")).json()
        confirm = await _confirm(client, held.id, "P1", preview["preview_token"])
    assert preview["result"] == "not_needed"
    assert preview["changes"] == [] and preview["moved"] is None
    assert preview["preview_token"] and preview["elapsed_ms"] is None
    assert confirm.status_code == 200, confirm.text
    assert confirm.json()["recalc_status"] == "not_needed"
    assert await _count(db_session, ScheduleRun) == runs
    await db_session.refresh(held)
    assert held.priority == ProjectPriority.P1


async def test_no_active_run_still_compares_against_a_fresh_baseline(db_session):
    """M2: the baseline is greedy on the current inputs, so the list does not
    need a stored run. `baseline_run_id` is null and a note says why."""

    w = await _world(db_session, baseline=False)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        preview = (await _preview(client, w.projects[3].id, "P1")).json()
        confirm = (await _confirm(client, w.projects[3].id, "P1", preview["preview_token"])).json()
    assert preview["baseline_run_id"] is None and preview["note"]
    assert str(w.projects[2].id) in {c["project_id"] for c in preview["changes"]}
    assert preview["moved"]["end_week_before"] > preview["moved"]["end_week_after"]
    assert confirm["recalc_status"] == "applied" and confirm["baseline_run_id"] is None
    assert confirm["changes"] == preview["changes"]
    assert confirm["moved"] == preview["moved"]


async def test_input_drift_since_the_stored_run_is_not_blamed_on_the_move(db_session):
    """M2: an unrelated project whose inputs changed after the active run was
    stored differs from that run, but not because of the move, so it is
    never listed (neither in the preview nor the confirm)."""

    w = await _world(db_session)
    loner_lead = await make_engineer(
        db_session, w.hub, name="Loner Leader", allowed_categories=[EngineerAllowedCategory.C]
    )
    loner = await make_project(
        db_session, w.hub, leader=loner_lead, name="Unrelated", category=ProjectCategory.C,
        priority=ProjectPriority.P2, status=ProjectStatus.IN_QUEUE, schedule_stale=False,
        certification_testing_required=False,
    )
    await sync_project_steps(db_session, loner, False)
    await _activate_baseline(db_session)
    loner.delay_weeks = 6  # drift after the stored run
    await db_session.flush()
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        preview = (await _preview(client, w.projects[3].id, "P1")).json()
        confirm = (await _confirm(client, w.projects[3].id, "P1", preview["preview_token"])).json()
    assert str(loner.id) not in {c["project_id"] for c in preview["changes"]}
    assert confirm["changes"] == preview["changes"]
    assert preview["changes"]  # the contenders still move


async def test_hidden_count_for_hub_scoped_user(db_session):
    w = await _world(db_session, other_hub=True)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        preview = (await _preview(client, w.projects[3].id, "P1")).json()
        confirm = (await _confirm(client, w.projects[3].id, "P1", preview["preview_token"])).json()
    listed = {c["project_id"] for c in preview["changes"]}
    assert str(w.projects[1].id) not in listed  # registered in the other hub
    assert str(w.projects[2].id) in listed
    assert listed <= {str(w.projects[0].id), str(w.projects[2].id)}
    assert preview["hidden_count"] == 1
    assert preview["summary"]["affected"] == len(listed)
    assert confirm["hidden_count"] == 1 and confirm["changes"] == preview["changes"]


async def test_out_of_scope_preview_is_404_and_engineer_403(db_session):
    w = await _world(db_session, other_hub=True)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await _preview(client, w.projects[1].id, "P1")
    assert resp.status_code == 404
    clear_current_principal_override()
    await _act_as(db_session, RoleName.ENGINEER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await _preview(client, w.projects[3].id, "P1")
    assert resp.status_code == 403


# --- reaper and in-flight ------------------------------------------------------------------


async def test_reaper_fails_abandoned_queued_row_then_move_applies(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    old = await _queued_run(
        db_session, trigger_reason="priority_move",
        created_at=datetime.now(UTC) - in_flight_window() - timedelta(minutes=5),
    )
    async with _client(db_session) as client:
        preview = (await _preview(client, w.projects[3].id, "P1")).json()
        resp = await _confirm(client, w.projects[3].id, "P1", preview["preview_token"])

    assert resp.status_code == 200 and resp.json()["recalc_status"] == "applied"
    await db_session.refresh(old)
    assert old.status == ScheduleRunStatus.FAILED and old.is_active is False
    assert old.error_message == ABANDONED_ERROR and old.completed_at is not None
    (audit,) = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "schedule_run.abandoned",
                AuditLogEntry.entity_id == str(old.id),
            )
        )
    ).scalars().all()
    assert audit.actor_user_id is None
    assert audit.before_state == {"status": "queued"}
    assert audit.after_state["status"] == "failed" and audit.after_state["error"] == "ABANDONED"


async def test_fresh_queued_row_defers_the_confirm(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    fresh = await _queued_run(db_session, trigger_reason="check_in")
    runs = await _count(db_session, ScheduleRun)
    async with _client(db_session) as client:
        preview = (await _preview(client, w.projects[3].id, "P1")).json()
        resp = await _confirm(client, w.projects[3].id, "P1", preview["preview_token"])

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "deferred"
    assert body["schedule_run_id"] is None and body["changes"] == []
    assert await _count(db_session, ScheduleRun) == runs
    await db_session.refresh(fresh)
    assert fresh.status == ScheduleRunStatus.QUEUED  # not reaped
    await db_session.refresh(w.projects[3])
    assert w.projects[3].priority == ProjectPriority.P1
    assert w.projects[3].schedule_stale is True
    assert await _follow_up_pending(db_session) is True  # ADR 0023 follow-up


async def test_without_token_adr_0015_is_unchanged(db_session, monkeypatch):
    import services.priority_move as priority_move
    from workers.schedule_tasks import run_greedy_schedule

    monkeypatch.setattr(
        run_greedy_schedule, "delay", lambda *a, **k: SimpleNamespace(id="celery-task-1")
    )
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.projects[3].id}/priority", json={"priority": "P1"})
    body = resp.json()
    assert body["recalc_status"] == "queued" and body["task_id"] == "celery-task-1"
    assert body["changes"] == [] and body["moved"] is None and body["hidden_count"] == 0


# --- caps and determinism ------------------------------------------------------------------


async def test_preview_time_cap_is_503(db_session, monkeypatch):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])

    def _slow(schedule_input):
        import time

        time.sleep(0.5)
        return run_greedy_sgs(schedule_input)

    monkeypatch.setattr(priority_preview, "run_greedy_sgs", _slow)
    monkeypatch.setattr(priority_preview, "PREVIEW_TIME_CAP_SECONDS", 0.05)
    async with _client(db_session) as client:
        resp = await _preview(client, w.projects[3].id, "P1")
    assert resp.status_code == 503 and resp.json()["code"] == "PREVIEW_TIMEOUT"
    await asyncio.sleep(0.6)  # let the abandoned pass finish before teardown


async def test_preview_is_rate_limited(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    capacity = int(projects_router.PRIORITY_PREVIEW_RATE_LIMIT.capacity)
    async with _client(db_session) as client:
        codes = [
            (await _preview(client, w.projects[2].id, "P3")).status_code
            for _ in range(capacity + 1)
        ]
    assert codes[:capacity] == [200] * capacity
    assert codes[-1] == 429


async def test_confirm_is_rate_limited_before_the_lock(db_session, monkeypatch):
    """P14-R01 S1: a flood of bad-token confirms is cut off with a 429 before
    the dispatch lock or the snapshot is touched."""

    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    capacity = int(projects_router.PRIORITY_CONFIRM_RATE_LIMIT.capacity)
    calls = 0
    real = projects_router.confirm_priority_move

    async def counting(*a, **k):
        nonlocal calls
        calls += 1
        return await real(*a, **k)

    monkeypatch.setattr(projects_router, "confirm_priority_move", counting)
    async with _client(db_session) as client:
        codes = [
            (await _confirm(client, w.projects[3].id, "P1", "0" * 64)).status_code
            for _ in range(capacity + 1)
        ]
    assert codes[:capacity] == [409] * capacity
    assert codes[-1] == 429
    assert calls == capacity


async def test_token_is_deterministic(db_session):
    w = await _world(db_session)
    target = w.projects[3]
    a = await priority_preview._snapshot(db_session, target, ProjectPriority.P1)
    b = await priority_preview._snapshot(db_session, target, ProjectPriority.P1)
    assert a.token == b.token
    shuffled = a.schedule_input.__class__(
        **{
            **a.schedule_input.__dict__,
            "projects": tuple(reversed(a.schedule_input.projects)),
            "engineers": tuple(reversed(a.schedule_input.engineers)),
        }
    )
    assert priority_preview.snapshot_token(
        shuffled, project_id=target.id, from_priority=ProjectPriority.P4,
        target=ProjectPriority.P1,
    ) == a.token
    c = await priority_preview._snapshot(db_session, target, ProjectPriority.P2)
    assert c.token != a.token
    moved = next(p for p in a.schedule_input.projects if p.project_id == str(target.id))
    assert moved.priority == "P1"
    project = await db_session.get(Project, target.id)
    assert project.priority == ProjectPriority.P4


# --- M3: broker refuses the message ------------------------------------------------------


def _broker_down(monkeypatch):
    from kombu.exceptions import OperationalError

    from workers.schedule_tasks import run_greedy_schedule

    def _raise(*_a, **_k):
        raise OperationalError("redis://user:secret@broker:6379 refused")

    monkeypatch.setattr(run_greedy_schedule, "delay", _raise)


async def _dispatch_failed_audits(db_session, run_id) -> list[AuditLogEntry]:
    return list(
        (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "schedule_run.dispatch_failed",
                    AuditLogEntry.entity_id == str(run_id),
                )
            )
        ).scalars().all()
    )


async def test_broker_failure_on_plain_move_is_dispatch_failed_not_500(
    db_session, monkeypatch, caplog
):
    _broker_down(monkeypatch)
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.projects[3].id}/priority", json={"priority": "P1"})

    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "dispatch_failed"
    assert body["schedule_run_id"] is None and body["task_id"] is None
    await db_session.refresh(w.projects[3])
    assert w.projects[3].priority == ProjectPriority.P1
    assert w.projects[3].schedule_stale is True
    (failed,) = (
        await db_session.execute(
            select(ScheduleRun).where(ScheduleRun.trigger_reason == "priority_move")
        )
    ).scalars().all()
    assert failed.status == ScheduleRunStatus.FAILED and failed.error_message == "DISPATCH_FAILED"
    assert failed.is_active is False
    (audit,) = await _dispatch_failed_audits(db_session, failed.id)
    assert audit.actor_user_id == user.id
    assert "secret" not in caplog.text  # only the exception type is logged


async def test_broker_failure_on_workspace_recalc_is_503(db_session, monkeypatch):
    _broker_down(monkeypatch)
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.projects[0].id}/recalculate")
    assert resp.status_code == 503, resp.text
    assert resp.json()["code"] == "SOLVER_UNAVAILABLE"
    (failed,) = (
        await db_session.execute(
            select(ScheduleRun).where(ScheduleRun.trigger_reason == "workspace_recalc")
        )
    ).scalars().all()
    assert failed.status == ScheduleRunStatus.FAILED and failed.error_message == "DISPATCH_FAILED"


async def test_broker_failure_on_follow_up_keeps_the_request(db_session, monkeypatch):
    from services.run_dispatch import _set_follow_up, dispatch_follow_up_if_requested

    _broker_down(monkeypatch)
    await _world(db_session)
    await _set_follow_up(db_session, "check_in")
    await db_session.flush()
    assert await dispatch_follow_up_if_requested(db_session) is None
    assert await _follow_up_pending(db_session) is True
    (failed,) = (
        await db_session.execute(
            select(ScheduleRun).where(ScheduleRun.trigger_reason == "follow_up")
        )
    ).scalars().all()
    assert failed.status == ScheduleRunStatus.FAILED and failed.error_message == "DISPATCH_FAILED"


# --- M4: the board lists schedulable projects only ----------------------------------------


async def test_priority_board_lists_only_schedulable_projects(db_session):
    w = await _world(db_session, baseline=False)
    for status in (
        ProjectStatus.COMMERCIALIZED, ProjectStatus.ON_HOLD,
        ProjectStatus.CANCELLED, ProjectStatus.DRAFT,
    ):
        await make_project(
            db_session, w.hub, leader=w.leader, name=f"Off board {status.value}",
            category=ProjectCategory.C, priority=ProjectPriority.P1, status=status,
        )
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        board = (await client.get("/priority-board")).json()
        held = (await client.get("/priority-board", params={"status_": "On Hold"})).json()

    names = {c["name"] for col in board["columns"] for c in col["cards"]}
    assert names == {p.name for p in w.projects}
    p1 = next(col for col in board["columns"] if col["priority"] == "P1")
    assert p1["count"] == 1  # totals follow the filtered set
    assert all(col["cards"] == [] and col["count"] == 0 for col in held["columns"])


# --- S1: a freeze marks the project stale ---------------------------------------------------


async def test_freeze_and_unfreeze_mark_the_project_stale(db_session):
    w = await _world(db_session)
    target = w.projects[0]
    assert target.schedule_stale is False  # cleared by the baseline activation
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        frozen = await client.post(
            f"/gantt/projects/{target.id}/freeze",
            json={"frozen": True, "actual_start_week": 30},
        )
        assert frozen.status_code == 200, frozen.text
        assert frozen.json()["schedule_stale"] is True
        target.schedule_stale = False
        await db_session.flush()
        unfrozen = await client.post(
            f"/gantt/projects/{target.id}/freeze", json={"frozen": False}
        )
    assert unfrozen.status_code == 200 and unfrozen.json()["schedule_stale"] is True
    (audit,) = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "project.freeze",
                AuditLogEntry.entity_id == str(target.id),
            )
        )
    ).scalars().all()
    assert audit.after_state.get("schedule_stale", True) is True
