import * as React from 'react';

import { useEditSession } from '@/stores/edit-session';
import type { WorkflowId, WorkflowStepKind } from '@/types/enums';

import type { LeadTimeSetting, WorkflowSetting } from '../api/types';
import { draftedStepCount, setWeeks, type WorkflowDrafts } from '../lib/effort-matrix';
import {
  nudge as nudgeDraft,
  pruneDrafts,
  resetStep as resetDraftStep,
  savedCells,
  type CategoryDrafts,
  type DraftField,
  type SavedCell,
} from '../lib/template-drafts';

type ByWorkflow<T> = Partial<Record<WorkflowId, T>>;
type KindDrafts = Readonly<Record<string, WorkflowStepKind>>;
const EMPTY_SAVED: Readonly<Record<string, SavedCell>> = {};

/**
 * P52-T01: the drafts of the "Effort & Timeline Planning" matrix, held by the
 * Workflow page above its tabs so switching tabs keeps them (owner rule
 * 2026-11-19: nothing typed is silently discarded). Two kinds of draft:
 *
 * - template lengths and gaps, per workflow × category (the P33 draft shape);
 *   saved only by "Apply to App" through the one apply dialog (E2 → E3);
 * - step kinds (the Resource row), per workflow; saved by "Apply to App"
 *   through the existing steps PUT (Super Admin), after the confirm dialog.
 *
 * A reloaded template or workflow drops drafts that now equal the saved
 * value. While anything is drafted the page holds auto reload
 * (`useEditSession`) and asks before leaving.
 */
