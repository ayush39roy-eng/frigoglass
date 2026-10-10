import * as React from 'react';
import { History } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatTimestamp, formatWeek } from '@/lib/format';
import { stageStatusLabel } from '@/types/enums';

import { useCheckInHistory } from '../api';

/**
 * A stage's own check-in history (`GET /check-ins/history`, newest first, at
 * most 52 rows), in a side drawer. The submitter's name appears only here, on
 * the stage's own record — never aggregated or ranked per engineer (GDPR,
 * ADR 0021 §7).
 */
export function HistoryDrawer({
  projectId,
  projectName,
  stepId,
  stepName,
}: {
  projectId: string;
  projectName: string;
  stepId: string;
  stepName: string;
}): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const history = useCheckInHistory(projectId, stepId, open);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="inline-flex h-8 items-center gap-1 rounded-control px-2 text-2xs font-medium text-text-muted transition-colors hover:bg-surface-sunken hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Check-in history for ${stepName}, ${projectName}`}
          data-testid="check-in-history-trigger"
        >
          <History className="size-3.5" aria-hidden="true" />
          History
        </button>
      </DialogTrigger>
      <DialogContent className="left-auto right-0 top-0 h-full max-w-md translate-x-0 translate-y-0 content-start overflow-y-auto rounded-none">
        <DialogHeader>
          <DialogTitle>{stepName}</DialogTitle>
          <DialogDescription>Check-in history for {projectName}, newest first.</DialogDescription>
        </DialogHeader>
        {history.isPending ? (
          <div className="space-y-2" aria-busy="true">
            <span className="sr-only">Loading history…</span>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </div>
        ) : history.isError ? (
          <ErrorState description="The history could not be loaded." onRetry={() => void history.refetch()} />
        ) : history.data.length === 0 ? (
          <EmptyState title="No check-ins yet" description="Nobody has checked in this stage yet." />
        ) : (
          <ol className="space-y-2" aria-label="Check-ins" data-testid="check-in-history">
            {history.data.map((row) => (
              <li key={`${row.created_at}-${String(row.week)}`} className="rounded-dash border border-dash-hairline p-3 text-xs">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-text">
                    <span className="font-mono tabular-nums" data-numeric="">
                      {formatWeek(row.week)}
                    </span>{' '}
                    · {stageStatusLabel(row.status)} ·{' '}
                    <span className="font-mono tabular-nums" data-numeric="">
                      {row.percent_complete} %
                    </span>
                  </span>
                  <time dateTime={row.created_at} className="text-2xs text-text-subtle">
                    {formatTimestamp(row.created_at)}
                  </time>
                </div>
                {row.blocked_reason ? <p className="mt-1 text-text-muted">Hold reason: {row.blocked_reason}</p> : null}
                {row.note ? <p className="mt-1 whitespace-pre-wrap text-text">{row.note}</p> : null}
                <p className="mt-1 text-2xs text-text-subtle">By {row.by}</p>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  );
}
