import * as React from 'react';
import { AlertTriangle } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { EditConflict } from '@/lib/api/edit-conflict';

import { conflictChangedText, conflictFieldLabel, formatConflictValue } from './edit-conflict-meta';

export interface EditConflictDialogProps {
  open: boolean;
  conflicts: readonly EditConflict[];
  /** Drop my value for the conflicting fields and reload. */
  onUseTheirs: () => void;
  /** Resend with `base` = the values stored now (a deliberate overwrite). */
  onKeepMine: () => void;
  /** Closed without choosing: nothing is saved, the edit stays. */
  onDismiss: () => void;
  /** Optional readable form of a served value (e.g. an engineer id → name). */
  formatValue?: ((conflict: EditConflict, value: unknown) => string | null) | undefined;
  /** Extra sentence under the description (e.g. a batch's other edits). */
  note?: string | undefined;
  busy?: boolean | undefined;
}

/**
 * P47-T03 (ADR 0059 C2): the one dialog for a 409 `EDIT_CONFLICT`. Lists each
 * conflicting field with what the user entered, what is stored now, and who
 * changed it and when. Plain text only: every value is rendered as a React
 * text node, never as HTML.
 */
export function EditConflictDialog({
  open,
  conflicts,
  onUseTheirs,
  onKeepMine,
  onDismiss,
  formatValue,
  note,
  busy = false,
}: EditConflictDialogProps): React.JSX.Element {
  const show = (c: EditConflict, value: unknown): string => formatValue?.(c, value) ?? formatConflictValue(value);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onDismiss();
      }}
    >
      <DialogContent className="max-w-xl" data-testid="edit-conflict-dialog">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle aria-hidden className="size-4 text-warning" />
            Someone else changed this while you were editing
          </DialogTitle>
          <DialogDescription>
            Nothing was saved. Choose whose value to keep for {conflicts.length === 1 ? 'this field' : 'these fields'}.
            {note ? ` ${note}` : ''}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex max-h-[50vh] flex-col gap-2 overflow-y-auto" aria-label="Conflicting fields">
          {conflicts.map((c, i) => (
            <li
              key={`${c.id}-${c.field}-${String(i)}`}
              className="rounded-md border border-border bg-surface-raised p-3 text-sm"
              data-testid="edit-conflict-item"
            >
              <p className="font-medium text-text">
                {c.label ? `${c.label}: ` : ''}
                {conflictFieldLabel(c.field)}
              </p>
              <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
                <dt className="text-text-muted">You entered</dt>
                <dd className="break-words">{show(c, c.your_value)}</dd>
                <dt className="text-text-muted">Now saved</dt>
                <dd className="break-words font-medium">{show(c, c.current_value)}</dd>
              </dl>
              <p className="mt-1 text-xs text-text-muted">{conflictChangedText(c)}</p>
            </li>
          ))}
        </ul>
        <DialogFooter>
          <Button variant="secondary" onClick={onUseTheirs} disabled={busy}>
            Use theirs
          </Button>
          <Button onClick={onKeepMine} disabled={busy}>
            Keep mine
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
