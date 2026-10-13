import * as React from 'react';
import { Ban, CalendarCheck, CalendarX, CircleCheck, CirclePause, CircleX, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { DISPLAY_HORIZON_WEEKS, SPILLOVER_YEAR } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { HEALTH_META } from '@/surfaces/project-workspace/lib/health-meta';

/**
 * Small, non-interactive chips for served schedule outcomes on a project card
 * (P12 Priority board and VIP cards). Every value is printed as served by the
 * active run (I9, I13); nothing here is derived.
 */

export type ServedHealth = 'on_track' | 'at_risk' | 'off_track' | 'left_out' | 'blocked';

const HEALTH_ICON: Record<ServedHealth, React.ComponentType<{ className?: string }>> = {
  on_track: CircleCheck,
  at_risk: TriangleAlert,
  off_track: CircleX,
  left_out: Ban,
  blocked: CirclePause,
};

/** The served health (I13). `blocked` is labelled "On Hold" (ADR 0017). `null` = not in the active run. */
export function HealthChip({ health, className }: { health: ServedHealth | null; className?: string }): React.JSX.Element {
  const meta = HEALTH_META[health ?? 'unscheduled'];
  const Icon = health ? HEALTH_ICON[health] : null;
  return (
    <Badge
      tone={meta.tone}
      className={cn('whitespace-nowrap', className)}
      title={`Health: ${meta.label}. ${meta.description}`}
      data-testid="health-chip"
      data-health={health ?? 'none'}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      <span className="sr-only">Health: </span>
      {meta.label}
    </Badge>
  );
}

/**
 * Projected finish week and the served within-year flag, e.g. "W48 · Within
 * year". `withinYear === null` means the run has no outcome for the project.
 */
export function ProjectedFinishChip({
  projectedEndWeek,
  withinYear,
  className,
}: {
  projectedEndWeek: number | null;
  withinYear: boolean | null;
  className?: string;
}): React.JSX.Element {
  if (projectedEndWeek === null || withinYear === null) {
    return (
      <Badge tone="outline" className={cn('whitespace-nowrap', className)} data-testid="finish-chip" data-within-year="none">
        No projected finish
      </Badge>
    );
  }
  const Icon = withinYear ? CalendarCheck : CalendarX;
  return (
    <Badge
      tone={withinYear ? 'success' : 'warning'}
      className={cn('whitespace-nowrap', className)}
      data-testid="finish-chip"
      data-within-year={String(withinYear)}
      title={
        withinYear
          ? 'Projected to finish inside the plan year'
          : `Projected to finish after week 52 — spillover to ${String(SPILLOVER_YEAR)}`
      }
    >
      <Icon aria-hidden="true" />
      {/* Client ask 2026-10-13: the UI frames the 52-week year only, so a finish
          past W52 is not printed as W53+; the served flag says "Past W52". */}
      {withinYear || projectedEndWeek <= DISPLAY_HORIZON_WEEKS ? (
        <>
          <span className="font-mono tabular-nums" data-numeric="">
            {formatWeek(projectedEndWeek)}
          </span>
          <span aria-hidden="true">·</span>
        </>
      ) : null}
      {withinYear ? 'Within year' : `Past W52 → ${String(SPILLOVER_YEAR)}`}
    </Badge>
  );
}
