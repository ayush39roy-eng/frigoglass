import { create } from 'zustand';

import { editKey, editsForRequest, isEmptyEdit, isMappedStatus, type EditMap, type ImportOptions } from './import-rows';
import type {
  ImportParseResponse,
  ImportRow,
  ImportSimulateRequest,
  ImportSimulateResponse,
  ImportStepEdit,
} from './import-types';
import { windowOptionsOf } from './plan-window';
import { optionsOf } from './saved-scenarios';

/**
 * Plan-import state (P32-T06, ADR 0044). Session only: no `persist`, a page refresh clears
 * it (a saved import scenario lives on the server, P41 / ADR 0055 D3, and is loaded on demand). Holds the parsed response, the planner's edited
 * rows, the options, the Gantt edits map (with an undo stack) and the last served result.
 * The result is stored exactly as served; nothing here derives a figure from it.
 */

export type ImportStep = 'upload' | 'review' | 'results';
export type ResultsTab = 'executive' | 'gantt' | 'capacity' | 'projects' | 'compare';

export const DEFAULT_IMPORT_OPTIONS: ImportOptions = {
  mode: 'file_only', // owner 2026-11-23: "This file only" by default
  // P53 (R53-4): null = the server's default, the end of the current plan year.
  planYearEndWeek: null,
  // Owner rule 2026-11-04 (P32-R03): "Num of Projects" is a project count, on by default.
  expandMulti: true,
};
const UNDO_LIMIT = 50;

/**
 * P41 (ADR 0055 D3): the workbook the session's rows came from, sent with a saved scenario
 * so the library can group by file. `sha256` is the browser's digest of the uploaded bytes
 * (null when the browser could not hash it; saving is then off).
 */
export interface ImportSource {
  file_name: string;
  sha256: string | null;
  imported_at: string;
}

/**
 * P41: a scenario shown read-only on the results instead of the current result. `session`
 * is a variant of this session; `saved` is a frozen server record (ADR 0055 D3).
 */
export type ScenarioView =
  | { kind: 'session'; id: string; name: string; result: ImportSimulateResponse; request: ImportSimulateRequest }
  | {
      kind: 'saved';
      id: string;
      name: string;
      result: ImportSimulateResponse;
      request: ImportSimulateRequest;
      simulated_week: number;
      plan_version: number | null;
      /** P50 (API_CONTRACT_P41 §F): the stored window (older rows: simulated week / preset). */
      plan_from_week: number;
      plan_until_week: number;
      source: ImportSource;
      can_edit: boolean;
    };

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
  /**
   * The Results "Year" filter key (P32-R05 C2): `all`, a year, `later` or `not_placed`.
   * Shared by the Executive, Gantt and Projects tabs.
   */
  yearFilter: string;
  /**
   * "Show on Gantt" from a drill-down (P32-R07): the project the Gantt tab opens on (filtered
   * by its name, expanded, scrolled to). Consumed by the Gantt on mount; `ganttFocusNonce`
   * remounts the Gantt so a second request applies too.
   */
  ganttFocus: { ref: string; name: string } | null;
  ganttFocusNonce: number;
  /** P41: the uploaded workbook (set after a parse). */
  source: ImportSource | null;
  /** P41 (contract B): plan projects unticked in the picker, sent in merge mode. */
  excludedPlanIds: string[];
  /** P41: a scenario shown read-only instead of the current result, or null. */
  view: ScenarioView | null;
  /** P41: bumped by "Re-run on today's plan" so an unchanged body still re-simulates. */
  rerunNonce: number;
  /**
   * P48-R01: the results were reached from the upload step's saved-scenario panel (Open or
   * Compare). They then show the stored scenarios whatever workbook is loaded, and the loaded
   * workbook is not simulated. Cleared by any step change, a new parse, a reset and a re-run.
   */
  savedBrowse: boolean;

  /** A fresh parse: rows reset to the served ones, edits and result cleared. */
  setParsed: (parsed: ImportParseResponse) => void;
  updateRow: (key: string, next: ImportRow) => void;
  setAllIncluded: (include: boolean) => void;
  setOptions: (patch: Partial<ImportOptions>) => void;
  setStep: (step: ImportStep) => void;
  /** P48-R01: go to the results from the saved-scenario panel (optionally on `tab`). */
  browseSaved: (tab?: ResultsTab) => void;
  setResultsTab: (tab: ResultsTab) => void;
  setYearFilter: (key: string) => void;
  /** Switch to the Gantt tab on `ref`; `yearFilter` "all" when its year block is not shown. */
  focusOnGantt: (focus: { ref: string; name: string }, resetYear: boolean) => void;
  consumeGanttFocus: () => void;
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
  setSource: (source: ImportSource | null) => void;
  /**
   * The project picker's "Compute scenario": file rows in `includedKeys` are included (a
   * not-mapped status stays out), the others excluded; `excludedPlanIds` replaces the list.
   * Back to the current result, which then re-simulates.
   */
  applyPicks: (includedKeys: ReadonlySet<string>, excludedPlanIds: readonly string[]) => void;
  openView: (view: ScenarioView) => void;
  closeView: () => void;
  /**
   * "Re-run on today's plan": the stored request becomes the session's rows, options,
   * edits and exclusions, and is simulated again (always, even when unchanged).
   */
  restoreRequest: (request: ImportSimulateRequest, source: ImportSource | null) => void;
  /**
   * P50 (R49-13 / R49-19): after a re-run, the window options take the served (possibly
   * raised) weeks and the re-run flag is cleared, so later requests send a valid window.
   */
  settleWindow: (result: ImportSimulateResponse) => void;
}

