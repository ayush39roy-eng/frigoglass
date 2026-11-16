import * as React from 'react';
import { Save, SquarePen, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { formatInteger } from '@/lib/format';

/**
 * The card header's edit controls (owner ask 2026-11-17). Read mode: "Edit".
 * Edit mode: "N rows unsaved", Cancel and Save. Save is disabled while nothing
 * changed, while a value is invalid, and while saving. Rendered only for a
 * caller who may edit the card (the same `canEdit` as "+ Add").
 *
 * Accessible names keep the visible word first ("Edit R&D-Greece Hub") so the
 * three cards' buttons are distinguishable and label-in-name holds.
 */
export function CardEditControls({
  subject,
  editing,
  saving,
  changedRowCount,
  hasInvalid,
  onBegin,
  onCancel,
  onSave,
}: {
  /** "R&D-Greece Hub", "Greece labs". */
  subject: string;
  editing: boolean;
  saving: boolean;
  changedRowCount: number;
  hasInvalid: boolean;
  onBegin: () => void;
  onCancel: () => void;
  onSave: () => void;
}): React.JSX.Element {
  if (!editing) {
    return (
      <Button type="button" variant="ghost" size="sm" className="h-7 px-1.5" aria-label={`Edit ${subject}`} onClick={onBegin}>
        <SquarePen aria-hidden="true" />
        Edit
      </Button>
    );
  }
  return (
    <>
      <span className="whitespace-nowrap text-2xs font-semibold text-warning-subtle-fg" aria-live="polite" data-testid="card-edit-count">
        {changedRowCount === 0
          ? 'No changes'
          : `${formatInteger(changedRowCount)} ${changedRowCount === 1 ? 'row' : 'rows'} unsaved`}
      </span>
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="h-7 px-2"
        aria-label={`Cancel ${subject} edits`}
        onClick={onCancel}
        disabled={saving}
      >
        <X aria-hidden="true" />
        Cancel
      </Button>
      <Button
        type="button"
        size="sm"
        className="h-7 px-2"
        aria-label={`Save ${subject}`}
        onClick={onSave}
        disabled={saving || changedRowCount === 0 || hasInvalid}
      >
        <Save aria-hidden="true" />
        {saving ? 'Saving…' : 'Save'}
      </Button>
    </>
  );
}

/** Visible per-row marker of unsaved changes (also the screen-reader cue). */
export function UnsavedTag(): React.JSX.Element {
  return (
    <span className="mt-0.5 flex w-fit rounded-pill border border-warning/60 bg-warning-subtle px-1.5 text-2xs font-semibold text-warning-subtle-fg">
      Unsaved
    </span>
  );
}