export function useEffortMatrix({
  leadTimes,
  workflows,
}: {
  leadTimes: readonly LeadTimeSetting[];
  workflows: readonly WorkflowSetting[];
}) {
  const [drafts, setDrafts] = React.useState<ByWorkflow<WorkflowDrafts>>({});
  const [kinds, setKinds] = React.useState<ByWorkflow<KindDrafts>>({});
  const [invalid, setInvalidKeys] = React.useState<ReadonlySet<string>>(() => new Set());

  const savedIndex = React.useMemo(() => {
    const index = new Map<string, Record<string, SavedCell>>();
    for (const lt of leadTimes) {
      const key = `${lt.workflow_id}|${lt.category}`;
      const row = index.get(key) ?? {};
      row[lt.step_id] = { weeks: lt.weeks, gap_weeks: lt.gap_weeks };
      index.set(key, row);
    }
    return index;
  }, [leadTimes]);
  const savedOf = React.useCallback(
    (workflowId: WorkflowId, category: string): Readonly<Record<string, SavedCell>> =>
      savedIndex.get(`${workflowId}|${category}`) ?? EMPTY_SAVED,
    [savedIndex],
  );

  // A reloaded template / workflow (an apply, a 409 reload, someone else's
  // save) drops drafts that equal the saved value. Adjusted during render.
  const [leadSeen, setLeadSeen] = React.useState(leadTimes);
  if (leadSeen !== leadTimes) {
    setLeadSeen(leadTimes);
    setDrafts((prev) => pruneAll(prev, (wf, cat) => savedCells(leadTimes, wf, cat)));
  }
  const [workflowsSeen, setWorkflowsSeen] = React.useState(workflows);
  if (workflowsSeen !== workflows) {
    setWorkflowsSeen(workflows);
    setKinds((prev) => pruneKinds(prev, workflows));
  }

  const updateCategory = React.useCallback(
    (workflowId: WorkflowId, category: string, fn: (d: CategoryDrafts, saved: Readonly<Record<string, SavedCell>>) => CategoryDrafts) => {
      const saved = savedOf(workflowId, category);
      setDrafts((prev) => {
        const byCat = prev[workflowId] ?? {};
        const next = fn(byCat[category] ?? {}, saved);
        const nextByCat: Record<string, CategoryDrafts> = { ...byCat };
        if (Object.keys(next).length === 0) delete nextByCat[category];
        else nextByCat[category] = next;
        return { ...prev, [workflowId]: nextByCat };
      });
    },
    [savedOf],
  );

  const setCellWeeks = React.useCallback(
    (workflowId: WorkflowId, category: string, stepId: string, weeks: number) =>
      updateCategory(workflowId, category, (d, saved) => setWeeks(d, saved, stepId, weeks)),
    [updateCategory],
  );
  const nudge = React.useCallback(
    (workflowId: WorkflowId, category: string, stepId: string, field: DraftField, direction: -1 | 1) =>
      updateCategory(workflowId, category, (d, saved) => nudgeDraft(d, saved, stepId, field, direction)),
    [updateCategory],
  );
  const resetStep = React.useCallback(
    (workflowId: WorkflowId, category: string, stepId: string) =>
      updateCategory(workflowId, category, (d) => resetDraftStep(d, stepId)),
    [updateCategory],
  );

  const servedKind = React.useCallback(
    (workflowId: WorkflowId, stepId: string): WorkflowStepKind | undefined =>
      workflows.find((w) => w.id === workflowId)?.steps.find((s) => s.step_id === stepId)?.kind,
    [workflows],
  );
  const kindOf = React.useCallback(
    (workflowId: WorkflowId, stepId: string): WorkflowStepKind =>
      kinds[workflowId]?.[stepId] ?? servedKind(workflowId, stepId) ?? 'elapsed',
    [kinds, servedKind],
  );
  const setKind = React.useCallback(
    (workflowId: WorkflowId, stepId: string, kind: WorkflowStepKind) => {
      const served = servedKind(workflowId, stepId);
      setKinds((prev) => {
        const next: Record<string, WorkflowStepKind> = { ...prev[workflowId] };
        if (kind === served) delete next[stepId];
        else next[stepId] = kind;
        return { ...prev, [workflowId]: next };
      });
    },
    [servedKind],
  );
  const clearKinds = React.useCallback((workflowId: WorkflowId) => {
    setKinds((prev) => ({ ...prev, [workflowId]: {} }));
  }, []);
  const clearTemplateDrafts = React.useCallback(() => setDrafts({}), []);
  const discardAll = React.useCallback(() => {
    setDrafts({});
    setKinds({});
    setInvalidKeys(new Set());
  }, []);

  const setInvalid = React.useCallback((key: string, isInvalid: boolean) => {
    setInvalidKeys((prev) => {
      if (prev.has(key) === isInvalid) return prev;
      const next = new Set(prev);
      if (isInvalid) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const templateCount = draftedStepCount(drafts.PDD) + draftedStepCount(drafts.OEM);
  const kindCount = Object.keys(kinds.PDD ?? {}).length + Object.keys(kinds.OEM ?? {}).length;
  const dirty = templateCount > 0 || kindCount > 0 || invalid.size > 0;
  // P49-R01 (ADR 0060 R1): unsaved matrix drafts hold an auto reload.
  useEditSession(dirty);

  return {
    drafts,
    kinds,
    savedOf,
    kindOf,
    setCellWeeks,
    nudge,
    resetStep,
    setKind,
    clearKinds,
    clearTemplateDrafts,
    discardAll,
    invalid,
    setInvalid,
    templateCount,
    kindCount,
    dirty,
  };
}

export type EffortMatrixState = ReturnType<typeof useEffortMatrix>;

function pruneAll(
  drafts: ByWorkflow<WorkflowDrafts>,
  savedOf: (workflowId: WorkflowId, category: string) => Readonly<Record<string, SavedCell>>,
): ByWorkflow<WorkflowDrafts> {
  let changed = false;
  const out: Record<string, WorkflowDrafts> = {};
  for (const [wf, byCat] of Object.entries(drafts) as [WorkflowId, WorkflowDrafts][]) {
    const nextByCat: Record<string, CategoryDrafts> = {};
    for (const [cat, d] of Object.entries(byCat)) {
      const pruned = pruneDrafts(d, savedOf(wf, cat));
      if (pruned !== d) changed = true;
      if (Object.keys(pruned).length > 0) nextByCat[cat] = pruned;
      else changed = true;
    }
    out[wf] = nextByCat;
  }
  return changed ? out : drafts;
}

function pruneKinds(kinds: ByWorkflow<KindDrafts>, workflows: readonly WorkflowSetting[]): ByWorkflow<KindDrafts> {
  let changed = false;
  const out: Record<string, KindDrafts> = {};
  for (const [wf, byStep] of Object.entries(kinds) as [WorkflowId, KindDrafts][]) {
    const served = new Map((workflows.find((w) => w.id === wf)?.steps ?? []).map((s) => [s.step_id, s.kind]));
    const next: Record<string, WorkflowStepKind> = {};
    for (const [stepId, kind] of Object.entries(byStep)) {
      if (served.get(stepId) === kind) changed = true;
      else next[stepId] = kind;
    }
    out[wf] = next;
  }
  return changed ? out : kinds;
}
