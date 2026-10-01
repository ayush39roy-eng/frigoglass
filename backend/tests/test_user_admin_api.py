"""P9-T03: User / Role Admin (docs/API_CONTRACT_P9.md §2, ADR 0010).

Admin vs Super Admin rules, the 409 `LAST_SUPER_ADMIN` guard, audit rows on
every change, and `GET /users/mention-search` staying empty while OQ#8 is
open. Real Postgres, principal overridden (`tests.auth_helpers`) with a real
`User` row behind it for the audit FK.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import HubName, LabRegion, RoleName
from models.project_access import ProjectAccessGrant
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_user


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _act_as(db_session, *roles: RoleName, **user_kwargs):
    hub_ids = user_kwargs.get("hub_ids") or []
    user = await make_user(db_session, *roles, **user_kwargs)
    override_current_principal(
        make_principal(
            *roles,
            user_id=user.id,
            email=user.email,
            hub_scope_all=user.hub_scope_all,
            hub_ids=hub_ids,
        )
    )
    return user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_list_users_search_and_paging(db_session):
    await _act_as(db_session, RoleName.ADMIN, email="admin-list@example.com")
    await make_user(
        db_session, RoleName.ENGINEER, email="zeta.one@example.com", full_name="Zeta One"
    )
    await make_user(
        db_session, RoleName.ENGINEER, email="zeta.two@example.com", full_name="Zeta Two"
    )
    async with _client(db_session) as client:
        resp = await client.get("/users", params={"q": "ZETA", "limit": 1})
        everyone = await client.get("/users")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total_count"] == 2
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["email"] == "zeta.one@example.com"
    assert item["roles"] == ["Engineer"]
    assert item["oidc_linked"] is False
    assert set(item) == {
        "id", "email", "full_name", "is_active", "roles", "hub_scope_all", "hub_ids",
        "engineer_id", "manager_id", "oidc_linked", "created_at", "updated_at",
    }
    assert everyone.json()["total_count"] >= 3


@pytest.mark.parametrize(
    "role,status_code",
    [
        (RoleName.PORTFOLIO_MANAGER, 403),
        (RoleName.HUB_PLANNER, 403),
        (RoleName.ENGINEER, 403),
        (RoleName.EXECUTIVE_VIEWER, 403),
        (RoleName.AUDITOR, 403),
        (RoleName.ADMIN, 200),
        (RoleName.SUPER_ADMIN, 200),
    ],
)
async def test_user_admin_rbac(db_session, role, status_code):
    await _act_as(db_session, role)
    async with _client(db_session) as client:
        assert (await client.get("/users")).status_code == status_code
        assert (await client.get("/roles")).status_code == status_code


async def test_roles_assignable_depends_on_caller(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        as_admin = {r["name"]: r["assignable"] for r in (await client.get("/roles")).json()}
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        as_super = {r["name"]: r["assignable"] for r in (await client.get("/roles")).json()}
    assert set(as_admin) == {r.value for r in RoleName}
    assert as_admin["Admin"] is False and as_admin["Super Admin"] is False
    assert as_admin["Hub Planner"] is True
    assert all(as_super.values())


async def test_create_user_writes_audit_and_links_engineer(db_session):
    actor = await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    engineer = await make_engineer(db_session, hub)
    async with _client(db_session) as client:
        resp = await client.post(
            "/users",
            json={
                "email": "New.Planner@Example.com",
                "full_name": "New Planner",
                "roles": ["Hub Planner", "Hub Planner"],
                "hub_scope_all": False,
                "hub_ids": [str(hub.id)],
                "engineer_id": str(engineer.id),
            },
        )
    assert resp.status_code == 201, resp.text
    body = resp.json()
    assert body["email"] == "new.planner@example.com"
    assert body["roles"] == ["Hub Planner"]
    assert body["hub_ids"] == [str(hub.id)]
    assert body["engineer_id"] == str(engineer.id)
    assert body["is_active"] is True
    await db_session.refresh(engineer)
    assert str(engineer.user_id) == body["id"]
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(
                AuditLogEntry.action == "user.create", AuditLogEntry.entity_id == body["id"]
            )
        )
    ).scalar_one()
    assert audit.actor_user_id == actor.id
    assert audit.after_state["roles"] == ["Hub Planner"]


async def test_create_user_validation(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    await make_user(db_session, email="taken@example.com")
    other = await make_user(db_session)
    hub = await make_hub(db_session)
    linked = await make_engineer(db_session, hub)
    linked.user_id = other.id
    await db_session.flush()
    async with _client(db_session) as client:
        dup = await client.post("/users", json={"email": "TAKEN@example.com", "full_name": "X"})
        bad_email = await client.post("/users", json={"email": "not-an-email", "full_name": "X"})
        bad_hub = await client.post(
            "/users",
            json={"email": "h@example.com", "full_name": "X", "hub_ids": [str(uuid.uuid4())]},
        )
        bad_eng = await client.post(
            "/users",
            json={"email": "e@example.com", "full_name": "X", "engineer_id": str(uuid.uuid4())},
        )
        linked_eng = await client.post(
            "/users",
            json={"email": "l@example.com", "full_name": "X", "engineer_id": str(linked.id)},
        )
        extra = await client.post(
            "/users", json={"email": "x@example.com", "full_name": "X", "password": "p"}
        )
    assert dup.status_code == 409 and dup.json()["code"] == "EMAIL_TAKEN"
    assert bad_email.status_code == 422
    assert bad_hub.status_code == 422 and bad_hub.json()["code"] == "UNKNOWN_HUB"
    assert bad_eng.status_code == 422 and bad_eng.json()["code"] == "UNKNOWN_ENGINEER"
    assert linked_eng.status_code == 409 and linked_eng.json()["code"] == "ENGINEER_ALREADY_LINKED"
    assert extra.status_code == 422


async def test_admin_cannot_grant_admin_roles(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER)
    async with _client(db_session) as client:
        create = await client.post(
            "/users", json={"email": "a2@example.com", "full_name": "A2", "roles": ["Admin"]}
        )
        promote = await client.patch(f"/users/{target.id}", json={"roles": ["Super Admin"]})
    assert create.status_code == 403
    assert create.json()["code"] == "ADMIN_ROLE_REQUIRES_SUPER_ADMIN"
    assert promote.status_code == 403


async def test_admin_cannot_touch_admin_accounts_including_own(db_session):
    me = await _act_as(db_session, RoleName.ADMIN)
    other_admin = await make_user(db_session, RoleName.ADMIN)
    super_admin = await make_user(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        r1 = await client.patch(f"/users/{other_admin.id}", json={"full_name": "Renamed"})
        r2 = await client.patch(f"/users/{super_admin.id}", json={"is_active": False})
        r3 = await client.patch(f"/users/{me.id}", json={"full_name": "Me"})
    for r in (r1, r2, r3):
        assert r.status_code == 403
        assert r.json()["code"] == "ADMIN_ACCOUNT_REQUIRES_SUPER_ADMIN"


async def test_admin_updates_non_admin_user_with_audit(db_session):
    actor = await _act_as(db_session, RoleName.ADMIN)
    hub = await make_hub(db_session)
    eng = await make_engineer(db_session, hub)
    target = await make_user(db_session, RoleName.ENGINEER, full_name="Before")
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/users/{target.id}",
            json={
                "full_name": "After",
                "roles": ["Hub Planner"],
                "hub_scope_all": False,
                "hub_ids": [str(hub.id)],
                "engineer_id": str(eng.id),
                "is_active": False,
            },
        )
        unlink = await client.patch(f"/users/{target.id}", json={"engineer_id": None})
        null_roles = await client.patch(f"/users/{target.id}", json={"roles": None})
        missing = await client.patch(f"/users/{uuid.uuid4()}", json={"full_name": "x"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["full_name"] == "After"
    assert body["roles"] == ["Hub Planner"]
    assert body["hub_ids"] == [str(hub.id)]
    assert body["engineer_id"] == str(eng.id)
    assert body["is_active"] is False
    assert unlink.status_code == 200 and unlink.json()["engineer_id"] is None
    assert null_roles.status_code == 422
    assert missing.status_code == 404
    rows = (
        (
            await db_session.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == "user.update")
                .where(AuditLogEntry.entity_id == str(target.id))
                .order_by(AuditLogEntry.occurred_at)
            )
        )
        .scalars()
        .all()
    )
    assert len(rows) == 2
    assert rows[0].actor_user_id == actor.id
    assert rows[0].before_state["full_name"] == "Before"
    assert rows[0].after_state["roles"] == ["Hub Planner"]
    engineer_link = (
        await db_session.execute(select(Engineer.user_id).where(Engineer.id == eng.id))
    ).scalar_one()
    assert engineer_link is None


async def test_last_super_admin_guard(db_session):
    me = await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        deactivate = await client.patch(f"/users/{me.id}", json={"is_active": False})
        demote = await client.patch(f"/users/{me.id}", json={"roles": ["Admin"]})
    assert deactivate.status_code == 409 and deactivate.json()["code"] == "LAST_SUPER_ADMIN"
    assert demote.status_code == 409 and demote.json()["code"] == "LAST_SUPER_ADMIN"

    # With a second active Super Admin the same change is allowed.
    second = await make_user(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        ok = await client.patch(f"/users/{me.id}", json={"roles": ["Admin"]})
        blocked = await client.patch(f"/users/{second.id}", json={"is_active": False})
    assert ok.status_code == 200 and ok.json()["roles"] == ["Admin"]
    assert blocked.status_code == 409


async def test_inactive_super_admin_does_not_count(db_session):
    me = await _act_as(db_session, RoleName.SUPER_ADMIN)
    await make_user(db_session, RoleName.SUPER_ADMIN, is_active=False)
    async with _client(db_session) as client:
        resp = await client.patch(f"/users/{me.id}", json={"is_active": False})
    assert resp.status_code == 409


async def test_super_admin_grants_admin(db_session):
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(
            "/users",
            json={"email": "boss@example.com", "full_name": "Boss", "roles": ["Admin"],
                  "hub_scope_all": True},
        )
    assert resp.status_code == 201
    assert resp.json()["roles"] == ["Admin"]


async def test_mention_search_is_withheld_while_oq8_open(db_session):
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    await make_user(db_session, email="findme@example.com", full_name="Find Me")
    async with _client(db_session) as client:
        resp = await client.get("/users/mention-search", params={"q": "find"})
    assert resp.status_code == 200
    assert resp.json() == []


async def test_mention_search_requires_workspace_read(db_session):
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        resp = await client.get("/users/mention-search", params={"q": "a"})
    assert resp.status_code == 403


async def test_super_admin_holds_admin_only_rights(db_session, monkeypatch):
    """ADR 0010 §1: every `require_roles(Admin)` gate admits Super Admin too."""

    import api.routers.schedule_runs as schedule_runs_module

    monkeypatch.setattr(schedule_runs_module, "publish_progress", lambda *a, **k: None)
    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        recalc = await client.post("/schedule-runs/greedy-recalc")
        rate = await client.put("/currency-rates/USD", json={"rate_to_eur": 1.1})
    assert recalc.status_code == 201, recalc.text
    assert rate.status_code in (200, 404)  # 404 only when the rate row is not seeded


# --- P10-F01: engineer-only hub_scope_all guard -----------------------------


async def test_create_user_rejects_engineer_only_hub_scope_all(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(
            "/users",
            json={
                "email": "bad-eng@example.com",
                "full_name": "Bad Engineer",
                "roles": ["Engineer"],
                "hub_scope_all": True,
            },
        )
    assert resp.status_code == 422


async def test_create_user_allows_multi_role_engineer_with_hub_scope_all(db_session):
    """The guard only fires for an Engineer-ONLY role set — a multi-role
    account (e.g. also Portfolio Manager) is unaffected, matching
    `services.hub_scope.is_engineer_self_scoped`'s own multi-role carve-out.
    """

    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(
            "/users",
            json={
                "email": "dual-role@example.com",
                "full_name": "Dual Role",
                "roles": ["Engineer", "Portfolio Manager"],
                "hub_scope_all": True,
            },
        )
    assert resp.status_code == 201, resp.text


async def test_update_user_rejects_engineer_only_hub_scope_all_via_roles(db_session):
    await _act_as(db_session, RoleName.ADMIN)
    target = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[])
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/users/{target.id}", json={"roles": ["Engineer"], "hub_scope_all": True}
        )
    assert resp.status_code == 422


async def test_update_user_rejects_hub_scope_all_on_existing_engineer_only_account(db_session):
    """The router-level guard (not just the schema's own-request-only
    validator) catches a PATCH that sets ONLY `hub_scope_all=True`, without
    touching `roles`, on an account that is already Engineer-only — this is
    exactly the P10-F01 gap the schema validator alone cannot see (it has no
    access to the target's current DB state).
    """

    await _act_as(db_session, RoleName.ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False)
    async with _client(db_session) as client:
        resp = await client.patch(f"/users/{target.id}", json={"hub_scope_all": True})
    assert resp.status_code == 422
    assert resp.json()["code"] == "ENGINEER_HUB_SCOPE_ALL_NOT_ALLOWED"


async def test_update_user_can_fix_a_legacy_engineer_hub_scope_all_account(db_session):
    """An Admin can still repair a pre-existing bad-shape account (forced
    directly via the factory, bypassing the schema guard, to simulate data
    from before this fix existed) by explicitly flipping `hub_scope_all` to
    `False` — the guard blocks the *bad* state, not corrective writes.
    """

    await _act_as(db_session, RoleName.ADMIN)
    target = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=True)
    async with _client(db_session) as client:
        resp = await client.patch(f"/users/{target.id}", json={"hub_scope_all": False})
    assert resp.status_code == 200
    assert resp.json()["hub_scope_all"] is False


# --- P10-F02: GET /users/me/manageable-projects -----------------------------


async def test_manageable_projects_no_surface_gate_for_bare_engineer(db_session):
    """No `user_role_admin`/`project_registration` gate at all — a bare
    Engineer (who holds neither) still gets a 200, empty when they have no
    admin-level project access anywhere.
    """

    await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    async with _client(db_session) as client:
        resp = await client.get("/users/me/manageable-projects")
    assert resp.status_code == 200
    assert resp.json() == []


async def test_manageable_projects_lists_hub_planner_admin_scope(db_session):
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project_a = await make_project(db_session, hub_a, name="In Scope")
    await make_project(db_session, hub_b, name="Out Of Scope")

    await _act_as(db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub_a.id])
    async with _client(db_session) as client:
        resp = await client.get("/users/me/manageable-projects")
    assert resp.status_code == 200
    body = resp.json()
    assert [p["name"] for p in body] == ["In Scope"]
    assert body[0]["id"] == str(project_a.id)
    assert body[0]["hub_id"] == str(hub_a.id)
    assert "customer_name" not in body[0] and "tcogs_eur" not in body[0]


async def test_manageable_projects_includes_grant_based_admin_access(db_session):
    """The exact motivating case (P10-F02): a manager-delegate holding a
    role with no `project_registration`/`user_role_admin` READ (Engineer)
    but an active Admin-level `ProjectAccessGrant` on one project — the
    picker must surface exactly that project, via rule 5 of
    `effective_project_access`, not the (unrelated, gate-blocked) `GET
    /projects` list.
    """

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, name="Delegated Project")
    other = await make_project(db_session, hub, name="Not Delegated")

    manager = await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)
    granter = await make_user(db_session, RoleName.SUPER_ADMIN)
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=manager.id,
            project_role="admin",
            granted_by_user_id=granter.id,
        )
    )
    await db_session.flush()

    async with _client(db_session) as client:
        resp = await client.get("/users/me/manageable-projects")
    assert resp.status_code == 200
    names = {p["name"] for p in resp.json()}
    assert names == {"Delegated Project"}
    assert "Not Delegated" not in names
    assert str(other.id) not in {p["id"] for p in resp.json()}
