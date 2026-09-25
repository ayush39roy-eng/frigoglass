"""End-to-end RBAC coverage across every router touched by P3-T02: for a
representative read + write endpoint per surface, confirm

  - no `Authorization` header at all -> 401 (real `get_current_principal`,
    not overridden — see the one test per file that deliberately skips the
    override, mirroring `tests/test_currency_api.py`'s pattern)
  - authenticated but wrong role -> 403
  - authenticated with an allowed role -> 200/201, not 403/500

`get_current_principal` is overridden (via `tests.auth_helpers`) with a
`core.principal.Principal` built directly (no real JWT/DB round trip needed
here — that machinery is already covered end-to-end by
`tests/test_api_deps.py` and `tests/test_core_oidc.py`; this file is about
the ROLE -> SURFACE -> ACTION matrix being wired onto the right endpoint, not
about token verification).
"""

from __future__ import annotations

import uuid

from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import LabRegion, RoleName
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as(db_session, *roles: RoleName) -> AsyncClient:
    """Authenticate as a real, DB-backed user with the given role(s) — a real
    `User` row is needed wherever the endpoint under test might write an
    `AuditLogEntry.actor_user_id` (a real FK), same rationale as
    `tests/test_currency_api.py`'s `_client` helper.
    """
    user = await make_user(db_session, *roles)
    client = _client(db_session)
    override_current_principal(make_principal(*roles, user_id=user.id))
    return client


# --------------------------------------------------------------------------
# Project Registration (api/routers/projects.py)
# --------------------------------------------------------------------------


async def test_projects_list_requires_authentication(db_session):
    try:
        async with _client(db_session) as client:
            resp = await client.get("/projects")
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_projects_list_forbidden_for_engineer(db_session):
    try:
        async with await _as(db_session, RoleName.ENGINEER) as client:
            resp = await client.get("/projects")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_projects_list_allowed_for_hub_planner(db_session):
    try:
        async with await _as(db_session, RoleName.HUB_PLANNER) as client:
            resp = await client.get("/projects")
        assert resp.status_code == 200
    finally:
        _teardown()


async def test_projects_create_forbidden_for_executive_viewer(db_session):
    hub = await make_hub(db_session)
    try:
        async with await _as(db_session, RoleName.EXECUTIVE_VIEWER) as client:
            resp = await client.post("/projects", json={"name": "X", "hub_id": str(hub.id)})
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_projects_create_allowed_for_portfolio_manager(db_session):
    hub = await make_hub(db_session)
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post("/projects", json={"name": "X", "hub_id": str(hub.id)})
        assert resp.status_code == 201
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Capacity Planning — Engineers (api/routers/engineers.py)
# --------------------------------------------------------------------------


async def test_engineers_list_requires_authentication(db_session):
    try:
        async with _client(db_session) as client:
            resp = await client.get("/engineers")
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_engineers_list_forbidden_for_auditor(db_session):
    try:
        async with await _as(db_session, RoleName.AUDITOR) as client:
            resp = await client.get("/engineers")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_engineers_create_forbidden_for_portfolio_manager_read_only_role(db_session):
    """Portfolio Manager has READ, not WRITE, on Capacity Planning."""
    hub = await make_hub(db_session)
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                "/engineers", json={"name": "Eng", "hub_id": str(hub.id)}
            )
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_engineers_create_allowed_for_hub_planner(db_session):
    hub = await make_hub(db_session)
    try:
        async with await _as(db_session, RoleName.HUB_PLANNER) as client:
            resp = await client.post(
                "/engineers", json={"name": "Eng", "hub_id": str(hub.id)}
            )
        assert resp.status_code == 201
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Capacity Planning — Chambers (api/routers/chambers.py)
# --------------------------------------------------------------------------


async def test_chambers_create_forbidden_for_engineer(db_session):
    try:
        async with await _as(db_session, RoleName.ENGINEER) as client:
            resp = await client.post(
                "/chambers",
                json={
                    "code": "CH-1",
                    "lab_region": LabRegion.GREECE.value,
                    "max_concurrent": 2,
                },
            )
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_chambers_read_allowed_for_admin(db_session):
    try:
        async with await _as(db_session, RoleName.ADMIN) as client:
            resp = await client.get("/chambers")
        assert resp.status_code == 200
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Prioritization Matrix (api/routers/priorities.py)
# --------------------------------------------------------------------------


async def test_priorities_list_allowed_for_executive_viewer(db_session):
    try:
        async with await _as(db_session, RoleName.EXECUTIVE_VIEWER) as client:
            resp = await client.get("/priorities")
        assert resp.status_code == 200
    finally:
        _teardown()


