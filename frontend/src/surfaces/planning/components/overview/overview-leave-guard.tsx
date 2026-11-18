import * as React from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';

import { shouldBlockLeave } from '@/lib/auth/leave-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { selectAnyDirty, useCardEditStore } from './card-edit-store';

/**
 * Leaving Capacity Planning with unsaved card edits asks first (owner ask
 * 2026-11-17). Same pattern as the Matrix grid-edit and register-edit guards:
 * `beforeunload` for reload / tab close, the data router's `useBlocker` for
 * in-app navigation (absent in tests without a data router). One guard for
 * the whole page — a router supports one blocker at a time. Mounted by
 * `PlanningPage`, which also clears the drafts on unmount.
 */
export function OverviewLeaveGuard(): React.JSX.Element | null {
  const dirty = useCardEditStore(selectAnyDirty);
  React.useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
  const dataRouter = React.useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <RouterLeaveGuard when={dirty} /> : null;
}

function RouterLeaveGuard({ when }: { when: boolean }): React.JSX.Element {
  const blocker = useBlocker((args) => shouldBlockLeave(when, args));
  const open = blocker.state === 'blocked';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) blocker.reset?.();
      }}
    >
      <DialogContent role="alertdialog" className="max-w-md" data-testid="planning-leave-dialog">
        <DialogHeader>
          <DialogTitle>Leave with unsaved capacity edits?</DialogTitle>
          <DialogDescription>
            A hub or lab card is in edit mode with changes that are not saved. If you leave this page, they are lost.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={() => blocker.reset?.()} autoFocus>
            Stay on this page
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={() => blocker.proceed?.()}>
            Leave and discard
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
