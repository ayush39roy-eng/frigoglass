import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { recalculatePlan, recalculateRunId } from '@/lib/api/plan-freshness';
import { queryKeys } from '@/lib/query-keys';
import { invalidateRunDerivedQueries, useScheduleRunFollow } from '@/lib/use-schedule-run-follow';
import { useSessionStore } from '@/stores/session';

/**
 * P61 (ADR 0069): "Recalculate now" — ONE run (`POST /schedule-runs/recalculate`,
 * Admin / Super Admin), followed over the shared progress stream, then every
 * plan query is refreshed. Works with nothing stale too (recomputes from the
 * current data). One shared state per app shell (`PlanRecalcProvider`), so the
 * header button and the freshness banner show the same "Recalculating…".
 */

export const PLAN_RECALC_COPY = {
  button: 'Recalculate now',
  headerButton: 'Recalculate',
  recalculating: 'Recalculating…',
  failed: 'The recalculation could not be started.',
  dispatchFailed: 'The recalculation could not be started (the job queue refused it). Try again in a moment.',
  adminOnly: 'Only an Admin or Super Admin can recalculate the plan.',
  tooltip: 'Recalculate the plan once from the current data (one run for every saved change).',
} as const;

const RECALC_ROLES = new Set(['Admin', 'Super Admin']);

export function useCanRecalculatePlan(): boolean {
  const roles = useSessionStore((s) => s.me?.roles);
  return roles?.some((r) => RECALC_ROLES.has(r)) ?? false;
}

export interface PlanRecalcApi {
  recalculate: () => Promise<void>;
  /** Dispatching or following our run. */
  busy: boolean;
  error: string | null;
}

function useLocalPlanRecalc(): PlanRecalcApi {
  const queryClient = useQueryClient();
  const run = useScheduleRunFollow();
  const { begin, follow, fail, reset } = run;
  const [error, setError] = React.useState<string | null>(null);

  const recalculate = React.useCallback(async () => {
    setError(null);
    const signal = begin('Queuing the recalculation…');
    const refreshFreshness = () => void queryClient.invalidateQueries({ queryKey: queryKeys.planFreshness() });
    let runId: string | null;
    try {
      const res = await recalculatePlan();
      if (res.recalc_status === 'dispatch_failed') {
        fail(PLAN_RECALC_COPY.dispatchFailed);
        setError(PLAN_RECALC_COPY.dispatchFailed);
        refreshFreshness();
        return;
      }
      runId = recalculateRunId(res);
    } catch (err) {
      const message = apiErrorMessage(err, PLAN_RECALC_COPY.failed);
      fail(message);
      setError(message);
      refreshFreshness();
      return;
    }
    if (runId) {
      const result = await follow(runId, signal, { completedMessage: 'Plan recalculated.' });
      if (result.outcome === 'aborted') return;
      if (result.outcome === 'failed') setError(result.message);
    }
    // Every plan view (Gantt, Dashboard, Capacity, projects, Matrix, board, freshness…).
    invalidateRunDerivedQueries(queryClient);
    void queryClient.invalidateQueries({ queryKey: ['planning'] });
    if (!runId) reset();
  }, [begin, fail, follow, queryClient, reset]);

  return { recalculate, busy: run.busy, error };
}

const PlanRecalcContext = React.createContext<PlanRecalcApi | null>(null);

export function PlanRecalcProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const api = useLocalPlanRecalc();
  return <PlanRecalcContext.Provider value={api}>{children}</PlanRecalcContext.Provider>;
}

/** The shell's shared recalculation; a standalone instance outside a provider (tests). */
export function usePlanRecalc(): PlanRecalcApi {
  const shared = React.useContext(PlanRecalcContext);
  const local = useLocalPlanRecalc();
  return shared ?? local;
}

/** Header "Recalculate": always visible on the plan pages; disabled with a tooltip for other roles. */
export function PlanRecalculateButton({ inFlight = false }: { inFlight?: boolean }): React.JSX.Element {
  const canRecalc = useCanRecalculatePlan();
  const { recalculate, busy, error } = usePlanRecalc();
  const running = busy || inFlight;
  const button = (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="h-7 gap-1 rounded-pill px-s2 text-2xs"
      disabled={!canRecalc || running}
      aria-disabled={!canRecalc || running}
      onClick={() => void recalculate()}
      data-testid="plan-recalculate-header"
    >
      {running ? (
        <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <RefreshCw className="size-3" aria-hidden="true" />
      )}
      {running ? PLAN_RECALC_COPY.recalculating : PLAN_RECALC_COPY.headerButton}
    </Button>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events; the span carries the tooltip. */}
        <span className="inline-flex" tabIndex={canRecalc ? undefined : 0}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {error ?? (canRecalc ? PLAN_RECALC_COPY.tooltip : PLAN_RECALC_COPY.adminOnly)}
      </TooltipContent>
    </Tooltip>
  );
}
