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
