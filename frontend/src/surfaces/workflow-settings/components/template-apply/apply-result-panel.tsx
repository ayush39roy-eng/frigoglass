import * as React from 'react';
import { CircleCheck, Info, Loader2, TriangleAlert, X } from 'lucide-react';

import { RunProgressStatus } from '@/components/shared/run-progress-status';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';
import { cn } from '@/lib/utils';

import type { TemplateApplyResponse } from '../../api/types';
import type { ApplyFlow } from '../../hooks/use-template-apply';
import { NOT_APPLIED_REASON, projects, TEMPLATE_COPY } from '../../lib/template-copy';

type PanelFlow = Extract<ApplyFlow, { kind: 'running' | 'updated' | 'notice' }>;

const TONE_ICON = {
  success: { Icon: CircleCheck, className: 'text-success' },
  warning: { Icon: Info, className: 'text-warning' },
  danger: { Icon: TriangleAlert, className: 'text-danger' },
} as const;

/**
 * P33-T17: what the apply did (contract E3 response) and the recalculation it
 * started — the same non-modal bottom-right panel as a register save or a
 * priority move. No close button while a run is followed.
 */
export function ApplyResultPanel({
  flow,
  runState,
  watchingFollowUp,
  onClose,
}: {
  flow: PanelFlow | null;
  runState: RunFollowState;
  watchingFollowUp: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const headingId = React.useId();
  if (!flow) return null;
  const closable = flow.kind !== 'running';
  const tone = flow.kind === 'notice' ? TONE_ICON[flow.tone] : flow.kind === 'updated' ? TONE_ICON.success : null;
  const title =
    flow.kind === 'running'
      ? 'Template saved — recalculating the timeline…'
      : flow.kind === 'notice' && flow.tone === 'danger'
        ? 'Template saved — timeline not recalculated'
        : 'Template saved';

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'fixed bottom-4 right-4 z-40 flex max-h-[min(36rem,calc(100vh-2rem))] w-[min(30rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto',
        'rounded-dash border-[1.5px] border-dash-hairline bg-surface p-4 text-text shadow-pop',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2',
      )}
      data-testid="template-apply-panel"
      data-kind={flow.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && closable) onClose();
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text">
          {tone ? <tone.Icon className={cn('size-4 shrink-0', tone.className)} aria-hidden="true" /> : null}
          {title}
        </h2>
        {closable ? (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : null}
      </header>

      <AppliedSummary result={flow.result} names={flow.names} />

      {flow.kind === 'running' ? (
        <RunProgressStatus state={runState} />
      ) : flow.kind === 'updated' ? (
        <p role="status" className="text-xs text-text">
          Timeline recalculated. Every view now shows the new schedule.
        </p>
      ) : (
        <div className="space-y-2">
          <p role={flow.tone === 'danger' ? 'alert' : 'status'} className="text-xs text-text" data-testid="template-apply-body">
            {flow.body}
          </p>
          {flow.followUp && watchingFollowUp ? (
            <p className="flex items-center gap-1.5 text-2xs text-text-muted">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              {TEMPLATE_COPY.followUpWatching}
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function AppliedSummary({
  result,
  names,
}: {
  result: TemplateApplyResponse;
  names: ReadonlyMap<string, string>;
}): React.JSX.Element {
  const { applied, not_applied } = result;
  return (
    <div className="space-y-1.5 text-xs text-text" data-testid="template-apply-summary" data-numeric="">
      <p>
        Applied to {projects(applied.automatic)} automatically
        {applied.selected > 0 ? ` and ${projects(applied.selected)} you chose` : ''}.
      </p>
      {applied.own_effort_not_applied > 0 ? (
        <p className="text-text-muted">
          {projects(applied.own_effort_not_applied)} use their own weeks — length not changed.
        </p>
      ) : null}
      {not_applied.length > 0 ? (
        <div className="rounded-md border border-warning/40 bg-warning-subtle px-2.5 py-1.5" data-testid="template-apply-not-applied">
          <p className="font-medium text-warning-subtle-fg">Not changed after all:</p>
          <ul className="list-disc pl-4">
            {not_applied.map((n) => (
              <li key={n.project_id}>
                {names.get(n.project_id) ?? 'A project'} {NOT_APPLIED_REASON[n.reason]}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
