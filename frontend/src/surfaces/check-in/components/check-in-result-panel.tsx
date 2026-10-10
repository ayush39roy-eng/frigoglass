import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheck, Info, Loader2, TriangleAlert, X } from 'lucide-react';

import { ChangedProjectsList } from '@/components/shared/priority-move/timeline-updated-panel';
import { RunProgressStatus } from '@/components/shared/run-progress-status';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api/error-messages';
import type { ScheduleRunChanges } from '@/lib/api/priority-move';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';
import { cn } from '@/lib/utils';

import { CHECK_IN_COPY, type CheckInFlow } from '../hooks/use-check-in-submit';

const TONE_ICON = {
  success: { Icon: CircleCheck, className: 'text-success' },
  warning: { Icon: Info, className: 'text-warning' },
  danger: { Icon: TriangleAlert, className: 'text-danger' },
} as const;

function UpdatedBody({
  flow,
  changes,
}: {
  flow: Extract<CheckInFlow, { kind: 'updated' }>;
  changes: UseQueryResult<ScheduleRunChanges>;
}): React.JSX.Element {
  if (flow.baselineRunId === null) return <p className="text-xs text-text-muted">{CHECK_IN_COPY.noBaseline}</p>;
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
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  return <ChangedProjectsList changes={changes.data} />;
}

/**
 * Non-modal result panel (bottom-right) after a check-in submit, the check-in
 * page's "toast": solver progress and "Timeline updated" for `queued`, the
 * honest saved copy for `deferred` / `not_needed`, or the error. It has no
 * close button while a run is being followed, so the result is never lost.
 */
export function CheckInResultPanel({
  flow,
  runState,
  changes,
  watchingFollowUp,
  onClose,
}: {
  flow: CheckInFlow;
  runState: RunFollowState;
  changes: UseQueryResult<ScheduleRunChanges>;
  watchingFollowUp: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const headingId = React.useId();
  if (flow.kind === 'idle' || flow.kind === 'submitting') return null;
  const closable = flow.kind !== 'running';
  const title =
    flow.kind === 'running'
      ? 'Check-in saved — recalculating the timeline…'
      : flow.kind === 'updated'
        ? 'Timeline updated'
        : flow.title;
  const tone = flow.kind === 'notice' ? TONE_ICON[flow.tone] : null;

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'fixed bottom-4 right-4 z-40 flex max-h-[min(36rem,calc(100vh-2rem))] w-[min(30rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto',
        'rounded-dash border-[1.5px] border-dash-hairline bg-surface p-4 text-text shadow-pop',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2',
      )}
      data-testid="check-in-result"
      data-kind={flow.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && closable) onClose();
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text">
          {tone ? <tone.Icon className={cn('size-4 shrink-0', tone.className)} aria-hidden="true" /> : null}
          {flow.kind === 'updated' ? <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" /> : null}
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
            {flow.accepted} {flow.accepted === 1 ? 'stage' : 'stages'} checked in. Following the solver run.
          </p>
          <RunProgressStatus state={runState} />
        </div>
      ) : flow.kind === 'updated' ? (
        <UpdatedBody flow={flow} changes={changes} />
      ) : (
        <div className="space-y-2">
          <p role={flow.tone === 'danger' ? 'alert' : 'status'} className="text-xs text-text" data-testid="check-in-result-body">
            {flow.body}
          </p>
          {flow.followUp && watchingFollowUp ? (
            <p className="flex items-center gap-1.5 text-2xs text-text-muted" data-testid="check-in-follow-up">
              <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Waiting for the follow-up recalculation…
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
