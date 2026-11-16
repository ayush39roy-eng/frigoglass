import { create } from 'zustand';

/**
 * Per-card edit mode on the Capacity Planning Overview (owner ask 2026-11-17:
 * "a save and edit option for selecting and deselecting in each card").
 *
 * A card (one hub's engineer card, one lab region card) is in edit mode while
 * it has an entry in `cards`. Drafts are kept per row and per field, holding
 * only the fields the user changed (a number as the typed text, a chip set as
 * the chosen codes). Nothing is sent until the card's Save.
 *
 * The store sits outside the cards so a draft survives the Overview tab being
 * unmounted (switching to Engineers / Chambers / What-if and back), and so the
 * page can guard leaving with one blocker. `PlanningPage` calls `reset()` on
 * unmount. No persistence: a reload drops drafts (the leave guard warns).
 *
 * Several cards may be in edit mode at the same time; each saves on its own.
 */
export type DraftValue = string | readonly string[];
export type RowDraft = Readonly<Record<string, DraftValue>>;

export interface CardEdit {
  /** rowId -> field -> draft value (only changed fields). */
  drafts: Readonly<Record<string, RowDraft>>;
  /** rowId -> save error message of the last Save (save-error.ts copy). */
  errors: Readonly<Record<string, string>>;
  saving: boolean;
}

interface CardEditState {
  cards: Readonly<Record<string, CardEdit>>;
  begin: (card: string) => void;
  /** Cancel, or a fully successful Save: drop the card's drafts and leave edit mode. */
  end: (card: string) => void;
  /** `undefined` drops the field (set back to the served value). */
  setField: (card: string, row: string, field: string, value: DraftValue | undefined) => void;
  /** Drop drafts of rows no longer listed (deleted, filtered out). */
  pruneRows: (card: string, keep: readonly string[]) => void;
  setSaving: (card: string, saving: boolean) => void;
  /** After a Save: clear saved rows, record failures; leave edit mode when nothing failed. */
  settle: (card: string, saved: readonly string[], failed: Readonly<Record<string, string>>) => void;
  reset: () => void;
}

const EMPTY: CardEdit = { drafts: {}, errors: {}, saving: false };

function without<T>(record: Readonly<Record<string, T>>, keys: readonly string[]): Record<string, T> {
  const next: Record<string, T> = { ...record };
  for (const k of keys) delete next[k];
  return next;
}

export const useCardEditStore = create<CardEditState>()((set) => ({
  cards: {},
  begin: (card) => set((s) => (s.cards[card] ? s : { cards: { ...s.cards, [card]: EMPTY } })),
  end: (card) => set((s) => (s.cards[card] ? { cards: without(s.cards, [card]) } : s)),
  setField: (card, row, field, value) =>
    set((s) => {
      const current = s.cards[card];
      if (!current) return s;
      const rowDraft: Record<string, DraftValue> = { ...(current.drafts[row] ?? {}) };
      if (value === undefined) delete rowDraft[field];
      else rowDraft[field] = value;
      const drafts =
        Object.keys(rowDraft).length === 0 ? without(current.drafts, [row]) : { ...current.drafts, [row]: rowDraft };
      return { cards: { ...s.cards, [card]: { ...current, drafts } } };
    }),
  pruneRows: (card, keep) =>
    set((s) => {
      const current = s.cards[card];
      if (!current) return s;
      const gone = Object.keys(current.drafts).filter((r) => !keep.includes(r));
      const goneErrors = Object.keys(current.errors).filter((r) => !keep.includes(r));
      if (gone.length === 0 && goneErrors.length === 0) return s;
      return {
        cards: {
          ...s.cards,
          [card]: { ...current, drafts: without(current.drafts, gone), errors: without(current.errors, goneErrors) },
        },
      };
    }),
  setSaving: (card, saving) =>
    set((s) => {
      const current = s.cards[card];
      if (!current) return s;
      return { cards: { ...s.cards, [card]: { ...current, saving } } };
    }),
  settle: (card, saved, failed) =>
    set((s) => {
      const current = s.cards[card];
      if (!current) return s;
      if (Object.keys(failed).length === 0) return { cards: without(s.cards, [card]) };
      return {
        cards: { ...s.cards, [card]: { drafts: without(current.drafts, saved), errors: { ...failed }, saving: false } },
      };
    }),
  reset: () => set({ cards: {} }),
}));

/** True while any card holds an unsaved draft (drives the leave guard). */
export function selectAnyDirty(s: { cards: Readonly<Record<string, CardEdit>> }): boolean {
  return Object.values(s.cards).some((c) => Object.keys(c.drafts).length > 0);
}
