"""Scenario #9 — the currency-rates API (`GET /currency-rates`,
`PUT /currency-rates/{currency_code}`) against a real (test) Postgres.

Covers:
  - GET returns seeded rows (no auth required, per established precedent).
  - PUT (as Admin) updates rate_to_eur and the change is visible on a
    subsequent read.
  - PUT writes exactly one audit row with the expected before/after state
    AND the acting Admin's `actor_user_id` (P3-T02).
  - PUT RBAC: 401 with no token at all, 403 for a non-Admin role.
  - The 404 case: a *valid* CurrencyCode enum member with no corresponding
    `currency_rates` row (distinct from an unknown/invalid code, which never
    reaches the handler — see the 422 case below).
  - The 422 validation cases: `rate_to_eur <= 0` (Pydantic `Field(gt=0)`),
    and an unknown currency code (FastAPI's own enum path-param validation,
    confirmed to 422 *before* the handler runs — no audit row is written for
    that case, unlike the 404 case above).
"""

from __future__ import annotations

from decimal import Decimal

from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.currency import CurrencyRate
from models.enums import CurrencyCode, RoleName
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_user


async def _seed_eur_and_usd(db_session) -> None:
    """Deliberately does NOT seed INR — used by the 404 test below to prove
    a *valid* CurrencyCode enum member with no DB row 404s, distinct from an
    entirely unknown code (GBP) which 422s before the handler even runs.
    """
    db_session.add(CurrencyRate(currency_code=CurrencyCode.EUR, rate_to_eur=Decimal("1.0000")))
    db_session.add(CurrencyRate(currency_code=CurrencyCode.USD, rate_to_eur=Decimal("1.0800")))
    await db_session.flush()


async def _client(
    db_session, *, principal_roles: tuple[RoleName, ...] = (RoleName.ADMIN,)
) -> AsyncClient:
    """A real, DB-backed `User` row (via `tests.factories.make_user`) is
    created for the acting principal — not just an in-memory `Principal` with
    a random UUID — so that a test exercising a full mutation (which writes
    `AuditLogEntry.actor_user_id`, a real FK to `users.id`) doesn't hit a
    foreign-key violation.
    """

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    user = await make_user(db_session, *principal_roles)
    override_current_principal(make_principal(*principal_roles, user_id=user.id))
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def test_get_currency_rates_returns_seeded_rows(db_session):
    await _seed_eur_and_usd(db_session)
    try:
        async with await _client(db_session) as client:
            resp = await client.get("/currency-rates")
        assert resp.status_code == 200
        body = resp.json()
        assert {r["currency_code"] for r in body} == {"EUR", "USD"}
        by_code = {r["currency_code"]: r["rate_to_eur"] for r in body}
        assert by_code["EUR"] == 1.0
        assert by_code["USD"] == 1.08
    finally:
        _teardown()


async def test_put_currency_rate_updates_value_and_is_visible_on_next_get(db_session):
    await _seed_eur_and_usd(db_session)
    try:
        async with await _client(db_session) as client:
            put_resp = await client.put("/currency-rates/USD", json={"rate_to_eur": 1.5})
            assert put_resp.status_code == 200
            assert put_resp.json()["rate_to_eur"] == 1.5

            get_resp = await client.get("/currency-rates")
            usd_row = next(r for r in get_resp.json() if r["currency_code"] == "USD")
            assert usd_row["rate_to_eur"] == 1.5
    finally:
        _teardown()

    result = await db_session.execute(
        select(CurrencyRate).where(CurrencyRate.currency_code == CurrencyCode.USD)
    )
    row = result.scalar_one()
    assert row.rate_to_eur == Decimal("1.5000")
    # P3-T02: `updated_by_user_id` (a real column since P1-T02, never set by
    # P1-T04's original no-auth stub) is now populated with the real actor.
    assert row.updated_by_user_id is not None


