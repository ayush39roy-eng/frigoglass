import * as React from 'react';

import {
  captureBase,
  CONFLICT_COPY,
  editConflicts,
  forgetBase,
  keepMineBase,
  snapshotBase,
  type BaseSnapshots,
} from '@/lib/api/edit-conflict';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { useEditSession } from '@/stores/edit-session';

import { saveErrorMessage } from './save-error';
import { useCardEditStore, type CardEdit, type DraftValue } from './card-edit-store';

/**
 * The edit-mode logic shared by the hub engineer card and the lab region card
 * (owner ask 2026-11-17). A field is either a number typed as text (FTE,
 * platforms, efficiency — validated with the existing form schemas) or a set
 * of chip codes (allowed categories / allowed stages).
 *
 * "Changed" is always judged against the CURRENT served value, so a refetch
 * that lands the same value clears the mark, and Save sends exactly the
 * changed fields of each changed row — one PATCH per row through the existing
 * mutations, rows in display order, one after another (the mutation hooks
 * patch the list cache optimistically; sequential calls keep their rollbacks
 * from overwriting each other). A failed row keeps its draft and shows the
 * save-error.ts message; the card stays in edit mode until every row saved.
 */
export type FieldSpec<Row, Body> =
  | { kind: 'number'; key: keyof Body & string; served: (row: Row) => number; validate: (text: string) => string | null }
  | { kind: 'set'; key: keyof Body & string; served: (row: Row) => readonly string[] };

export interface CardEditor<Row> {
  editing: boolean;
  saving: boolean;
  begin: () => void;
  cancel: () => void;
  save: () => Promise<void>;
  /** The text shown in a number input (draft, else the served value). */
  text: (row: Row, key: string) => string;
  /** The chip codes currently selected (draft, else the served set). */
  selected: (row: Row, key: string) => readonly string[];
  set: (row: Row, key: string, value: DraftValue) => void;
  /** Restore one field to its served value (Escape in an input). */
  revert: (row: Row, key: string) => void;
  isChanged: (row: Row, key: string) => boolean;
  rowChanged: (row: Row) => boolean;
  /** Validation message of a number draft, else null. */
  invalid: (row: Row, key: string) => string | null;
  rowError: (row: Row) => string | null;
  changedRowCount: number;
  hasInvalid: boolean;
  /** P47 (ADR 0059): the 409 conflict dialog; render once in the card. */
  conflictDialog: React.JSX.Element;
}

const NO_CARD: CardEdit | undefined = undefined;

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

