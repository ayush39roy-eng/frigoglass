import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/**
 * Graceful degradation for the RBAC 401/403 paths (same pattern as every other
 * surface's `AccessNotice`). User / Role Admin is Admin and Super Admin only
 * (`docs/PROJECT_AND_STACK.md` §5, ADR 0010); the route guard normally stops a
 * lesser role before this renders, the server 403 is the real gate.
 */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to User / Role Admin'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'User / Role Admin is available to Admins (non-admin roles) and Super Admins. If you need access, contact your RPD administrator.'
          : 'Sign in again to view User / Role Admin.'
      }
    />
  );
}
