import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths. The Dashboard is not in the
 * nav for Engineer/Auditor, but a direct navigation (or an expired session)
 * still needs a clean, non-alarming surface rather than a stack of red error
 * panels. Server-side RBAC (P3-T02) remains the actual gate.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to the Global RPD Dashboard'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'The Dashboard is available to Portfolio Managers, Hub Planners, Executive Viewers and Admins. If you need access, contact your RPD administrator.'
          : 'Sign in again to view the Dashboard.'
      }
    />
  );
}
