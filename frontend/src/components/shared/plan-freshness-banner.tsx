import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { subscribePlanWrites } from '@/lib/api/defer-recalc';
import { fetchPlanFreshness, type PlanFreshness } from '@/lib/api/plan-freshness';
import { formatInteger, formatTimestamp } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';

import { PLAN_RECALC_COPY, useCanRecalculatePlan, usePlanRecalc } from './plan-recalc';

/**
 * P61 (ADR 0069): "Plan not recalculated — N projects changed since <time>".
 *
 * Shown on the plan surfaces whenever the SERVED `stale_project_count` is above
 * zero (every number is a served field, I9). Admin / Super Admin get
 * "Recalculate now", which dispatches ONE run (`POST /schedule-runs/recalculate`),
 * follows it over the shared progress stream, then refreshes every plan query.
 * Hub Planners and readers see the text only. While a run is in flight the
 * banner says "Recalculating…".
 *
 * Polled every 20 s, and refetched right after any plan save
 * (`subscribePlanWrites`, fired by the API client).
 */

const FRESHNESS_POLL_MS = 20_000;

export const FRESHNESS_COPY = {
  recalculating: PLAN_RECALC_COPY.recalculating,
  button: PLAN_RECALC_COPY.button,
} as const;

/** The served freshness (polled every 20 s); shared by the banner and the header button. */
export function usePlanFreshness() {
  return useQuery({
    queryKey: queryKeys.planFreshness(),
    queryFn: ({ signal }) => fetchPlanFreshness({ signal }),
    refetchInterval: FRESHNESS_POLL_MS,
    retry: false,
  });
}

export function isFreshness(value: unknown): value is PlanFreshness {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as PlanFreshness).stale_project_count === 'number'
  );
}

function staleText(f: PlanFreshness): string {
  const n = f.stale_project_count;
  const what = `${formatInteger(n)} ${n === 1 ? 'project' : 'projects'} changed`;
  const since = f.last_run_at ? ` since ${formatTimestamp(f.last_run_at)}` : '';
  return `Plan not recalculated — ${what}${since}`;
}

export function PlanFreshnessBanner({ className }: { className?: string }): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const canRecalc = useCanRecalculatePlan();
  const freshness = usePlanFreshness();

  React.useEffect(
    () => subscribePlanWrites(() => void queryClient.invalidateQueries({ queryKey: queryKeys.planFreshness() })),
    [queryClient],
  );

  const { recalculate, busy: following, error } = usePlanRecalc();

  const data = isFreshness(freshness.data) ? freshness.data : null;
  if (!data || (data.stale_project_count <= 0 && !following)) return null;

  const inFlight = following || data.run_in_flight;
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="plan-freshness-banner"
      data-in-flight={inFlight ? 'true' : 'false'}
      className={cn(
        'flex flex-wrap items-center gap-s2 rounded-card border border-warning/40 bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg',
        className,
      )}
    >
      {inFlight ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span data-testid="plan-freshness-text">
        {data.stale_project_count > 0 ? staleText(data) : null}
        {inFlight ? (
          <span className="font-semibold">
            {data.stale_project_count > 0 ? ' · ' : ''}
            {FRESHNESS_COPY.recalculating}
          </span>
        ) : null}
      </span>
      {canRecalc && !inFlight ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-6 gap-1 px-2 text-2xs"
          onClick={() => void recalculate()}
          data-testid="plan-freshness-recalculate"
        >
          <RefreshCw className="size-3" aria-hidden="true" />
          {FRESHNESS_COPY.button}
        </Button>
      ) : null}
      {error ? (
        <span className="text-2xs text-danger" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
