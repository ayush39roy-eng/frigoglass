import type { MeResponse } from '@/lib/api/session';
import { permissionFor } from '@/stores/session';

import { NAV_GROUP_ORDER, SURFACES, type NavGroup, type SurfaceNavItem } from './nav';

/**
 * `true` when the session may open the nav item: `surface: null` = any
 * signed-in user; otherwise read on `surface` or (P32-R04) on any of
 * `alsoReadableVia`. Shared by the sidebar and the route guard.
 */
export function canReadNavItem(me: MeResponse | null, item: Pick<SurfaceNavItem, 'surface' | 'alsoReadableVia'>): boolean {
  if (item.surface === null) return me !== null;
  if (permissionFor(me, item.surface).read) return true;
  return (item.alsoReadableVia ?? []).some((s) => permissionFor(me, s).read);
}

/**
 * Nav items the session can READ (ADR 0010 §2), grouped. A group with nothing
 * readable disappears with its label. Exported for the gating tests.
 */
export function visibleNavGroups(
  me: MeResponse | null,
): ReadonlyArray<readonly [NavGroup, readonly SurfaceNavItem[]]> {
  return NAV_GROUP_ORDER.map(
    (group) =>
      [
        group,
        SURFACES.filter(
          (s) =>
            s.group === group &&
            // `surface: null` = any authenticated user (P13-T15 Downloads).
            canReadNavItem(me, s),
        ),
      ] as const,
  ).filter(([, items]) => items.length > 0);
}

