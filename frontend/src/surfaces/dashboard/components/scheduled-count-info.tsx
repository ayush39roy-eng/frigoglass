import * as React from 'react';

import { CardInfo } from '@/components/ui/card-info';
import { formatInteger } from '@/lib/format';

/**
 * Why "scheduled" is smaller than the pipeline total (P17-R05, ADR 0030).
 *
 * The active schedule run plans every project except Cancelled and On Hold ones,
 * so its project count is lower than the pipeline Total. Every figure here is a
 * served field (pipeline-totals `total_count`, status-overview Cancelled count
 * and `on_hold_count`); nothing is derived in the browser. When the status
 * overview has not loaded, the sentence simply omits the two counts.
 */
export interface ScheduledCountFigures {
  /** Served PipelineTotals.total_count, when loaded. */
  pipelineTotal?: number | null | undefined;
  /** Served StatusOverview Cancelled / On Hold counts, when loaded. */
  cancelled?: number | null | undefined;
  onHold?: number | null | undefined;
}

export interface ScheduledCountInfoProps extends ScheduledCountFigures {
  /** Projects the active run plans (the served outcome buckets). */
  scheduled: number;
  label?: string;
  className?: string;
}

export function ScheduledCountInfo({
  scheduled,
  pipelineTotal = null,
  cancelled = null,
  onHold = null,
  label = 'About the scheduled project count',
  className,
}: ScheduledCountInfoProps): React.JSX.Element {
  const excluded =
    cancelled !== null && onHold !== null
      ? `Cancelled (${formatInteger(cancelled)}) and paused (status On Hold) (${formatInteger(onHold)}) projects are not scheduled.`
      : 'Cancelled and paused (status On Hold) projects are not scheduled.';
  return (
    <CardInfo label={label} {...(className ? { className } : {})}>
      <p data-testid="scheduled-count-note">
        {formatInteger(scheduled)} projects are planned in the active schedule run.
        {pipelineTotal !== null
          ? ` The pipeline total is ${formatInteger(pipelineTotal)}. `
          : ' The pipeline total is higher. '}
        {excluded}
      </p>
    </CardInfo>
  );
}
