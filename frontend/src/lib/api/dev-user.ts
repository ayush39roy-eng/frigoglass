/**
 * Dev-mode acting-user selection (ADR 0010 §4).
 *
 * Only when the backend runs with `RPD_DEV_MODE=true` does `X-Dev-User-Email`
 * select which seeded user an unauthenticated request runs as. The login page
 * and the header switcher (`components/session/dev-role-switcher.tsx`) write
 * the choice here; `lib/api/client.ts` reads it on every request. It is not a
 * credential; sign-out clears it.
 *
 * ADR 0060 L1 (P49): the value lives in `sessionStorage` ONLY, so closing the
 * browser (every tab) ends the session. "Remember me" (P31-R01, which kept it
 * in `localStorage`) is removed, and `purgeLegacyDevUserEmail()` deletes any
 * old `localStorage` copy on startup. A new tab gets the session from an open
 * tab through the BroadcastChannel handshake (`lib/auth/session-channel.ts`).
 *
 * Kept as its own tiny module so the API client never has to import the
 * session store (which imports the API client — a cycle).
 */

export const DEV_USER_STORAGE_KEY = 'rpd-dev-user-email';

export function getDevUserEmail(): string | null {
  try {
    return window.sessionStorage.getItem(DEV_USER_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDevUserEmail(email: string | null): void {
  try {
    window.sessionStorage.removeItem(DEV_USER_STORAGE_KEY);
    if (email === null) return;
    window.sessionStorage.setItem(DEV_USER_STORAGE_KEY, email);
  } catch {
    // storage unavailable (privacy mode) — the switch just does not persist
  }
}

/** ADR 0060 L1: delete the pre-P49 "Remember me" copy, so a remembered login ends at the next load. */
export function purgeLegacyDevUserEmail(): void {
  try {
    window.localStorage.removeItem(DEV_USER_STORAGE_KEY);
  } catch {
    // storage unavailable — nothing to purge
  }
}
