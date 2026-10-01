import * as React from 'react';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/** Same pattern as every other surface's `AccessNotice`. Workflow Settings is
 *  Admin (read) and Super Admin (read/write) only — ADR 0010. */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' }): React.JSX.Element {
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={
        kind === 'forbidden'
          ? 'Your role does not have access to Workflow Settings'
          : 'Your session has expired'
      }
      description={
        kind === 'forbidden'
          ? 'Workflow Settings is readable by Admins and editable by Super Admins only. If you need access, contact your RPD administrator.'
          : 'Sign in again to view Workflow Settings.'
      }
    />
  );
}
