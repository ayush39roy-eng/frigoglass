"""`api.deps` integration tests against a real (test) Postgres:

- `get_current_principal` end-to-end: real RS256 JWT (via
  `tests.jwt_helpers.FakeIdPKeypair`, JWKS monkeypatched — same pattern as
  `tests/test_core_oidc.py`) -> real DB lookup of `models.user.User` (roles +
  hub scopes eagerly loaded) -> `core.principal.Principal`.
- The "no auto-provisioning" contract: an unprovisioned `sub`/`email` 401s
  rather than silently creating a `User` row.
- JIT `oidc_subject` linking by email on first SSO login.
- The email-conflict case (a different `oidc_subject` already linked).
- Inactive accounts 401.
- `require_permission`/`require_any_permission`/`require_roles` end-to-end
  through a live `AsyncClient` request against `api.main.app` (no
  `get_current_principal` override here — this hits the REAL dependency, is
  the point of this file, as opposed to `tests/test_rbac_enforcement.py`
  which overrides it for cheap per-endpoint coverage).
"""

from __future__ import annotations

import uuid

import pytest
from fastapi import HTTPException
from httpx import ASGITransport, AsyncClient

import core.oidc as oidc_module
from api.db import get_db
from api.main import app
from core.config import get_oidc_settings
from core.oidc import clear_jwks_cache
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import RoleName
from tests.factories import make_user
from tests.jwt_helpers import FakeIdPKeypair

ISSUER = "https://issuer.test/realms/rpd"
AUDIENCE = "rpd-backend"


@pytest.fixture(autouse=True)
def _oidc_settings(monkeypatch):
    clear_jwks_cache()
    get_oidc_settings.cache_clear()
    monkeypatch.setenv("RPD_OIDC_ISSUER", ISSUER)
    monkeypatch.setenv("RPD_OIDC_AUDIENCE", AUDIENCE)
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


def _teardown():
    app.dependency_overrides.pop(get_db, None)


async def test_get_current_principal_resolves_provisioned_user_by_oidc_subject(
    db_session, idp
):
    user = await make_user(
        db_session, RoleName.PORTFOLIO_MANAGER, oidc_subject="already-linked-sub"
    )
    token = idp.sign(sub="already-linked-sub", iss=ISSUER, aud=AUDIENCE, email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {token}"}
            )
        # Portfolio Manager has READ on Project Registration -> 200, not 401/403.
        assert resp.status_code == 200
    finally:
        _teardown()


async def test_get_current_principal_401s_with_no_authorization_header(db_session):
    try:
        async with _client(db_session) as client:
            resp = await client.get("/projects")
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_get_current_principal_401s_for_unprovisioned_identity(db_session, idp):
    """A validly-signed token for a `sub`/`email` with no matching `User` row
    at all — must 401, not silently create an account (see `api.deps`'s
    `_resolve_user` docstring: "this dependency should [not] make [that
    decision] unilaterally").
    """
    token = idp.sign(sub="nobody-provisioned", email="nobody@example.com")
    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {token}"}
            )
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_get_current_principal_jit_links_oidc_subject_by_email(db_session, idp):
    """A pre-provisioned `User` row (created by Admin, e.g. via seed data)
    with `oidc_subject=None` — first SSO login backfills it by matching
    `email`, per `models/user.py`'s own docstring ("Nullable so a user
    record can be provisioned ... before first SSO login").
    """
    user = await make_user(
        db_session,
        RoleName.PORTFOLIO_MANAGER,  # has PROJECT_REGISTRATION/READ -> a clean 200 below
        email="preprovisioned@example.com",
        oidc_subject=None,
    )
    await db_session.commit()  # visible to the handler's own db.commit() path
    token = idp.sign(sub="brand-new-sub", email="preprovisioned@example.com")

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {token}"}
            )
        assert resp.status_code == 200
    finally:
        _teardown()

    await db_session.refresh(user)
    assert user.oidc_subject == "brand-new-sub"


