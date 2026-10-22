/**
 * Dashboard view resolution (P28, ADR 0039 §2).
 *
 * The Dashboard has two presentations of the same served data: the Executive
 * ("helicopter") view and the Detailed view (the pre-P28 page, unchanged).
 * Which one renders is resolved here, with this precedence:
 *
 *   1. the `view` URL search param on `/` (deep-linkable, e2e-friendly),
 *   2. the per-user stored choice (`localStorage['rpd-dashboard-view']`),
 *   3. the role default: a caller whose served `/me` roles are EXACTLY
 *      `["Executive Viewer"]` lands on Executive; everyone else on Detailed.
 *
 * Pure functions + two thin storage wrappers so the precedence is unit-testable
 * without a DOM. Nothing here is business logic: it picks a presentation, never
 * a figure.
 */

export const DASHBOARD_VIEWS = ['executive', 'detailed'] as const;
export type DashboardView = (typeof DASHBOARD_VIEWS)[number];

/** ADR 0039 §2: persisted per user under this key. */
export const DASHBOARD_VIEW_STORAGE_KEY = 'rpd-dashboard-view';

export function isDashboardView(value: unknown): value is DashboardView {
  return typeof value === 'string' && (DASHBOARD_VIEWS as readonly string[]).includes(value);
}

/** ADR 0039 §2 role default: ONLY the pure Executive Viewer principal (served
 *  roles exactly `["Executive Viewer"]`) defaults to the Executive view. A user
 *  holding Executive Viewer plus anything else works in the app day-to-day and
 *  keeps the Detailed default. */
export function defaultViewForRoles(roles: readonly string[]): DashboardView {
  return roles.length === 1 && roles[0] === 'Executive Viewer' ? 'executive' : 'detailed';
}

/** URL param → stored choice → role default. Invalid values fall through. */
export function resolveDashboardView(
  urlParam: string | null,
  stored: string | null,
  roles: readonly string[],
): DashboardView {
  if (isDashboardView(urlParam)) return urlParam;
  if (isDashboardView(stored)) return stored;
  return defaultViewForRoles(roles);
}

/** `localStorage` read that survives a blocked storage (private mode, CSP). */
export function readStoredDashboardView(): string | null {
  try {
    return window.localStorage.getItem(DASHBOARD_VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeDashboardView(view: DashboardView): void {
  try {
    window.localStorage.setItem(DASHBOARD_VIEW_STORAGE_KEY, view);
  } catch {
    // Persistence is a convenience; the URL param still carries the choice.
  }
}
