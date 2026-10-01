/**
 * Dev-mode acting-user selection (ADR 0010 §4).
 *
 * Only when the backend runs with `RPD_DEV_MODE=true` does `X-Dev-User-Email`
 * select which seeded user an unauthenticated request runs as. The header
 * switcher in the app header (`components/session/dev-role-switcher.tsx`)
 * writes the choice here; `lib/api/client.ts` reads it on every request. The
 * value lives in `sessionStorage` (per-tab, cleared when the tab closes) — it
 * is not a credential and is never persisted across sessions.
 *
 * Kept as its own tiny module so the API client never has to import the
 * session store (which imports the API client — a cycle).
 */

const STORAGE_KEY = 'rpd-dev-user-email';

export function getDevUserEmail(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDevUserEmail(email: string | null): void {
  try {
    if (email === null) window.sessionStorage.removeItem(STORAGE_KEY);
    else window.sessionStorage.setItem(STORAGE_KEY, email);
  } catch {
    // storage unavailable (privacy mode) — the switch just does not persist
  }
}
