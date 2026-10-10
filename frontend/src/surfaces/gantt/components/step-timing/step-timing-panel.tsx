import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';

import { RunProgressStatus } from '@/components/shared/run-progress-status';
import { MOVE_COPY } from '@/components/shared/priority-move/move-copy';
import { TimelineUpdatedPanel } from '@/components/shared/priority-move/timeline-updated-panel';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api/error-messages';
import type { ScheduleRunChanges } from '@/lib/api/priority-move';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';
import { cn } from '@/lib/utils';

import { timingChangeSummary, type StepTimingFlowState } from './step-timing-state';

const NOTICE_ICON = {
  success: { Icon: CircleCheck, className: 'text-success' },
  warning: { Icon: Info, className: 'text-warning' },
  danger: { Icon: TriangleAlert, className: 'text-danger' },
} as const;

function ChangesBody({
  flow,
  changes,
}: {
  flow: Extract<StepTimingFlowState, { kind: 'updated' }>;
  changes: UseQueryResult<ScheduleRunChanges>;
}): React.JSX.Element {
  if (flow.baselineRunId === null) {
    return <p className="text-xs text-text-muted">{MOVE_COPY.noBaseline}</p>;
  }
  if (changes.isError) {
    return (
      <p role="alert" className="text-xs text-danger">
        The new timeline is active, but the list of what moved could not be loaded. {apiErrorMessage(changes.error, '')}
      </p>
    );
  }
  if (!changes.data) {
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">Loading what moved…</span>
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  return (
    <TimelineUpdatedPanel
      changes={changes.data}
      projectId={flow.target.projectId}
      projectName={flow.target.projectName}
      summary={<span>{timingChangeSummary(flow.change)}</span>}
    />
  );
}

/**
 * Non-modal floating panel (bottom-right) after a step-timing change: solver
 * progress, the served "Timeline updated" list, or the honest outcome copy.
 * Same shell and behaviour as the P11 priority-move panel: no close button
 * while the run is followed, so the result is never silently lost.
 */
export function StepTimingPanel({
  flow,
  runState,
  changes,
  onClose,
  followUpWatching,
}: {
  flow: StepTimingFlowState;
  runState: RunFollowState;
  changes: UseQueryResult<ScheduleRunChanges>;
  onClose: () => void;
  followUpWatching: boolean;
}): React.JSX.Element | null {
  const headingId = React.useId();
  if (flow.kind !== 'running' && flow.kind !== 'updated' && flow.kind !== 'notice') return null;
  const closable = flow.kind !== 'running';
  const title =
    flow.kind === 'running' ? 'Recalculating the timeline…' : flow.kind === 'updated' ? 'Timeline updated' : flow.title;
  const notice = flow.kind === 'notice' ? NOTICE_ICON[flow.tone] : null;

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'fixed bottom-4 right-4 z-40 flex max-h-[min(36rem,calc(100vh-2rem))] w-[min(30rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto',
        'rounded-dash border-[1.5px] border-dash-hairline bg-surface p-4 text-text shadow-pop',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2',
      )}
      data-testid="step-timing-panel"
      data-kind={flow.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && closable) onClose();
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text">
          {notice ? (
            <notice.Icon className={cn('size-4 shrink-0', notice.className)} aria-hidden="true" />
          ) : flow.kind === 'updated' ? (
            <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          ) : null}
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

      {flow.kind === 'running' ? (
        <div className="space-y-2">
          <p className="text-xs text-text-muted">
            {flow.target.projectName} — {timingChangeSummary(flow.change)}. Following the solver run.
          </p>
          <RunProgressStatus state={runState} />
        </div>
      ) : flow.kind === 'updated' ? (
        <ChangesBody flow={flow} changes={changes} />
      ) : (
        <>
          <p className="text-2xs font-semibold text-text-muted">
            {flow.target.projectName} · {flow.target.stepName}
          </p>
          <p role={flow.tone === 'danger' ? 'alert' : 'status'} className="text-xs text-text" data-testid="step-timing-notice">
            {flow.body}
          </p>
          {followUpWatching ? (
            <p role="status" className="flex items-center gap-1.5 text-2xs text-text-muted" data-testid="follow-up-watching">
              <span className="size-1.5 shrink-0 rounded-full bg-primary motion-safe:animate-pulse" aria-hidden="true" />
              {MOVE_COPY.followUpWatching}
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
