"""P46-T02 (ADR 0058 L1): the two dev-mode test logins.

- Provisioning (`services.dev_accounts.provision_dev_accounts`): creates the
  two accounts, repairs a missing role or an inactive flag and nothing else,
  and is idempotent (a second run writes nothing).
- Startup hook: a no-op outside dev mode.
- `GET /me/dev-users`: exactly the two accounts.
- `POST /me/dev-login`: username or email, password = username, one generic
  401 for every failure, 404 outside dev mode, rate-limited per client IP.

These use the REAL `get_current_principal` path (no override): the endpoints
under test run before any session exists.
"""

from __future__ import annotations

import logging

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.orm import selectinload

import api.routers.me as me_router
import services.dev_accounts as dev_accounts
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.user import User, UserRole
from services.dev_accounts import (
    AUDIT_ACTION,
    DEV_LOGIN_EMAILS,
    account_for_login,
    provision_dev_accounts,
)
from tests.factories import make_user

SUPER = "superadmin@example.com"
ADMIN = "admin@example.com"


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    me_router.DEV_LOGIN_RATE_LIMIT.reset()
    yield
    me_router.DEV_LOGIN_RATE_LIMIT.reset()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _user(db_session, email: str) -> User | None:
    return (
        await db_session.execute(
            select(User)
            .options(selectinload(User.roles).selectinload(UserRole.role))
            .where(func.lower(User.email) == email)
            .execution_options(populate_existing=True)
        )
    ).scalar_one_or_none()


def _roles(user: User) -> set[str]:
    return {str(ur.role.name) for ur in user.roles}


async def _audits(db_session) -> list[AuditLogEntry]:
    stmt = select(AuditLogEntry).where(AuditLogEntry.action == AUDIT_ACTION)
    return list((await db_session.execute(stmt)).scalars().all())


# --- provisioning ---------------------------------------------------------------


async def test_provisioning_creates_both_accounts_and_audits_with_null_actor(db_session):
    assert await provision_dev_accounts(db_session) == {
        "superadmin": "created",
        "admin": "created",
    }
    sup = await _user(db_session, SUPER)
    adm = await _user(db_session, ADMIN)
    assert sup is not None and adm is not None
    assert (sup.full_name, sup.is_active, sup.hub_scope_all) == ("Super Admin", True, True)
    assert (adm.full_name, adm.is_active, adm.hub_scope_all) == ("Admin", True, True)
    assert _roles(sup) == {"Super Admin"} and _roles(adm) == {"Admin"}

    audits = await _audits(db_session)
    assert len(audits) == 2
    assert all(a.actor_user_id is None and a.before_state is None for a in audits)
    assert {a.entity_id for a in audits} == {str(sup.id), str(adm.id)}


async def test_provisioning_is_idempotent(db_session):
    await provision_dev_accounts(db_session)
    first = {e: (await _user(db_session, e)) for e in DEV_LOGIN_EMAILS}
    ids = {e: u.id for e, u in first.items() if u is not None}

    assert await provision_dev_accounts(db_session) == {
        "superadmin": "unchanged",
        "admin": "unchanged",
    }
    assert len(await _audits(db_session)) == 2  # nothing new written
    for email in DEV_LOGIN_EMAILS:
        again = await _user(db_session, email)
        assert again is not None and again.id == ids[email]
        assert len(again.roles) == 1
    count = (
        await db_session.execute(
            select(func.count())
            .select_from(User)
            .where(func.lower(User.email).in_(DEV_LOGIN_EMAILS))
        )
    ).scalar_one()
    assert count == 2


async def test_provisioning_repairs_role_and_active_flag_and_nothing_else(db_session):
    # An existing admin@ that was deactivated, renamed, hub-scoped and given
    # another role instead of Admin.
    adm = await make_user(
        db_session, RoleName.AUDITOR, email=ADMIN, full_name="Renamed", is_active=False,
        hub_scope_all=False,
    )  # fmt: skip
    # superadmin@ exists, active, and already holds Super Admin plus Auditor.
    sup = await make_user(
        db_session, RoleName.SUPER_ADMIN, RoleName.AUDITOR, email=SUPER, full_name="Sam"
    )

    assert await provision_dev_accounts(db_session) == {
        "superadmin": "unchanged",
        "admin": "repaired",
    }
    adm_after = await _user(db_session, ADMIN)
    assert adm_after is not None and adm_after.id == adm.id
    assert adm_after.is_active is True
    assert _roles(adm_after) == {"Auditor", "Admin"}  # role added, none removed
    assert adm_after.full_name == "Renamed"  # untouched
    assert adm_after.hub_scope_all is False  # untouched
    sup_after = await _user(db_session, SUPER)
    assert sup_after is not None and sup_after.full_name == "Sam"
    assert _roles(sup_after) == {"Super Admin", "Auditor"}

    (audit,) = await _audits(db_session)
    assert audit.actor_user_id is None and audit.entity_id == str(adm.id)
    assert audit.before_state["is_active"] is False
    assert audit.before_state["roles"] == ["Auditor"]
    assert audit.after_state["is_active"] is True
    assert audit.after_state["roles"] == ["Admin", "Auditor"]
    assert sup.id == sup_after.id


