"""P46-T02 (ADR 0058 D1): destructive actions are Super Admin only.

For every D1 item: a 403 `SUPER_ADMIN_ONLY` probe as Admin (nothing
written) and a positive test as Super Admin. The rights ADR 0058 keeps with
Admin are checked next to them (leaving Cancelled, reactivating an engineer
or a user, adding a role, the manager-delegation revoke, deleting one's own
scenario, editing the import format).

D1.2 (remove / retire a category or a workflow step, delete a project or a
category) has no API route today; `test_no_unguarded_delete_route_exists`
pins the DELETE route inventory so a new one has to be added here.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

import api.routers.engineers as engineers_router
import api.routers.projects as projects_router
import api.routers.schedule_runs as schedule_runs_module
import api.routers.whatif as whatif_router
import services.priority_move as priority_move
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import (
    HubName,
    LabRegion,
    ProjectAccessRole,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
)
from models.project import Project
from models.project_access import ProjectAccessGrant
from models.user import User
from services.engineer_status import led_projects_token
from services.project_steps import sync_project_steps
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_chamber,
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
)
from workers.schedule_tasks import run_greedy_schedule

SUPER_ADMIN_ONLY = "SUPER_ADMIN_ONLY"


@pytest.fixture(autouse=True)
def _cleanup(monkeypatch):
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    engineers_router.ENGINEER_STATUS_RATE_LIMIT.reset()
    whatif_router.WHATIF_RATE_LIMIT.reset()
    yield
    projects_router.REGISTER_EDITS_RATE_LIMIT.reset()
    engineers_router.ENGINEER_STATUS_RATE_LIMIT.reset()
    whatif_router.WHATIF_RATE_LIMIT.reset()
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
    return calls


@pytest.fixture
def run_side_effects(monkeypatch):
    revoked: list[tuple] = []
    monkeypatch.setattr(schedule_runs_module, "publish_progress", lambda *a, **k: None)
    monkeypatch.setattr(
        schedule_runs_module.celery_app.control,
        "revoke",
        lambda task_id, terminate=False, signal=None: revoked.append((task_id, terminate)),
    )
    return revoked


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, hub_ids=None) -> User:
    scope_all = hub_ids is None
    user = await make_user(db_session, *roles, hub_ids=hub_ids or [], hub_scope_all=scope_all)
    override_current_principal(
        make_principal(
            *roles, user_id=user.id, email=user.email, hub_scope_all=scope_all,
            hub_ids=hub_ids or [],
        )
    )  # fmt: skip
    return user


def _is_super_admin_only(resp) -> bool:
    return resp.status_code == 403 and resp.json().get("code") == SUPER_ADMIN_ONLY


async def _greece(db_session):
    return await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)


async def _status(db_session, project_id: uuid.UUID) -> ProjectStatus:
    return (
        await db_session.execute(
            select(Project.status)
            .where(Project.id == project_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


# --- D1.1 Cancel a project: PATCH /projects/{id} ------------------------------------------


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER])
async def test_patch_to_cancelled_is_super_admin_only(db_session, role):
    hub = await _greece(db_session)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_DEVELOPMENT)
    await _act_as(db_session, role, hub_ids=[hub.id] if role is RoleName.HUB_PLANNER else None)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}", json={"status": "Cancelled", "comments": "bye"}
        )
    assert _is_super_admin_only(resp), resp.text
    assert await _status(db_session, project.id) == ProjectStatus.IN_DEVELOPMENT


async def test_patch_to_cancelled_as_super_admin(db_session):
    hub = await _greece(db_session)
    project = await make_project(db_session, hub, status=ProjectStatus.IN_DEVELOPMENT)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"status": "Cancelled"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "Cancelled"


async def test_admin_may_leave_cancelled_and_resend_it(db_session):
    """Leaving Cancelled is an edit (ADR 0058 D1.1); re-sending Cancelled on a
    Cancelled project sets nothing."""

    hub = await _greece(db_session)
    leader = await make_engineer(db_session, hub)
    project = await make_project(
        db_session, hub, leader=leader, status=ProjectStatus.CANCELLED, priority=None
    )
    other = await make_project(
        db_session, hub, leader=leader, status=ProjectStatus.CANCELLED, priority=None
    )
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        same = await client.patch(
            f"/projects/{other.id}", json={"status": "Cancelled", "comments": "still"}
        )
        leave = await client.patch(f"/projects/{project.id}", json={"status": "On Hold"})
    assert same.status_code == 200, same.text
    assert leave.status_code == 200, leave.text
    assert leave.json()["status"] == "On Hold"


# --- D1.1 Cancel a project: POST /projects/register-edits ---------------------------------
# (the register inline status, the batch, the row / popup edit and the bulk
# edit all save through this one endpoint)


async def test_register_batch_with_a_cancel_is_super_admin_only(db_session, dispatch):
    hub = await _greece(db_session)
    a = await make_project(db_session, hub, name="A", status=ProjectStatus.IN_DEVELOPMENT)
    b = await make_project(db_session, hub, name="B", status=ProjectStatus.IN_QUEUE)
    await _act_as(db_session, RoleName.ADMIN)
    edits = [
        {"project_id": str(a.id), "status": "On Hold"},
        {"project_id": str(b.id), "status": "Cancelled"},
    ]
    async with _client(db_session) as client:
        resp = await client.post("/projects/register-edits", json={"edits": edits})
    assert _is_super_admin_only(resp), resp.text
    assert await _status(db_session, a.id) == ProjectStatus.IN_DEVELOPMENT
    assert await _status(db_session, b.id) == ProjectStatus.IN_QUEUE
    assert dispatch == []


async def test_register_batch_cancel_as_super_admin(db_session, dispatch):
    hub = await _greece(db_session)
    a = await make_project(db_session, hub, name="A", status=ProjectStatus.IN_DEVELOPMENT)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(a.id), "status": "Cancelled"}]},
        )
    assert resp.status_code == 200, resp.text
    assert await _status(db_session, a.id) == ProjectStatus.CANCELLED


async def test_register_batch_other_status_edits_stay_admin(db_session, dispatch):
    hub = await _greece(db_session)
    a = await make_project(db_session, hub, name="A", status=ProjectStatus.IN_DEVELOPMENT)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(
            "/projects/register-edits",
            json={"edits": [{"project_id": str(a.id), "status": "On Hold"}]},
        )
    assert resp.status_code == 200, resp.text
    assert await _status(db_session, a.id) == ProjectStatus.ON_HOLD


# --- D1.2 Remove / retire a category or step: no route today ------------------------------


def test_no_unguarded_delete_route_exists():
    """ADR 0058 D1.2: there is no route that deletes a project, a category or
    a workflow step, or retires one. Every DELETE route is listed here with
    its rule; a new one fails this test until it is classified."""

    paths = app.openapi()["paths"]
    deletes = sorted(path for path, ops in paths.items() if "delete" in ops)
    assert deletes == sorted(
        [
            "/chambers/{chamber_id}",  # D1.3: Super Admin only
            "/engineers/{engineer_id}",  # 410 ENGINEER_DELETE_RETIRED (P38)
            "/projects/{project_id}/access/{grant_id}",  # D1.4: Super Admin / delegate
            "/projects/{project_id}/comments/{comment_id}",  # own comment (workspace)
            "/vip-items/{item_id}",  # VIP board item, not in D1
            "/whatif/import/scenarios/{scenario_id}",  # D1.4: creator / Super Admin
        ]
    )
    for path, ops in paths.items():
        if path.startswith(("/workflow-templates", "/workflow-settings")):
            assert "delete" not in ops, path


# --- D1.3 Delete a lab chamber ------------------------------------------------------------


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.HUB_PLANNER])
async def test_delete_chamber_is_super_admin_only(db_session, role):
    hub = await _greece(db_session)
    chamber = await make_chamber(db_session, lab_region=LabRegion.GREECE)
    await _act_as(db_session, role, hub_ids=[hub.id] if role is RoleName.HUB_PLANNER else None)
    async with _client(db_session) as client:
        resp = await client.delete(f"/chambers/{chamber.id}")
    assert _is_super_admin_only(resp), resp.text
    assert await db_session.get(Chamber, chamber.id) is not None


async def test_delete_chamber_as_super_admin(db_session):
    chamber = await make_chamber(db_session, lab_region=LabRegion.GREECE)
    chamber_id = chamber.id
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.delete(f"/chambers/{chamber_id}")
    assert resp.status_code == 204, resp.text
    found = (
        await db_session.execute(select(Chamber.id).where(Chamber.id == chamber_id))
    ).scalar_one_or_none()
    assert found is None


# --- D1.3 Deactivate an engineer ----------------------------------------------------------


def _deactivate_body() -> dict:
    return {"reason": "left_company", "led_projects_token": led_projects_token([]),
            "reassignments": []}  # fmt: skip


async def _active(db_session, engineer_id: uuid.UUID) -> bool:
    return (
        await db_session.execute(
            select(Engineer.active)
            .where(Engineer.id == engineer_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()


async def test_deactivate_engineer_is_super_admin_only(db_session):
    hub = await _greece(db_session)
    engineer = await make_engineer(db_session, hub)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/engineers/{engineer.id}/deactivate", json=_deactivate_body())
    assert _is_super_admin_only(resp), resp.text
    assert await _active(db_session, engineer.id) is True


async def test_deactivate_engineer_as_super_admin_then_admin_reactivates(db_session, dispatch):
    hub = await _greece(db_session)
    engineer = await make_engineer(db_session, hub)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/engineers/{engineer.id}/deactivate", json=_deactivate_body())
    assert resp.status_code == 200, resp.text
    assert await _active(db_session, engineer.id) is False

    # Reactivating stays an Admin right.
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        back = await client.post(f"/engineers/{engineer.id}/reactivate")
    assert back.status_code == 200, back.text
    assert await _active(db_session, engineer.id) is True


# --- D1.4 Deactivate a user / remove a role -----------------------------------------------


async def test_admin_cannot_deactivate_a_user_or_remove_a_role(db_session):
    target = await make_user(
        db_session, RoleName.PORTFOLIO_MANAGER, RoleName.AUDITOR, email="pm@example.com"
    )
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        deactivate = await client.patch(f"/users/{target.id}", json={"is_active": False})
        remove_role = await client.patch(
            f"/users/{target.id}", json={"roles": ["Portfolio Manager"]}
        )
        swap_role = await client.patch(f"/users/{target.id}", json={"roles": ["Hub Planner"]})
        got = (await client.get("/users", params={"q": "pm@example.com"})).json()["items"][0]
    for resp in (deactivate, remove_role, swap_role):
        assert _is_super_admin_only(resp), resp.text
    assert got["is_active"] is True
    assert got["roles"] == ["Portfolio Manager", "Auditor"]


async def test_admin_keeps_reactivate_add_role_and_other_edits(db_session):
    target = await make_user(
        db_session, RoleName.PORTFOLIO_MANAGER, email="pm2@example.com", is_active=False
    )
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        reactivate = await client.patch(f"/users/{target.id}", json={"is_active": True})
        add_role = await client.patch(
            f"/users/{target.id}", json={"roles": ["Portfolio Manager", "Auditor"]}
        )
        same_roles = await client.patch(
            f"/users/{target.id}",
            json={"roles": ["Portfolio Manager", "Auditor"], "full_name": "Renamed"},
        )
        noop_active = await client.patch(f"/users/{target.id}", json={"is_active": True})
    for resp in (reactivate, add_role, same_roles, noop_active):
        assert resp.status_code == 200, resp.text
    assert same_roles.json()["roles"] == ["Portfolio Manager", "Auditor"]
    assert same_roles.json()["full_name"] == "Renamed"


async def test_super_admin_deactivates_a_user_and_removes_a_role(db_session):
    target = await make_user(
        db_session, RoleName.PORTFOLIO_MANAGER, RoleName.AUDITOR, email="pm3@example.com"
    )
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        remove_role = await client.patch(
            f"/users/{target.id}", json={"roles": ["Portfolio Manager"]}
        )
        deactivate = await client.patch(f"/users/{target.id}", json={"is_active": False})
    assert remove_role.status_code == 200, remove_role.text
    assert remove_role.json()["roles"] == ["Portfolio Manager"]
    assert deactivate.status_code == 200, deactivate.text
    assert deactivate.json()["is_active"] is False


# --- D1.4 Revoke a project access grant ---------------------------------------------------


async def _grant_world(db_session):
    hub = await _greece(db_session)
    project = await make_project(db_session, hub, name="Access Grant Project")
    await sync_project_steps(db_session, project, False)
    granter = await make_user(db_session, RoleName.SUPER_ADMIN, email="granter@example.com")
    target = await make_user(db_session, RoleName.ENGINEER, email="grantee@example.com")
    grant = ProjectAccessGrant(
        project_id=project.id, user_id=target.id, project_role=ProjectAccessRole.EDITOR,
        granted_by_user_id=granter.id,
    )  # fmt: skip
    db_session.add(grant)
    await db_session.flush()
    return SimpleNamespace(hub=hub, project=project, target=target, grant=grant)


async def _revoked(db_session, grant_id: uuid.UUID) -> bool:
    return (
        await db_session.execute(
            select(ProjectAccessGrant.revoked_at)
            .where(ProjectAccessGrant.id == grant_id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one() is not None


async def test_admin_revoke_is_super_admin_only(db_session):
    w = await _grant_world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert _is_super_admin_only(resp), resp.text
    assert await _revoked(db_session, w.grant.id) is False


async def test_super_admin_revokes(db_session):
    w = await _grant_world(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert resp.status_code == 204, resp.text
    assert await _revoked(db_session, w.grant.id) is True


@pytest.mark.parametrize("manager_role", [RoleName.HUB_PLANNER, RoleName.PORTFOLIO_MANAGER])
async def test_manager_delegation_revoke_is_unchanged(db_session, manager_role):
    """ADR 0012: the target's manager whose own project-admin level does not
    come from the global Admin / Super Admin role may still revoke."""

    w = await _grant_world(db_session)
    hub_ids = [w.hub.id] if manager_role is RoleName.HUB_PLANNER else None
    manager = await _act_as(db_session, manager_role, hub_ids=hub_ids)
    w.target.manager_id = manager.id
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert resp.status_code == 204, resp.text
    assert await _revoked(db_session, w.grant.id) is True


async def test_manager_delegate_through_an_admin_project_grant(db_session):
    """An Engineer manager whose project-admin level is an Admin-level grant
    on this project (ADR 0012) may revoke their report's grant."""

    w = await _grant_world(db_session)
    manager = await _act_as(db_session, RoleName.ENGINEER, hub_ids=[])
    granter = await make_user(db_session, RoleName.SUPER_ADMIN)
    db_session.add(
        ProjectAccessGrant(
            project_id=w.project.id, user_id=manager.id, project_role=ProjectAccessRole.ADMIN,
            granted_by_user_id=granter.id,
        )
    )  # fmt: skip
    w.target.manager_id = manager.id
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert resp.status_code == 204, resp.text


