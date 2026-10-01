"""P10-T02: I18 delegation authorization (`services.project_access.
can_manage_grant`) and `User.manager_id` self-cycle / multi-hop-cycle
rejection (`api/routers/users.py::update_user`).
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import RoleName
from services.project_access import can_manage_grant
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_user


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _act_as(db_session, *roles: RoleName, **user_kwargs):
    user = await make_user(db_session, *roles, **user_kwargs)
    override_current_principal(
        make_principal(*roles, user_id=user.id, email=user.email, hub_scope_all=user.hub_scope_all)
    )
    return user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --- can_manage_grant (I18) — pure-function cases ---------------------------


async def test_can_manage_grant_super_admin_always_true(db_session):
    actor = make_principal(RoleName.SUPER_ADMIN, hub_scope_all=False, hub_ids=())
    target = await make_user(db_session, RoleName.ENGINEER)
    # Even with no manager link and no effective access at all, Super Admin
    # always wins.
    assert can_manage_grant(actor, target, actor_effective_role_on_project=None) is True


async def test_can_manage_grant_global_admin_always_true(db_session):
    actor_user = await make_user(db_session, RoleName.ADMIN)
    actor = make_principal(RoleName.ADMIN, user_id=actor_user.id, hub_scope_all=False, hub_ids=())
    target = await make_user(db_session, RoleName.ENGINEER)
    assert can_manage_grant(actor, target, actor_effective_role_on_project=None) is True


async def test_can_manage_grant_manager_with_admin_access_on_report_true(db_session):
    manager_user = await make_user(db_session, RoleName.HUB_PLANNER)
    report = await make_user(db_session, RoleName.ENGINEER)
    report.manager_id = manager_user.id
    await db_session.flush()
    actor = make_principal(RoleName.HUB_PLANNER, user_id=manager_user.id)

    assert can_manage_grant(actor, report, actor_effective_role_on_project="admin") is True


async def test_can_manage_grant_non_report_rejected(db_session):
    manager_user = await make_user(db_session, RoleName.HUB_PLANNER)
    stranger = await make_user(db_session, RoleName.ENGINEER)  # manager_id stays None
    actor = make_principal(RoleName.HUB_PLANNER, user_id=manager_user.id)

    assert can_manage_grant(actor, stranger, actor_effective_role_on_project="admin") is False


async def test_can_manage_grant_manager_without_project_admin_rejected(db_session):
    manager_user = await make_user(db_session, RoleName.HUB_PLANNER)
    report = await make_user(db_session, RoleName.ENGINEER)
    report.manager_id = manager_user.id
    await db_session.flush()
    actor = make_principal(RoleName.HUB_PLANNER, user_id=manager_user.id)

    # The manager's own effective access on the project is only Viewer (or
    # None) — I18 requires Admin.
    assert can_manage_grant(actor, report, actor_effective_role_on_project="viewer") is False
    assert can_manage_grant(actor, report, actor_effective_role_on_project=None) is False


async def test_can_manage_grant_self_grant_rejected(db_session):
    """A manager attempting to grant/revoke their OWN access: `target_user is
    actor`, so `target_user.manager_id == actor.user_id` can never hold (a
    user cannot be their own manager — `ck_users_manager_id_not_self`), and
    this function does not otherwise special-case identity — the rejection
    falls out of the manager-report check itself.
    """

    self_user = await make_user(db_session, RoleName.HUB_PLANNER)
    actor = make_principal(RoleName.HUB_PLANNER, user_id=self_user.id)

    assert can_manage_grant(actor, self_user, actor_effective_role_on_project="admin") is False


# --- `User.manager_id` self-cycle / multi-hop cycle (API layer) ------------


async def test_patch_user_manager_id_self_cycle_rejected(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        resp = await client.patch(f"/users/{target.id}", json={"manager_id": str(target.id)})
    assert resp.status_code == 422
    assert resp.json()["code"] == "MANAGER_SELF_CYCLE"


async def test_patch_user_manager_id_multi_hop_cycle_rejected(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    a = await make_user(db_session, RoleName.ENGINEER, email="chain.a@example.com")
    b = await make_user(db_session, RoleName.ENGINEER, email="chain.b@example.com")
    c = await make_user(db_session, RoleName.ENGINEER, email="chain.c@example.com")
    # a -> b -> c (a manages b, b manages c)
    b.manager_id = a.id
    c.manager_id = b.id
    await db_session.flush()

    # Attempting c -> a (a's manager becomes c) would close the loop
    # a -> b -> c -> a.
    async with _client(db_session) as client:
        resp = await client.patch(f"/users/{a.id}", json={"manager_id": str(c.id)})
    assert resp.status_code == 409
    assert resp.json()["code"] == "MANAGER_CYCLE"


async def test_patch_user_manager_id_success(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    manager = await make_user(db_session, RoleName.HUB_PLANNER, email="mgr@example.com")
    report = await make_user(db_session, RoleName.ENGINEER, email="report@example.com")
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/users/{report.id}", json={"manager_id": str(manager.id)}
        )
    assert resp.status_code == 200
    assert resp.json()["manager_id"] == str(manager.id)


async def test_patch_user_manager_id_unknown_manager_rejected(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/users/{target.id}", json={"manager_id": "00000000-0000-0000-0000-000000000000"}
        )
    assert resp.status_code == 422
    assert resp.json()["code"] == "UNKNOWN_MANAGER"
