"""Unit tests for `core.oidc.verify_token` — real RS256 signature
verification (via `tests.jwt_helpers.FakeIdPKeypair`) against a monkeypatched
JWKS source, so the crypto path itself is exercised, not just mocked away.
"""

from __future__ import annotations

import httpx
import pytest

import core.oidc as oidc_module
from core.config import OIDCSettings
from core.oidc import TokenValidationError, clear_jwks_cache, get_jwks, verify_token
from tests.jwt_helpers import FakeIdPKeypair

ISSUER = "https://issuer.test/realms/rpd"
AUDIENCE = "rpd-backend"


@pytest.fixture(autouse=True)
def _clear_cache():
    clear_jwks_cache()
    yield
    clear_jwks_cache()


@pytest.fixture
def idp() -> FakeIdPKeypair:
    return FakeIdPKeypair()


@pytest.fixture
def settings(monkeypatch, idp: FakeIdPKeypair) -> OIDCSettings:
    s = OIDCSettings(issuer=ISSUER, audience=AUDIENCE)

    async def _fake_get_jwks(_settings):
        return idp.jwks

    monkeypatch.setattr(oidc_module, "get_jwks", _fake_get_jwks)
    return s


async def test_verify_token_accepts_valid_signed_token(idp, settings):
    token = idp.sign(sub="user-1", iss=ISSUER, aud=AUDIENCE)
    claims = await verify_token(token, settings)
    assert claims["sub"] == "user-1"
    assert claims["email"] == "user@example.com"


async def test_verify_token_rejects_expired_token(idp, settings):
    token = idp.sign(iss=ISSUER, aud=AUDIENCE, exp_delta_seconds=-3600)
    with pytest.raises(TokenValidationError):
        await verify_token(token, settings)


async def test_verify_token_rejects_wrong_audience(idp, settings):
    token = idp.sign(iss=ISSUER, aud="some-other-client")
    with pytest.raises(TokenValidationError):
        await verify_token(token, settings)


async def test_verify_token_rejects_wrong_issuer(idp, settings):
    token = idp.sign(iss="https://not-the-real-issuer.test", aud=AUDIENCE)
    with pytest.raises(TokenValidationError):
        await verify_token(token, settings)


async def test_verify_token_rejects_token_signed_by_a_different_key(settings):
    """A second, unrelated keypair signs a token with the SAME claims — the
    JWKS the app trusts only contains the first keypair's public key, so
    signature verification must fail even though every claim looks valid.
    """
    attacker_idp = FakeIdPKeypair()
    token = attacker_idp.sign(iss=ISSUER, aud=AUDIENCE)
    with pytest.raises(TokenValidationError):
        await verify_token(token, settings)


async def test_verify_token_rejects_malformed_token(settings):
    with pytest.raises(TokenValidationError):
        await verify_token("not-a-jwt-at-all", settings)


async def test_verify_token_rejects_token_with_no_sub_claim(idp, settings):
    token = idp.sign(iss=ISSUER, aud=AUDIENCE, extra_claims={"sub": ""})
    with pytest.raises(TokenValidationError):
        await verify_token(token, settings)


async def test_get_jwks_uses_kid_omitted_single_key_fallback(idp, settings):
    """Some IdPs omit `kid` in the JWT header when there is only one active
    signing key — `core.oidc._find_signing_key` should still resolve it via
    the "exactly one key in the JWKS" fallback rather than failing closed on
    a spec technicality.
    """
    token = idp.sign(iss=ISSUER, aud=AUDIENCE, kid=None)
    claims = await verify_token(token, settings)
    assert claims["sub"] == "test-subject"


async def test_get_jwks_real_discovery_and_fetch_path_and_cache(monkeypatch, idp):
    """Exercises the REAL `get_jwks`/`_discover_jwks_uri` bodies (issuer
    discovery -> `jwks_uri` extraction -> fetch -> cache), not the
    monkeypatched-away version every other test in this file uses — via an
    `httpx.MockTransport` (a fake HTTP server, not a real network call, but
    real `httpx` request/response handling) so this doesn't depend on any
    real IdP being reachable in CI. The equivalent REAL end-to-end discovery
    (against a real, running Keycloak) is covered by this task's own live
    smoke test, not by pytest — see this task's MEMORY.md entry.
    """
    call_count = {"discovery": 0, "jwks": 0}

    def _handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/.well-known/openid-configuration"):
            call_count["discovery"] += 1
            return httpx.Response(200, json={"jwks_uri": f"{ISSUER}/protocol/openid-connect/certs"})
        if request.url.path.endswith("/protocol/openid-connect/certs"):
            call_count["jwks"] += 1
            return httpx.Response(200, json=idp.jwks)
        return httpx.Response(404)  # pragma: no cover - defensive only

    real_async_client = httpx.AsyncClient

    def _fake_async_client(*args, **kwargs):
        return real_async_client(transport=httpx.MockTransport(_handler))

    monkeypatch.setattr(oidc_module.httpx, "AsyncClient", _fake_async_client)
    settings = OIDCSettings(issuer=ISSUER, audience=AUDIENCE)

    jwks = await get_jwks(settings)
    assert jwks == idp.jwks
    assert call_count == {"discovery": 1, "jwks": 1}

    # Second call within the cache TTL must hit neither endpoint again.
    jwks_again = await get_jwks(settings)
    assert jwks_again == idp.jwks
    assert call_count == {"discovery": 1, "jwks": 1}


async def test_get_jwks_discovery_failure_raises_token_validation_error(monkeypatch):
    """No monkeypatch of `get_jwks` here — this exercises the REAL discovery
    path against an issuer that doesn't exist, confirming network/DNS
    failures surface as `TokenValidationError` (401-mappable), not an
    unhandled exception.
    """
    settings = OIDCSettings(
        issuer="https://this-issuer-does-not-exist.invalid.example",
        audience=AUDIENCE,
    )
    with pytest.raises(TokenValidationError):
        await oidc_module.get_jwks(settings)