async def test_startup_hook_is_a_noop_outside_dev_mode(monkeypatch):
    monkeypatch.delenv("RPD_DEV_MODE", raising=False)

    def _boom():
        raise AssertionError("must not open a session outside dev mode")

    import api.db as api_db

    monkeypatch.setattr(api_db, "get_session_factory", _boom)
    await dev_accounts.provision_dev_accounts_at_startup()


async def test_startup_hook_failure_does_not_raise(monkeypatch, caplog):
    import api.db as api_db

    def _broken():
        raise RuntimeError("no database")

    monkeypatch.setattr(api_db, "get_session_factory", _broken)
    with caplog.at_level(logging.WARNING, logger="services.dev_accounts"):
        await dev_accounts.provision_dev_accounts_at_startup()
    assert "RuntimeError" in caplog.text


def test_account_for_login_accepts_username_or_email():
    assert account_for_login("superadmin").email == SUPER  # type: ignore[union-attr]
    assert account_for_login(" Admin@Example.com ").username == "admin"  # type: ignore[union-attr]
    assert account_for_login("frank.admin@example.com") is None
    assert account_for_login("") is None


# --- GET /me/dev-users ----------------------------------------------------------------


async def test_dev_users_lists_exactly_the_two_accounts(db_session):
    await make_user(db_session, RoleName.ADMIN, email="frank.admin@example.com")
    await make_user(db_session, RoleName.AUDITOR, email="erin@example.com")
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        resp = await client.get("/me/dev-users")
    assert resp.status_code == 200, resp.text
    assert resp.json() == [
        {"email": SUPER, "full_name": "Super Admin", "roles": ["Super Admin"]},
        {"email": ADMIN, "full_name": "Admin", "roles": ["Admin"]},
    ]


async def test_dev_users_omits_an_inactive_test_account(db_session):
    await provision_dev_accounts(db_session)
    adm = await _user(db_session, ADMIN)
    assert adm is not None
    adm.is_active = False
    await db_session.flush()
    async with _client(db_session) as client:
        resp = await client.get("/me/dev-users")
    assert [r["email"] for r in resp.json()] == [SUPER]


# --- POST /me/dev-login ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("username", "password", "email", "role"),
    [
        ("superadmin", "superadmin", SUPER, "Super Admin"),
        ("admin", "admin", ADMIN, "Admin"),
        (SUPER, "superadmin", SUPER, "Super Admin"),
        ("  ADMIN@example.com", "admin", ADMIN, "Admin"),
    ],
)
async def test_dev_login_success(db_session, username, password, email, role):
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        resp = await client.post("/me/dev-login", json={"username": username, "password": password})
        # The answered email is then used as X-Dev-User-Email.
        me = await client.get("/me", headers={"X-Dev-User-Email": resp.json()["email"]})
    assert resp.status_code == 200, resp.text
    assert resp.json()["email"] == email and resp.json()["roles"] == [role]
    assert me.status_code == 200 and me.json()["roles"] == [role]


@pytest.mark.parametrize(
    ("username", "password"),
    [
        ("admin", "superadmin"),  # wrong password (another account's)
        ("superadmin", "Superadmin"),  # case matters for the password
        ("admin", ""),
        ("superadmin", "rpd-test-2026"),  # the retired shared password
        ("frank.admin@example.com", "frank.admin@example.com"),  # unknown user
        ("nobody", "nobody"),
        ("", ""),
        ("admin", "admin" * 100),
    ],
)
async def test_dev_login_failures_are_one_generic_401(db_session, username, password):
    await make_user(db_session, RoleName.ADMIN, email="frank.admin@example.com")
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        resp = await client.post("/me/dev-login", json={"username": username, "password": password})
    assert resp.status_code == 401
    assert resp.json() == {"detail": "Invalid username or password."}


async def test_dev_login_never_logs_or_echoes_the_password(db_session, caplog):
    await provision_dev_accounts(db_session)
    secret = "Zq9-unlogged-pw-7731"
    with caplog.at_level(logging.DEBUG):
        async with _client(db_session) as client:
            resp = await client.post(
                "/me/dev-login", json={"username": "admin", "password": secret}
            )
    assert resp.status_code == 401
    assert secret not in caplog.text
    assert secret not in resp.text


async def test_dev_login_401_when_account_inactive_or_missing(db_session):
    async with _client(db_session) as client:
        missing = await client.post(
            "/me/dev-login", json={"username": "admin", "password": "admin"}
        )
    await provision_dev_accounts(db_session)
    adm = await _user(db_session, ADMIN)
    assert adm is not None
    adm.is_active = False
    await db_session.flush()
    async with _client(db_session) as client:
        inactive = await client.post(
            "/me/dev-login", json={"username": "admin", "password": "admin"}
        )
    assert missing.status_code == 401 and inactive.status_code == 401
    assert missing.json() == inactive.json()


