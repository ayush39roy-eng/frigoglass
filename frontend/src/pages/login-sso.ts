/**
 * Production sign-in path (ADR 0013 §2) — the minimal, honest slice of the
 * standard OIDC authorization-code redirect.
 *
 * `docs/OPEN_QUESTIONS.md` #9 (which IdP) is still open, and no backend
 * callback/token-exchange endpoint exists yet (`api/routers/` has no
 * `/auth/callback` — `core/oidc.py` only verifies bearer tokens presented on
 * API requests, per `lib/api/client.ts`'s own "browser SSO redirect flow is
 * not built yet" note). Building a full PKCE round trip against a callback
 * that cannot complete would be worse than being explicit: this module only
 * exposes whether the two PUBLIC, non-secret config values
 * (`VITE_OIDC_ISSUER`, `VITE_OIDC_CLIENT_ID`) are set, and — only when they
 * are — builds a standard authorize-endpoint URL so the day OQ#9 is answered
 * and a callback exists, wiring the button is a config change, not a rewrite.
 */

export interface OidcConfig {
  issuer: string;
  clientId: string;
}

/** `undefined` unless BOTH public values are configured (`.env.example`). */
export function getOidcConfig(): OidcConfig | undefined {
  const issuer = import.meta.env.VITE_OIDC_ISSUER?.trim();
  const clientId = import.meta.env.VITE_OIDC_CLIENT_ID?.trim();
  if (!issuer || !clientId) return undefined;
  return { issuer: issuer.replace(/\/+$/, ''), clientId };
}

/** Standard OAuth2/OIDC authorization-code request against `{issuer}`'s
 *  authorize endpoint (Keycloak's `/protocol/openid-connect/auth` path,
 *  the dev IdP `core/oidc.py` is verified against — see that module's
 *  docstring on IdP-agnosticism). `state` is the caller's to generate and
 *  verify later, once a callback endpoint exists to receive it. */
export function buildAuthorizeUrl(config: OidcConfig, redirectUri: string, state: string): string {
  const url = new URL(`${config.issuer}/protocol/openid-connect/auth`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid profile email');
  url.searchParams.set('state', state);
  return url.toString();
}
