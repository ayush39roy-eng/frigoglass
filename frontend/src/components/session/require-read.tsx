import * as React from 'react';

import { ForbiddenPage } from '@/pages/forbidden';
import { permissionFor, usePermission, useSessionStore } from '@/stores/session';
import type { SurfaceKey } from '@/types/enums';

/**
 * Route guard (ADR 0010 §2): a surface the session cannot `read` renders the
 * 403 page instead of mounting — so a lazy chunk is not even fetched for a
 * surface the role cannot open. The server still 403s every request behind
 * it; this only decides what the browser draws.
 *
 * `alsoAllow` (2026-09-30, ADR 0012, P10-F03): an optional extra "OR this is
 * true" escape hatch for a route that a session-store boolean can open even
 * without surface `read` — today, `/admin/users` for `me.is_delegate_manager`
 * (a manager-delegate with no `user_role_admin` permission at all, who still
 * needs the Project Access tab). Kept as one shared guard rather than a
 * route-specific bypass so every other route's behaviour is unchanged
 * (`alsoAllow` defaults to `false`).
 */
export function RequireRead({
  surface,
  title,
  alsoAllow = false,
  children,
}: {
  surface: SurfaceKey;
  title: string;
  alsoAllow?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const { read } = usePermission(surface);
  if (!read && !alsoAllow) return <ForbiddenPage surfaceTitle={title} />;
  return <>{children}</>;
}

/**
 * P32-R04: a route readable through further surfaces as well as its own
 * (`nav.ts` `alsoReadableVia`; `/settings/workflow` = `workflow_settings` OR
 * `gantt` read). The shared `alsoAllow` escape hatch above, nothing more.
 */
export function RequireAnyRead({
  surface,
  title,
  via,
  children,
}: {
  surface: SurfaceKey;
  title: string;
  via: readonly SurfaceKey[];
  children: React.ReactNode;
}): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const alsoAllow = via.some((v) => permissionFor(me, v).read);
  return (
    <RequireRead surface={surface} title={title} alsoAllow={alsoAllow}>
      {children}
    </RequireRead>
  );
}
