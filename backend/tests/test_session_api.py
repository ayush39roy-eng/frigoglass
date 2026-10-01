"""P9-T03: `GET /me`, `GET /me/dev-users` and the dev-mode `X-Dev-User-Email`
header (docs/API_CONTRACT_P9.md §1, ADR 0010 §2/§4).

These tests use the REAL `api.deps.get_current_principal` (no override),
against a real Postgres, because what they check is the auth fallback itself:

- dev mode ON + no Authorization + header → runs as that user;
- dev mode ON + no Authorization + no header → the seeded Admin;
- dev mode ON + unknown / inactive header email → 401 (no silent fallback);
- dev mode ON + Authorization present → header ignored;
- dev mode OFF (the default) → header ignored, unauthenticated → 401.
"""

from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

import core.oidc as oidc_module
from api.db import get_db
from api.main import app
from core.config import get_oidc_settings, is_dev_mode
from core.oidc import clear_jwks_cache
from core.rbac import Surface
from models.enums import HubName, LabRegion, RoleName
from models.project_access import ProjectAccessGrant
from tests.factories import make_engineer, make_hub, make_project, make_user
from tests.jwt_helpers import FakeIdPKeypair

ISSUER = "https://issuer.test/realms/rpd"
AUDIENCE = "rpd-backend"


@pytest.fixture(autouse=True)
def _oidc(monkeypatch):
    clear_jwks_cache()
    get_oidc_settings.cache_clear()
    monkeypatch.setenv("RPD_OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("RPD_OIDC_AUDIENCE", AUDIENCE)
    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    yield
    get_oidc_settings.cache_clear()
    clear_jwks_cache()


@pytest.fixture
def idp(monkeypatch) -> FakeIdPKeypair:
    kp = FakeIdPKeypair()

    async def _fake_get_jwks(_settings):
        return kp.jwks

    monkeypatch.setattr(oidc_module, "get_jwks", _fake_get_jwks)
    return kp


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    app.dependency_overrides.pop(get_db, None)


def test_dev_mode_is_off_by_default(monkeypatch):
    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    assert is_dev_mode() is False
    for value in ("true", "1", "YES", " True "):
        monkeypatch.setenv("RPD_DEV_MODE", value)
        assert is_dev_mode() is True
    for value in ("false", "0", "", "no", "on"):
        monkeypatch.setenv("RPD_DEV_MODE", value)
        assert is_dev_mode() is False


async def test_dev_header_selects_user_in_dev_mode(db_session, monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    hub = await make_hub(db_session)
    user = await make_user(
        db_session,
        RoleName.HUB_PLANNER,
        email="bob.dev@example.com",
        full_name="Bob Dev",
        hub_scope_all=False,
        hub_ids=[hub.id],
    )
    engineer = await make_engineer(db_session, hub)
    engineer.user_id = user.id
    await db_session.flush()

    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"X-Dev-User-Email": "bob.dev@example.com"})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["email"] == "bob.dev@example.com"
    assert body["roles"] == ["Hub Planner"]
    assert body["hub_scope_all"] is False
    assert body["hub_ids"] == [str(hub.id)]
    assert body["engineer_id"] == str(engineer.id)
    assert body["dev_mode"] is True
    assert set(body["permissions"]) == {s.value for s in Surface}
    assert body["permissions"]["capacity_planning"] == {"read": True, "write": True}
    assert body["permissions"]["workflow_settings"] == {"read": False, "write": False}
    assert body["permissions"]["audit_log"] == {"read": False, "write": False}


