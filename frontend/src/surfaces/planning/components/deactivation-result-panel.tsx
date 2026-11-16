import * as React from 'react';
import { Link } from 'react-router-dom';
import { CircleCheck, Loader2, X } from 'lucide-react';

import { RunProgressStatus } from '@/components/shared/run-progress-status';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';

import type { DeactivationResultState } from '../hooks/use-deactivation-result';
import { NO_LEADER_REGISTER_PATH } from '../lib/deactivation';

/**
 * P38-T06: the success toast after a deactivation: a non-modal panel
 * (bottom-right), the same shape as the register-save and check-in panels.
 * Counts are the served `reassigned` / `left_without_leader`; the run line is
 * the shared `RunProgressStatus`. When projects were left without a leader it
 * links to the register filtered to "No leader". It cannot be closed while a
 * run is being followed, so the result is never lost.
 */
function plural(n: number, one: string, many: string): string {
  return `${formatInteger(n)} ${n === 1 ? one : many}`;
}

export function DeactivationResultPanel({
  state,
  runState,
  watchingFollowUp,
  onClose,
}: {
  state: DeactivationResultState | null;
  runState: RunFollowState;
  watchingFollowUp: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const headingId = React.useId();
  if (!state) return null;
  const { result, phase } = state;
  const closable = phase !== 'following';
  const warnings = result.warnings.length;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'fixed bottom-4 right-4 z-40 flex w-[min(28rem,calc(100vw-2rem))] flex-col gap-2',
        'rounded-dash border-[1.5px] border-dash-hairline bg-surface p-4 text-text shadow-pop',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2',
      )}
      data-testid="deactivation-result"
      data-phase={phase}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && closable) onClose();
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text">
          <CircleCheck className="size-4 shrink-0 text-success" aria-hidden="true" />
          {state.engineerName} deactivated
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
      <p role="status" className="text-xs text-text" data-testid="deactivation-result-counts">
        {plural(result.reassigned, 'project', 'projects')} got a new leader.{' '}
        {result.left_without_leader > 0 ? `${plural(result.left_without_leader, 'project has', 'projects have')} no leader.` : ''}
        {warnings > 0
          ? ` ${plural(warnings, 'new leader is', 'new leaders are')} outside the project's allowed categories (a warning only).`
          : ''}
      </p>
      {result.left_without_leader > 0 ? (
        <Link
          to={NO_LEADER_REGISTER_PATH}
          className="w-fit text-xs font-semibold text-primary underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          data-testid="deactivation-no-leader-link"
        >
          Show projects with no leader
        </Link>
      ) : null}
      {phase === 'following' || phase === 'completed' || phase === 'failed' ? <RunProgressStatus state={runState} /> : null}
      {state.runMessage ? (
        <p role={phase === 'failed' || phase === 'no_run' ? 'alert' : 'status'} className="text-2xs text-text-muted" data-testid="deactivation-run-message">
          {state.runMessage}
        </p>
      ) : null}
      {phase === 'deferred' && watchingFollowUp ? (
        <p className="flex items-center gap-1.5 text-2xs text-text-muted">
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Waiting for the follow-up recalculation…
        </p>
      ) : null}
    </section>
  );
}
