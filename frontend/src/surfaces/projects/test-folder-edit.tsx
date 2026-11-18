import * as React from 'react';

import { PriorityMoveProvider } from '@/components/shared/priority-move/priority-move-provider';
import { WorkspaceEditHost } from '@/surfaces/project-workspace/components/workspace-edit-host';

/**
 * Test harness (P44-T01): since the Projects row "Edit" edits in place, the
 * register Edit popup opens only from the project folder's "Edit"
 * (`workspace-header.tsx` → `WorkspaceEditHost`). The popup tests mount that
 * same host here, with a trigger button standing in for the folder header's,
 * so they exercise the folder's path without the whole workspace page.
 */
export function FolderEditHarness({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  return (
    <PriorityMoveProvider>
      <button ref={trigger} type="button" onClick={() => setOpen(true)} data-testid="folder-edit">
        Edit {projectName}
      </button>
      <WorkspaceEditHost
        projectId={projectId}
        open={open}
        onClose={() => setOpen(false)}
        returnFocusTo={trigger}
        onForbidden={() => setOpen(false)}
      />
    </PriorityMoveProvider>
  );
}