async def test_dev_mode_without_header_falls_back_to_seeded_admin(db_session, monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    await make_user(db_session, RoleName.ADMIN, email="frank.admin@example.com")
    async with _client(db_session) as client:
        resp = await client.get("/me")
    assert resp.status_code == 200
    assert resp.json()["roles"] == ["Admin"]


async def test_dev_header_unknown_or_inactive_email_is_401(db_session, monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    await make_user(db_session, RoleName.ADMIN, email="frank.admin@example.com")
    await make_user(db_session, RoleName.ADMIN, email="gone@example.com", is_active=False)
    async with _client(db_session) as client:
        unknown = await client.get("/me", headers={"X-Dev-User-Email": "nobody@example.com"})
        inactive = await client.get("/me", headers={"X-Dev-User-Email": "gone@example.com"})
        blank = await client.get("/me", headers={"X-Dev-User-Email": "  "})
    assert unknown.status_code == 401
    assert inactive.status_code == 401
    assert blank.status_code == 401


async def test_dev_header_ignored_outside_dev_mode(db_session, monkeypatch):
    """Security-critical (P9-T07 will verify): with dev mode off the header is
    never honoured, even when it names a real active Super Admin.
    """

    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    await make_user(db_session, RoleName.SUPER_ADMIN, email="sam.super@example.com")
    await make_user(db_session, RoleName.ADMIN, email="frank.admin@example.com")
    async with _client(db_session) as client:
        with_header = await client.get("/me", headers={"X-Dev-User-Email": "sam.super@example.com"})
        without = await client.get("/me")
        users = await client.get("/users", headers={"X-Dev-User-Email": "sam.super@example.com"})
    assert with_header.status_code == 401
    assert without.status_code == 401
    assert users.status_code == 401


async def test_dev_header_ignored_when_authorization_present(db_session, monkeypatch, idp):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    await make_user(db_session, RoleName.SUPER_ADMIN, email="sam.super@example.com")
    viewer = await make_user(
        db_session, RoleName.EXECUTIVE_VIEWER, email="dave@example.com", oidc_subject="dave-sub"
    )
    token = idp.sign(sub="dave-sub", iss=ISSUER, aud=AUDIENCE, email=viewer.email)
    async with _client(db_session) as client:
        resp = await client.get(
            "/me",
            headers={
                "Authorization": f"Bearer {token}",
                "X-Dev-User-Email": "sam.super@example.com",
            },
        )
    assert resp.status_code == 200
    assert resp.json()["email"] == "dave@example.com"
    assert resp.json()["roles"] == ["Executive Viewer"]
    assert resp.json()["dev_mode"] is True


async def test_me_with_bearer_token_outside_dev_mode(db_session, idp):
    user = await make_user(
        db_session, RoleName.SUPER_ADMIN, email="sam@example.com", oidc_subject="sam-sub"
    )
    token = idp.sign(sub="sam-sub", iss=ISSUER, aud=AUDIENCE, email=user.email)
    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["dev_mode"] is False
    assert body["engineer_id"] is None
    # Super Admin: every surface readable, every surface writable except the audit log.
    for surface, cell in body["permissions"].items():
        assert cell["read"] is True
        assert cell["write"] is (surface != "audit_log")


async def test_dev_users_404_outside_dev_mode(db_session, idp):
    user = await make_user(db_session, RoleName.ADMIN, oidc_subject="a-sub")
    token = idp.sign(sub="a-sub", iss=ISSUER, aud=AUDIENCE, email=user.email)
    async with _client(db_session) as client:
        resp = await client.get("/me/dev-users", headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 404


async def test_dev_users_404_outside_dev_mode_with_no_authorization_header(db_session):
    """Regression: this is the ACTUAL call the login page makes — no session
    exists yet, so there is no Authorization header at all. Requiring a
    principal here previously 401'd before the route's own dev-mode check
    ever ran, which the frontend doesn't treat as "outside dev mode" (only a
    clean 404 means that) — it showed a "could not reach the server" fallback
    on every production login instead of a quiet SSO-only screen."""
    async with _client(db_session) as client:
        resp = await client.get("/me/dev-users")
    assert resp.status_code == 404


async def test_dev_users_lists_active_users_with_roles(db_session, monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    await make_user(db_session, RoleName.ADMIN, email="frank.admin@example.com", full_name="F A")
    await make_user(db_session, RoleName.AUDITOR, email="erin@example.com", full_name="E A")
    await make_user(db_session, RoleName.AUDITOR, email="off@example.com", is_active=False)
    await make_user(db_session, email="norole@example.com")
    async with _client(db_session) as client:
        resp = await client.get("/me/dev-users")
    assert resp.status_code == 200
    emails = [row["email"] for row in resp.json()]
    assert "frank.admin@example.com" in emails and "erin@example.com" in emails
    assert "off@example.com" not in emails and "norole@example.com" not in emails
    erin = next(row for row in resp.json() if row["email"] == "erin@example.com")
    assert erin == {"email": "erin@example.com", "full_name": "E A", "roles": ["Auditor"]}


# --- P10-F03: is_delegate_manager -------------------------------------------


async def test_me_is_delegate_manager_false_with_no_reports(db_session, monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_project(db_session, hub)
    await make_user(
        db_session, RoleName.HUB_PLANNER, email="lonely@example.com",
        hub_scope_all=False, hub_ids=[hub.id],
    )
    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"X-Dev-User-Email": "lonely@example.com"})
    assert resp.status_code == 200
    assert resp.json()["is_delegate_manager"] is False


async def test_me_is_delegate_manager_false_with_reports_but_no_admin_access(
    db_session, monkeypatch
):
    """A manager with a direct report but zero admin-level project access
    anywhere (a bare Engineer manager, no grant) gets `False` — the Project
    Access tab would show them nothing useful.
    """

    monkeypatch.setenv("RPD_DEV_MODE", "true")
    manager = await make_user(
        db_session, RoleName.ENGINEER, email="mgr@example.com", hub_scope_all=False
    )
    report = await make_user(
        db_session, RoleName.ENGINEER, email="report@example.com", hub_scope_all=False
    )
    report.manager_id = manager.id
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"X-Dev-User-Email": "mgr@example.com"})
    assert resp.status_code == 200
    assert resp.json()["is_delegate_manager"] is False


async def test_me_is_delegate_manager_true_with_reports_and_admin_project_access(
    db_session, monkeypatch
):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    await make_project(db_session, hub)
    manager = await make_user(
        db_session, RoleName.HUB_PLANNER, email="hubmgr@example.com",
        hub_scope_all=False, hub_ids=[hub.id],
    )
    report = await make_user(
        db_session, RoleName.ENGINEER, email="report2@example.com", hub_scope_all=False
    )
    report.manager_id = manager.id
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"X-Dev-User-Email": "hubmgr@example.com"})
    assert resp.status_code == 200
    assert resp.json()["is_delegate_manager"] is True


async def test_me_is_delegate_manager_true_via_grant_based_admin_access(db_session, monkeypatch):
    """Same signal, reached via rule 5 (an active `ProjectAccessGrant`)
    instead of a role/hub-based rule — the manager here holds only Engineer,
    which grants no role-level project access at all.
    """

    monkeypatch.setenv("RPD_DEV_MODE", "true")
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub)
    super_admin = await make_user(db_session, RoleName.SUPER_ADMIN, email="root@example.com")
    manager = await make_user(
        db_session, RoleName.ENGINEER, email="delegate.mgr@example.com", hub_scope_all=False
    )
    report = await make_user(
        db_session, RoleName.ENGINEER, email="report3@example.com", hub_scope_all=False
    )
    report.manager_id = manager.id
    db_session.add(
        ProjectAccessGrant(
            project_id=project.id,
            user_id=manager.id,
            project_role="admin",
            granted_by_user_id=super_admin.id,
        )
    )
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.get("/me", headers={"X-Dev-User-Email": "delegate.mgr@example.com"})
    assert resp.status_code == 200
    assert resp.json()["is_delegate_manager"] is True
