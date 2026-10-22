import { create } from 'zustand';

import type { PriorityScoreUpdateRequest, ScenarioPriorityScoreChange } from '@/surfaces/matrix/api/types';

/**
 * Scenario edit state (P5-T01) — an in-progress, uncommitted set of
 * priority-score edits, held entirely client-side until "Apply"
 * (`docs/PROJECT_AND_STACK.md` §4: "A 'scenario' … is held in frontend
 * Zustand state and, on 'Apply', POSTed as a diff against the last committed
 * version"). Per `docs/MEMORY.md`'s P5-T02 entry, `POST /scenarios/apply`
 * only accepts `priority_scores` diffs today — Project/Engineer/Chamber
 * scenario edits have no backend path yet, so this store (and the types it
 * imports) is deliberately scoped to priority-score edits only. Widening it
 * to other entity types is a future task once the backend contract grows.
 *
 * This is a genuinely different interaction model from Matrix's existing
 * `PUT /priorities/{id}` immediate-write edit (`score-edit-dialog.tsx` /
 * `useUpdatePriorityScore`), which is untouched by this store and keeps
 * working exactly as before — "scenario mode" is additive, not a
 * replacement.
 *
 * No `persist` middleware: an in-progress scenario is intentionally ephemeral
 * (matching "not yet committed" — a page refresh abandoning unsaved edits is
 * the expected, conservative behaviour, not a bug to paper over).
 */

/** One project's staged, not-yet-applied priority-score edit. */
export interface ScenarioPendingEdit {
  projectId: string;
  /** Display-only — never sent to the backend. */
  projectName: string;
  /** Display-only — never sent to the backend. */
  hub: string;
  /**
   * P26: requests hold a `scores` map keyed by ACTIVE dimension key. `baseline`
   * and `next` both carry every active key of the row (null = not scored).
   *
   * The live `PriorityScoreUpdateRequest` values captured at the moment this
   * project was FIRST staged in the current scenario — i.e. "the last
   * committed version" this project is diffed against. Deliberately never
   * re-derived on a second edit of the same project before Apply: rebasing
   * `baseline` against an already-staged (uncommitted) value would make the
   * diff-on-Apply silently drop a real change if the user edited a project
   * twice and only the second edit happened to match the first edit's value.
   */
  baseline: PriorityScoreUpdateRequest;
  /**
   * Whether the project had a real, committed `PriorityScore` at the moment
   * this edit was first staged (`PriorityMatrixRow.has_score`). `false` means
   * `baseline` is only the form's neutral 3/5 pre-fill, not an actual
   * committed value — there is nothing to diff against, so `isNoOpEdit`
   * always treats such an edit as a genuine change (a first-time score is
   * meaningful even if every dimension happens to land on the default).
   * Captured once, alongside `baseline`, and never re-derived on a later
   * re-stage of the same project (same rationale as `baseline` itself).
   */
  hasScore: boolean;
  /** The staged, not-yet-applied new values. */
  next: PriorityScoreUpdateRequest;
  /** Display-only (P26): dimension labels by key, from the row the edit was
   *  staged on, so the pending list reads well even for a dimension the served
   *  model no longer lists. Never sent to the backend. */
  labels?: Record<string, string>;
}

type PendingMap = Record<string, ScenarioPendingEdit>;

export interface StageEditInput {
  projectId: string;
  projectName: string;
  hub: string;
  /** The project's current live `PriorityScoreUpdateRequest` values — read
   *  fresh from `GET /priorities` by the caller, never invented here. */
  liveValues: PriorityScoreUpdateRequest;
  /** The project's current live `has_score` flag — see `ScenarioPendingEdit
   *  .hasScore`. */
  liveHasScore: boolean;
  next: PriorityScoreUpdateRequest;
  /** Display-only dimension labels by key (see `ScenarioPendingEdit.labels`). */
  labels?: Record<string, string>;
}

interface ScenarioState {
  /** Whether "scenario mode" is toggled on for the Matrix surface. Turning
   *  this off does NOT discard any staged edits — only "Discard" does. */
  active: boolean;
  /** Optional free-text note sent as `ScenarioApplyRequest.notes` on Apply.
   *  Not part of undo/redo history (only the pending-edits map is). */
  notes: string;
  pending: PendingMap;
  /** Undo stack — snapshots of `pending` immediately before each mutation. */
  past: PendingMap[];
  /** Redo stack — snapshots of `pending` popped off by `undo()`. */
  future: PendingMap[];

  setActive: (active: boolean) => void;
  setNotes: (notes: string) => void;
  /** Stage (or update) one project's edit. If the project already has a
   *  staged edit, its original `baseline` is preserved — only `next` moves. */
  stageEdit: (input: StageEditInput) => void;
  /** Remove one project's staged edit entirely (undoable). */
  removeEdit: (projectId: string) => void;
  undo: () => void;
  redo: () => void;
  /** Clear all staged edits, history, and notes — used by both "Discard" and
   *  a successful "Apply" (the scenario is either abandoned or committed;
   *  either way there is nothing left to stage). */
  reset: () => void;
}

