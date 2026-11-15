import * as React from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useFollowUpRunWatcher } from '@/lib/use-follow-up-run';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';

import { applyTemplate, previewApply } from '../api/workflow-settings-api';
import type {
  ApplyPreviewResponse,
  ApplySelection,
  TemplateApplyResponse,
  TemplateChangeSet,
} from '../api/types';
import { ApplyDialog } from '../components/template-apply/apply-dialog';
import { ApplyResultPanel } from '../components/template-apply/apply-result-panel';
import { applyErrorMessage, isTemplateChanged, TEMPLATE_COPY } from '../lib/template-copy';
import { invalidateTemplateQueries } from './use-workflow-settings';

/**
 * P33-T17 (ADR 0045 §2/§5/§6, API_CONTRACT_P33 E2 → E3): the one save path of
 * the category templates, shared by the timeline editor and the Lead times tab.
 *
 *   start(changeSet)   → POST /workflow-templates/apply-preview → the dialog
 *   Apply(selection)   → POST /workflow-templates/apply {changes, selection}
 *     queued           → follow the run (SSE) → "Timeline recalculated"
 *     deferred         → "updates automatically" + the follow-up watcher (ADR 0023)
 *     not_needed       → saved, no timeline change
 *     dispatch_failed  → saved, stale, Recalculate by hand
 *   409 TEMPLATE_CHANGED → the template is reloaded and the dialog says so
 *   429 / 422 / 403      → said in the dialog; nothing was saved
 *
 * The same lifecycle as a priority move / register save, through the same
 * shared hooks. The server decides every list and every branch.
 */

export interface ApplyRequestOptions {
  /** One line per changed step, e.g. "A · PDD-E length 6w → 7w" (shown in the dialog). */
  summary: string[];
  /** Called once the apply succeeded (drafts can be cleared). */
  onApplied?: () => void;
}

export type ApplyFlow =
  | { kind: 'idle' }
  | { kind: 'checking'; request: TemplateChangeSet; options: ApplyRequestOptions }
  | { kind: 'review'; request: TemplateChangeSet; options: ApplyRequestOptions; preview: ApplyPreviewResponse }
  | {
      kind: 'applying';
      request: TemplateChangeSet;
      options: ApplyRequestOptions;
      preview: ApplyPreviewResponse;
    }
  | {
      kind: 'refused';
      request: TemplateChangeSet;
      options: ApplyRequestOptions;
      preview: ApplyPreviewResponse | null;
      message: string;
      /** 409: the template was reloaded; Apply is no longer offered. */
      reloaded: boolean;
    }
  | { kind: 'running'; result: TemplateApplyResponse; names: ReadonlyMap<string, string>; runId: string }
  | { kind: 'updated'; result: TemplateApplyResponse; names: ReadonlyMap<string, string> }
  | {
      kind: 'notice';
      result: TemplateApplyResponse;
      names: ReadonlyMap<string, string>;
      tone: 'success' | 'warning' | 'danger';
      body: string;
      followUp: boolean;
    };

