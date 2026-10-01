"""P10-T02: `GET/POST/DELETE /projects/{id}/access` (ADR 0012) and the
Editor-grant write-scope restriction on Project Workspace/Registration
endpoints (stage-progress PATCH allowed; Registration charter-field PATCH
403).
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, RoleName
from models.project_access import ProjectAccessGrant
from services.project_steps import sync_project_steps
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids=None, **user_kwargs):
    user_kwargs.setdefault("hub_scope_all", hub_ids is None)
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], **user_kwargs)
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=user.hub_scope_all,
            hub_ids=hub_ids or [],
        )
    )
    return user


async def _project(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, name="Access Grant Project")
    await sync_project_steps(db_session, project, False)
    return hub, project


async def _grant(db_session, project, target_user, granter_user, role: str) -> ProjectAccessGrant:
    grant = ProjectAccessGrant(
        project_id=project.id,
        user_id=target_user.id,
        project_role=role,
        granted_by_user_id=granter_user.id,
    )
    db_session.add(grant)
    await db_session.flush()
    return grant


# --- GET/POST/DELETE /projects/{id}/access ---------------------------------


async def test_super_admin_can_grant_list_and_revoke(db_session):
    hub, project = await _project(db_session)
    admin = await _act_as(db_session, RoleName.SUPER_ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER, email="grantee@example.com")

    async with _client(db_session) as client:
        create_resp = await client.post(
            f"/projects/{project.id}/access",
            json={"user_id": str(target.id), "project_role": "editor"},
        )
        list_resp = await client.get(f"/projects/{project.id}/access")

    assert create_resp.status_code == 201
    body = create_resp.json()
    assert body["user_id"] == str(target.id)
    assert body["project_role"] == "editor"
    assert body["granted_by_user_id"] == str(admin.id)
    assert list_resp.status_code == 200
    assert [g["user_id"] for g in list_resp.json()] == [str(target.id)]

    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project_access_grant.create")
        )
    ).scalar_one()
    assert audit.after_state["user_id"] == str(target.id)
    assert audit.after_state["project_role"] == "editor"

    grant_id = body["id"]
    async with _client(db_session) as client:
        revoke_resp = await client.delete(f"/projects/{project.id}/access/{grant_id}")
        list_after = await client.get(f"/projects/{project.id}/access")

    assert revoke_resp.status_code == 204
    assert list_after.json() == []
    revoke_audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project_access_grant.revoke")
        )
    ).scalar_one()
    assert revoke_audit.after_state["user_id"] == str(target.id)


async def test_duplicate_active_grant_is_conflict(db_session):
    hub, project = await _project(db_session)
    admin = await _act_as(db_session, RoleName.SUPER_ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER, email="dup@example.com")
    await _grant(db_session, project, target, admin, "viewer")

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/access",
            json={"user_id": str(target.id), "project_role": "editor"},
        )
    assert resp.status_code == 409
    assert resp.json()["code"] == "ACTIVE_GRANT_EXISTS"


async def test_bare_engineer_cannot_grant(db_session):
    """Not Super Admin/global Admin, not the target's manager, and no
    project-level Admin access — 403, not a silent no-op (I18)."""

    hub, project = await _project(db_session)
    await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    target = await make_user(db_session, RoleName.ENGINEER, email="target@example.com")

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/access",
            json={"user_id": str(target.id), "project_role": "viewer"},
        )
    assert resp.status_code == 403


async def test_manager_can_grant_own_report_on_admin_project(db_session):
    hub, project = await _project(db_session)
    manager = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub.id])
    report = await make_user(db_session, RoleName.ENGINEER, email="report@example.com")
    report.manager_id = manager.id
    await db_session.flush()

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/access",
            json={"user_id": str(report.id), "project_role": "editor"},
        )
    assert resp.status_code == 201


async def test_manager_cannot_grant_non_report(db_session):
    hub, project = await _project(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[hub.id])
    stranger = await make_user(db_session, RoleName.ENGINEER, email="stranger@example.com")

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/access",
            json={"user_id": str(stranger.id), "project_role": "editor"},
        )
    assert resp.status_code == 403


async def test_manager_without_project_admin_access_cannot_grant(db_session):
    hub, project = await _project(db_session)
    other_hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    # Scoped to a DIFFERENT hub than the project's -> no Admin-level access here.
    manager = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[other_hub.id])
    report = await make_user(db_session, RoleName.ENGINEER, email="report2@example.com")
    report.manager_id = manager.id
    await db_session.flush()

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/access",
            json={"user_id": str(report.id), "project_role": "viewer"},
        )
    assert resp.status_code == 403


# --- Editor grant write-scope restriction (ADR 0012) -----------------------


async def test_editor_grant_can_patch_stage_progress_but_not_registration(db_session):
    hub, project = await _project(db_session)
    admin = await make_user(db_session, RoleName.SUPER_ADMIN, email="super@example.com")
    editor_user = await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    await _grant(db_session, project, editor_user, admin, "editor")

    async with _client(db_session) as client:
        stage_resp = await client.patch(
            f"/projects/{project.id}/stages/PDD-A", json={"percent_complete": 0}
        )
        comment_resp = await client.post(
            f"/projects/{project.id}/comments", json={"body_md": "editor comment"}
        )
        registration_resp = await client.patch(
            f"/projects/{project.id}", json={"name": "Renamed by editor"}
        )

    assert stage_resp.status_code == 200
    assert comment_resp.status_code == 201
    assert registration_resp.status_code == 403


async def test_admin_grant_can_patch_registration_charter_field(db_session):
    hub, project = await _project(db_session)
    super_admin = await make_user(db_session, RoleName.SUPER_ADMIN, email="super2@example.com")
    admin_grantee = await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    await _grant(db_session, project, admin_grantee, super_admin, "admin")

    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"name": "Renamed by admin"})

    assert resp.status_code == 200
    assert resp.json()["name"] == "Renamed by admin"


async def test_viewer_grant_cannot_write_anything(db_session):
    hub, project = await _project(db_session)
    super_admin = await make_user(db_session, RoleName.SUPER_ADMIN, email="super3@example.com")
    viewer = await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    await _grant(db_session, project, viewer, super_admin, "viewer")

    async with _client(db_session) as client:
        read_resp = await client.get(f"/projects/{project.id}/workspace")
        stage_resp = await client.patch(
            f"/projects/{project.id}/stages/PDD-A", json={"percent_complete": 0}
        )

    assert read_resp.status_code == 200
    assert stage_resp.status_code == 403
