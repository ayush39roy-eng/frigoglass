"""`POST /schedule-runs/cp-sat-dispatch` and `POST /schedule-runs/{id}/cancel`
(P3-T06) — RBAC gating, `ScheduleRun` lifecycle/persistence, audit rows, and
the cancellation branch logic.

**What this file does NOT cover (deliberately, by design — see
`docs/MEMORY.md`'s P3-T06 entry for the honest split)**: it never lets a real
Celery task actually execute (`workers.schedule_tasks.run_cp_sat_schedule.
delay` is monkeypatched to a fake that records its call args and returns a
fake `AsyncResult`), never calls a real `celery_app.control.revoke` against a
live broker, and never calls the real `workers.progress.publish_progress`
against a live Redis (that function is monkeypatched to a recorder). This
keeps the suite fast/hermetic and matches this project's established
"unit-test the endpoint logic, live-verify the real worker/Redis pipeline
separately" split (see `tests/test_workers_progress.py` for the real-Redis
integration coverage, and this task's own live smoke-test verification for
the real end-to-end worker pipeline).
"""

from __future__ import annotations

import json
import uuid

import pytest
from httpx import ASGITransport, AsyncClient

import api.routers.schedule_runs as schedule_runs_module
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import RoleName, ScheduleRunStatus, SolverType
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_schedule_run, make_user


class _FakeAsyncResult:
    def __init__(self, task_id: str):
        self.id = task_id


class _FakeTask:
    def __init__(self):
        self.calls: list[tuple[tuple, dict]] = []

    def delay(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        return _FakeAsyncResult(f"fake-task-{uuid.uuid4().hex[:8]}")


@pytest.fixture
def fake_task(monkeypatch) -> _FakeTask:
    task = _FakeTask()
    monkeypatch.setattr(schedule_runs_module, "run_cp_sat_schedule", task)
    return task


@pytest.fixture
def published(monkeypatch) -> list[dict]:
    calls: list[dict] = []

    def _fake_publish(schedule_run_id, *, status, **kwargs):
        calls.append({"schedule_run_id": str(schedule_run_id), "status": status, **kwargs})

    monkeypatch.setattr(schedule_runs_module, "publish_progress", _fake_publish)
    return calls


@pytest.fixture
def revoked(monkeypatch) -> list[tuple]:
    calls: list[tuple] = []

    def _fake_revoke(task_id, terminate=False, signal=None):
        calls.append((task_id, terminate, signal))

    monkeypatch.setattr(schedule_runs_module.celery_app.control, "revoke", _fake_revoke)
    return calls


async def _client(db_session, *principal_roles: RoleName) -> tuple[AsyncClient, uuid.UUID]:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    user = await make_user(db_session, *principal_roles)
    override_current_principal(make_principal(*principal_roles, user_id=user.id))
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test"), user.id


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


# --------------------------------------------------------------------------
# POST /schedule-runs/cp-sat-dispatch
# --------------------------------------------------------------------------


async def test_dispatch_requires_admin(db_session, fake_task, published):
    client, _ = await _client(db_session, RoleName.PORTFOLIO_MANAGER)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={})
        assert resp.status_code == 403
        assert fake_task.calls == []
    finally:
        _teardown()


async def test_dispatch_as_admin_creates_queued_run_and_enqueues_task(
    db_session, fake_task, published
):
    client, user_id = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={})
        assert resp.status_code == 202
        body = resp.json()
        assert body["schedule_run"]["solver_type"] == "cp_sat"
        assert body["schedule_run"]["status"] == "queued"
        assert body["schedule_run"]["is_active"] is False
        assert body["celery_task_id"].startswith("fake-task-")

        # Exactly one task enqueued, with the new run's id as first arg.
        assert len(fake_task.calls) == 1
        args, kwargs = fake_task.calls[0]
        assert args[0] == body["schedule_run"]["id"]
        assert kwargs["triggered_by_user_id"] == str(user_id)
        assert kwargs["deterministic_time"] is None
        assert "max_time_in_seconds" not in kwargs

        # A "queued" progress event was published.
        assert any(p["status"] == "queued" for p in published)
    finally:
        _teardown()


async def test_dispatch_accepts_deterministic_time_override(db_session, fake_task, published):
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(
            "/schedule-runs/cp-sat-dispatch", json={"deterministic_time": 12.5}
        )
        assert resp.status_code == 202
        _, kwargs = fake_task.calls[0]
        assert kwargs["deterministic_time"] == 12.5
    finally:
        _teardown()


async def test_dispatch_ignores_legacy_max_time_in_seconds(db_session, fake_task, published):
    # P9-R02b: one-release tolerance; the wall-clock value is dropped (ruling 6).
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(
            "/schedule-runs/cp-sat-dispatch", json={"max_time_in_seconds": 12.5}
        )
        assert resp.status_code == 202
        _, kwargs = fake_task.calls[0]
        assert "max_time_in_seconds" not in kwargs
        assert kwargs["deterministic_time"] is None
    finally:
        _teardown()


async def test_dispatch_rejects_non_positive_deterministic_time(db_session, fake_task, published):
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={"deterministic_time": 0})
        assert resp.status_code == 422
        assert fake_task.calls == []
    finally:
        _teardown()


async def test_dispatch_rejects_deterministic_time_above_ceiling(db_session, fake_task, published):
    # P9-F01 (R04-L1): `le=60` — the security-auditor's live pentest sent
    # 1e12 and held the only solver slot for 900s instead of ~53s.
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(
            "/schedule-runs/cp-sat-dispatch", json={"deterministic_time": 61}
        )
        assert resp.status_code == 422
        assert fake_task.calls == []
    finally:
        _teardown()


