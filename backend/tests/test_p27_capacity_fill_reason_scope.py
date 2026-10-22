"""P27 / S26-L1 (final security gate): the Workspace's `capacity_fill_reason`
carries the hub's P1 design load and remaining design capacity. It is served
with figures only when the project's hub is in the caller's scope AND the
caller can read the Matrix; otherwise a reason without numbers ("P1 (capacity
fill)" for a promoted project, else null). `capacity_fill` is unchanged.

Reproduces the auditor's probe: a PD-India Hub Planner with a Viewer grant on
an R&D-Greece project, and an Engineer on their own project. Reuses P25-T01's
hand-worked world (R&D-Greece, capacity 10.00; First promoted to 9.00,
Second stopped at 11.00).
"""

from __future__ import annotations

import re
import uuid

import pytest

from api.db import get_db
from api.main import app
from core.principal import Principal
from models.enums import HubName, LabRegion, ProjectAccessRole, RoleName
from models.project_access import ProjectAccessGrant
from services.workspace import GENERIC_CAPACITY_FILL_REASON, _scoped_fill_reason
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_user
from tests.test_p25_capacity_fill import _act_as, _client, _hand_worked_world

FIGURES = re.compile(r"\d")
FIRST_REASON = "P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project"
SECOND_REASON = "Not promoted: hub P1 design load would be 11.00 of 10.00 weeks"


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _grant(db_session, project, user, role=ProjectAccessRole.VIEWER):
    granter = await make_user(
        db_session, RoleName.ADMIN, email=f"granter-{uuid.uuid4().hex[:8]}@example.com"
    )
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=user.id,
            project_role=role,
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()


async def _workspace_score(db_session, project) -> dict:
    async with _client(db_session) as client:
        resp = await client.get(f"/projects/{project.id}/workspace")
    assert resp.status_code == 200, resp.text
    return resp.json()["priority_score"]


async def test_auditor_probe_out_of_hub_hub_planner_with_viewer_grant(db_session):
    _hub, _run, p = await _hand_worked_world(db_session)  # R&D-Greece
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    user = await make_user(
        db_session, RoleName.HUB_PLANNER, hub_ids=[india.id], hub_scope_all=False
    )
    await _grant(db_session, p["first"], user)
    await _grant(db_session, p["second"], user)
    override_current_principal(
        make_principal(
            RoleName.HUB_PLANNER,
            user_id=user.id,
            email=user.email,
            hub_scope_all=False,
            hub_ids=[india.id],
        )
    )

    first = await _workspace_score(db_session, p["first"])
    assert first["capacity_fill"] is True
    assert first["suggested_band"] == "P1"
    assert first["capacity_fill_reason"] == GENERIC_CAPACITY_FILL_REASON
    assert not FIGURES.search(first["capacity_fill_reason"].replace("P1", ""))

    second = await _workspace_score(db_session, p["second"])
    assert second["capacity_fill"] is False
    assert second["capacity_fill_reason"] is None


async def test_auditor_probe_engineer_on_own_project(db_session):
    _hub, _run, p = await _hand_worked_world(db_session)
    user = await make_user(db_session, RoleName.ENGINEER)
    # Homed in another hub so the R&D-Greece capacity (10.00) is unchanged.
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    engineer = await make_engineer(db_session, india, name="Own Engineer")
    engineer.user_id = user.id
    p["first"].leader_engineer_id = engineer.id
    p["second"].leader_engineer_id = engineer.id
    await db_session.flush()
    override_current_principal(
        make_principal(
            RoleName.ENGINEER, user_id=user.id, email=user.email, hub_scope_all=False, hub_ids=[]
        )
    )

    first = await _workspace_score(db_session, p["first"])
    assert (first["capacity_fill"], first["capacity_fill_reason"]) == (
        True,
        GENERIC_CAPACITY_FILL_REASON,
    )
    second = await _workspace_score(db_session, p["second"])
    assert (second["capacity_fill"], second["capacity_fill_reason"]) == (False, None)


async def test_in_scope_matrix_reader_keeps_the_figures(db_session):
    hub, _run, p = await _hand_worked_world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub.id])
    first = await _workspace_score(db_session, p["first"])
    second = await _workspace_score(db_session, p["second"])
    assert first["capacity_fill_reason"] == FIRST_REASON
    assert second["capacity_fill_reason"] == SECOND_REASON


async def test_global_portfolio_manager_keeps_the_figures(db_session):
    _hub, _run, p = await _hand_worked_world(db_session)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    assert (await _workspace_score(db_session, p["first"]))["capacity_fill_reason"] == FIRST_REASON


def _principal(*roles: RoleName, hub_scope_all: bool, hub_ids=None) -> Principal:
    return make_principal(*roles, hub_scope_all=hub_scope_all, hub_ids=hub_ids or [])


def test_scoped_fill_reason_unit():
    hub = uuid.uuid4()
    other = uuid.uuid4()
    # In scope and Matrix read: unchanged.
    hp = _principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub])
    assert _scoped_fill_reason(hp, hub, True, FIRST_REASON) == FIRST_REASON
    assert _scoped_fill_reason(hp, hub, False, SECOND_REASON) == SECOND_REASON
    # Out of scope: generic for a promoted project, null otherwise.
    assert _scoped_fill_reason(hp, other, True, FIRST_REASON) == GENERIC_CAPACITY_FILL_REASON
    assert _scoped_fill_reason(hp, other, False, SECOND_REASON) is None
    # No Matrix read (Engineer), even when unrestricted.
    eng = _principal(RoleName.ENGINEER, hub_scope_all=True)
    assert _scoped_fill_reason(eng, hub, True, FIRST_REASON) == GENERIC_CAPACITY_FILL_REASON
    assert _scoped_fill_reason(eng, hub, False, SECOND_REASON) is None
    # Never decided: stays null for everyone.
    assert _scoped_fill_reason(hp, other, False, None) is None
