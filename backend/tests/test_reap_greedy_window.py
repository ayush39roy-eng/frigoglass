"""Owner 2026-11-24: an orphaned greedy run older than 5 min is reaped when
someone presses Recalculate (GREEDY_IN_FLIGHT_WINDOW)."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

import pytest

from api.db import get_db
from api.main import app
from models.enums import RoleName, ScheduleRunStatus, SolverType
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_schedule_run
from tests.p12_helpers import act_as, client_for


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def test_recalculate_reaps_an_orphaned_greedy_run(db_session, monkeypatch):
    import services.run_dispatch as rd

    monkeypatch.setattr(rd, "dispatch_greedy", lambda *a, **k: "task")
    orphan = await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING, version=8801)
    orphan.solver_type = SolverType.GREEDY
    orphan.created_at = datetime.now(UTC) - timedelta(minutes=10)
    await db_session.flush()
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post("/schedule-runs/recalculate")
    assert resp.status_code == 202, resp.text
    await db_session.refresh(orphan)
    assert orphan.status == ScheduleRunStatus.FAILED
