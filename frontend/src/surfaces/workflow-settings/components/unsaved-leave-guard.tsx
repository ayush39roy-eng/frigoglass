import * as React from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';

import { shouldBlockLeave } from '@/lib/auth/leave-guard';
import { RegisterDiscardDialog } from '@/surfaces/projects/components/register-edit-bar';

/**
 * P52-T01 (owner rule 2026-11-19): leaving the Workflow page with unsaved
 * "Effort & Timeline Planning" drafts asks first — closing / reloading the tab
 * through the browser's own prompt, in-app navigation through a dialog. A
 * forced sign-out passes (`shouldBlockLeave`). Same pattern as the register's
 * leave guard (P35).
 */
export function UnsavedLeaveGuard({ when }: { when: boolean }): React.JSX.Element | null {
  React.useEffect(() => {
    if (!when) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [when]);
  // In-app navigation needs a data router (the app has one; some tests do not).
  const dataRouter = React.useContext(UNSAFE_DataRouterContext);
  return dataRouter ? <RouterLeaveGuard when={when} /> : null;
}

function RouterLeaveGuard({ when }: { when: boolean }): React.JSX.Element {
  const blocker = useBlocker((args) => shouldBlockLeave(when, args));
  return (
    <RegisterDiscardDialog
      open={blocker.state === 'blocked'}
      title="You have unsaved changes"
      description="Your Effort & Timeline Planning edits have not been applied. If you leave this page, they are lost. Press Apply to App to save them."
      keepLabel="Stay on this page"
      discardLabel="Leave and discard"
      onKeep={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
      testId="workflow-leave-dialog"
    />
  );
}
