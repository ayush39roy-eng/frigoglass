"""OIDC configuration — env-driven, per `docs/OPEN_QUESTIONS.md` #9 and this
task's (P3-T02) explicit instruction: no IdP-specific values (Entra tenant
IDs, Keycloak realm names, client secrets, ...) are ever hardcoded here. Every
value comes from `RPD_OIDC_*` environment variables, mirroring the
`RPD_DATABASE_URL` / `RPD_FIELD_ENCRYPTION_KEY` convention already established
by `api/db.py` / `models/types.py`.

**Open question, not a settled decision** (`docs/OPEN_QUESTIONS.md` #9 is still
open as of this task): `docs/PROJECT_AND_STACK.md` assumes Microsoft Entra ID
as the primary target with Keycloak as a local/dev fallback, but no real Entra
app registration exists yet. This module is written against the standard
OIDC/OAuth2 contract (issuer discovery via
`{issuer}/.well-known/openid-configuration`, JWKS signature validation,
standard `iss`/`aud`/`exp`/`sub` claims) so it is IdP-agnostic in practice —
swapping `RPD_OIDC_ISSUER`/`RPD_OIDC_AUDIENCE` from a Keycloak realm URL to an
Entra tenant URL requires no code change, only config. Keycloak is what this
task's dev/Docker-Compose environment stands up and live-verifies against
(see `docker-compose.auth.dev.yml` at the repo root); it is not the assumed
production IdP.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class OIDCSettings(BaseSettings):
    """No default `issuer`/`audience` — both must be explicitly configured
    (env or `.env`), so a misconfigured deployment fails loudly at startup
    (first token-verification attempt) rather than silently trusting an
    unintended issuer.
    """

    model_config = SettingsConfigDict(env_prefix="RPD_OIDC_", extra="ignore")

    #: e.g. `http://localhost:8080/realms/rpd` (dev Keycloak) or
    #: `https://login.microsoftonline.com/{tenant}/v2.0` (Entra ID, once P0-Q9
    #: is answered). Trailing slash is stripped so discovery-URL concatenation
    #: is consistent.
    issuer: str

    #: Expected `aud` claim on incoming access tokens. For Keycloak this is
    #: typically the client id (or `account` if audience mapping isn't
    #: customised); for Entra ID, the Application ID URI or client id.
    audience: str

    #: Public OAuth2 client id used by the (future, P4/P6) frontend login
    #: redirect flow. Not a secret — informational/config only. Optional here
    #: since P3-T02 is server-side token verification, not the browser login
    #: redirect itself.
    client_id: str | None = Field(default=None)

    #: Override for the JWKS endpoint. If unset, discovered from
    #: `{issuer}/.well-known/openid-configuration`'s `jwks_uri` at first use
    #: (standard OIDC discovery), per-issuer cached — see `core/oidc.py`.
    jwks_url: str | None = Field(default=None)

    #: Accepted JWS algorithms. RS256 is the near-universal default for both
    #: Keycloak and Entra ID; kept configurable rather than hardcoded so an
    #: IdP using a different algorithm doesn't require a code change.
    algorithms: list[str] = Field(default_factory=lambda: ["RS256"])

    #: Clock-skew tolerance for `exp`/`iat`/`nbf` validation.
    leeway_seconds: int = Field(default=30, ge=0)

    #: How long a fetched JWKS document is cached in-process before being
    #: re-fetched, so signing-key rotation on the IdP side is picked up within
    #: a bounded window without a network round-trip on every request.
    jwks_cache_seconds: int = Field(default=300, ge=0)

    @property
    def issuer_normalised(self) -> str:
        return self.issuer.rstrip("/")


@lru_cache
def get_oidc_settings() -> OIDCSettings:
    """Cached singleton — `OIDCSettings()` reads env vars at construction
    time; re-constructing per-request would be wasteful and would also mean a
    test that monkeypatches env vars mid-process wouldn't need
    `get_oidc_settings.cache_clear()` if it never ran once already. Tests that
    need a different config call `.cache_clear()` first.
    """

    return OIDCSettings()