export function useCardEditor<Row extends { id: string }, Body>({
  cardKey,
  rows,
  fields,
  canEdit,
  onUpdate,
}: {
  cardKey: string;
  rows: readonly Row[];
  fields: readonly FieldSpec<Row, Body>[];
  canEdit: boolean;
  onUpdate: (id: string, body: Body) => Promise<unknown>;
}): CardEditor<Row> {
  const card = useCardEditStore((s) => s.cards[cardKey] ?? NO_CARD);
  const begin = useCardEditStore((s) => s.begin);
  const end = useCardEditStore((s) => s.end);
  const setField = useCardEditStore((s) => s.setField);
  const pruneRows = useCardEditStore((s) => s.pruneRows);
  const setSaving = useCardEditStore((s) => s.setSaving);
  const settle = useCardEditStore((s) => s.settle);

  const editing = canEdit && card !== undefined;
  /** P47 (ADR 0059): per row, each field's served value when it was first changed. */
  const [bases, setBases] = React.useState<BaseSnapshots>({});
  const conflict = useEditConflict();
  useEditSession(editing);
  if (!editing && Object.keys(bases).length > 0) setBases({});

  // Losing write (a 403 downgrades the page) ends edit mode and drops drafts.
  React.useEffect(() => {
    if (!canEdit && card !== undefined) end(cardKey);
  }, [canEdit, card, cardKey, end]);

  // A deleted (or no longer listed) row takes its draft with it.
  const rowIds = rows.map((r) => r.id).join('\u0000');
  React.useEffect(() => {
    if (card !== undefined) pruneRows(cardKey, rowIds === '' ? [] : rowIds.split('\u0000'));
  }, [card, cardKey, rowIds, pruneRows]);

  const spec = React.useCallback((key: string) => fields.find((f) => f.key === key), [fields]);

  const draftOf = React.useCallback(
    (row: Row, key: string): DraftValue | undefined => (editing ? card?.drafts[row.id]?.[key] : undefined),
    [card, editing],
  );

  const text = (row: Row, key: string): string => {
    const f = spec(key);
    const d = draftOf(row, key);
    if (typeof d === 'string') return d;
    return f?.kind === 'number' ? String(f.served(row)) : '';
  };

  const selected = (row: Row, key: string): readonly string[] => {
    const f = spec(key);
    const d = draftOf(row, key);
    if (Array.isArray(d)) return d as readonly string[];
    return f?.kind === 'set' ? f.served(row) : [];
  };

  const isChanged = (row: Row, key: string): boolean => {
    const f = spec(key);
    const d = draftOf(row, key);
    if (!f || d === undefined) return false;
    if (f.kind === 'number') {
      const t = (d as string).trim();
      return t === '' || Number(t) !== f.served(row);
    }
    return !sameSet(d as readonly string[], f.served(row));
  };

  const invalid = (row: Row, key: string): string | null => {
    const f = spec(key);
    if (!f || f.kind !== 'number' || !isChanged(row, key)) return null;
    return f.validate(text(row, key).trim());
  };

  const rowChanged = (row: Row): boolean => fields.some((f) => isChanged(row, f.key));
  const changedRows = editing ? rows.filter(rowChanged) : [];
  const hasInvalid = changedRows.some((r) => fields.some((f) => invalid(r, f.key) !== null));

  const servedOf = (row: Row): Record<string, unknown> =>
    Object.fromEntries(fields.map((f) => [f.key, f.kind === 'number' ? f.served(row) : [...f.served(row)]]));

  const set = (row: Row, key: string, value: DraftValue): void => {
    const f = spec(key);
    if (!f || !editing) return;
    setBases((b) => captureBase(b, row.id, servedOf(row), [key]));
    const backToServed =
      f.kind === 'number'
        ? typeof value === 'string' && value.trim() !== '' && Number(value.trim()) === f.served(row)
        : Array.isArray(value) && sameSet(value as readonly string[], f.served(row));
    setField(cardKey, row.id, key, backToServed ? undefined : value);
  };

  const save = async (): Promise<void> => {
    if (!editing || card?.saving || changedRows.length === 0 || hasInvalid) return;
    setSaving(cardKey, true);
    const saved: string[] = [];
    const failed: Record<string, string> = {};
    for (const row of changedRows) {
      const body: Record<string, unknown> = {};
      for (const f of fields) {
        if (!isChanged(row, f.key)) continue;
        body[f.key] = f.kind === 'number' ? Number(text(row, f.key).trim()) : [...selected(row, f.key)];
      }
      let base = snapshotBase(bases, row.id, Object.keys(body), servedOf(row));
      for (;;) {
        try {
          await onUpdate(row.id, { ...body, base } as Body);
          saved.push(row.id);
        } catch (err) {
          const conflicts = editConflicts(err);
          if (conflicts !== null) {
            // P47 (ADR 0059 C2): ask whose value to keep for this row.
            const choice = await conflict.ask(conflicts);
            if (choice === 'mine') {
              base = keepMineBase(base, conflicts);
              continue;
            }
            if (choice === 'theirs') {
              // Drop my value for the conflicting fields only; the rest stays.
              const fieldsHit = conflicts.map((c) => c.field);
              for (const key of fieldsHit) setField(cardKey, row.id, key, undefined);
              setBases((b) => forgetBase(b, row.id, fieldsHit));
            }
            failed[row.id] = choice === 'theirs' ? CONFLICT_COPY.theirsKept : CONFLICT_COPY.dismissed;
          } else {
            failed[row.id] = saveErrorMessage(err);
          }
        }
        break;
      }
    }
    setBases((b) => saved.reduce((acc, id) => forgetBase(acc, id), b));
    settle(cardKey, saved, failed);
  };

  return {
    editing,
    saving: editing && (card?.saving ?? false),
    begin: () => begin(cardKey),
    cancel: () => end(cardKey),
    save,
    text,
    selected,
    set,
    revert: (row, key) => setField(cardKey, row.id, key, undefined),
    isChanged,
    rowChanged,
    invalid,
    rowError: (row) => (editing ? (card?.errors[row.id] ?? null) : null),
    changedRowCount: changedRows.length,
    hasInvalid,
    conflictDialog: conflict.dialog,
  };
}