export const useScenarioStore = create<ScenarioState>()((set) => ({
  active: false,
  notes: '',
  pending: {},
  past: [],
  future: [],

  setActive: (active) => set({ active }),
  setNotes: (notes) => set({ notes }),

  stageEdit: ({ projectId, projectName, hub, liveValues, liveHasScore, next, labels }) =>
    set((state) => {
      const existing = state.pending[projectId];
      const baseline = existing ? existing.baseline : liveValues;
      const hasScore = existing ? existing.hasScore : liveHasScore;
      const merged = existing?.labels || labels ? { ...(existing?.labels ?? {}), ...(labels ?? {}) } : undefined;
      return {
        pending: {
          ...state.pending,
          [projectId]: { projectId, projectName, hub, baseline, hasScore, next, ...(merged ? { labels: merged } : {}) },
        },
        past: [...state.past, state.pending],
        future: [],
      };
    }),

  removeEdit: (projectId) =>
    set((state) => {
      if (!(projectId in state.pending)) return state;
      const nextPending = { ...state.pending };
      delete nextPending[projectId];
      return { pending: nextPending, past: [...state.past, state.pending], future: [] };
    }),

  undo: () =>
    set((state) => {
      if (state.past.length === 0) return state;
      const previous = state.past[state.past.length - 1] as PendingMap;
      return {
        pending: previous,
        past: state.past.slice(0, -1),
        future: [state.pending, ...state.future],
      };
    }),

  redo: () =>
    set((state) => {
      if (state.future.length === 0) return state;
      const [nextPending, ...rest] = state.future as [PendingMap, ...PendingMap[]];
      return {
        pending: nextPending,
        past: [...state.past, state.pending],
        future: rest,
      };
    }),

  reset: () => set({ pending: {}, past: [], future: [], notes: '' }),
}));

/** P26: equality over the union of both score maps' keys (a missing key reads
 *  as null) + order-independent `hard_gates`. */
function scoresEqual(a: PriorityScoreUpdateRequest, b: PriorityScoreUpdateRequest): boolean {
  const keys = new Set([...Object.keys(a.scores), ...Object.keys(b.scores)]);
  for (const key of keys) {
    if ((a.scores[key] ?? null) !== (b.scores[key] ?? null)) return false;
  }
  if (a.hard_gates.length !== b.hard_gates.length) return false;
  const bSorted = [...b.hard_gates].sort();
  return [...a.hard_gates].sort().every((g, i) => g === bSorted[i]);
}

/** The scores of `next` that differ from `baseline` (P26 diff semantics). */
export function changedScoreKeys(edit: ScenarioPendingEdit): string[] {
  return Object.keys(edit.next.scores).filter(
    (key) => (edit.baseline.scores[key] ?? null) !== (edit.next.scores[key] ?? null),
  );
}

/** True if a staged edit's `next` is identical to its `baseline` — e.g. the
 *  user changed a value and then changed it back before Apply. Such an edit
 *  is a no-op: nothing to send, and (per `effectivePendingEdits` below) not
 *  counted as a "real" staged change either.
 *
 *  An unscored project (`hasScore=false`) is NEVER a no-op, regardless of
 *  what `next` contains: there is no committed value to diff against, so any
 *  staged score is a genuine create. */
export function isNoOpEdit(edit: ScenarioPendingEdit): boolean {
  if (!edit.hasScore) return false;
  return scoresEqual(edit.baseline, edit.next);
}

/** All staged edits that are genuinely different from their baseline —
 *  filters out no-ops. This is what the pending-changes panel counts and
 *  lists, and what `computeScenarioDiff` sources from. */
export function effectivePendingEdits(pending: PendingMap): ScenarioPendingEdit[] {
  return Object.values(pending).filter((edit) => !isNoOpEdit(edit));
}

/**
 * The `POST /scenarios/apply` `priority_scores` diff (P26 contract §5): one
 * entry per genuinely-changed project with ONLY the dimensions whose staged
 * value differs from the baseline (omitted keys keep their stored value; null
 * clears) and the full `hard_gates` list. No-op edits (see `isNoOpEdit`) are
 * excluded — the frontend does not rely on the backend to drop them. With
 * `activeKeys`, a key that is no longer an active dimension (the rubric changed
 * after the edit was staged) is left out, so the batch is not rejected.
 */
export function computeScenarioDiff(
  pending: PendingMap,
  activeKeys?: ReadonlySet<string>,
): ScenarioPriorityScoreChange[] {
  return effectivePendingEdits(pending).map((edit) => {
    const scores: PriorityScoreUpdateRequest['scores'] = {};
    for (const key of changedScoreKeys(edit)) {
      if (activeKeys && !activeKeys.has(key)) continue;
      scores[key] = edit.next.scores[key] ?? null;
    }
    return { project_id: edit.projectId, scores, hard_gates: [...edit.next.hard_gates] };
  });
}
