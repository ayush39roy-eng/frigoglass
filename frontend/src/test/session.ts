import type { MeResponse, SurfacePermission } from '@/lib/api/session';
import { useSessionStore } from '@/stores/session';
import { SURFACE_KEYS, type RoleName, type SurfaceKey } from '@/types/enums';

/**
 * Test seams for the session store (ADR 0010). Every render helper seeds a
 * full-permission "Super Admin" session by default so the ~440 pre-P9 tests —
 * written when the frontend had no role awareness — keep rendering every nav
 * item and every write control. Tests of the gating itself pass a narrower
 * `permissions` table or `null` to exercise the boot gate.
 */

const FULL: SurfacePermission = { read: true, write: true };

export function fullPermissions(): Record<SurfaceKey, SurfacePermission> {
  return Object.fromEntries(SURFACE_KEYS.map((k) => [k, { ...FULL }])) as Record<
    SurfaceKey,
    SurfacePermission
  >;
}

/** Build a permission table from a sparse `{surface: 'r' | 'rw'}` spec. */
export function permissionsFrom(
  spec: Partial<Record<SurfaceKey, 'r' | 'rw'>>,
): Record<SurfaceKey, SurfacePermission> {
  return Object.fromEntries(
    SURFACE_KEYS.map((k) => {
      const v = spec[k];
      return [k, { read: v !== undefined, write: v === 'rw' }];
    }),
  ) as Record<SurfaceKey, SurfacePermission>;
}

/** P37: the week and year every test session serves (the backend suites pin
 *  31). The app itself has no week or year constant; these are fixtures. */
export const TEST_CURRENT_WEEK = 31;
export const TEST_PLAN_YEAR = 2026;

export function makeMe(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    user_id: 'user-super',
    email: 'sam.super@example.com',
    full_name: 'Sam Super',
    roles: ['Super Admin'] as RoleName[],
    hub_scope_all: true,
    hub_ids: [],
    engineer_id: null,
    permissions: fullPermissions(),
    dev_mode: false,
    is_delegate_manager: false,
    // P13-T15: served planning week (tests pin 31, like the backend suites).
    current_week: TEST_CURRENT_WEEK,
    weeks_left_in_year: 52 - TEST_CURRENT_WEEK,
    // P37 (API_CONTRACT_P37 §1): the served plan clock. Monday of 2026-W31.
    as_of_date: '2026-07-27',
    plan_year: TEST_PLAN_YEAR,
    // P53 (R53-6): served week line + search limit (N = 5 → 31 + 260).
    week_base_year: TEST_PLAN_YEAR,
    plan_year_start_week: 1,
    plan_year_end_week: 52,
    horizon_years: 5,
    horizon_weeks: TEST_CURRENT_WEEK + 260,
    week_source: 'pinned',
    week_ends_at: '2026-08-03T00:00:00+03:00',
    plan_week: null,
    ...overrides,
  };
}

/** Install a ready session (no network). `null` resets to the idle boot state. */
export function seedSession(me: Partial<MeResponse> | null = {}): MeResponse | null {
  const store = useSessionStore.getState();
  if (me === null) {
    store.reset();
    return null;
  }
  const full = makeMe(me);
  store.seed(full);
  return full;
}