const EMPTY = {
  step: 'upload' as ImportStep,
  parsed: null,
  rows: [] as ImportRow[],
  options: DEFAULT_IMPORT_OPTIONS,
  edits: {} as EditMap,
  undoStack: [] as EditMap[],
  result: null,
  resultsTab: 'executive' as ResultsTab,
  yearFilter: 'all',
  ganttFocus: null as { ref: string; name: string } | null,
  ganttFocusNonce: 0,
  source: null as ImportSource | null,
  excludedPlanIds: [] as string[],
  view: null as ScenarioView | null,
  rerunNonce: 0,
  savedBrowse: false,
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
  setStep: (step) => set({ step, savedBrowse: false }),
  browseSaved: (tab) => set({ step: 'results', savedBrowse: true, ...(tab ? { resultsTab: tab } : {}) }),
  setResultsTab: (resultsTab) => set({ resultsTab }),
  setYearFilter: (yearFilter) => set({ yearFilter }),
  focusOnGantt: (ganttFocus, resetYear) =>
    set((s) => ({
      ganttFocus,
      ganttFocusNonce: s.ganttFocusNonce + 1,
      resultsTab: 'gantt',
      ...(resetYear ? { yearFilter: 'all' } : {}),
    })),
  consumeGanttFocus: () => set((s) => (s.ganttFocus === null ? {} : { ganttFocus: null })),
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
      const kept = editsForRequest(s.edits, s.rows, s.options, s.excludedPlanIds);
      if (kept.length === Object.keys(s.edits).length) return {};
      return {
        edits: Object.fromEntries(kept.map((e) => [editKey(e.project_ref, e.step_id), e])),
        undoStack: [],
      };
    }),
  reset: () => set({ ...EMPTY }),
  setSource: (source) => set({ source }),
  applyPicks: (includedKeys, excludedPlanIds) =>
    set((s) => ({
      rows: s.rows.map((r) => {
        const include = includedKeys.has(r.key) && isMappedStatus(r.status);
        return r.include === include ? r : { ...r, include };
      }),
      excludedPlanIds: [...new Set(excludedPlanIds)].sort(),
      view: null,
    })),
  openView: (view) => set({ view }),
  closeView: () => set((s) => (s.view === null ? {} : { view: null })),
  restoreRequest: (request, source) =>
    set((s) => ({
      rows: request.rows.map((r) => ({ ...r })),
      // P50: the stored window, sent with `plan_window_rerun: true` (the server raises a
      // passed f to today's week, then u to f, instead of answering 422).
      options: { ...optionsOf(request), planWindowRerun: true },
      edits: Object.fromEntries(request.edits.map((e) => [editKey(e.project_ref, e.step_id), { ...e }])),
      undoStack: [],
      excludedPlanIds: [...(request.exclude_plan_project_ids ?? [])],
      source: source ?? s.source,
      view: null,
      rerunNonce: s.rerunNonce + 1,
      savedBrowse: false,
    })),
  settleWindow: (result) =>
    set((s) => ({ options: { ...s.options, ...windowOptionsOf(result, s.options.planYearEndWeek) } })),
}));
