import { ApiError } from '@/lib/api/client';

/**
 * Test logins for local / demo environments (2026-10-01; P46, ADR 0058 L1).
 *
 * WHAT THIS IS: the sign-in form for backends running with `RPD_DEV_MODE=true`.
 * The SERVER checks the username (or email) and password (`POST /me/dev-login`,
 * which 404s outside dev mode); the browser holds no password and checks
 * nothing itself. The login page names no account and gives no password hint
 * (owner, 2026-11-18): the accounts are handed out outside the app.
 *
 * WHAT THIS IS NOT: security. Dev mode still lets any request act as a seeded
 * user through the dev-user header (ADR 0010 §4, OQ #107). Production signs in
 * through OIDC SSO (`login-sso.ts`), where none of this code runs.
 */

/** A missing field, checked before any request; null when both are filled. */
export function loginFormError(username: string, password: string): string | null {
  if (!username.trim()) return 'Enter your username or email.';
  if (!password) return 'Enter your password.';
  return null;
}

export const LOGIN_FAILED_MESSAGE = 'That username and password combination is not recognised.';

/** Plain copy for a failed `POST /me/dev-login`. A 401 is deliberately generic. */
export function devLoginErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return LOGIN_FAILED_MESSAGE;
    if (err.status === 429) {
      return err.retryAfterSeconds === undefined
        ? 'Too many sign-in attempts. Wait a minute and try again.'
        : `Too many sign-in attempts. Wait ${String(Math.max(1, err.retryAfterSeconds))} s and try again.`;
    }
    if (err.status === 404) return 'Test sign-in is not available on this server.';
    if (err.status === 0) return 'Could not reach the server. Check your connection and try again.';
  }
  return 'Sign-in failed. Please try again.';
}
