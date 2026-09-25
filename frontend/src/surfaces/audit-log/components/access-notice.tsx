import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths (same pattern as every
 * other surface's `AccessNotice`, e.g. `surfaces/dashboard/components/
 * access-notice.tsx`). The Audit Log is gated to Auditor and Admin only
 * (`backend/core/rbac.py::ROLE_PERMISSIONS`) — every other role gets a
 * server-side 403. Server-side RBAC (P3-T02) remains the actual gate; this is
 * just a clean surface instead of a stack of red error panels.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to the Audit Log'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'The Audit Log is available to Auditors and Admins only. If you need access, contact your RPD administrator.'
          : 'Sign in again to view the Audit Log.'
      }
    />
  );
}
