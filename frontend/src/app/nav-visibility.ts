import type { MeResponse } from '@/lib/api/session';
import { permissionFor } from '@/stores/session';

import { NAV_GROUP_ORDER, SURFACES, type NavGroup, type SurfaceNavItem } from './nav';

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
        SURFACES.filter((s) => s.group === group && permissionFor(me, s.surface).read),
      ] as const,
  ).filter(([, items]) => items.length > 0);
}

