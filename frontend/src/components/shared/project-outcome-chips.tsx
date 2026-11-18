import * as React from 'react';
import { Ban, CalendarCheck, CalendarX, CircleCheck, CirclePause, CircleX, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatWeek, formatWeekTitle, weekTitleIfNextYear } from '@/lib/format';
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

/** The served R42-4 text for a queued project finishing past W52. */
const QUEUED_AFTER_YEAR = 'Queued — after W52';

/**
 * Owner rule 2026-11-18: the served "Queued — after W52" names the actual
 * finish when the served `projected_end_week` is past W52 — "Queued — fits by
 * W5 '27" (week 5 of the next year). Every other served label is returned
 * verbatim. Display only: both parts are served fields (I9).
 */
export function outcomeLabelForDisplay(
  label: string | null | undefined,
  projectedEndWeek: number | null | undefined,
): string | null | undefined {
  if (label === QUEUED_AFTER_YEAR && projectedEndWeek != null && projectedEndWeek > WITHIN_YEAR_WEEK) {
    return `Queued — fits by ${formatWeek(projectedEndWeek)}`;
  }
  return label;
}

/**
 * P42 (ADR 0056): a project that does not count toward the year — a queued P3
 * or a P4 / Q that is never planned. The text is the SERVED `outcome_label`
 * verbatim ("Queued — fits by W40", "Not scheduled (P4)"); the bucket only
 * picks the tone and icon. A queued finish past W52 names its next-year week
 * ({@link outcomeLabelForDisplay}).
 */
export function BandOutcomeChip({
  outcome,
  label,
  projectedEndWeek = null,
  className,
}: {
  outcome: NonCountingOutcome;
  /** The served `outcome_label`; falls back to the bucket's short name. */
  label: string | null | undefined;
  /** The served `projected_end_week`, used only to name a next-year finish. */
  projectedEndWeek?: number | null | undefined;
  className?: string;
}): React.JSX.Element {
  const meta = BAND_OUTCOME_META[outcome];
  const yearTitle = label === QUEUED_AFTER_YEAR ? weekTitleIfNextYear(projectedEndWeek) : undefined;
  return (
    <Badge
      tone={meta.tone}
      className={cn('whitespace-nowrap', className)}
      title={yearTitle === undefined ? meta.description : `${meta.description} Fits by ${yearTitle.replace(/^Week/, 'week')}.`}
      data-testid="band-outcome-chip"
      data-outcome={outcome}
    >
      <meta.Icon aria-hidden="true" />
      {outcomeLabelForDisplay(label, projectedEndWeek) ?? meta.label}
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
    return <BandOutcomeChip outcome={outcome} label={outcomeLabel} projectedEndWeek={projectedEndWeek} {...(className !== undefined ? { className } : {})} />;
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
          : `Projected to finish ${formatWeekTitle(projectedEndWeek).replace(/^Week/, 'in week')} — after week 52, spillover to ${spilloverYear}`
      }
    >
      <Icon aria-hidden="true" />
      {/* Owner rule 2026-11-18: a finish past W52 shows as the week of the next
          year ("W5 '27"), never W53+; the served flag still says "Past W52". */}
      <span className="font-mono tabular-nums" data-numeric="">
        {formatWeek(projectedEndWeek)}
      </span>
      <span aria-hidden="true">·</span>
      {withinYear ? 'Within year' : `Past W52 → ${spilloverYear}`}
    </Badge>
  );
}