async def test_admin_cannot_make_themselves_manager_then_revoke(db_session):
    """P46-R01 (security M-1): the two-step chain. Setting `manager_id` is an
    Admin right and still works, but it no longer opens the delegate path."""

    w = await _grant_world(db_session)
    admin = await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        relink = await client.patch(f"/users/{w.target.id}", json={"manager_id": str(admin.id)})
        revoke = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert relink.status_code == 200, relink.text
    assert relink.json()["manager_id"] == str(admin.id)
    assert _is_super_admin_only(revoke), revoke.text
    assert await _revoked(db_session, w.grant.id) is False


async def test_admin_who_is_also_an_in_scope_hub_planner_manager_is_refused(db_session):
    """Holding the global Admin role refuses the revoke whatever else the
    caller holds or `manager_id` says."""

    w = await _grant_world(db_session)
    manager = await _act_as(db_session, RoleName.ADMIN, RoleName.HUB_PLANNER)
    w.target.manager_id = manager.id
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert _is_super_admin_only(resp), resp.text
    assert await _revoked(db_session, w.grant.id) is False


async def test_non_admin_non_manager_revoke_keeps_its_old_403(db_session):
    w = await _grant_world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        resp = await client.delete(f"/projects/{w.project.id}/access/{w.grant.id}")
    assert resp.status_code == 403
    assert "code" not in resp.json()


