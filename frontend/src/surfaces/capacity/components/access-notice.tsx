import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths (same pattern as the
 * Dashboard's `AccessNotice`). Capacity is available to Portfolio Managers, Hub
 * Planners, Executive Viewers and Admins; Engineer and Auditor get a server-side
 * 403 (`docs/PROJECT_AND_STACK.md` §5). Server-side RBAC (P3-T02) is the actual
 * gate — this is just a clean surface instead of a stack of red panels.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to RPD Capacity'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'RPD Capacity is available to Portfolio Managers, Hub Planners, Executive Viewers and Admins. If you need access, contact your RPD administrator.'
          : 'Sign in again to view RPD Capacity.'
      }
    />
  );
}
