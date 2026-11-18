/**
 * ADR 0060 L2 (P49): sign out after `IDLE_TIMEOUT_MS` without activity in any
 * tab of the app. The last activity time is shared across tabs as a timestamp
 * in `localStorage` (not a credential: it identifies no one). Writes are
 * throttled; each tab also keeps its own exact time in memory.
 */

/** The idle timeout. Change this one constant to change the rule. */
export const IDLE_TIMEOUT_MS = 30 * 60_000;

/** How long before the timeout the warning dialog opens. */
export const IDLE_WARNING_BEFORE_MS = 2 * 60_000;

/** At most one shared-timestamp write per this interval per tab. */
export const ACTIVITY_WRITE_THROTTLE_MS = 15_000;

export const LAST_ACTIVITY_KEY = 'rpd-last-activity';

/** Events that count as activity (ADR 0060: pointer, key, wheel, touch, scroll). */
export const ACTIVITY_EVENTS = [
  'pointerdown',
  'pointermove',
  'keydown',
  'wheel',
  'touchstart',
  'scroll',
] as const;

/** The idle notice on the login page. */
export const IDLE_SIGNED_OUT_NOTICE = `You were signed out after ${String(
  Math.round(IDLE_TIMEOUT_MS / 60_000),
)} minutes of inactivity.`;

export function readSharedLastActivity(): number | null {
  try {
    const raw = window.localStorage.getItem(LAST_ACTIVITY_KEY);
    if (raw === null || !/^\d{1,16}$/.test(raw)) return null;
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  } catch {
    return null;
  }
}

export function writeSharedLastActivity(at: number): void {
  try {
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(Math.floor(at)));
  } catch {
    // storage unavailable — this tab still tracks its own activity
  }
}

/** True when the shared last activity is known and at least the timeout ago. */
export function isSharedSessionIdle(now: number = Date.now()): boolean {
  const last = readSharedLastActivity();
  return last !== null && now - last >= IDLE_TIMEOUT_MS;
}

/** `m:ss` for the warning countdown. */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1_000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes)}:${String(seconds).padStart(2, '0')}`;
}
