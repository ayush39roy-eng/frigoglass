import * as React from 'react';
import { Lock } from 'lucide-react';

/**
 * Inline banner shown when a registration WRITE (create / edit / submit) was
 * rejected 403 although the session table allowed it. Not expected to be
 * reachable given the RBAC matrix (every role that may read Registration may
 * also write it) — kept as defensive, low-cost insurance matching the
 * Matrix/Gantt convention.
 *
 * P22-T01: the old `/register` page's full-page `AccessNotice` is gone with
 * that page. The Projects page is gated on `dashboard` read by its route, and
 * its registration controls simply do not render without Registration write.
 */
export function WriteForbiddenNotice(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-2xs text-text-muted"
    >
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Your role has read-only access to Project Registration. Creating or editing projects is
        limited to Portfolio Managers, Hub Planners and Admins.
      </span>
    </div>
  );
}
