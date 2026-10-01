import type { DevUser } from '@/lib/api/session';
import type { RoleName } from '@/types/enums';

/**
 * Test logins for local / demo environments (2026-10-01).
 *
 * WHAT THIS IS: a sign-in screen for backends running with `RPD_DEV_MODE=true`.
 * Every seeded user can sign in with the shared test password below. The check
 * runs in the browser against the server's own seeded-user list
 * (`GET /me/dev-users`, which 404s outside dev mode).
 *
 * WHAT THIS IS NOT: security. Dev mode already lets any request act as a
 * seeded user, so this password is a demo convention, not a secret, and it is
 * never sent to the server. Production signs in through OIDC SSO
 * (`login-sso.ts`), where none of this code runs.
 */
export const TEST_LOGIN_PASSWORD = 'rpd-test-2026';

export type TestLoginResult = { ok: true; user: DevUser } | { ok: false; error: string };

export function verifyTestLogin(email: string, password: string, users: readonly DevUser[]): TestLoginResult {
  const normalised = email.trim().toLowerCase();
  if (!normalised) return { ok: false, error: 'Enter your email address.' };
  if (!password) return { ok: false, error: 'Enter your password.' };
  const user = users.find((u) => u.email.toLowerCase() === normalised);
  if (!user || password !== TEST_LOGIN_PASSWORD) {
    // One message for both cases, so the form does not reveal which accounts exist.
    return { ok: false, error: 'That email and password combination is not recognised.' };
  }
  return { ok: true, user };
}

/** One suggested account per role, most privileged first — the "Test logins" panel. */
export function pickTestAccounts(users: readonly DevUser[], order: readonly RoleName[]): DevUser[] {
  const picked: DevUser[] = [];
  for (const role of order) {
    const user = users.find((u) => u.roles.includes(role) && !picked.includes(u));
    if (user) picked.push(user);
  }
  return picked;
}
