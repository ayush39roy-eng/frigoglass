import * as React from 'react';
import { UNSAFE_DataRouterContext, useBlocker } from 'react-router-dom';
import { Save, X } from 'lucide-react';

import { shouldBlockLeave } from '@/lib/auth/leave-guard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatInteger } from '@/lib/format';

import { DiscardDialog } from './scoring-rubric-panel';

/**
 * P34-T02 (D34-1): the scoring grid's edit-mode bar, sticky at the bottom of the
 * view: "N projects changed · Save · Cancel" and an optional note. Save sends
 * ONE `POST /scenarios/apply` (one version) — or, in scenario mode, stages the
 * edits into the scenario (nothing is sent).
 */
export function GridEditBar({
  changedCount,
  notes,
  onNotesChange,
  onSave,
  onCancel,
  saving,
  scenario,
  error,
}: {
  changedCount: number;
  notes: string;
  onNotesChange: (next: string) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  /** Scenario mode: Save stages instead of applying. */
  scenario: boolean;
  error: string | null;
}): React.JSX.Element {
  const noteId = React.useId();
  const countText = `${formatInteger(changedCount)} ${changedCount === 1 ? 'project' : 'projects'} changed`;
  return (
    <div
      role="region"
      aria-label="Unsaved score edits"
      className="sticky bottom-0 z-20 flex flex-wrap items-center gap-3 rounded-card border-2 border-warning/60 bg-surface px-3 py-2 shadow-pop"
      data-testid="grid-edit-bar"
    >
      <span className="text-xs font-semibold text-text" aria-live="polite" data-testid="grid-edit-count">
        {countText}
      </span>
      {scenario ? (
        <span className="text-2xs text-text-muted">Scenario mode: saving stages these edits; nothing is sent until you Apply the scenario.</span>
      ) : (
        <label htmlFor={noteId} className="flex min-w-[12rem] flex-1 items-center gap-2 text-2xs text-text-muted">
          Note (optional)
          <Input
            id={noteId}
            value={notes}
            maxLength={500}
            onChange={(e) => onNotesChange(e.currentTarget.value)}
            placeholder="Why these scores changed"
            className="h-7 flex-1 px-2 text-xs"
          />
        </label>
      )}
      {error ? (
        <p role="alert" className="basis-full text-2xs text-danger" data-testid="grid-edit-error">
          {error}
        </p>
      ) : null}
      <div className="ml-auto flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" onClick={onCancel} disabled={saving}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button type="button" size="sm" onClick={onSave} disabled={saving || changedCount === 0} data-testid="grid-edit-save">
          <Save aria-hidden="true" />
          {scenario ? 'Stage in scenario' : saving ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}

/** Reload / closing the tab and in-app navigation with unsaved grid edits ask first. */
export function GridLeaveGuard({ when }: { when: boolean }): React.JSX.Element | null {
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
    <DiscardDialog
      open={blocker.state === 'blocked'}
      title="Leave with unsaved score edits?"
      description="You are editing scores in the grid. If you leave this page, your unsaved edits are lost."
      keepLabel="Stay on this page"
      discardLabel="Leave and discard"
      onKeep={() => blocker.reset?.()}
      onDiscard={() => blocker.proceed?.()}
      testId="grid-leave-dialog"
    />
  );
}
