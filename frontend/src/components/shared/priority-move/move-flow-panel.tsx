import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheck, Info, TriangleAlert, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { apiErrorMessage } from '@/lib/api/error-messages';
import type { ScheduleRunChanges } from '@/lib/api/priority-move';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';
import { cn } from '@/lib/utils';

import { RunProgressStatus } from '../run-progress-status';
import { MOVE_COPY } from './move-copy';
import { TimelineUpdatedPanel } from './timeline-updated-panel';
import type { MoveFlowState } from './use-priority-move-flow';

/** The light confirm step: "Move to P2? The timeline will be recalculated." */
export function MoveConfirmDialog({
  flow,
  onConfirm,
  onCancel,
}: {
  flow: MoveFlowState;
  onConfirm: () => void;
  onCancel: () => void;
}): React.JSX.Element {
  const open = flow.kind === 'confirm' || flow.kind === 'submitting';
  const submitting = flow.kind === 'submitting';
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && flow.kind === 'confirm') onCancel();
      }}
    >
      <DialogContent className="max-w-sm" data-testid="priority-move-confirm">
        {open ? (
          <>
            <DialogHeader>
              <DialogTitle>Move to {flow.next}?</DialogTitle>
              <DialogDescription>
                {flow.target.projectName} moves from {flow.target.priority ?? 'no priority'} to {flow.next}.{' '}
                {MOVE_COPY.confirmBody}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button type="button" variant="secondary" onClick={onCancel} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={onConfirm} disabled={submitting}>
                {submitting ? 'Moving…' : `Move to ${flow.next}`}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const NOTICE_ICON = {
  success: { Icon: CircleCheck, className: 'text-success' },
  warning: { Icon: Info, className: 'text-warning' },
  danger: { Icon: TriangleAlert, className: 'text-danger' },
} as const;

function NoticeIcon({ tone }: { tone: keyof typeof NOTICE_ICON }): React.JSX.Element {
  const { Icon, className } = NOTICE_ICON[tone];
  return <Icon className={cn('size-4 shrink-0', className)} aria-hidden="true" />;
}

function ChangesBody({
  flow,
  changes,
}: {
  flow: Extract<MoveFlowState, { kind: 'updated' }>;
  changes: UseQueryResult<ScheduleRunChanges>;
}): React.JSX.Element {
  if (flow.baselineRunId === null) {
    return <p className="text-xs text-text-muted">{MOVE_COPY.noBaseline}</p>;
  }
  if (changes.isError) {
    return (
      <p role="alert" className="text-xs text-danger">
        The new timeline is active, but the list of what moved could not be loaded.{' '}
        {apiErrorMessage(changes.error, '')}
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
      priorityBefore={flow.before}
      priorityAfter={flow.after}
    />
  );
}

/**
 * Non-modal floating panel (bottom-right) for everything after the confirm:
 * solver progress, the "Timeline updated" list, or the honest outcome copy.
 * Non-modal on purpose: a greedy run over 236 projects can take a while, and
 * the user can keep reading the Gantt underneath. It has no close button while
 * the run is being followed, so the result is never silently lost.
 */
export function MoveFlowPanel({
  flow,
  runState,
  changes,
  onClose,
}: {
  flow: MoveFlowState;
  runState: RunFollowState;
  changes: UseQueryResult<ScheduleRunChanges>;
  onClose: () => void;
}): React.JSX.Element | null {
  const headingId = React.useId();
  if (flow.kind !== 'running' && flow.kind !== 'updated' && flow.kind !== 'notice') return null;
  const closable = flow.kind !== 'running';
  const title =
    flow.kind === 'running' ? 'Recalculating the timeline…' : flow.kind === 'updated' ? 'Timeline updated' : flow.title;

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'fixed bottom-4 right-4 z-40 flex max-h-[min(36rem,calc(100vh-2rem))] w-[min(30rem,calc(100vw-2rem))] flex-col gap-3 overflow-y-auto',
        'rounded-dash border-[1.5px] border-dash-hairline bg-surface p-4 text-text shadow-pop',
        'motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-bottom-2',
      )}
      data-testid="priority-move-panel"
      data-kind={flow.kind}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && closable) onClose();
      }}
    >
      <header className="flex items-start justify-between gap-2">
        <h2 id={headingId} className="flex items-center gap-1.5 text-sm font-bold text-text">
          {flow.kind === 'notice' ? (
            <NoticeIcon tone={flow.tone} />
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
            {flow.target.projectName} moved {flow.before ?? 'from no priority'} → {flow.after ?? 'no priority'}. Following
            the solver run.
          </p>
          <RunProgressStatus state={runState} />
        </div>
      ) : flow.kind === 'updated' ? (
        <ChangesBody flow={flow} changes={changes} />
      ) : (
        <p role={flow.tone === 'danger' ? 'alert' : 'status'} className="text-xs text-text" data-testid="priority-move-notice">
          {flow.body}
        </p>
      )}
    </section>
  );
}
