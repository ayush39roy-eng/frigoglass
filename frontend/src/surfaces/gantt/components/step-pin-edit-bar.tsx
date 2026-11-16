import * as React from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { Save, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatInteger } from '@/lib/format';

/**
 * P40-T03c: the unsaved step-weeks bar, sticky under the timeline —
 * "N steps changed in M projects · Cancel · Save", after the register's and
 * the Matrix's edit bars. Save sends ONE `PUT /gantt/step-pins`.
 */
export function StepPinEditBar({
  changedCount,
  projectCount,
  invalidCount,
  onSave,
  onCancel,
  saving,
  error,
  tooMany,
}: {
  changedCount: number;
  projectCount: number;
  invalidCount: number;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  tooMany: string | null;
}): React.JSX.Element {
  const countText = `${formatInteger(changedCount)} ${changedCount === 1 ? 'step' : 'steps'} changed in ${formatInteger(
    projectCount,
  )} ${projectCount === 1 ? 'project' : 'projects'}`;
  const invalidText =
    invalidCount > 0
      ? `${formatInteger(invalidCount)} ${invalidCount === 1 ? 'step has' : 'steps have'} weeks in red: fix ${invalidCount === 1 ? 'it' : 'them'} to save.`
      : null;
  const message = error ?? tooMany ?? invalidText;
  return (
    <div
      role="region"
      aria-label="Unsaved step weeks"
      className="sticky bottom-0 z-40 flex flex-wrap items-center gap-3 rounded-card border-2 border-warning/60 bg-surface px-3 py-2 shadow-pop"
      data-testid="step-pin-edit-bar"
    >
      <span className="text-xs font-semibold text-text" aria-live="polite" data-testid="step-pin-edit-count">
        {countText}
      </span>
      <span className="text-2xs text-text-muted">Saving recalculates the timeline once for every changed step.</span>
      {message ? (
        <p
          role={error || tooMany ? 'alert' : 'status'}
          className="basis-full text-2xs text-danger"
          data-testid="step-pin-edit-error"
        >
          {message}
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={onSave}
          disabled={saving || changedCount === 0 || invalidCount > 0 || tooMany !== null}
          data-testid="step-pin-edit-save"
        >
          <Save aria-hidden="true" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

export function StepPinDiscardDialog({
  open,
  title,
  description,
  keepLabel = 'Keep editing',
  discardLabel = 'Discard changes',
  onKeep,
  onDiscard,
  testId,
}: {
  open: boolean;
  title: string;
  description: string;
  keepLabel?: string;
  discardLabel?: string;
  onKeep: () => void;
  onDiscard: () => void;
  testId: string;
}): React.JSX.Element {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeep();
      }}
    >
      <DialogContent role="alertdialog" className="max-w-md" data-testid={testId}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onKeep} autoFocus>
            {keepLabel}
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={onDiscard}>
            {discardLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Reload / closing the tab and in-app navigation with unsaved step weeks ask first. */
export function StepPinLeaveGuard({ when }: { when: boolean }): React.JSX.Element | null {
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
  const blocker = useBlocker(({ currentLocation, nextLocation }) => when && currentLocation.pathname !== nextLocation.pathname);
  return (
    <StepPinDiscardDialog
      open={blocker.state === 'blocked'}
      title="Leave with unsaved step weeks?"
      description="You have typed step Start / End weeks on the timeline. If you leave this page, they are lost."
      keepLabel="Stay on this page"
      discardLabel="Leave and discard"
      onKeep={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
      testId="step-pin-leave-dialog"
    />
  );
}