@pytest.mark.parametrize("bad_value", [float("inf"), float("-inf")])
async def test_dispatch_rejects_non_finite_deterministic_time(
    db_session, fake_task, published, bad_value
):
    # P9-F01 (R04-L1): `allow_inf_nan=False` — `inf`/`-inf` used to reach the
    # Celery task and hold the solver slot forever; `NaN` used to 500 (an
    # unrenderable 422 body) rather than 422. httpx's own `json=` kwarg
    # refuses to serialize inf/nan client-side (`allow_nan=False`), unlike
    # the real P9-R04 pentest's raw `curl` body — encode it ourselves with
    # Python's default `allow_nan=True` to reproduce the same wire bytes.
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(
            "/schedule-runs/cp-sat-dispatch",
            content=json.dumps({"deterministic_time": bad_value}).encode(),
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 422
        assert fake_task.calls == []
    finally:
        _teardown()


async def test_dispatch_rejects_string_deterministic_time_in_strict_mode(
    db_session, fake_task, published
):
    # P9-F01 (R04-L1): `strict=True` — lax mode used to coerce `"15"`/`true`.
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(
            "/schedule-runs/cp-sat-dispatch", json={"deterministic_time": "15"}
        )
        assert resp.status_code == 422
        assert fake_task.calls == []
    finally:
        _teardown()


async def test_dispatch_refused_while_a_run_is_already_in_flight(db_session, fake_task, published):
    # P9-F01 (R04-L1): single-flight, mirroring the Project Workspace
    # `RUN_IN_PROGRESS` recalculate check — the pentest's own finding was
    # that this dispatch endpoint had none.
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={})
        assert resp.status_code == 409
        assert resp.json()["code"] == "RUN_IN_PROGRESS"
        assert fake_task.calls == []
    finally:
        _teardown()


async def test_dispatch_allowed_once_the_in_flight_run_is_terminal(
    db_session, fake_task, published
):
    # A COMPLETED run (not QUEUED/RUNNING) never blocks a new dispatch.
    await make_schedule_run(db_session, status=ScheduleRunStatus.COMPLETED)
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={})
        assert resp.status_code == 202
        assert len(fake_task.calls) == 1
    finally:
        _teardown()


async def test_dispatch_rejects_unknown_fields(db_session, fake_task, published):
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={"bogus": 1})
        assert resp.status_code == 422
    finally:
        _teardown()


async def test_dispatch_writes_audit_row(db_session, fake_task, published):
    from sqlalchemy import select

    client, user_id = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post("/schedule-runs/cp-sat-dispatch", json={})
        run_id = resp.json()["schedule_run"]["id"]
        rows = (
            (
                await db_session.execute(
                    select(AuditLogEntry).where(
                        AuditLogEntry.entity_id == run_id,
                        AuditLogEntry.action == "schedule_run.cp_sat_dispatch",
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].actor_user_id == user_id
        assert rows[0].after_state["solver_type"] == "cp_sat"
    finally:
        _teardown()


# --------------------------------------------------------------------------
# POST /schedule-runs/{id}/cancel
# --------------------------------------------------------------------------


async def test_cancel_requires_admin(db_session, revoked, published):
    run = await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED)
    client, _ = await _client(db_session, RoleName.PORTFOLIO_MANAGER)
    try:
        resp = await client.post(f"/schedule-runs/{run.id}/cancel")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_cancel_unknown_run_404s(db_session, revoked, published):
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(f"/schedule-runs/{uuid.uuid4()}/cancel")
        assert resp.status_code == 404
    finally:
        _teardown()


async def test_cancel_terminal_run_409s(db_session, revoked, published):
    run = await make_schedule_run(db_session, status=ScheduleRunStatus.COMPLETED)
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(f"/schedule-runs/{run.id}/cancel")
        assert resp.status_code == 409
        assert revoked == []
    finally:
        _teardown()


async def test_cancel_queued_run_without_celery_task_id_never_calls_revoke(
    db_session, revoked, published
):
    run = await make_schedule_run(
        db_session, status=ScheduleRunStatus.QUEUED, celery_task_id=None
    )
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(f"/schedule-runs/{run.id}/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        assert revoked == []
        assert any(p["status"] == "cancelled" for p in published)
    finally:
        _teardown()


async def test_cancel_running_run_with_celery_task_id_calls_revoke_with_terminate(
    db_session, revoked, published
):
    run = await make_schedule_run(
        db_session,
        status=ScheduleRunStatus.RUNNING,
        celery_task_id="real-task-id-123",
        solver_type=SolverType.CP_SAT,
    )
    client, _ = await _client(db_session, RoleName.ADMIN)
    try:
        resp = await client.post(f"/schedule-runs/{run.id}/cancel")
        assert resp.status_code == 200
        assert resp.json()["status"] == "cancelled"
        assert revoked == [("real-task-id-123", True, "SIGTERM")]
    finally:
        _teardown()


async def test_cancel_writes_audit_row(db_session, revoked, published):
    from sqlalchemy import select

    run = await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED)
    client, user_id = await _client(db_session, RoleName.ADMIN)
    try:
        await client.post(f"/schedule-runs/{run.id}/cancel")
        rows = (
            (
                await db_session.execute(
                    select(AuditLogEntry).where(
                        AuditLogEntry.entity_id == str(run.id),
                        AuditLogEntry.action == "schedule_run.cancel",
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        assert rows[0].actor_user_id == user_id
    finally:
        _teardown()