async def test_get_current_principal_401s_on_email_match_with_conflicting_oidc_subject(
    db_session, idp
):
    """The matched-by-email row already has a DIFFERENT `oidc_subject` linked
    — must not silently re-link to a second identity.
    """
    await make_user(
        db_session,
        RoleName.EXECUTIVE_VIEWER,
        email="shared@example.com",
        oidc_subject="original-sub",
    )
    await db_session.commit()
    token = idp.sign(sub="impersonating-sub", email="shared@example.com")

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {token}"}
            )
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_get_current_principal_401s_for_inactive_user(db_session, idp):
    user = await make_user(
        db_session,
        RoleName.PORTFOLIO_MANAGER,
        oidc_subject="inactive-sub",
        is_active=False,
    )
    token = idp.sign(sub="inactive-sub", email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {token}"}
            )
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_get_current_principal_401s_for_malformed_authorization_header(db_session):
    try:
        async with _client(db_session) as client:
            resp = await client.get("/projects", headers={"Authorization": "NotBearer xyz"})
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_get_current_principal_401s_for_token_with_bad_signature(db_session, idp):
    forged = FakeIdPKeypair().sign(sub="whoever", email="whoever@example.com")
    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {forged}"}
            )
        assert resp.status_code == 401
    finally:
        _teardown()


async def test_engineer_role_gets_403_on_project_registration(db_session, idp):
    user = await make_user(db_session, RoleName.ENGINEER, oidc_subject="eng-sub")
    token = idp.sign(sub="eng-sub", email=user.email)

    try:
        async with _client(db_session) as client:
            resp = await client.get(
                "/projects", headers={"Authorization": f"Bearer {token}"}
            )
        assert resp.status_code == 403
    finally:
        _teardown()


# --- require_permission / require_any_permission / require_roles, isolated
# unit tests of the three dependency-factory functions themselves (calling
# the returned async function directly with an explicit `Principal`, rather
# than going through FastAPI's DI container — these three factories are
# plain functions, so this is a legitimate, much cheaper unit-test path than
# a full HTTP round trip for every branch). ---


class _FakeRequest:
    """Minimal stand-in for `fastapi.Request` — only `.state` is touched by
    `require_permission`/`require_any_permission`/`require_roles`.
    """

    def __init__(self) -> None:
        self.state = type("State", (), {})()


def _principal(*roles: RoleName) -> Principal:
    return Principal(
        user_id=uuid.uuid4(),
        email="e@example.com",
        full_name="E",
        oidc_subject="s",
        roles=frozenset(roles),
    )


async def test_require_permission_denies_when_role_lacks_action():
    from api.deps import require_permission

    dep = require_permission(Surface.AUDIT_LOG, Action.READ)
    with pytest.raises(HTTPException) as exc_info:
        await dep(_FakeRequest(), _principal(RoleName.ENGINEER))
    assert exc_info.value.status_code == 403


async def test_require_permission_allows_and_stashes_principal_on_request_state():
    from api.deps import require_permission

    dep = require_permission(Surface.AUDIT_LOG, Action.READ)
    request = _FakeRequest()
    principal = _principal(RoleName.AUDITOR)
    result = await dep(request, principal)
    assert result is principal
    assert request.state.principal is principal


async def test_require_any_permission_allows_if_any_pair_matches():
    from api.deps import require_any_permission

    dep = require_any_permission(
        (Surface.DASHBOARD, Action.READ), (Surface.GANTT, Action.READ)
    )
    # Engineer has no Dashboard access but does have Gantt READ.
    result = await dep(_FakeRequest(), _principal(RoleName.ENGINEER))
    assert result.roles == {RoleName.ENGINEER}


async def test_require_any_permission_denies_if_no_pair_matches():
    from api.deps import require_any_permission

    dep = require_any_permission((Surface.DASHBOARD, Action.READ))
    with pytest.raises(HTTPException) as exc_info:
        await dep(_FakeRequest(), _principal(RoleName.AUDITOR))
    assert exc_info.value.status_code == 403


async def test_require_roles_allows_matching_role_and_denies_others():
    from api.deps import require_roles

    dep = require_roles(RoleName.ADMIN)
    result = await dep(_FakeRequest(), _principal(RoleName.ADMIN))
    assert result.roles == {RoleName.ADMIN}

    with pytest.raises(HTTPException) as exc_info:
        await dep(_FakeRequest(), _principal(RoleName.PORTFOLIO_MANAGER))
    assert exc_info.value.status_code == 403
