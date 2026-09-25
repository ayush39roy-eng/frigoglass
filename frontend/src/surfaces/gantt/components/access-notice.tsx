import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths (same pattern as the Dashboard
 * / Capacity / Matrix `AccessNotice`). Per `docs/PROJECT_AND_STACK.md` §5 the
 * Project Execution Timeline is readable by Portfolio Manager, Hub Planner,
 * Executive Viewer, Engineer and Admin; Auditor gets a server-side 403.
 * Server-side RBAC (P3-T02) is the real gate — this is just a clean surface
 * instead of a stack of red panels.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to the Project Execution Timeline'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'The timeline is available to Portfolio Managers, Hub Planners, Executive Viewers, Engineers and Admins. If you need access, contact your RPD administrator.'
          : 'Sign in again to view the Project Execution Timeline.'
      }
    />
  );
}

/**
 * Inline banner shown when the surface loads read-only but a freeze toggle
 * (`GANTT`/`WRITE`) was rejected 403 — only Hub Planner and Admin hold Gantt
 * WRITE (`docs/PROJECT_AND_STACK.md` §5). Reads keep working; the freeze
 * affordances are withdrawn.
 */
export function FreezeForbiddenNotice(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-2xs text-text-muted"
    >
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Your role has read-only access to the timeline. Freezing a project is limited to Hub
        Planners and Admins.
      </span>
    </div>
  );
}
