"""Standard OIDC/OAuth2 authorization-code-flow token verification: issuer
discovery, JWKS fetch + cache, and JWT signature/claims validation.

Deliberately IdP-agnostic (per `docs/OPEN_QUESTIONS.md` #9 — no real Entra ID
app registration exists yet): this module only relies on the parts of the
OIDC spec every conformant IdP implements (`.well-known/openid-configuration`
discovery, a JWKS endpoint, RFC 7519 JWT claims). It has been live-verified
against a Keycloak instance (this task's concrete dev/test IdP) but contains
no Keycloak-specific or Entra-specific branching.

Uses `pyjwt[crypto]` (not `python-jose`, see docs/MEMORY.md P3-T09 entry):
`python-jose[cryptography]` pulls in the unmaintained `ecdsa` package as a
transitive dependency purely to support ES*-family algorithms we never
configure (`OIDCSettings.algorithms` defaults to, and both Keycloak and
Entra sign with, RS256 only) — `ecdsa` 0.19.2 carries PYSEC-2026-1325 (a
Minerva-class timing side-channel with no fix version planned). `pyjwt[crypto]`
verifies every algorithm family (RS*, ES*, PS*, HS*) using `cryptography`
directly and never imports `ecdsa`, removing the vulnerable package from the
dependency graph entirely rather than merely avoiding the vulnerable code
path.
"""

from __future__ import annotations

import time
from typing import Any, cast

import httpx
import jwt
from jwt import PyJWK
from jwt.exceptions import PyJWTError

from core.config import OIDCSettings

_HTTP_TIMEOUT_SECONDS = 5.0


class TokenValidationError(Exception):
    """Raised for any reason a bearer token cannot be trusted: missing,
    malformed, expired, wrong issuer/audience, bad signature, or the IdP's
    JWKS/discovery endpoint being unreachable. Callers (see `api/deps.py`)
    treat this uniformly as "the caller is not authenticated" (HTTP 401) —
    the specific reason is included in the message for logs/debugging only,
    never surfaced verbatim to the client as a security-relevant detail.
    """


# Per-issuer in-memory cache: issuer -> (jwks_dict, fetched_at_monotonic).
# Module-level and process-wide (not per-request) since JWKS documents are
# public, non-sensitive, and change only on IdP key rotation — a short TTL
# (see `OIDCSettings.jwks_cache_seconds`) is enough to pick that up without
# a network round-trip per incoming request.
_jwks_cache: dict[str, tuple[dict[str, Any], float]] = {}


def clear_jwks_cache() -> None:
    """Test-only helper — forces the next `get_jwks()` call to re-fetch."""

    _jwks_cache.clear()


async def _discover_jwks_uri(issuer: str) -> str:
    discovery_url = f"{issuer}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
        try:
            resp = await client.get(discovery_url)
            resp.raise_for_status()
            document = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise TokenValidationError(
                f"OIDC discovery failed for issuer {issuer!r}: {exc}"
            ) from exc

    jwks_uri = document.get("jwks_uri")
    if not jwks_uri:
        raise TokenValidationError(
            f"OIDC discovery document for issuer {issuer!r} has no 'jwks_uri'"
        )
    return cast(str, jwks_uri)


async def get_jwks(settings: OIDCSettings) -> dict[str, Any]:
    """Returns the JWKS document (`{"keys": [...]}`)  for `settings.issuer`,
    using `settings.jwks_url` directly if configured, otherwise discovering it
    via the issuer's `.well-known/openid-configuration`. Cached per-issuer for
    `settings.jwks_cache_seconds`.
    """

    issuer = settings.issuer_normalised
    cached = _jwks_cache.get(issuer)
    now = time.monotonic()
    if cached is not None and (now - cached[1]) < settings.jwks_cache_seconds:
        return cached[0]

    jwks_uri = settings.jwks_url or await _discover_jwks_uri(issuer)
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT_SECONDS) as client:
        try:
            resp = await client.get(jwks_uri)
            resp.raise_for_status()
            jwks = resp.json()
        except (httpx.HTTPError, ValueError) as exc:
            raise TokenValidationError(
                f"Fetching JWKS from {jwks_uri!r} failed: {exc}"
            ) from exc

    _jwks_cache[issuer] = (jwks, now)
    return cast(dict[str, Any], jwks)


def _find_signing_key(jwks: dict[str, Any], kid: str | None) -> dict[str, Any]:
    keys: list[dict[str, Any]] = jwks.get("keys", [])
    if kid is not None:
        for key in keys:
            if key.get("kid") == kid:
                return key
    if len(keys) == 1:
        # Some IdPs (esp. simple dev Keycloak realms) omit `kid` when there is
        # only one active signing key — fall back to it rather than failing
        # closed on a spec-technicality when there is no real ambiguity.
        return keys[0]
    raise TokenValidationError(f"No matching JWKS signing key for kid={kid!r}")


async def verify_token(token: str, settings: OIDCSettings) -> dict[str, Any]:
    """Validate signature (via JWKS), `iss`, `aud`, and `exp`/`nbf`/`iat`
    (with `settings.leeway_seconds` clock skew). Returns the decoded claims
    dict on success. Raises `TokenValidationError` on any failure — never
    returns a partially-trusted result.
    """

    try:
        unverified_header = jwt.get_unverified_header(token)
    except PyJWTError as exc:
        raise TokenValidationError(f"Malformed token header: {exc}") from exc

    jwks = await get_jwks(settings)
    signing_key = _find_signing_key(jwks, unverified_header.get("kid"))

    try:
        # `PyJWK` needs to know which algorithm family the JWK material
        # should be loaded as. Prefer the token header's declared `alg`
        # (falling back to the JWK's own `alg`, if present) — this only
        # selects the key-loading routine; `jwt.decode`'s `algorithms=`
        # allow-list below is what actually enforces which algorithms are
        # trusted, so a forged header `alg` cannot widen acceptance.
        key_algorithm = unverified_header.get("alg") or signing_key.get("alg")
        public_key = PyJWK(signing_key, algorithm=key_algorithm).key
        claims = jwt.decode(
            token,
            public_key,
            algorithms=settings.algorithms,
            audience=settings.audience,
            issuer=settings.issuer_normalised,
            leeway=settings.leeway_seconds,
        )
    except PyJWTError as exc:
        raise TokenValidationError(f"Token validation failed: {exc}") from exc

    if not claims.get("sub"):
        raise TokenValidationError("Token has no 'sub' claim")

    return claims
