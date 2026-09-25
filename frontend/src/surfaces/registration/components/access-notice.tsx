import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths (same pattern as the
 * Dashboard / Capacity / Matrix / Gantt `AccessNotice`). Per
 * `docs/PROJECT_AND_STACK.md` §5, Project Registration is the one surface
 * where every role with any access at all (Portfolio Manager, Hub Planner,
 * Admin) has both READ and WRITE — Engineer / Executive Viewer / Auditor get a
 * server-side 403 on everything here, with no partial "read-only" role to
 * degrade to (unlike Matrix's write-forbidden-but-still-readable case).
 * Server-side RBAC (P3-T02) is the real gate — this is just a clean surface
 * instead of a stack of red panels.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to Project Registration'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'Project Registration is available to Portfolio Managers, Hub Planners and Admins. If you need access, contact your RPD administrator.'
          : 'Sign in again to view Project Registration.'
      }
    />
  );
}

/**
 * Inline banner shown when the surface loads read-only but a WRITE (create /
 * edit / submit) was rejected 403. Not expected to be reachable given the
 * RBAC matrix note above (every role that can READ here can also WRITE) — kept
 * anyway as defensive, low-cost insurance matching the Matrix/Gantt
 * convention, in case that ever changes.
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
