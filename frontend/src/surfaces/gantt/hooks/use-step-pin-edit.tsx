import * as React from 'react';

import type { GanttProjectRow, GanttStepRow, StepPinError } from '../api/types';
import { stepPinErrorText } from '../api/step-pins-api';
import {
  draftsToItems,
  pinDraftProblem,
  pinKey,
  sameAsLive,
  shownPair,
  typeEnd,
  typeStart,
  type StepPinDraft,
} from '../lib/step-pin-drafts';

/**
 * P40-T03c: the Timeline's drafted Start / End weeks across projects, held by
 * GanttPage and read by each expanded step row's inputs through a context
 * (the rows are virtualized; a draft outlives its row scrolling away or a
 * filter hiding its project). One batch Save sends them all.
 */
export interface StepPinEditApi {
  /** The served current week (`GanttResponse.current_week`): the lowest week
   *  the inputs accept. */
  minWeek: number;
  /** The plan year's last week (R40-1: the write cap is W52). */
  maxWeek: number;
  drafts: ReadonlyMap<string, StepPinDraft>;
  /** Per-step refusals of the last Save, by `pinKey`. */
  serverErrors: ReadonlyMap<string, string>;
  /** True while a Save is in flight: the inputs are locked. */
  locked: boolean;
  setStart: (project: GanttProjectRow, step: GanttStepRow, raw: string) => void;
  setEnd: (project: GanttProjectRow, step: GanttStepRow, raw: string) => void;
  clear: (project: GanttProjectRow, step: GanttStepRow) => void;
}

const StepPinEditContext = React.createContext<StepPinEditApi | null>(null);

export const StepPinEditProvider = StepPinEditContext.Provider;

/** The page's pin editing, or null where the chart is not the Timeline. */
export function useStepPinEdit(): StepPinEditApi | null {
  return React.useContext(StepPinEditContext);
}

export interface StepPinDraftState {
  api: StepPinEditApi;
  /** Drafts in the order they were first edited (the batch order). */
  list: StepPinDraft[];
  /** Drafts with a red value: Save is disabled while any exists. */
  invalidCount: number;
  projectCount: number;
  /** Map a refused batch's per-item errors back onto their steps. */
  applyServerErrors: (errors: readonly StepPinError[], sent: readonly StepPinDraft[]) => void;
  /** Drop every draft and error (Cancel, or after a successful Save). */
  reset: () => void;
  /** P47 ("Use theirs"): drop the drafts of these steps only. */
  dropKeys: (keys: readonly string[]) => void;
  items: () => ReturnType<typeof draftsToItems>;
}

export function useStepPinDraftState({
  minWeek,
  maxWeek,
  locked,
}: {
  minWeek: number;
  maxWeek: number;
  locked: boolean;
}): StepPinDraftState {
  const [drafts, setDrafts] = React.useState<ReadonlyMap<string, StepPinDraft>>(() => new Map());
  const [serverErrors, setServerErrors] = React.useState<ReadonlyMap<string, string>>(() => new Map());

  const write = React.useCallback(
    (project: GanttProjectRow, step: GanttStepRow, next: (cur: { start: string; end: string }) => { start: string; end: string }) => {
      const key = pinKey(project.project_id, step.step_id);
      setDrafts((prev) => {
        const before = prev.get(key);
        const pair = next(shownPair(step, before));
        const out = new Map(prev);
        if (sameAsLive(pair, step)) {
          out.delete(key);
        } else {
          // Keep the first-edit position (Map insertion order) for a stable batch.
          out.set(key, {
            projectId: project.project_id,
            stepId: step.step_id,
            projectName: project.project_name,
            stepName: step.step_name,
            start: pair.start,
            end: pair.end,
            // P47 (ADR 0059): the served pin when the step was first edited.
            baseStart: before ? (before.baseStart ?? null) : step.manual_start_week,
            baseEnd: before ? (before.baseEnd ?? null) : step.manual_end_week,
          });
        }
        return out;
      });
      setServerErrors((prev) => {
        if (!prev.has(key)) return prev;
        const out = new Map(prev);
        out.delete(key);
        return out;
      });
    },
    [],
  );

  const setStart = React.useCallback<StepPinEditApi['setStart']>(
    (project, step, raw) => write(project, step, (cur) => typeStart(cur, raw, step.current_length_weeks)),
    [write],
  );
  const setEnd = React.useCallback<StepPinEditApi['setEnd']>(
    (project, step, raw) => write(project, step, (cur) => typeEnd(cur, raw, step.planned_start_week)),
    [write],
  );
  const clear = React.useCallback<StepPinEditApi['clear']>(
    (project, step) => write(project, step, () => ({ start: '', end: '' })),
    [write],
  );

  const reset = React.useCallback(() => {
    setDrafts(new Map());
    setServerErrors(new Map());
  }, []);

  const dropKeys = React.useCallback((keys: readonly string[]) => {
    setDrafts((prev) => {
      const out = new Map(prev);
      for (const key of keys) out.delete(key);
      return out;
    });
  }, []);

  const applyServerErrors = React.useCallback(
    (errors: readonly StepPinError[], sent: readonly StepPinDraft[]) => {
      const out = new Map<string, string>();
      for (const err of errors) {
        // `index` is the item's position in the sent batch; fall back to the ids.
        const byIndex = sent[err.index];
        const key =
          byIndex && byIndex.projectId === err.project_id && byIndex.stepId === err.step_template_id
            ? pinKey(byIndex.projectId, byIndex.stepId)
            : pinKey(err.project_id, err.step_template_id);
        if (!out.has(key)) out.set(key, stepPinErrorText(err));
      }
      setServerErrors(out);
    },
    [],
  );

  const list = React.useMemo(() => [...drafts.values()], [drafts]);
  const invalidCount = React.useMemo(
    () => list.filter((d) => pinDraftProblem(d, minWeek, maxWeek) !== null).length,
    [list, minWeek, maxWeek],
  );
  const projectCount = React.useMemo(() => new Set(list.map((d) => d.projectId)).size, [list]);

  const api = React.useMemo<StepPinEditApi>(
    () => ({ minWeek, maxWeek, drafts, serverErrors, locked, setStart, setEnd, clear }),
    [minWeek, maxWeek, drafts, serverErrors, locked, setStart, setEnd, clear],
  );

  const items = React.useCallback(() => draftsToItems(list), [list]);

  return { api, list, invalidCount, projectCount, applyServerErrors, reset, dropKeys, items };
}
