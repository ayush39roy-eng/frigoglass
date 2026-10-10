"""P12-T03: weekly check-in API (docs/API_CONTRACT_P12.md §5; ADR 0021,
ADR 0023 §1).

Covers: who may check in (Engineer own/led stages only; another engineer's
stage, an out-of-hub stage, a Viewer grant ⇒ `FORBIDDEN_STAGE`; Editor
grant, Hub Planner own hub), batch atomicity, server-filled actual weeks,
Done immutable, every per-entry code, the recalc lifecycle (queued /
deferred + follow-up flag / not_needed), the due list per role, history,
rate limiting, and DB-level immutability of `stage_checkins`.
`run_greedy_schedule.delay` and `publish_progress` are patched.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.exc import DBAPIError

import api.routers.checkins as checkins_router
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp, StageCheckin
from models.enums import (
    HubName,
    LabRegion,
    ProjectAccessRole,
    RoleName,
    ScheduleRunStatus,
    WorkflowStepStatus,
)
from models.project_access import ProjectAccessGrant
from models.schedule import ScheduleRun
from services.rate_limit import TokenBucketLimiter
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run, make_user
from tests.p12_helpers import (
    CW,
    act_as,
    add_checkin,
    client_for,
    link_engineer,
    live_step,
    plan_step,
    set_progress,
    stepped_project,
)
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    checkins_router.CHECKIN_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    checkins_router.CHECKIN_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []
    published: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(
        checkins_router, "publish_progress", lambda *a, **k: published.append((a, k))
    )
    return SimpleNamespace(calls=calls, published=published)


async def _world(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    eng_a = await make_engineer(db_session, gr, name="Engineer A")
    eng_b = await make_engineer(db_session, gr, name="Engineer B")
    run = await make_schedule_run(db_session, is_active=True)

    led = await stepped_project(db_session, gr, name="Led by A", leader=eng_a)
    await plan_step(db_session, run, led, "PDD-E", 28, 34)
    await plan_step(db_session, run, led, "PDD-F", 31, 34)

    shared = await stepped_project(db_session, gr, name="Shared", leader=eng_b)
    await plan_step(db_session, run, shared, "PDD-E", 28, 34, engineer=eng_a)
    await plan_step(db_session, run, shared, "PDD-F", 31, 34, engineer=eng_b)

    far = await stepped_project(db_session, india, name="India project")
    await plan_step(db_session, run, far, "PDD-E", 28, 34)
    return SimpleNamespace(
        gr=gr, india=india, eng_a=eng_a, eng_b=eng_b, run=run, led=led, shared=shared, far=far
    )


async def _as_engineer_a(db_session, w):
    user = await act_as(db_session, RoleName.ENGINEER)
    await link_engineer(db_session, w.eng_a, user)
    return user


def _entry(project, step_id="PDD-E", status="In Progress", percent=40, **extra):
    return {
        "project_id": str(project.id),
        "step_id": step_id,
        "status": status,
        "percent_complete": percent,
        **extra,
    }


def _codes(response) -> list[tuple[int, str]]:
    body = response.json()
    assert body["code"] == "CHECKIN_INVALID"
    assert body["detail"]["code"] == "CHECKIN_INVALID"
    return [(e["index"], e["code"]) for e in body["detail"]["errors"]]


async def _checkin_count(db_session) -> int:
    return (await db_session.execute(select(func.count()).select_from(StageCheckin))).scalar_one()


# --- Engineer write scope -------------------------------------------------------------


async def test_engineer_checks_in_led_and_assigned_stages(db_session, dispatch):
    w = await _world(db_session)
    user = await _as_engineer_a(db_session, w)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={
                "entries": [
                    _entry(w.led, "PDD-E", percent=40, note="  Going well  "),
                    _entry(w.led, "PDD-F", percent=10),
                    _entry(w.shared, "PDD-E", percent=20),
                ]
            },
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["week"] == CW
    assert body["accepted"] == 3
    assert set(body["projects_marked_stale"]) == {str(w.led.id), str(w.shared.id)}
    assert body["recalc_status"] == "queued"

    row = await live_step(db_session, w.led, "PDD-E")
    assert (row.status, row.percent_complete, row.actual_start_week) == (
        WorkflowStepStatus.IN_PROGRESS, 40, CW,
    )
    checkins = (
        await db_session.execute(
            select(StageCheckin).where(StageCheckin.project_id == w.led.id)
        )
    ).scalars().all()
    assert {(c.step_template_id, c.week, c.user_id) for c in checkins} == {
        ("PDD-E", CW, user.id), ("PDD-F", CW, user.id),
    }
    assert {c.note for c in checkins} == {"Going well", None}
    await db_session.refresh(w.led)
    assert w.led.schedule_stale is True

    audits = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project.check_in")
        )
    ).scalars().all()
    assert {a.entity_id for a in audits} == {str(w.led.id), str(w.shared.id)}
    led_audit = next(a for a in audits if a.entity_id == str(w.led.id))
    assert led_audit.after_state["week"] == CW
    assert len(led_audit.after_state["stages"]) == 2
    # Free text is never audited, only its length.
    assert "Going well" not in str(led_audit.after_state)
    assert {s["note_length"] for s in led_audit.after_state["stages"]} == {10, 0}


async def test_engineer_forbidden_on_other_stages(db_session, dispatch):
    w = await _world(db_session)
    await _as_engineer_a(db_session, w)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={
                "entries": [
                    _entry(w.shared, "PDD-F"),  # assigned to engineer B
                    _entry(w.far, "PDD-E"),  # another hub, not theirs
                    {**_entry(w.far, "PDD-E"), "project_id": str(uuid.UUID(int=1))},
                    _entry(w.led, "PDD-Z"),  # their project, unknown stage
                ]
            },
        )
    assert r.status_code == 422
    assert _codes(r) == [
        (0, "FORBIDDEN_STAGE"), (1, "FORBIDDEN_STAGE"), (2, "FORBIDDEN_STAGE"), (3, "NOT_DUE"),
    ]
    assert await _checkin_count(db_session) == 0
    assert dispatch.calls == []


async def test_engineer_without_linked_engineer_row_is_forbidden(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ENGINEER)  # no Engineer.user_id link
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json={"entries": [_entry(w.led)]})
        due = await client.get("/check-ins/due")
    assert _codes(r) == [(0, "FORBIDDEN_STAGE")]
    assert due.status_code == 200
    assert due.json()["projects"] == []


async def test_engineer_has_no_general_workspace_write(db_session):
    w = await _world(db_session)
    await _as_engineer_a(db_session, w)
    async with client_for(db_session) as client:
        r = await client.patch(
            f"/projects/{w.led.id}/stages/PDD-E",
            json={"status": "In Progress", "percent_complete": 10, "actual_start_week": 31},
        )
    assert r.status_code == 403


# --- Grants and planners --------------------------------------------------------------


@pytest.mark.parametrize(
    ("grant", "allowed"),
    [(ProjectAccessRole.VIEWER, False), (ProjectAccessRole.EDITOR, True),
     (ProjectAccessRole.ADMIN, True)],
)
async def test_project_grant_write_scope(db_session, dispatch, grant, allowed):
    w = await _world(db_session)
    granter = await make_user(db_session, RoleName.ADMIN)
    user = await act_as(db_session, RoleName.EXECUTIVE_VIEWER, hub_ids=[w.gr.id],
                        hub_scope_all=False)
    db_session.add(
        ProjectAccessGrant(
            project_id=w.far.id, user_id=user.id, project_role=grant,
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json={"entries": [_entry(w.far)]})
    if allowed:
        assert r.status_code == 200, r.text
    else:
        assert _codes(r) == [(0, "FORBIDDEN_STAGE")]


async def test_hub_planner_own_hub_only(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    async with client_for(db_session) as client:
        ok = await client.post("/check-ins", json={"entries": [_entry(w.shared, "PDD-F")]})
        bad = await client.post("/check-ins", json={"entries": [_entry(w.far)]})
    assert ok.status_code == 200, ok.text
    assert _codes(bad) == [(0, "FORBIDDEN_STAGE")]


@pytest.mark.parametrize("role", [RoleName.EXECUTIVE_VIEWER, RoleName.AUDITOR])
async def test_read_only_roles_cannot_check_in(db_session, dispatch, role):
    w = await _world(db_session)
    await act_as(db_session, role)
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json={"entries": [_entry(w.led)]})
    assert _codes(r) == [(0, "FORBIDDEN_STAGE")]
    assert await _checkin_count(db_session) == 0


# --- Validation, atomicity, server-filled weeks ---------------------------------------


async def test_batch_is_atomic(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    before = await live_step(db_session, w.led, "PDD-E")
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={"entries": [_entry(w.led, percent=50), _entry(w.led, "PDD-A")]},
        )
    assert _codes(r) == [(1, "NOT_DUE")]
    await db_session.refresh(before)
    assert (before.status, before.percent_complete) == (WorkflowStepStatus.NOT_STARTED, 0)
    assert await _checkin_count(db_session) == 0
    await db_session.refresh(w.led)
    assert w.led.schedule_stale is False
    audits = (
        await db_session.execute(
            select(func.count()).select_from(AuditLogEntry).where(
                AuditLogEntry.action == "project.check_in"
            )
        )
    ).scalar_one()
    assert audits == 0


async def test_server_fills_weeks_and_done_percent(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await set_progress(db_session, w.led, "PDD-F", WorkflowStepStatus.IN_PROGRESS, percent=60,
                       start=29)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={
                "entries": [
                    _entry(w.led, "PDD-E", status="Done", percent=70),
                    _entry(w.led, "PDD-F", status="Done", percent=100),
                ]
            },
        )
    assert r.status_code == 200, r.text
    e = await live_step(db_session, w.led, "PDD-E")
    f = await live_step(db_session, w.led, "PDD-F")
    assert (e.status, e.percent_complete, e.actual_start_week, e.actual_end_week) == (
        WorkflowStepStatus.DONE, 100, CW, CW,
    )
    # An existing actual start is kept.
    assert (f.actual_start_week, f.actual_end_week) == (29, CW)
    stored = (
        await db_session.execute(
            select(StageCheckin.percent_complete).where(StageCheckin.step_template_id == "PDD-E")
        )
    ).scalar_one()
    assert stored == 100


async def test_done_stage_is_immutable(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await set_progress(db_session, w.led, "PDD-E", WorkflowStepStatus.DONE, percent=100,
                       start=28, end=30)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins", json={"entries": [_entry(w.led, "PDD-E", status="In Progress")]}
        )
    assert _codes(r) == [(0, "STEP_DONE_IMMUTABLE")]


async def test_per_entry_codes(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    w.far.frozen = True
    w.far.actual_start_week = 20
    await db_session.flush()
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={
                "entries": [
                    _entry(w.led, "PDD-E", status="Blocked", percent=10),
                    _entry(w.led, "PDD-F", status="Not Started", percent=10),
                    _entry(w.far, "PDD-E"),
                    _entry(w.shared, "PDD-E"),
                    _entry(w.shared, "PDD-E"),
                    _entry(w.shared, "PDD-F", status="In Progress", percent=5,
                           blocked_reason="not on hold"),
                ]
            },
        )
    assert _codes(r) == [
        (0, "INCONSISTENT_PROGRESS"),
        (1, "INCONSISTENT_PROGRESS"),
        (2, "PROJECT_FROZEN"),
        (4, "DUPLICATE_STAGE"),
        (5, "INCONSISTENT_PROGRESS"),
    ]
    messages = {e["index"]: e["message"] for e in r.json()["detail"]["errors"]}
    assert "On Hold" in messages[0]


async def test_blocked_with_reason_and_blank_reason_normalised(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={
                "entries": [
                    _entry(w.led, "PDD-E", status="Blocked", percent=10,
                           blocked_reason="  Waiting for parts "),
                    _entry(w.led, "PDD-F", status="In Progress", percent=5, blocked_reason="  "),
                ]
            },
        )
    assert r.status_code == 200, r.text
    e = await live_step(db_session, w.led, "PDD-E")
    assert (e.status, e.blocked_reason) == (WorkflowStepStatus.BLOCKED, "Waiting for parts")


@pytest.mark.parametrize(
    "body",
    [
        {"entries": []},
        {"entries": [{"project_id": "x", "step_id": "PDD-E", "status": "Done",
                      "percent_complete": 100}]},
        {"entries": [{"project_id": "00000000-0000-0000-0000-000000000001", "step_id": "PDD-E",
                      "status": "Finished", "percent_complete": 100}]},
        {"entries": [{"project_id": "00000000-0000-0000-0000-000000000001", "step_id": "PDD-E",
                      "status": "Done", "percent_complete": 101}]},
        {"entries": [{"project_id": "00000000-0000-0000-0000-000000000001", "step_id": "PDD-E",
                      "status": "Done", "percent_complete": "100"}]},
        {"entries": [{"project_id": "00000000-0000-0000-0000-000000000001", "step_id": "PDD-E",
                      "status": "Done", "percent_complete": 100, "note": "x" * 1001}]},
        {"entries": [{"project_id": "00000000-0000-0000-0000-000000000001", "step_id": "PDD-E",
                      "status": "Done", "percent_complete": 100, "extra": 1}]},
        {"entries": [], "extra": 1},
    ],
)
async def test_request_validation(db_session, dispatch, body):
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json=body)
    assert r.status_code == 422


async def test_batch_size_limit(db_session, dispatch):
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    entry = {"project_id": "00000000-0000-0000-0000-000000000001", "step_id": "PDD-E",
             "status": "Done", "percent_complete": 100}
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json={"entries": [entry] * 101})
    assert r.status_code == 422


# --- Recalc lifecycle (ADR 0023 §1) ---------------------------------------------------


async def test_queued_dispatches_one_greedy_run(db_session, dispatch):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        r = await client.post(
            "/check-ins",
            json={"entries": [_entry(w.led), _entry(w.shared), _entry(w.shared, "PDD-F")]},
        )
    body = r.json()
    assert body["recalc_status"] == "queued"
    assert body["baseline_run_id"] == str(w.run.id)
    assert body["task_id"] == "celery-task-1"
    assert len(dispatch.calls) == 1
    args, kwargs = dispatch.calls[0]
    assert args == (body["schedule_run_id"],)
    assert kwargs["activate"] is True
    assert kwargs["recalc_project_id"] is None  # two projects changed
    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run is not None
    assert (run.trigger_reason, run.status, run.triggered_by_user_id) == (
        "check_in", ScheduleRunStatus.QUEUED, user.id,
    )
    assert dispatch.published == [((body["schedule_run_id"],), {"status": "queued"})]
    requested = (
        await db_session.execute(
            select(func.count()).select_from(AuditLogEntry).where(
                AuditLogEntry.action == "project.recalculate_requested"
            )
        )
    ).scalar_one()
    assert requested == 2


async def test_single_project_batch_names_it_for_the_activity_event(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with client_for(db_session) as client:
        await client.post("/check-ins", json={"entries": [_entry(w.led)]})
    assert dispatch.calls[0][1]["recalc_project_id"] == str(w.led.id)


async def test_deferred_registers_follow_up(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json={"entries": [_entry(w.led)]})
    body = r.json()
    assert body["recalc_status"] == "deferred"
    assert (body["schedule_run_id"], body["baseline_run_id"], body["task_id"]) == (
        None, None, None,
    )
    assert dispatch.calls == []
    flag = await db_session.get(ScheduleRunFollowUp, 1, populate_existing=True)
    assert flag is not None and flag.pending is True
    assert flag.last_trigger_reason == "check_in"
    assert flag.request_count == 1
    await db_session.refresh(w.led)
    assert w.led.schedule_stale is True


async def test_unchanged_report_still_recorded_not_needed(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await set_progress(db_session, w.led, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=40,
                       start=29)
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    async with client_for(db_session) as client:
        r = await client.post("/check-ins", json={"entries": [_entry(w.led, percent=40)]})
    body = r.json()
    assert (body["accepted"], body["projects_marked_stale"], body["recalc_status"]) == (
        1, [], "not_needed",
    )
    assert await _checkin_count(db_session) == 1
    await db_session.refresh(w.led)
    assert w.led.schedule_stale is False
    # not_needed never touches the follow-up flag.
    flag = await db_session.get(ScheduleRunFollowUp, 1, populate_existing=True)
    assert flag is not None and flag.pending is False


async def test_rate_limited(db_session, dispatch, monkeypatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    monkeypatch.setattr(
        checkins_router,
        "CHECKIN_RATE_LIMIT",
        TokenBucketLimiter(capacity=1, refill_per_second=0.01),
    )
    async with client_for(db_session) as client:
        first = await client.post("/check-ins", json={"entries": [_entry(w.led)]})
        second = await client.post("/check-ins", json={"entries": [_entry(w.led)]})
    assert first.status_code == 200
    assert second.status_code == 429
    assert second.json()["code"] == "RATE_LIMITED"
    assert int(second.headers["Retry-After"]) >= 1


# --- GET /check-ins/due ---------------------------------------------------------------


async def test_due_list_for_engineer_shows_own_stages_only(db_session):
    w = await _world(db_session)
    await _as_engineer_a(db_session, w)
    async with client_for(db_session) as client:
        r = await client.get("/check-ins/due")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["week"] == CW
    by_name = {p["name"]: p for p in body["projects"]}
    assert set(by_name) == {"Led by A", "Shared"}
    assert [s["step_id"] for s in by_name["Led by A"]["stages"]] == ["PDD-E", "PDD-F"]
    assert [s["step_id"] for s in by_name["Shared"]["stages"]] == ["PDD-E"]
    assert all(s["can_check_in"] for p in body["projects"] for s in p["stages"])
    stage = by_name["Led by A"]["stages"][0]
    assert (stage["planned_start_week"], stage["planned_end_week"], stage["plan_percent"]) == (
        28, 34, 57,
    )
    assert stage["step_name"] == "Design Detailing"
    assert stage["kind"] == "design"
    assert body["summary"]["due_stages"] == 3


async def test_due_list_summary_and_order(db_session):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await add_checkin(db_session, w.led, "PDD-E", CW, user)
    await add_checkin(db_session, w.led, "PDD-F", CW, user)
    await add_checkin(db_session, w.shared, "PDD-E", CW - 4, user)
    await add_checkin(db_session, w.far, "PDD-E", CW - 1, user)
    w.far.schedule_stale = True
    await db_session.flush()
    async with client_for(db_session) as client:
        r = await client.get("/check-ins/due")
    body = r.json()
    assert [(p["name"], p["tracking_status"]) for p in body["projects"]] == [
        ("Shared", "overdue"), ("India project", "due"), ("Led by A", "live"),
    ]
    assert body["summary"] == {
        "due_stages": 5, "checked_in_stages": 2, "projects_live": 1, "projects_due": 1,
        "projects_overdue": 1, "stale_projects": 1,
    }
    led = next(p for p in body["projects"] if p["name"] == "Led by A")
    assert all(s["checked_in_this_week"] and s["last_checkin_week"] == CW for s in led["stages"])


async def test_due_list_hub_filter_never_widens(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    async with client_for(db_session) as client:
        own = await client.get("/check-ins/due")
        other = await client.get("/check-ins/due", params={"hub_id": str(w.india.id)})
    assert {p["name"] for p in own.json()["projects"]} == {"Led by A", "Shared"}
    assert other.status_code == 200
    assert other.json()["projects"] == []
    assert other.json()["summary"]["due_stages"] == 0


async def test_due_list_executive_viewer_read_only(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with client_for(db_session) as client:
        r = await client.get("/check-ins/due", params={"hub_id": str(w.gr.id)})
    projects = r.json()["projects"]
    assert {p["name"] for p in projects} == {"Led by A", "Shared"}
    assert not any(s["can_check_in"] for p in projects for s in p["stages"])


async def test_due_list_auditor_forbidden(db_session):
    await _world(db_session)
    await act_as(db_session, RoleName.AUDITOR)
    async with client_for(db_session) as client:
        r = await client.get("/check-ins/due")
    assert r.status_code == 403


async def test_due_list_editor_grant_adds_project(db_session):
    w = await _world(db_session)
    granter = await make_user(db_session, RoleName.ADMIN)
    user = await act_as(db_session, RoleName.AUDITOR)
    db_session.add(
        ProjectAccessGrant(
            project_id=w.far.id, user_id=user.id, project_role=ProjectAccessRole.EDITOR,
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()
    async with client_for(db_session) as client:
        r = await client.get("/check-ins/due")
    assert r.status_code == 200
    listed = [(p["name"], [s["can_check_in"] for s in p["stages"]]) for p in r.json()["projects"]]
    assert listed == [("India project", [True])]


# --- History --------------------------------------------------------------------------


async def test_history_newest_first_with_name(db_session):
    w = await _world(db_session)
    author = await make_user(db_session, RoleName.HUB_PLANNER, full_name="Maria Planner")
    for week in (28, 29, 30):
        await add_checkin(db_session, w.led, "PDD-E", week, author, percent=week, note=f"w{week}")
    await add_checkin(db_session, w.led, "PDD-F", 30, author)
    await act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.gr.id])
    async with client_for(db_session) as client:
        r = await client.get(
            "/check-ins/history", params={"project_id": str(w.led.id), "step_id": "PDD-E"}
        )
        hidden = await client.get(
            "/check-ins/history", params={"project_id": str(w.far.id), "step_id": "PDD-E"}
        )
    assert r.status_code == 200, r.text
    rows = r.json()
    assert [row["week"] for row in rows] == [30, 29, 28]
    assert rows[0]["by"] == "Maria Planner"
    assert rows[0]["note"] == "w30"
    assert hidden.status_code == 404


async def test_history_auditor_forbidden(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.AUDITOR)
    async with client_for(db_session) as client:
        r = await client.get(
            "/check-ins/history", params={"project_id": str(w.led.id), "step_id": "PDD-E"}
        )
    assert r.status_code == 403


# --- Append-only at the DB level ------------------------------------------------------


@pytest.mark.parametrize("operation", ["update", "delete", "truncate"])
async def test_stage_checkins_are_append_only(db_session, operation):
    w = await _world(db_session)
    user = await make_user(db_session, RoleName.HUB_PLANNER)
    row = await add_checkin(db_session, w.led, "PDD-E", CW, user)
    statement = {
        "update": update(StageCheckin).where(StageCheckin.id == row.id).values(percent_complete=99),
        "delete": delete(StageCheckin).where(StageCheckin.id == row.id),
        "truncate": text("TRUNCATE stage_checkins"),
    }[operation]
    with pytest.raises(DBAPIError, match="append-only"):
        async with db_session.begin_nested():
            await db_session.execute(statement)
