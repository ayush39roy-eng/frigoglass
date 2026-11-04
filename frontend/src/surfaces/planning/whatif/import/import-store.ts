import { create } from 'zustand';

import { editKey, editsForRequest, isEmptyEdit, type EditMap, type ImportOptions } from './import-rows';
import type { ImportParseResponse, ImportRow, ImportSimulateResponse, ImportStepEdit } from './import-types';

/**
 * Plan-import state (P32-T06, ADR 0044). Session only: no `persist`, nothing is saved
 * server-side, a page refresh clears it. Holds the parsed response, the planner's edited
 * rows, the options, the Gantt edits map (with an undo stack) and the last served result.
 * The result is stored exactly as served; nothing here derives a figure from it.
 */

export type ImportStep = 'upload' | 'review' | 'results';
export type ResultsTab = 'overview' | 'gantt' | 'capacity' | 'projects';

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  mode: 'merge',
  planYearEndWeek: 104,
  expandMulti: false,
};
const UNDO_LIMIT = 50;

export type StepEditPatch = Partial<Pick<ImportStepEdit, 'duration_weeks' | 'start_not_before_week' | 'overlap_weeks'>>;

export interface ImportState {
  step: ImportStep;
  parsed: ImportParseResponse | null;
  rows: ImportRow[];
  options: ImportOptions;
  edits: EditMap;
  undoStack: EditMap[];
  result: ImportSimulateResponse | null;
  resultsTab: ResultsTab;

  /** A fresh parse: rows reset to the served ones, edits and result cleared. */
  setParsed: (parsed: ImportParseResponse) => void;
  updateRow: (key: string, next: ImportRow) => void;
  setAllIncluded: (include: boolean) => void;
  setOptions: (patch: Partial<ImportOptions>) => void;
  setStep: (step: ImportStep) => void;
  setResultsTab: (tab: ResultsTab) => void;
  setResult: (result: ImportSimulateResponse) => void;
  /**
   * Apply a Gantt drop. `base` is the step's served timing triple, used when the step has
   * no edit yet so an edit never silently clears a value the plan already had.
   */
  applyEdit: (ref: string, stepId: string, patch: StepEditPatch, base: StepEditPatch) => void;
  undoEdit: () => void;
  resetEdits: () => void;
  /** Drop edits that no longer apply (row excluded, plan project out of the run, replaced). */
  pruneEdits: () => void;
  /** Back to an empty upload. */
  reset: () => void;
}

const EMPTY = {
  step: 'upload' as ImportStep,
  parsed: null,
  rows: [] as ImportRow[],
  options: DEFAULT_IMPORT_OPTIONS,
  edits: {} as EditMap,
  undoStack: [] as EditMap[],
  result: null,
  resultsTab: 'overview' as ResultsTab,
};

function pushUndo(stack: EditMap[], edits: EditMap): EditMap[] {
  const next = [...stack, edits];
  return next.length > UNDO_LIMIT ? next.slice(next.length - UNDO_LIMIT) : next;
}

export const useImportPlan = create<ImportState>()((set) => ({
  ...EMPTY,
  setParsed: (parsed) =>
    set({
      ...EMPTY,
      parsed,
      rows: parsed.rows.map((r) => ({ ...r })),
      step: 'review',
    }),
  updateRow: (key, next) => set((s) => ({ rows: s.rows.map((r) => (r.key === key ? next : r)) })),
  setAllIncluded: (include) =>
    set((s) => ({
      rows: s.rows.map((r) => (r.include === include ? r : { ...r, include })),
    })),
  setOptions: (patch) => set((s) => ({ options: { ...s.options, ...patch } })),
  setStep: (step) => set({ step }),
  setResultsTab: (resultsTab) => set({ resultsTab }),
  setResult: (result) => set({ result }),
  applyEdit: (ref, stepId, patch, base) =>
    set((s) => {
      const k = editKey(ref, stepId);
      const prev = s.edits[k];
      const from = prev ?? {
        duration_weeks: base.duration_weeks ?? null,
        start_not_before_week: base.start_not_before_week ?? null,
        overlap_weeks: base.overlap_weeks ?? null,
      };
      const merged: ImportStepEdit = {
        project_ref: ref,
        step_id: stepId,
        duration_weeks: from.duration_weeks,
        start_not_before_week: from.start_not_before_week,
        overlap_weeks: from.overlap_weeks,
        ...patch,
      };
      const edits = { ...s.edits };
      if (isEmptyEdit(merged)) delete edits[k];
      else edits[k] = merged;
      return { edits, undoStack: pushUndo(s.undoStack, s.edits) };
    }),
  undoEdit: () =>
    set((s) => {
      const prev = s.undoStack.at(-1);
      if (!prev) return {};
      return { edits: prev, undoStack: s.undoStack.slice(0, -1) };
    }),
  resetEdits: () =>
    set((s) => (Object.keys(s.edits).length === 0 ? {} : { edits: {}, undoStack: pushUndo(s.undoStack, s.edits) })),
  pruneEdits: () =>
    set((s) => {
      const kept = editsForRequest(s.edits, s.rows, s.options);
      if (kept.length === Object.keys(s.edits).length) return {};
      return {
        edits: Object.fromEntries(kept.map((e) => [editKey(e.project_ref, e.step_id), e])),
        undoStack: [],
      };
    }),
  reset: () => set({ ...EMPTY }),
}));
