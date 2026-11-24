"""Owner 2026-11-24: Super Admin DB-activity diagnostics (runs stuck "running")."""

from __future__ import annotations

import pytest

from api.db import get_db
from api.main import app
from models.enums import RoleName, ScheduleRunStatus
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_schedule_run
from tests.p12_helpers import act_as, client_for


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def test_super_admin_sees_sessions_and_run_errors(db_session):
    run = await make_schedule_run(db_session, status=ScheduleRunStatus.FAILED, version=7001)
    run.error_message = "boom"
    await db_session.flush()
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/schedule-runs/db-activity")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert isinstance(body["sessions"], list)
    assert any(r["version"] == 7001 and r["error_message"] == "boom" for r in body["runs"])


async def test_admin_is_refused(db_session):
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/schedule-runs/db-activity")
    assert resp.status_code == 403


async def test_super_admin_sees_db_health(db_session):
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/schedule-runs/db-health")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["server"]["db_bytes"] > 0
    assert body["server"]["max_connections"]
    assert isinstance(body["tables"], list) and body["tables"]


async def test_admin_is_refused_db_health(db_session):
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.get("/schedule-runs/db-health")
    assert resp.status_code == 403