# --- D1.4 Cancel a schedule run -----------------------------------------------------------


async def test_cancel_run_is_super_admin_only(db_session, run_side_effects):
    run = await make_schedule_run(db_session, status=ScheduleRunStatus.QUEUED)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/schedule-runs/{run.id}/cancel")
        unknown = await client.post(f"/schedule-runs/{uuid.uuid4()}/cancel")
    assert _is_super_admin_only(resp), resp.text
    assert _is_super_admin_only(unknown)  # checked before the lookup
    await db_session.refresh(run)
    assert run.status == ScheduleRunStatus.QUEUED
    assert run_side_effects == []


async def test_cancel_run_as_super_admin(db_session, run_side_effects):
    run = await make_schedule_run(
        db_session, status=ScheduleRunStatus.RUNNING, celery_task_id="task-1"
    )
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(f"/schedule-runs/{run.id}/cancel")
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "cancelled"
    assert run_side_effects == [("task-1", True)]


# --- D1.4 Saved import scenarios: delete someone else's ----------------------------------


async def _saved_scenario(db_session):
    from tests.test_p32_whatif_import_api import _parsed_rows, act_as, client_for, make_world
    from tests.test_p41_import_scenarios import save_body

    await make_world(db_session)
    creator = await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as c:
        rows = await _parsed_rows(c)
        saved = await c.post("/whatif/import/scenarios", json=save_body({"rows": rows}))
    assert saved.status_code == 201, saved.text
    body = saved.json()
    assert body["can_edit"] is True and body["can_delete"] is True
    return creator, body["id"]