async def test_dev_login_404_outside_dev_mode(db_session, monkeypatch):
    await provision_dev_accounts(db_session)
    monkeypatch.delenv("RPD_DEV_MODE", raising=False)
    async with _client(db_session) as client:
        good = await client.post("/me/dev-login", json={"username": "admin", "password": "admin"})
        bad_body = await client.post("/me/dev-login", json={"nope": 1})
        users = await client.get("/me/dev-users")
    assert good.status_code == 404
    assert bad_body.status_code == 404
    assert users.status_code == 404


async def test_dev_login_rate_limited_per_ip(db_session):
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        codes = [
            (
                await client.post("/me/dev-login", json={"username": "admin", "password": "x"})
            ).status_code
            for _ in range(int(me_router.DEV_LOGIN_RATE_LIMIT.capacity))
        ]
        limited = await client.post(
            "/me/dev-login", json={"username": "admin", "password": "admin"}
        )
    assert codes == [401] * int(me_router.DEV_LOGIN_RATE_LIMIT.capacity)
    assert limited.status_code == 429
    assert limited.json()["code"] == "RATE_LIMITED"
    assert int(limited.headers["Retry-After"]) >= 1
    # Another peer address has its own bucket.
    allowed, _ = me_router.DEV_LOGIN_RATE_LIMIT.allow("peer:10.0.0.9")
    assert allowed


async def _exhaust(client, headers: dict[str, str]) -> list[int]:
    return [
        (
            await client.post(
                "/me/dev-login", json={"username": "admin", "password": "x"}, headers=headers
            )
        ).status_code
        for _ in range(int(me_router.DEV_LOGIN_RATE_LIMIT.capacity) + 1)
    ]


async def test_dev_login_limit_keyed_on_left_most_forwarded_for(db_session):
    """P46-R01 (security L-1): behind Render's proxy every request has the
    same peer address, so the key is the left-most `X-Forwarded-For` entry.
    One client exhausting its bucket does not block another."""

    await provision_dev_accounts(db_session)
    cap = int(me_router.DEV_LOGIN_RATE_LIMIT.capacity)
    async with _client(db_session) as client:
        a = await _exhaust(client, {"X-Forwarded-For": "203.0.113.7, 10.0.0.1"})
        # Same client through another proxy hop: same bucket.
        a_again = await client.post(
            "/me/dev-login",
            json={"username": "admin", "password": "admin"},
            headers={"X-Forwarded-For": "203.0.113.7"},
        )
        b = await client.post(
            "/me/dev-login",
            json={"username": "admin", "password": "admin"},
            headers={"X-Forwarded-For": "198.51.100.4, 10.0.0.1"},
        )
        # No header: the peer address has its own, untouched bucket.
        peer = await client.post("/me/dev-login", json={"username": "admin", "password": "admin"})
    assert a == [401] * cap + [429]
    assert a_again.status_code == 429
    assert b.status_code == 200, b.text
    assert peer.status_code == 200, peer.text


async def test_dev_login_overlong_or_empty_forwarded_for_falls_back_to_peer(db_session):
    await provision_dev_accounts(db_session)
    async with _client(db_session) as client:
        await _exhaust(client, {})
        for header in ("x" * 65, " , 203.0.113.7", ""):
            resp = await client.post(
                "/me/dev-login",
                json={"username": "admin", "password": "admin"},
                headers={"X-Forwarded-For": header},
            )
            assert resp.status_code == 429, header


def test_dev_login_limiter_is_bounded():
    assert me_router.DEV_LOGIN_RATE_LIMIT.max_keys == 10_000


def test_token_bucket_max_keys_evicts_least_recently_used():
    from services.rate_limit import TokenBucketLimiter

    limiter = TokenBucketLimiter(capacity=1, refill_per_second=0.001, max_keys=3)
    for key in ("a", "b", "c"):
        assert limiter.allow(key, now=0.0)[0]
    assert not limiter.allow("a", now=0.0)[0]  # "a" used again: now most recent
    assert limiter.allow("d", now=0.0)[0]  # evicts "b", the least recent
    assert len(limiter) == 3
    assert limiter.allow("b", now=0.0)[0]  # fresh bucket after eviction
    assert not limiter.allow("a", now=0.0)[0]  # "a" was kept
    for i in range(1000):
        limiter.allow(f"k{i}", now=0.0)
    assert len(limiter) == 3


def test_token_bucket_without_max_keys_is_unchanged():
    from services.rate_limit import TokenBucketLimiter

    limiter = TokenBucketLimiter(capacity=2, refill_per_second=1.0)
    assert limiter.max_keys is None
    assert [limiter.allow("k", now=0.0)[0] for _ in range(3)] == [True, True, False]
    assert limiter.allow("k", now=1.0)[0]
    for i in range(50):
        limiter.allow(f"x{i}", now=0.0)
    assert len(limiter) == 51


async def test_dev_login_rejects_extra_fields(db_session):
    async with _client(db_session) as client:
        resp = await client.post(
            "/me/dev-login", json={"username": "admin", "password": "admin", "role": "x"}
        )
    assert resp.status_code == 422
