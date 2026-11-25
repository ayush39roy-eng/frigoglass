import * as React from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';

import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useEditSession } from '@/stores/edit-session';
import type { ProjectCategory, WorkflowId } from '@/types/enums';

import { previewTimeline } from '../api/workflow-settings-api';
import type { CategoryTimeline, TemplateStepOverride } from '../api/types';
import {
  draftOverrides,
  nudge as nudgeDraft,
  nudgeHold as nudgeHoldDraft,
  pruneDrafts,
  resetStep as resetDraftStep,
  type CategoryDrafts,
  type DraftField,
  type HoldAction,
  type SavedCell,
} from '../lib/template-drafts';

/** Contract D: the editor calls the preview after each click, debounced 150 ms. */
export const PREVIEW_DEBOUNCE_MS = 150;

export interface ShownTimeline {
  timeline: CategoryTimeline;
  /** The overrides `timeline` was computed for (empty = the saved template). */
  basis: readonly TemplateStepOverride[];
}

function sameOverrides(a: readonly TemplateStepOverride[], b: readonly TemplateStepOverride[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * P33-T16: draft state of one category's timeline editor plus its live
 * redraw. Each Move / Length click updates the drafts; once clicks pause for
 * 150 ms the overrides go to `POST /workflow-templates/timeline-preview`
 * (stateless). The latest reply is drawn; an older one stays on screen while
 * the newer is in flight (`pending`). With no drafts the saved timeline (C2)
 * is drawn and nothing is requested.
 */
export function useTemplateEditor({
  workflowId,
  category,
  saved,
  savedTimeline,
  enabled,
}: {
  workflowId: WorkflowId;
  category: ProjectCategory;
  saved: Readonly<Record<string, SavedCell>>;
  savedTimeline: CategoryTimeline;
  /** `workflow_templates.write`: readers never call the preview (it needs write). */
  enabled: boolean;
}) {
  const [drafts, setDrafts] = React.useState<CategoryDrafts>({});
  // A reloaded template (after a 409 TEMPLATE_CHANGED, or someone else's
  // save) can make a draft equal to the saved value: drop it, so Save never
  // sends a no-op step (E1 `NO_CHANGE`). Adjusted during render, not in an effect.
  const [savedSeen, setSavedSeen] = React.useState(saved);
  if (savedSeen !== saved) {
    setSavedSeen(saved);
    setDrafts((prev) => pruneDrafts(prev, saved));
  }
  const overrides = React.useMemo(() => draftOverrides(drafts), [drafts]);
  // P49-R01 (ADR 0060 R1, Q49-1a): unsaved timeline drafts hold an auto reload.
  useEditSession(overrides.length > 0);
  const { shown, pending, error } = useTimelinePreview({ workflowId, category, overrides, savedTimeline, enabled });

  const nudge = React.useCallback(
    (stepId: string, field: DraftField, direction: -1 | 1) => {
      setDrafts((prev) => nudgeDraft(prev, saved, stepId, field, direction));
    },
    [saved],
  );
  /** P62: a room-weeks click on a lab step whose length in force is `weeks`. */
  const hold = React.useCallback(
    (stepId: string, action: HoldAction, weeks: number) => {
      setDrafts((prev) => nudgeHoldDraft(prev, saved, stepId, action, weeks));
    },
    [saved],
  );
  const resetStep = React.useCallback((stepId: string) => setDrafts((prev) => resetDraftStep(prev, stepId)), []);
  const discard = React.useCallback(() => setDrafts({}), []);

  return {
    drafts,
    overrides,
    shown,
    /** A click is not yet reflected by a served timeline. */
    pending,
    /** The newest preview request failed (the last good timeline stays drawn). */
    error,
    nudge,
    hold,
    resetStep,
    discard,
  };
}

/**
 * P52-T01: the live redraw of one category timeline for drafts held by the
 * caller (the "Effort & Timeline Planning" matrix keeps one draft set per
 * workflow, shared by its grid cells and its timeline ± buttons). Same
 * contract D call, debounce and fallbacks as `useTemplateEditor`.
 */
export function useTimelinePreview({
  workflowId,
  category,
  overrides,
  savedTimeline,
  enabled,
}: {
  workflowId: WorkflowId;
  category: ProjectCategory;
  overrides: readonly TemplateStepOverride[];
  savedTimeline: CategoryTimeline;
  enabled: boolean;
}): { shown: ShownTimeline; pending: boolean; error: Error | null } {
  const debounced = useDebouncedValue(overrides, PREVIEW_DEBOUNCE_MS);
  const preview = useQuery({
    queryKey: ['workflow-settings', 'timeline-preview', workflowId, category, debounced] as const,
    queryFn: async ({ signal }): Promise<ShownTimeline> => {
      const timeline = await previewTimeline({ workflow_id: workflowId, category, steps: [...debounced] }, { signal });
      return { timeline, basis: debounced };
    },
    enabled: enabled && debounced.length > 0,
    placeholderData: keepPreviousData,
    // A refused preview (422 / 429) is shown, not retried in a loop.
    retry: false,
    staleTime: 60_000,
  });

  const savedShown = React.useMemo<ShownTimeline>(() => ({ timeline: savedTimeline, basis: [] }), [savedTimeline]);
  // No drafts: the saved template. Otherwise the newest served reply (which
  // may still be for an older click while the next one is pending).
  const shown: ShownTimeline = overrides.length === 0 ? savedShown : (preview.data ?? savedShown);
  const settled = overrides.length === 0 || (sameOverrides(shown.basis, overrides) && !preview.isFetching);
  return {
    shown,
    pending: !settled,
    error: overrides.length > 0 && sameOverrides(debounced, overrides) && preview.isError ? preview.error : null,
  };
}
