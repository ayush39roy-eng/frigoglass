import * as React from 'react';
import { Ban, CalendarCheck, CalendarX, CircleCheck, CirclePause, CircleX, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { usePlanYearLabels } from '@/lib/plan-clock';
import { cn } from '@/lib/utils';
import { HEALTH_META } from '@/surfaces/project-workspace/lib/health-meta';
import type { NonCountingOutcome } from '@/types/enums';

import { BAND_OUTCOME_META } from './schedule-outcome-meta';

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
 * P42 (ADR 0056): a project that does not count toward the year — a queued P3
 * or a P4 / Q that is never planned. The text is the SERVED `outcome_label`
 * verbatim ("Queued — fits by W40", "Not scheduled (P4)"); the bucket only
 * picks the tone and icon. Never composed here.
 */
export function BandOutcomeChip({
  outcome,
  label,
  className,
}: {
  outcome: NonCountingOutcome;
  /** The served `outcome_label`; falls back to the bucket's short name. */
  label: string | null | undefined;
  className?: string;
}): React.JSX.Element {
  const meta = BAND_OUTCOME_META[outcome];
  return (
    <Badge
      tone={meta.tone}
      className={cn('whitespace-nowrap', className)}
      title={meta.description}
      data-testid="band-outcome-chip"
      data-outcome={outcome}
    >
      <meta.Icon aria-hidden="true" />
      {label ?? meta.label}
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
  outcome = null,
  outcomeLabel = null,
  className,
}: {
  projectedEndWeek: number | null;
  withinYear: boolean | null;
  /** P42: the served non-counting bucket (`servedNonCountingOutcome`). When
   *  set, the chip shows the served `outcomeLabel` instead of the finish — a
   *  queued or P4 project is never "past W52 → spillover". */
  outcome?: NonCountingOutcome | null;
  outcomeLabel?: string | null;
  className?: string;
}): React.JSX.Element {
  const { spilloverYear } = usePlanYearLabels();
  if (outcome !== null) {
    return <BandOutcomeChip outcome={outcome} label={outcomeLabel} {...(className !== undefined ? { className } : {})} />;
  }
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
          : `Projected to finish after week 52 — spillover to ${spilloverYear}`
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
      {withinYear ? 'Within year' : `Past W52 → ${spilloverYear}`}
    </Badge>
  );
}
