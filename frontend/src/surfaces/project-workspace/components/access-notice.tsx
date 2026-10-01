import * as React from 'react';
import { Lock, SearchX } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';

/** 401 / 403 / 404 for the workspace. A project outside the caller's hub scope
 *  is filtered server-side and reads as 404 or 403 — both land here, not blank. */
export function AccessNotice({ kind }: { kind: 'forbidden' | 'unauthorized' | 'not_found' }): React.JSX.Element {
  if (kind === 'not_found') {
    return (
      <EmptyState
        media={<SearchX className="size-8" />}
        title="Project not found"
        description="This project does not exist, or it is outside your hub scope."
      />
    );
  }
  return (
    <EmptyState
      media={<Lock className="size-8" />}
      title={kind === 'forbidden' ? 'Your role does not have access to this project' : 'Your session has expired'}
      description={
        kind === 'forbidden'
          ? 'The Project Workspace is available to Portfolio Managers, Hub Planners (own hub), Engineers (own assignments), Executive Viewers and Admins.'
          : 'Sign in again to open the Project Workspace.'
      }
    />
  );
}
