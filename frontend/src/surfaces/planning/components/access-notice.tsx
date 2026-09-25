import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths (same pattern as every
 * other P4 surface's `AccessNotice`). Per `docs/PROJECT_AND_STACK.md` §5,
 * Capacity Planning is READ-only for Portfolio Manager, READ/WRITE for Hub
 * Planner (own hub) and Admin, and NOT AVAILABLE AT ALL to Engineer,
 * Executive Viewer or Auditor (all three get a server-side 403 on every
 * endpoint here — `backend/core/rbac.py`'s `CAPACITY_PLANNING` surface has an
 * empty permission set for all three). Server-side RBAC (P3-T02) is the
 * actual gate — this is just a clean surface instead of a stack of red
 * panels.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to Capacity Planning'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'Capacity Planning is available (read-only) to Portfolio Managers, and read/write to Hub Planners and Admins. If you need access, contact your RPD administrator.'
          : 'Sign in again to view Capacity Planning.'
      }
    />
  );
}

/**
 * Inline banner shown when the surface loads read-only (Portfolio Manager) or
 * a WRITE was rejected 403 for another reason. Unlike Project Registration
 * (P4-T06, where every role with any access also has WRITE), Capacity
 * Planning genuinely has a read-only role in the matrix — this is expected to
 * be reachable, not defensive insurance.
 */
export function WriteForbiddenNotice(): React.JSX.Element {
  return (
    <div
      role="status"
      className="flex items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-2xs text-text-muted"
    >
      <Lock className="size-3.5 shrink-0" aria-hidden="true" />
      <span>
        Your role has read-only access to Capacity Planning. Creating, editing or applying changes
        is limited to Hub Planners and Admins.
      </span>
    </div>
  );
}
