"""P61-B (ADR 0069): manual recalculation mode.

- `defer_recalc: true` on every auto-recalculating write: saved, audited and
  `schedule_stale` set as usual, NO run dispatched (no ADR 0023 follow-up
  either), `recalc_status: "deferred"`. Default false: unchanged.
- `GET /schedule-runs/freshness`: stale schedulable count, active run,
  in-flight flag; any signed-in user.
- `POST /schedule-runs/recalculate`: Admin / Super Admin, 202, ONE greedy
  run (coalesced into the follow-up when a run is in flight); activating it
  clears `schedule_stale`.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import func, select

import api.routers.checkins as checkins_router
import api.routers.gantt as gantt_router
import api.routers.projects as projects_router
import services.priority_move as priority_move
import services.priority_preview as priority_preview
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp
from models.enums import ProjectPriority, ProjectStatus, RoleName, ScheduleRunStatus, SolverType
from models.project import Project
from models.schedule import ScheduleRun
from scheduling.greedy import run_greedy_sgs
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_schedule_run
from tests.p12_helpers import act_as, client_for
from tests.test_p12_checkins import _entry as _checkin_entry
from tests.test_p12_checkins import _world as _checkin_world
from tests.test_p36_band_rank_api import _body as _rank_body
from tests.test_p36_band_rank_api import _world as _band_world
from tests.test_p40_step_pins_api import _item as _pin_item
from tests.test_p40_step_pins_api import _world as _pin_world
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    monkeypatch.setattr(priority_preview, "publish_progress", lambda *a, **k: None)
    for limiter in (
        projects_router.PRIORITY_PREVIEW_RATE_LIMIT,
        projects_router.PRIORITY_CONFIRM_RATE_LIMIT,
        projects_router.REGISTER_EDITS_RATE_LIMIT,
        checkins_router.CHECKIN_RATE_LIMIT,
        gantt_router.STEP_PINS_RATE_LIMIT,
    ):
        limiter.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    monkeypatch.setattr(checkins_router, "publish_progress", lambda *a, **k: None)
    return calls


async def _runs(db_session) -> int:
    return (await db_session.execute(select(func.count(ScheduleRun.id)))).scalar_one()


async def _fresh(db_session, project_id: uuid.UUID) -> Project:
    return (
        await db_session.execute(
            select(Project).where(Project.id == project_id).execution_options(
                populate_existing=True
            )
        )
    ).scalar_one()


async def _audit_count(db_session, action: str) -> int:
    return (
        await db_session.execute(
            select(func.count()).select_from(AuditLogEntry).where(AuditLogEntry.action == action)
        )
    ).scalar_one()


async def _follow_up_pending(db_session) -> bool:
    row = await db_session.get(ScheduleRunFollowUp, 1, populate_existing=True)
    return bool(row is not None and row.pending)


# --- defer_recalc on each write path -----------------------------------------------------


@pytest.mark.parametrize("defer", [True, False])
async def test_priority_post(db_session, dispatch, defer):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    project = w.p2[0]
    runs = await _runs(db_session)
    body = {"priority": "P1", **({"defer_recalc": True} if defer else {})}
    async with client_for(db_session) as client:
        resp = await client.post(f"/projects/{project.id}/priority", json=body)
    assert resp.status_code == 200, resp.text
    fresh = await _fresh(db_session, project.id)
    assert fresh.priority == ProjectPriority.P1 and fresh.schedule_stale is True
    assert await _audit_count(db_session, "project.priority_move") == 1
    if defer:
        assert resp.json()["recalc_status"] == "deferred"
        assert dispatch == [] and await _runs(db_session) == runs
        assert resp.json()["schedule_run_id"] is None
    else:
        assert resp.json()["recalc_status"] == "queued" and len(dispatch) == 1


async def test_priority_post_deferred_registers_no_follow_up_while_a_run_is_in_flight(
    db_session, dispatch
):
    w = await _band_world(db_session)
    await make_schedule_run(
        db_session, status=ScheduleRunStatus.RUNNING, version=9001
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/projects/{w.p2[0].id}/priority", json={"priority": "P1", "defer_recalc": True}
        )
    assert resp.json()["recalc_status"] == "deferred"
    assert await _follow_up_pending(db_session) is False


async def test_priority_post_non_schedulable_stays_not_needed(db_session, dispatch):
    w = await _band_world(db_session)
    held = await w.project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/projects/{held.id}/priority", json={"priority": "P1", "defer_recalc": True}
        )
    assert resp.json()["recalc_status"] == "not_needed" and dispatch == []


async def test_patch_priority_deferred(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    project = w.p2[1]
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}", json={"priority": "P1", "defer_recalc": True}
        )
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Recalc"] == "deferred"
    assert dispatch == [] and await _runs(db_session) == runs
    fresh = await _fresh(db_session, project.id)
    assert fresh.priority == ProjectPriority.P1 and fresh.schedule_stale is True


async def test_patch_defer_recalc_alone_is_not_a_field_update(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{w.p2[1].id}", json={"defer_recalc": True})
    assert resp.status_code == 200, resp.text
    # The flag is a request option, never a field: the (pre-existing) empty
    # PATCH audit row does not carry it.
    rows = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project.update")
        )
    ).scalars().all()
    assert all("defer_recalc" not in (r.after_state or {}) for r in rows)
    assert dispatch == []


async def test_patch_priority_default_still_queues(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{w.p2[1].id}", json={"priority": "P1"})
    assert resp.headers["X-Schedule-Recalc"] == "queued" and len(dispatch) == 1


async def test_register_edits_deferred(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={
                "edits": [{"project_id": str(w.p2[2].id), "priority": "P1"}],
                "defer_recalc": True,
            },
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["recalc_status"] == "deferred"
    assert body["projects_marked_stale"] == [str(w.p2[2].id)]
    assert body["schedule_run_id"] is None
    assert dispatch == [] and await _runs(db_session) == runs
    assert (await _fresh(db_session, w.p2[2].id)).schedule_stale is True
    assert await _audit_count(db_session, "project.priority_move") == 1


async def test_register_edits_default_still_queues(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(w.p2[2].id), "priority": "P1"}]},
        )
    assert resp.json()["recalc_status"] == "queued" and len(dispatch) == 1


async def test_band_rank_confirm_deferred_applies_no_run(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    moved, anchor = w.p2[3], w.p2[1]
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        preview = await client.post(
            f"/projects/{moved.id}/band-rank/preview",
            json=_rank_body(before=anchor.id, defer_recalc=True),
        )
        assert preview.status_code == 200, preview.text
        resp = await client.post(
            f"/projects/{moved.id}/band-rank",
            json=_rank_body(
                before=anchor.id, preview_token=preview.json()["preview_token"],
                defer_recalc=True,
            ),
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "deferred"
    assert resp.json()["band_rank"] == 2
    assert dispatch == [] and await _runs(db_session) == runs
    fresh = await _fresh(db_session, moved.id)
    assert fresh.band_rank == 2 and fresh.schedule_stale is True
    (audit,) = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project.band_rank_move")
        )
    ).scalars().all()
    assert audit.after_state["recalc_status"] == "deferred"
    assert await _follow_up_pending(db_session) is False


async def test_priority_confirm_deferred_applies_no_run(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    project = w.p2[4]
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        preview = await client.post(
            f"/projects/{project.id}/priority/preview",
            json={"priority": "P1", "defer_recalc": True},
        )
        assert preview.status_code == 200, preview.text
        resp = await client.post(
            f"/projects/{project.id}/priority",
            json={
                "priority": "P1", "preview_token": preview.json()["preview_token"],
                "defer_recalc": True,
            },
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "deferred"
    assert dispatch == [] and await _runs(db_session) == runs
    fresh = await _fresh(db_session, project.id)
    assert fresh.priority == ProjectPriority.P1 and fresh.schedule_stale is True


async def test_step_pins_deferred(db_session, dispatch):
    w = await _pin_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.put(
            "/gantt/step-pins", json={"items": [_pin_item(w.a)], "defer_recalc": True}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "deferred"
    assert resp.json()["projects_marked_stale"] == [str(w.a.id)]
    assert dispatch == [] and await _runs(db_session) == runs
    assert (await _fresh(db_session, w.a.id)).schedule_stale is True


async def test_check_ins_deferred(db_session, dispatch):
    w = await _checkin_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/check-ins", json={"entries": [_checkin_entry(w.led)], "defer_recalc": True}
        )
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "deferred"
    assert dispatch == [] and await _runs(db_session) == runs
    assert (await _fresh(db_session, w.led.id)).schedule_stale is True
    assert await _follow_up_pending(db_session) is False


async def test_stage_patch_accepts_defer_recalc(db_session, dispatch):
    w = await _pin_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.a.id}/stages/PDD-E",
            json={"status": "In Progress", "actual_start_week": 30, "defer_recalc": True},
        )
    assert resp.status_code == 200, resp.text
    assert dispatch == []
    assert (await _fresh(db_session, w.a.id)).schedule_stale is True


async def test_defer_recalc_is_strict_bool(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            f"/projects/{w.p2[0].id}/priority", json={"priority": "P1", "defer_recalc": "yes"}
        )
    assert resp.status_code == 422


# --- freshness ---------------------------------------------------------------------------


async def test_freshness_counts_stale_schedulable_only(db_session):
    w = await _band_world(db_session)
    w.p2[0].schedule_stale = True
    w.p2[1].schedule_stale = True
    held = await w.project("Held", ProjectPriority.P2, status=ProjectStatus.ON_HOLD)
    held.schedule_stale = True
    await db_session.flush()
    await act_as(db_session, RoleName.ENGINEER)
    async with client_for(db_session) as client:
        resp = await client.get("/schedule-runs/freshness")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["stale_project_count"] == 2
    assert body["last_run_version"] == w.run.version
    assert body["last_run_at"] is not None
    assert body["run_in_flight"] is False
    assert body["oldest_stale_since"] is None


async def test_freshness_without_a_run_and_with_one_in_flight(db_session):
    await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[])
    async with client_for(db_session) as client:
        body = (await client.get("/schedule-runs/freshness")).json()
    assert body["stale_project_count"] == 0
    assert (body["last_run_at"], body["last_run_version"]) == (None, None)
    assert body["run_in_flight"] is True


# --- recalculate now ---------------------------------------------------------------------


async def test_recalculate_dispatches_one_run_that_clears_stale(db_session, dispatch):
    w = await _band_world(db_session)
    user = await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        await client.post(
            f"/projects/{w.p2[0].id}/priority", json={"priority": "P1", "defer_recalc": True}
        )
        await client.post(
            f"/projects/{w.p2[1].id}/priority", json={"priority": "P1", "defer_recalc": True}
        )
        assert (await client.get("/schedule-runs/freshness")).json()[
            "stale_project_count"
        ] == 2
        assert dispatch == []
        resp = await client.post("/schedule-runs/recalculate")
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["recalc_status"] == "queued"
    assert body["stale_project_count"] == 2
    assert body["baseline_run_id"] == str(w.run.id)
    assert body["in_flight_run_id"] is None
    assert len(dispatch) == 1
    args, kwargs = dispatch[0]
    assert args == (body["schedule_run_id"],) and kwargs["activate"] is True
    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run is not None
    assert (run.solver_type, run.status, run.trigger_reason, run.triggered_by_user_id) == (
        SolverType.GREEDY, ScheduleRunStatus.QUEUED, "manual_recalc", user.id,
    )
    (audit,) = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "schedule_run.recalculate_requested"
            )
        )
    ).scalars().all()
    assert audit.after_state["recalc_status"] == "queued"
    assert audit.after_state["stale_project_count"] == 2

    # The worker's completion (as `_run_schedule_body`, activate=True).
    schedule_input = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    await persist_schedule_output(
        db_session, schedule_input, run_greedy_sgs(schedule_input),
        solver_type=SolverType.GREEDY, trigger_reason="manual_recalc",
        activate=True, existing_run=run,
    )
    await db_session.flush()
    async with client_for(db_session) as client:
        after = (await client.get("/schedule-runs/freshness")).json()
    assert after["stale_project_count"] == 0
    assert after["last_run_version"] == run.version


async def test_recalculate_coalesces_with_a_run_in_flight(db_session, dispatch):
    await _band_world(db_session)
    in_flight = await make_schedule_run(
        db_session, status=ScheduleRunStatus.RUNNING, version=9001
    )
    await act_as(db_session, RoleName.SUPER_ADMIN)
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.post("/schedule-runs/recalculate")
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["recalc_status"] == "deferred"
    assert body["schedule_run_id"] is None
    assert body["in_flight_run_id"] == str(in_flight.id)
    assert dispatch == [] and await _runs(db_session) == runs
    assert await _follow_up_pending(db_session) is True


@pytest.mark.parametrize(
    "role", [RoleName.HUB_PLANNER, RoleName.PORTFOLIO_MANAGER, RoleName.ENGINEER]
)
async def test_recalculate_is_admin_only(db_session, dispatch, role):
    await act_as(db_session, role)
    async with client_for(db_session) as client:
        resp = await client.post("/schedule-runs/recalculate")
    assert resp.status_code == 403
    assert dispatch == []


async def test_vip_pin_deferred(db_session, dispatch):
    w = await _band_world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    runs = await _runs(db_session)
    async with client_for(db_session) as client:
        resp = await client.put(
            f"/projects/{w.p2[0].id}/vip", json={"is_vip": True, "defer_recalc": True}
        )
    assert resp.status_code == 200, resp.text
    assert resp.headers["X-Schedule-Recalc"] == "deferred"
    assert dispatch == [] and await _runs(db_session) == runs
    fresh = await _fresh(db_session, w.p2[0].id)
    assert fresh.is_vip is True and fresh.schedule_stale is True
