import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { apiSend } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import type { PlanWeek } from '@/lib/api/session';
import { formatWeek } from '@/lib/format';
import { planBehind, usePlanClock } from '@/lib/plan-clock';
import { invalidateRunDerivedQueries } from '@/lib/use-schedule-run-follow';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session';

/**
 * P37 (ADR 0052 §6, R37-3): what the user sees while the active plan was
 * calculated at an earlier week than the calendar week.
 *
 * - `PlanWeekChip` sits in the header: "Plan from W42 · recalculating…".
 * - `PlanWeekNotice` is the same fact as a one-line notice on the Gantt,
 *   Dashboard, Capacity, Workspace and check-in pages.
 * - `SimulatedWeekNotice` is the What-if / plan-import line: "Simulated from
 *   W47; the active plan is from W42".
 *
 * Every week shown is a served field (`/me.current_week`,
 * `/me.plan_week.run_week`, a result's `current_week`). Verdicts on the
 * surfaces stay the active run's (I9).
 *
 * Recalculate is the existing `POST /schedule-runs/greedy-recalc`, which the
 * server allows Admin and Super Admin only; the button is offered to those
 * roles when nothing is in flight (`pending`) or the week's automatic
 * attempts are spent (`failed`).
 */

const RECALC_ROLES = new Set(['Admin', 'Super Admin']);

function statusPhrase(status: PlanWeek['status']): string {
  switch (status) {
    case 'recalculating':
      return 'recalculating…';
    case 'failed':
      return 'recalculation failed';
    case 'pending':
      return 'recalculation pending';
    default:
      return '';
  }
}

function useCanRecalculate(): boolean {
  const roles = useSessionStore((s) => s.me?.roles);
  return roles?.some((r) => RECALC_ROLES.has(r)) ?? false;
}

function useRecalculatePlan() {
  const queryClient = useQueryClient();
  const refresh = useSessionStore((s) => s.refresh);
  return useMutation({
    mutationFn: () => apiSend<unknown>('POST', '/schedule-runs/greedy-recalc'),
    onSettled: () => {
      invalidateRunDerivedQueries(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['planning'] });
      void refresh();
    },
  });
}

function RecalculateButton({ compact }: { compact?: boolean }): React.JSX.Element {
  const recalc = useRecalculatePlan();
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className={cn('h-6 gap-1 px-2 text-2xs', compact && 'rounded-pill')}
        disabled={recalc.isPending}
        onClick={() => recalc.mutate()}
        data-testid="plan-week-recalculate"
      >
        {recalc.isPending ? (
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <RefreshCw className="size-3" aria-hidden="true" />
        )}
        Recalculate
      </Button>
      {recalc.isError ? (
        <span className="text-2xs text-danger" role="alert">
          {apiErrorMessage(recalc.error, 'The recalculation could not be started.')}
        </span>
      ) : null}
    </>
  );
}

/** Header chip. Renders nothing while the plan is current or there is no run. */
export function PlanWeekChip(): React.JSX.Element | null {
  const clock = usePlanClock();
  const behind = planBehind(clock);
  const canRecalc = useCanRecalculate();
  if (!behind) return null;
  const failed = behind.status === 'failed';
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" data-testid="plan-week-chip" data-status={behind.status}>
      <span
        role="status"
        aria-live="polite"
        className={cn(
          'flex items-center gap-1 rounded-pill px-s2 py-1 text-2xs font-semibold',
          failed ? 'bg-danger-subtle text-danger-subtle-fg' : 'bg-warning-subtle text-warning-subtle-fg',
        )}
        title={`The active plan was calculated from week ${String(behind.run_week)}; the current week is ${String(clock?.week ?? '')}.`}
      >
        {behind.status === 'recalculating' ? (
          <Loader2 className="size-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
        ) : (
          <AlertTriangle className="size-3" aria-hidden="true" />
        )}
        Plan from {formatWeek(behind.run_week)} · {statusPhrase(behind.status)}
      </span>
      {canRecalc && behind.status !== 'recalculating' ? <RecalculateButton compact /> : null}
    </span>
  );
}

/**
 * One-line notice for a surface. Renders nothing while the plan is current or
 * there is no active run.
 */
export function PlanWeekNotice({ className }: { className?: string }): React.JSX.Element | null {
  const clock = usePlanClock();
  const behind = planBehind(clock);
  const canRecalc = useCanRecalculate();
  if (!behind || !clock) return null;
  const failed = behind.status === 'failed';
  const tail =
    behind.status === 'recalculating'
      ? 'A recalculation from this week is running.'
      : failed
        ? 'The automatic recalculation failed.'
        : 'A recalculation from this week has not started yet.';
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="plan-week-notice"
      data-status={behind.status}
      className={cn(
        'flex flex-wrap items-center gap-s2 rounded-card border px-s3 py-s2 text-xs',
        failed
          ? 'border-danger/40 bg-danger-subtle text-danger-subtle-fg'
          : 'border-warning/40 bg-warning-subtle text-warning-subtle-fg',
        className,
      )}
    >
      {behind.status === 'recalculating' ? (
        <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      ) : (
        <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      )}
      <span>
        This plan is from {formatWeek(behind.run_week)}; the current week is {formatWeek(clock.week)}. {tail}
      </span>
      {canRecalc && behind.status !== 'recalculating' ? <RecalculateButton /> : null}
    </div>
  );
}

/**
 * R37-3: a What-if / plan-import result solved at its own input week. Shows
 * "Simulated from W47; the active plan is from W42" when that week differs
 * from the active run's; nothing otherwise (or with no active run).
 */
export function SimulatedWeekNotice({
  simulatedWeek,
  className,
}: {
  simulatedWeek: number | null | undefined;
  className?: string;
}): React.JSX.Element | null {
  const runWeek = useSessionStore((s) => s.me?.plan_week?.run_week ?? null);
  if (simulatedWeek === null || simulatedWeek === undefined || runWeek === null || simulatedWeek === runWeek) {
    return null;
  }
  return (
    <p
      role="note"
      data-testid="simulated-week-notice"
      className={cn(
        'flex items-center gap-s2 rounded-card border border-warning/40 bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg',
        className,
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
      Simulated from {formatWeek(simulatedWeek)}; the active plan is from {formatWeek(runWeek)}.
    </p>
  );
}

/** "Planning year 2026 closed" banner (R37-10). Nothing while the year is open. */
export function PlanYearClosedNotice({ className, detail }: { className?: string; detail?: string }): React.JSX.Element | null {
  const clock = usePlanClock();
  if (!clock?.closed) return null;
  return (
    <div
      role="status"
      data-testid="plan-year-closed-notice"
      className={cn(
        'flex items-center gap-s2 rounded-card border border-border bg-surface-sunken px-s3 py-s2 text-xs text-text',
        className,
      )}
    >
      <AlertTriangle className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
      <span>
        Planning year {clock.planYear} closed. The week stays at {formatWeek(clock.week)} until an Admin opens{' '}
        {clock.spilloverYear}.{detail ? ` ${detail}` : ''}
      </span>
    </div>
  );
}
