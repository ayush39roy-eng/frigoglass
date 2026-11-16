import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { usePriorityMoveHost } from '@/components/shared/priority-move/priority-move-context';
import { useHubs } from '@/lib/api/reference';
import { queryKeys } from '@/lib/query-keys';

import { RegisterSavePanel } from '@/surfaces/projects/components/register-save-panel';
import type { RegistrationSaved } from '@/surfaces/projects/components/registration-drawer';
import { useRegisterSave } from '@/surfaces/projects/hooks/use-register-save';

/** The same popup the Projects list's row "Edit" opens (deferred: it pulls in
 *  the registration form). */
const RegistrationDrawer = React.lazy(() => import('@/surfaces/projects/components/registration-drawer'));

/**
 * Register popup (owner 2026-11-17): the project folder's "Edit" opens the
 * project's one Edit popup. Lives inside the page's `PriorityMoveProvider`
 * (a priority change previews through it) and hosts the register save's
 * "recalculating" panel, which outlives the popup.
 */
export function WorkspaceEditHost({
  projectId,
  open,
  onClose,
  returnFocusTo,
  onForbidden,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLElement | null>;
  onForbidden: () => void;
}): React.JSX.Element | null {
  const moveApi = usePriorityMoveHost();
  const hubs = useHubs();
  const registerSave = useRegisterSave();
  const queryClient = useQueryClient();
  const [loaded, setLoaded] = React.useState(open);
  if (open && !loaded) setLoaded(true);

  const refresh = React.useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.projectWorkspace(projectId) });
  }, [queryClient, projectId]);

  const handleClose = React.useCallback(
    (saved: RegistrationSaved | null) => {
      onClose();
      if (saved) refresh();
    },
    [onClose, refresh],
  );

  return (
    <>
      {loaded && moveApi ? (
        <React.Suspense fallback={null}>
          <RegistrationDrawer
            state={open ? { mode: 'edit', projectId } : null}
            onClose={handleClose}
            hubs={hubs.data ?? []}
            moveApi={moveApi}
            onForbidden={onForbidden}
            onSubmitted={refresh}
            returnFocusTo={returnFocusTo}
            registerSave={registerSave.save}
          />
        </React.Suspense>
      ) : null}
      <RegisterSavePanel
        flow={registerSave.flow}
        runState={registerSave.runState}
        changes={registerSave.changes}
        watchingFollowUp={registerSave.watchingFollowUp}
        onClose={registerSave.close}
        effChanges={registerSave.effChanges}
      />
    </>
  );
}