/** Everything a written template copy makes stale: the projects' `schedule_stale` and views. */
function invalidateAfterApply(queryClient: QueryClient): void {
  invalidateTemplateQueries(queryClient);
  for (const key of [['projects'], ['gantt'], ['dashboard'], ['priority-board'], ['workflow-template']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

function projectNames(preview: ApplyPreviewResponse): Map<string, string> {
  const names = new Map<string, string>();
  for (const list of [preview.automatic, preview.choosable, preview.own_effort, preview.never]) {
    for (const p of list) names.set(p.project_id, p.name);
  }
  return names;
}

export function useTemplateApply(): {
  start: (request: TemplateChangeSet, options: ApplyRequestOptions) => void;
  busy: boolean;
  element: React.JSX.Element;
} {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, reset } = run;
  const followUp = useFollowUpRunWatcher();
  const { start: startFollowUp } = followUp;
  const [flow, setFlow] = React.useState<ApplyFlow>({ kind: 'idle' });
  const previewAbort = React.useRef<AbortController | null>(null);
  React.useEffect(() => () => previewAbort.current?.abort(), []);

  const refuse = React.useCallback(
    (
      err: unknown,
      stage: 'preview' | 'apply',
      request: TemplateChangeSet,
      options: ApplyRequestOptions,
      preview: ApplyPreviewResponse | null,
    ) => {
      const reloaded = isTemplateChanged(err);
      if (reloaded) invalidateTemplateQueries(queryClient);
      setFlow({ kind: 'refused', request, options, preview, message: applyErrorMessage(err, stage), reloaded });
    },
    [queryClient],
  );

  const start = React.useCallback(
    (request: TemplateChangeSet, options: ApplyRequestOptions) => {
      previewAbort.current?.abort();
      const controller = new AbortController();
      previewAbort.current = controller;
      reset();
      setFlow({ kind: 'checking', request, options });
      previewApply(request, { signal: controller.signal })
        .then((preview) => {
          if (controller.signal.aborted) return;
          setFlow({ kind: 'review', request, options, preview });
        })
        .catch((err: unknown) => {
          if (controller.signal.aborted || (err instanceof DOMException && err.name === 'AbortError')) return;
          refuse(err, 'preview', request, options, null);
        });
    },
    [refuse, reset],
  );

  const apply = React.useCallback(
    async (selection: ApplySelection) => {
      if (flow.kind !== 'review') return;
      const { request, options, preview } = flow;
      setFlow({ kind: 'applying', request, options, preview });
      let result: TemplateApplyResponse;
      try {
        result = await applyTemplate({ ...request, selection });
      } catch (err) {
        refuse(err, 'apply', request, options, preview);
        return;
      }
      options.onApplied?.();
      invalidateAfterApply(queryClient);
      const names = projectNames(preview);
      switch (result.recalc_status) {
        case 'not_needed':
        case 'unchanged':
        case 'applied':
          setFlow({ kind: 'notice', result, names, tone: 'success', body: TEMPLATE_COPY.notNeeded, followUp: false });
          return;
        case 'dispatch_failed':
          setFlow({ kind: 'notice', result, names, tone: 'danger', body: TEMPLATE_COPY.dispatchFailed, followUp: false });
          return;
        case 'deferred':
          startFollowUp();
          setFlow({ kind: 'notice', result, names, tone: 'success', body: TEMPLATE_COPY.deferred, followUp: true });
          return;
        case 'queued':
          break;
      }
      const runId = result.schedule_run_id;
      if (!runId) {
        setFlow({ kind: 'notice', result, names, tone: 'warning', body: TEMPLATE_COPY.queuedWithoutRun, followUp: false });
        return;
      }
      setFlow({ kind: 'running', result, names, runId });
      const abort = begin('Queuing the solver…');
      const outcome = await follow(runId, abort, { completedMessage: 'Timeline recalculated.' });
      if (outcome.outcome === 'aborted') return;
      if (outcome.outcome === 'completed') {
        invalidateRunDerivedQueries(queryClient);
        setFlow({ kind: 'updated', result, names });
        return;
      }
      setFlow({
        kind: 'notice',
        result,
        names,
        tone: 'danger',
        body: `${outcome.message ?? 'The recalculation did not complete.'} ${TEMPLATE_COPY.failedRun}`,
        followUp: false,
      });
    },
    [begin, flow, follow, queryClient, refuse, startFollowUp],
  );

  const closeDialog = React.useCallback(() => {
    if (flow.kind === 'applying') return;
    previewAbort.current?.abort();
    setFlow({ kind: 'idle' });
  }, [flow.kind]);

  /** After a refusal that left the template as it was (429, 422…): back to the lists. */
  const backToReview = React.useCallback(() => {
    if (flow.kind !== 'refused' || flow.preview === null || flow.reloaded) return;
    setFlow({ kind: 'review', request: flow.request, options: flow.options, preview: flow.preview });
  }, [flow]);

  const closePanel = React.useCallback(() => {
    reset();
    setFlow({ kind: 'idle' });
  }, [reset]);

  const busy = flow.kind === 'checking' || flow.kind === 'applying' || flow.kind === 'running';
  const dialogFlow =
    flow.kind === 'checking' || flow.kind === 'review' || flow.kind === 'applying' || flow.kind === 'refused' ? flow : null;
  const panelFlow = flow.kind === 'running' || flow.kind === 'updated' || flow.kind === 'notice' ? flow : null;

  const element = (
    <>
      <ApplyDialog flow={dialogFlow} onApply={(s) => void apply(s)} onBack={backToReview} onClose={closeDialog} />
      <ApplyResultPanel flow={panelFlow} runState={run.state} watchingFollowUp={followUp.watching} onClose={closePanel} />
    </>
  );
  return { start, busy, element };
}