async def test_admin_cannot_delete_someone_elses_scenario(db_session):
    _, sid = await _saved_scenario(db_session)
    await _act_as(db_session, RoleName.ADMIN)  # another Admin
    async with _client(db_session) as client:
        listed = (await client.get("/whatif/import/scenarios")).json()["items"]
        resp = await client.delete(f"/whatif/import/scenarios/{sid}")
        still = await client.get(f"/whatif/import/scenarios/{sid}")
        rename = await client.patch(f"/whatif/import/scenarios/{sid}", json={"name": "Renamed"})
    assert listed[0]["can_edit"] is True and listed[0]["can_delete"] is False
    assert _is_super_admin_only(resp), resp.text
    assert still.status_code == 200
    assert rename.status_code == 200  # editing others' scenarios stays an Admin right
    deleted = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "whatif_scenario.deleted")
        )
    ).all()
    assert deleted == []


async def test_creator_deletes_own_scenario(db_session):
    creator, sid = await _saved_scenario(db_session)
    override_current_principal(
        make_principal(RoleName.ADMIN, user_id=creator.id, email=creator.email)
    )
    async with _client(db_session) as client:
        resp = await client.delete(f"/whatif/import/scenarios/{sid}")
    assert resp.status_code == 204, resp.text


async def test_super_admin_deletes_someone_elses_scenario(db_session):
    _, sid = await _saved_scenario(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        listed = (await client.get("/whatif/import/scenarios")).json()["items"]
        resp = await client.delete(f"/whatif/import/scenarios/{sid}")
    assert listed[0]["can_delete"] is True
    assert resp.status_code == 204, resp.text


# --- D1.4 Reset the import format ---------------------------------------------------------


async def _format_v1(db_session) -> None:
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        put = await client.put(
            "/whatif/import/format", json={"version": 0, "fields": {"plant": ["factory"]}}
        )
    assert put.status_code == 200, put.text  # editing stays an Admin right


async def test_admin_cannot_reset_import_format(db_session):
    await _format_v1(db_session)
    async with _client(db_session) as client:
        resp = await client.post("/whatif/import/format/reset", json={"version": 1})
        now = (await client.get("/whatif/import/format")).json()
    assert _is_super_admin_only(resp), resp.text
    assert now["version"] == 1 and now["is_default"] is False


async def test_super_admin_resets_import_format(db_session):
    await _format_v1(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post("/whatif/import/format/reset", json={"version": 1})
    assert resp.status_code == 200, resp.text
    assert resp.json()["is_default"] is True and resp.json()["version"] == 2
