/**
 * P35-T08: the Projects register's per-user column layout (which optional
 * columns are hidden, and each resized column's width in px), kept in this
 * browser's `localStorage` under a key that names the signed-in user.
 *
 * Every read and write is wrapped in try/catch: storage may be blocked
 * (private mode, a CSP, a full quota) or hold a value from an older build.
 * The page then simply uses the default layout; nothing here ever throws.
 * Display preference only — never sent to the server.
 */

export interface ColumnPrefs {
  hidden: string[];
  widths: Record<string, number>;
}

export const EMPTY_COLUMN_PREFS: ColumnPrefs = { hidden: [], widths: {} };

const KEY_PREFIX = 'rpd-projects-register-columns:v1:';
export const MIN_COLUMN_PX = 48;
export const MAX_COLUMN_PX = 640;

export function columnPrefsKey(userId: string | null | undefined): string {
  return `${KEY_PREFIX}${userId ?? 'anonymous'}`;
}

export function clampWidth(px: number): number {
  return Math.round(Math.min(MAX_COLUMN_PX, Math.max(MIN_COLUMN_PX, px)));
}

/** Keep only well-formed entries of a stored value. */
export function sanitizeColumnPrefs(raw: unknown): ColumnPrefs {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return EMPTY_COLUMN_PREFS;
  const o = raw as { hidden?: unknown; widths?: unknown };
  const hidden = Array.isArray(o.hidden) ? o.hidden.filter((h): h is string => typeof h === 'string') : [];
  const widths: Record<string, number> = {};
  if (o.widths && typeof o.widths === 'object' && !Array.isArray(o.widths)) {
    for (const [id, px] of Object.entries(o.widths as Record<string, unknown>)) {
      if (typeof px === 'number' && Number.isFinite(px)) widths[id] = clampWidth(px);
    }
  }
  return { hidden: [...new Set(hidden)], widths };
}

export function readColumnPrefs(userId: string | null | undefined): ColumnPrefs {
  try {
    const raw = window.localStorage.getItem(columnPrefsKey(userId));
    if (raw === null) return EMPTY_COLUMN_PREFS;
    return sanitizeColumnPrefs(JSON.parse(raw));
  } catch {
    return EMPTY_COLUMN_PREFS;
  }
}

/** `true` when stored; `false` when storage refused (the layout still applies for this visit). */
export function writeColumnPrefs(userId: string | null | undefined, prefs: ColumnPrefs): boolean {
  try {
    window.localStorage.setItem(columnPrefsKey(userId), JSON.stringify(prefs));
    return true;
  } catch {
    return false;
  }
}

export function clearColumnPrefs(userId: string | null | undefined): void {
  try {
    window.localStorage.removeItem(columnPrefsKey(userId));
  } catch {
    // Storage unavailable: nothing stored, nothing to clear.
  }
}