async def test_priorities_put_forbidden_for_hub_planner_read_only_role(db_session):
    """Hub Planner has READ, not WRITE, on the Matrix — unlike most other
    surfaces, where Hub Planner gets R/W.
    """
    body = {
        "strategic_project": 3,
        "new_customer": 3,
        "new_options": 3,
        "regulatory_compliance": 3,
        "quality_improvements": 3,
        "rm_savings": 3,
        "total_rm_savings": 3,
        "gross_margins": 3,
        "profitability": 3,
        "annual_volume": 3,
        "three_year_volume": 3,
        "new_models": 3,
        "capex_investment": 3,
        "hard_gates": [],
    }
    try:
        async with await _as(db_session, RoleName.HUB_PLANNER) as client:
            resp = await client.put(f"/priorities/{uuid.uuid4()}", json=body)
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_priorities_put_allowed_for_portfolio_manager(db_session):
    from tests.factories import make_project

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    body = {
        "strategic_project": 3,
        "new_customer": 3,
        "new_options": 3,
        "regulatory_compliance": 3,
        "quality_improvements": 3,
        "rm_savings": 3,
        "total_rm_savings": 3,
        "gross_margins": 3,
        "profitability": 3,
        "annual_volume": 3,
        "three_year_volume": 3,
        "new_models": 3,
        "capex_investment": 3,
        "hard_gates": [],
    }
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.put(f"/priorities/{project.id}", json=body)
        assert resp.status_code == 200
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Global RPD Dashboard (api/routers/dashboard.py)
# --------------------------------------------------------------------------


async def test_dashboard_forbidden_for_engineer(db_session):
    try:
        async with await _as(db_session, RoleName.ENGINEER) as client:
            resp = await client.get("/dashboard/pipeline-totals")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_dashboard_allowed_for_executive_viewer(db_session):
    try:
        async with await _as(db_session, RoleName.EXECUTIVE_VIEWER) as client:
            resp = await client.get("/dashboard/pipeline-totals")
        assert resp.status_code == 200
    finally:
        _teardown()


# --------------------------------------------------------------------------
# RPD Capacity (api/routers/capacity.py)
# --------------------------------------------------------------------------


async def test_capacity_forbidden_for_auditor(db_session):
    try:
        async with await _as(db_session, RoleName.AUDITOR) as client:
            resp = await client.get("/capacity/hub-load")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_capacity_allowed_for_hub_planner(db_session):
    try:
        async with await _as(db_session, RoleName.HUB_PLANNER) as client:
            resp = await client.get("/capacity/hub-load")
        assert resp.status_code == 200
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Gantt (api/routers/gantt.py)
# --------------------------------------------------------------------------


async def test_gantt_read_allowed_for_engineer_own_assignments_role(db_session):
    """Engineer's Gantt access is action-level READ here (row-level "own
    assignments" scoping is P3-T03's job) — confirms it is NOT 403 at this
    layer. No DB fixtures needed beyond the authenticated user: `GET /gantt`
    with no active `ScheduleRun` still 200s (documented "no schedule computed
    yet" state) — this test only checks the RBAC gate, not scheduling
    behaviour.
    """
    try:
        async with await _as(db_session, RoleName.ENGINEER) as client:
            resp = await client.get("/gantt")
        assert resp.status_code == 200
        assert resp.json()["has_active_schedule_run"] is False
    finally:
        _teardown()


async def test_gantt_read_forbidden_for_auditor(db_session):
    try:
        async with await _as(db_session, RoleName.AUDITOR) as client:
            resp = await client.get("/gantt")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_gantt_freeze_forbidden_for_portfolio_manager_read_only_role(db_session):
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post(
                f"/gantt/projects/{uuid.uuid4()}/freeze", json={"frozen": False}
            )
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_gantt_freeze_allowed_for_hub_planner(db_session):
    from tests.factories import make_project

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, frozen=True, actual_start_week=10)
    try:
        async with await _as(db_session, RoleName.HUB_PLANNER) as client:
            # Unfreezing (frozen=False) needs no actual_start_week, so this
            # exercises the RBAC-allowed path without also depending on the
            # handler's own hard-gate validation logic.
            resp = await client.post(
                f"/gantt/projects/{project.id}/freeze", json={"frozen": False}
            )
        assert resp.status_code == 200
        assert resp.json()["frozen"] is False
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Schedule runs (api/routers/schedule_runs.py)
# --------------------------------------------------------------------------


async def test_schedule_runs_list_forbidden_for_auditor(db_session):
    try:
        async with await _as(db_session, RoleName.AUDITOR) as client:
            resp = await client.get("/schedule-runs")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_schedule_runs_list_allowed_for_engineer_via_gantt_read(db_session):
    try:
        async with await _as(db_session, RoleName.ENGINEER) as client:
            resp = await client.get("/schedule-runs")
        assert resp.status_code == 200
    finally:
        _teardown()


async def test_greedy_recalc_forbidden_for_portfolio_manager(db_session):
    """Flagged decision (see `api/routers/schedule_runs.py`'s module
    docstring and this task's MEMORY.md entry): Admin-only, not
    Portfolio-Manager, since the matrix has no dedicated row for this action.
    """
    try:
        async with await _as(db_session, RoleName.PORTFOLIO_MANAGER) as client:
            resp = await client.post("/schedule-runs/greedy-recalc")
        assert resp.status_code == 403
    finally:
        _teardown()