async def test_put_writes_exactly_one_audit_row_with_before_after_state(db_session):
    await _seed_eur_and_usd(db_session)
    try:
        async with await _client(db_session) as client:
            resp = await client.put("/currency-rates/USD", json={"rate_to_eur": 1.5})
        assert resp.status_code == 200
    finally:
        _teardown()

    result = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    audit_rows = result.scalars().all()
    assert len(audit_rows) == 1

    audit = audit_rows[0]
    assert audit.entity_type == "CurrencyRate"
    assert audit.actor_user_id is not None  # P3-T02: real actor attribution
    assert audit.before_state["currency_code"] == "USD"
    assert Decimal(audit.before_state["rate_to_eur"]) == Decimal("1.0800")
    assert audit.after_state["currency_code"] == "USD"
    assert Decimal(audit.after_state["rate_to_eur"]) == Decimal("1.5000")


async def test_put_unknown_but_valid_currency_code_returns_404(db_session):
    """INR is a valid `CurrencyCode` enum member (so it passes FastAPI's
    path-param validation and reaches the handler) but has no seeded
    `currency_rates` row in this test — this exercises the handler's own
    `HTTPException(404)` branch specifically, not the enum-validation 422
    below.
    """
    await _seed_eur_and_usd(db_session)  # EUR, USD only — no INR row
    try:
        async with await _client(db_session) as client:
            resp = await client.put("/currency-rates/INR", json={"rate_to_eur": 99.0})
        assert resp.status_code == 404
    finally:
        _teardown()

    # No audit row should have been written for a failed (404) update.
    result = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    assert result.scalars().all() == []


async def test_put_unrecognised_currency_code_returns_422_before_reaching_handler(db_session):
    """GBP is not a `CurrencyCode` member at all — FastAPI's own path-param
    enum validation rejects it with 422 before `update_currency_rate` ever
    runs (per the P1-T04 MEMORY.md entry's own claim). Confirmed here by
    asserting no audit row is written — if this reached the handler and hit
    the 404 branch instead, this test would still fail on the status code
    assertion, but the audit-row assertion additionally rules out "reached
    the handler and errored some other way."
    """
    await _seed_eur_and_usd(db_session)
    try:
        async with await _client(db_session) as client:
            resp = await client.put("/currency-rates/GBP", json={"rate_to_eur": 1.0})
        assert resp.status_code == 422
    finally:
        _teardown()

    result = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    assert result.scalars().all() == []


async def test_put_non_positive_rate_returns_422(db_session):
    await _seed_eur_and_usd(db_session)
    try:
        async with await _client(db_session) as client:
            resp_negative = await client.put("/currency-rates/USD", json={"rate_to_eur": -1})
            assert resp_negative.status_code == 422

            resp_zero = await client.put("/currency-rates/USD", json={"rate_to_eur": 0})
            assert resp_zero.status_code == 422
    finally:
        _teardown()

    # Neither invalid attempt should have changed the stored rate or written
    # an audit row.
    result = await db_session.execute(
        select(CurrencyRate).where(CurrencyRate.currency_code == CurrencyCode.USD)
    )
    assert result.scalar_one().rate_to_eur == Decimal("1.0800")
    audit_result = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    assert audit_result.scalars().all() == []


async def test_put_currency_rate_without_a_token_returns_401(db_session):
    """No override of `get_current_principal` at all here (unlike every other
    test in this file) — this exercises the REAL `get_current_principal`
    dependency with no `Authorization` header, proving the endpoint is
    genuinely gated, not just gated in tests that happen to supply a fake
    principal.
    """
    await _seed_eur_and_usd(db_session)

    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.put("/currency-rates/USD", json={"rate_to_eur": 1.5})
        assert resp.status_code == 401
    finally:
        app.dependency_overrides.pop(get_db, None)

    result = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    assert result.scalars().all() == []


async def test_put_currency_rate_as_non_admin_role_returns_403(db_session):
    """Portfolio Manager (a real role with write access on several other
    surfaces) still gets 403 here — currency-rate config is Admin-only.
    """
    await _seed_eur_and_usd(db_session)
    pm_only = (RoleName.PORTFOLIO_MANAGER,)
    try:
        async with await _client(db_session, principal_roles=pm_only) as client:
            resp = await client.put("/currency-rates/USD", json={"rate_to_eur": 1.5})
        assert resp.status_code == 403
    finally:
        _teardown()

    result = await db_session.execute(
        select(AuditLogEntry).where(AuditLogEntry.action == "currency_rate.update")
    )
    assert result.scalars().all() == []
