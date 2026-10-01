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

/**
 * 2026-10-01 (test-login sign-in): "Remember me" on the login page keeps the
 * choice in `localStorage` so it survives closing the tab; otherwise it stays
 * per-tab in `sessionStorage` as before. Still not a credential — it only
 * selects a seeded user on a backend that runs with RPD_DEV_MODE on.
 */
export function getDevUserEmail(): string | null {
  try {
    return window.sessionStorage.getItem(STORAGE_KEY) ?? window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function setDevUserEmail(email: string | null, options: { remember?: boolean } = {}): void {
  try {
    window.sessionStorage.removeItem(STORAGE_KEY);
    window.localStorage.removeItem(STORAGE_KEY);
    if (email === null) return;
    if (options.remember) window.localStorage.setItem(STORAGE_KEY, email);
    else window.sessionStorage.setItem(STORAGE_KEY, email);
  } catch {
    // storage unavailable (privacy mode) — the switch just does not persist
  }
}
