"""P40-F01: security follow-ups from the P40 gate (docs/API_CONTRACT_P40.md §1).

- S40-M1: `PUT /gantt/step-pins` is rate-limited per user (429
  `RATE_LIMITED` with `Retry-After`), after the role check, before any lock
  or write.
- S40-L1: the save locks only the project rows in the caller's hub scope;
  an out-of-scope id is not locked and still reads as the same 404
  `PROJECT_NOT_FOUND` as a nonexistent one.
- S40-I1: the (unreachable today) delete branch of `sync_project_steps`
  writes the `project.step_pin_cleared` audit row before deleting a pinned
  row.

Row locks are observed with `pgrowlocks` (mode `For Update`, as opposed to
the `For Key Share` the fixtures' FK checks take). The probe is checked
against `lock_projects` first.
`run_greedy_schedule.delay` and `publish_progress` are patched.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from sqlalchemy import select, text

import api.routers.gantt as gantt_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, RoleName
from models.workflow import ProjectWorkflowStep
from services.project_steps import sync_project_steps
from services.template_apply import lock_projects
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_hub
from tests.p12_helpers import act_as, client_for, live_step, stepped_project
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture(autouse=True)
def _cleanup():
    gantt_router.STEP_PINS_RATE_LIMIT.reset()
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    gantt_router.STEP_PINS_RATE_LIMIT.reset()


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return SimpleNamespace(calls=calls)


async def _world(db_session):
    gr = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    a = await stepped_project(db_session, gr, name="Alpha")
    far = await stepped_project(db_session, india, name="India project")
    return SimpleNamespace(gr=gr, india=india, a=a, far=far)


def _item(project_id, step="PDD-E", start=40, end=43):
    return {
        "project_id": str(project_id),
        "step_template_id": step,
        "manual_start_week": start,
        "manual_end_week": end,
    }


async def _put(db_session, items):
    async with client_for(db_session) as client:
        return await client.put("/gantt/step-pins", json={"items": items})


@pytest.fixture
async def row_locks(db_session):
    """`pgrowlocks` (contrib) inside the test's own transaction, so it is
    rolled back with everything else. Skips when the extension is missing."""

    try:
        async with db_session.begin_nested():
            await db_session.execute(text("CREATE EXTENSION IF NOT EXISTS pgrowlocks"))
    except Exception as exc:  # pragma: no cover - depends on the image
        pytest.skip(f"pgrowlocks unavailable: {exc}")


async def _locked_for_update(db_session, project_id: uuid.UUID) -> bool:
    """Whether this transaction holds a `FOR UPDATE` lock on the project row.
    The FK checks of the fixtures' step inserts take `FOR KEY SHARE` on it,
    which does not count."""

    modes = (
        (
            await db_session.execute(
                text(
                    "SELECT l.modes FROM projects p "
                    "JOIN pgrowlocks('projects') l ON l.locked_row = p.ctid "
                    "WHERE p.id = :id"
                ),
                {"id": project_id},
            )
        )
        .scalars()
        .all()
    )
    return any("For Update" in m for m in modes)


async def _audits(db_session, action):
    return list(
        (
            await db_session.execute(select(AuditLogEntry).where(AuditLogEntry.action == action))
        ).scalars()
    )


# --- S40-M1: rate limit --------------------------------------------------------------


async def test_step_pins_rate_limited_per_user_with_retry_after(db_session, dispatch, row_locks):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.ADMIN)
    # Spend the user's burst (capacity 10) without going through HTTP.
    for _ in range(10):
        allowed, _ = gantt_router.STEP_PINS_RATE_LIMIT.allow(f"step-pins:{user.id}")
        assert allowed
    resp = await _put(db_session, [_item(w.a.id)])
    assert resp.status_code == 429, resp.text
    assert resp.json()["code"] == "RATE_LIMITED"
    assert int(resp.headers["Retry-After"]) >= 1
    # Nothing written, nothing locked, no run.
    row = await live_step(db_session, w.a, "PDD-E")
    assert (row.manual_start_week, row.manual_end_week) == (None, None)
    assert await _audits(db_session, "project.step_pinned") == []
    assert not await _locked_for_update(db_session, w.a.id)
    assert dispatch.calls == []

    # Per user: another Admin is not affected.
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(w.a.id)])
    assert resp.status_code == 200, resp.text


async def test_step_pins_burst_of_ten_then_429(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    statuses = []
    for _ in range(11):
        # The same pair each time: the first is a write, the rest are no-ops.
        statuses.append((await _put(db_session, [_item(w.a.id)])).status_code)
    assert statuses == [200] * 10 + [429]


async def test_role_check_comes_before_the_rate_limit(db_session, dispatch):
    w = await _world(db_session)
    user = await act_as(db_session, RoleName.HUB_PLANNER)
    for _ in range(10):
        gantt_router.STEP_PINS_RATE_LIMIT.allow(f"step-pins:{user.id}")
    resp = await _put(db_session, [_item(w.a.id)])
    assert resp.status_code == 403, resp.text


# --- S40-L1: lock only in-scope rows -------------------------------------------------


async def test_lock_probe_detects_a_row_lock(db_session, row_locks):
    """Control for the probe used below: the unscoped lock marks the row."""

    w = await _world(db_session)
    assert not await _locked_for_update(db_session, w.far.id)
    await lock_projects(db_session, [w.far.id])
    assert await _locked_for_update(db_session, w.far.id)


async def test_scoped_admin_does_not_lock_out_of_scope_project(db_session, dispatch, row_locks):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN, hub_ids=[w.gr.id], hub_scope_all=False)
    assert not await _locked_for_update(db_session, w.a.id)
    assert not await _locked_for_update(db_session, w.far.id)

    resp = await _put(db_session, [_item(w.a.id), _item(w.far.id)])
    assert resp.status_code == 404, resp.text
    # The in-scope row was locked (the R33-10 lock still applies) ...
    assert await _locked_for_update(db_session, w.a.id)
    # ... the out-of-scope row was not.
    assert not await _locked_for_update(db_session, w.far.id)
    row = await live_step(db_session, w.a, "PDD-E")
    assert row.manual_start_week is None
    assert dispatch.calls == []


async def test_out_of_scope_404_identical_to_nonexistent(db_session, dispatch, row_locks):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN, hub_ids=[w.gr.id], hub_scope_all=False)
    ghost_id = uuid.UUID(int=7)

    out_of_scope = await _put(db_session, [_item(w.far.id)])
    ghost = await _put(db_session, [_item(ghost_id)])
    assert out_of_scope.status_code == ghost.status_code == 404

    def _normalise(body, pid):
        errors = [
            {**e, "project_id": "X" if e["project_id"] == str(pid) else e["project_id"]}
            for e in body["detail"]["errors"]
        ]
        return {**body, "detail": {**body["detail"], "errors": errors}}

    assert _normalise(out_of_scope.json(), w.far.id) == _normalise(ghost.json(), ghost_id)
    assert out_of_scope.json()["code"] == "PROJECT_NOT_FOUND"
    assert not await _locked_for_update(db_session, w.far.id)


async def test_unscoped_admin_still_locks_and_saves(db_session, dispatch):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    resp = await _put(db_session, [_item(w.a.id), _item(w.far.id)])
    assert resp.status_code == 200, resp.text
    for project in (w.a, w.far):
        row = await live_step(db_session, project, "PDD-E")
        assert (row.manual_start_week, row.manual_end_week) == (40, 43)


# --- S40-I1: delete branch writes the clear audit row ---------------------------------


async def test_sync_delete_branch_audits_the_pin_before_delete(db_session):
    """Both workflows have 14 steps, so the branch is unreachable with real
    data; a row whose sequence has no target in the new workflow forces it."""

    w = await _world(db_session)
    user = await act_as(db_session, RoleName.ADMIN)
    row = await live_step(db_session, w.a, "PDD-E")
    row_id = row.id
    row.manual_start_week, row.manual_end_week = 40, 43
    row.sequence_order = 99  # no OEM step has this sequence
    await db_session.flush()

    await sync_project_steps(db_session, w.a, True, actor_user_id=user.id)
    await db_session.flush()

    assert await db_session.get(ProjectWorkflowStep, row_id) is None
    (audit,) = await _audits(db_session, "project.step_pin_cleared")
    assert audit.entity_type == "ProjectWorkflowStep"
    assert audit.entity_id == str(row_id)
    assert audit.actor_user_id == user.id
    assert audit.before_state["step_id"] == "PDD-E"
    assert (audit.before_state["manual_start_week"], audit.before_state["manual_end_week"]) == (
        40,
        43,
    )
    assert (audit.after_state["manual_start_week"], audit.after_state["manual_end_week"]) == (
        None,
        None,
    )
    assert audit.after_state["cause"] == "workflow_change"
