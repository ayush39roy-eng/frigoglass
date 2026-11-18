import * as React from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { Save, X } from 'lucide-react';

import { shouldBlockLeave } from '@/lib/auth/leave-guard';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatInteger } from '@/lib/format';

/**
 * P35-T02 (D35-2): the register's edit-mode bar, sticky under the grid —
 * "N projects changed · Cancel · Save", after the Matrix's P34 grid-edit bar.
 * Save sends ONE `POST /projects/register-edits`.
 */
export function RegisterEditBar({
  changedCount,
  onSave,
  onCancel,
  saving,
  error,
  tooMany,
}: {
  changedCount: number;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
  /** More changed projects than one batch takes. */
  tooMany: string | null;
}): React.JSX.Element {
  const countText = `${formatInteger(changedCount)} ${changedCount === 1 ? 'project' : 'projects'} changed`;
  return (
    <div
      role="region"
      aria-label="Unsaved register edits"
      className="sticky bottom-0 z-20 mt-3 flex flex-wrap items-center gap-3 rounded-card border-2 border-warning/60 bg-surface px-3 py-2 shadow-pop"
      data-testid="register-edit-bar"
    >
      <span className="text-xs font-semibold text-text" aria-live="polite" data-testid="register-edit-count">
        {countText}
      </span>
      <span className="text-2xs text-text-muted">Saving recalculates the timeline once for all changed projects.</span>
      {error || tooMany ? (
        <p role="alert" className="basis-full text-2xs text-danger" data-testid="register-edit-error">
          {error ?? tooMany}
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
          disabled={saving || changedCount === 0 || tooMany !== null}
          data-testid="register-edit-save"
        >
          <Save aria-hidden="true" />
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

export function RegisterDiscardDialog({
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

/** Reload / closing the tab and in-app navigation with unsaved register edits ask first. */
export function RegisterLeaveGuard({ when }: { when: boolean }): React.JSX.Element | null {
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
      title="Leave with unsaved register edits?"
      description="You are editing projects in the register. If you leave this page, your unsaved edits are lost."
      keepLabel="Stay on this page"
      discardLabel="Leave and discard"
      onKeep={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
      testId="register-leave-dialog"
    />
  );
}
