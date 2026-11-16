import type * as React from 'react';
import { CalendarCheck, CircleOff, CirclePause, CircleSlash, Clock, HelpCircle, Hourglass } from 'lucide-react';

import type { CompletingWithinYear, CompletingWithinYearRow, DeliveryRegionRow, ProjectRunOutcome } from '../api/types';

/**
 * ONE place that resolves a `CompletingWithinYearRow`'s raw outcome booleans into
 * the single bucket the backend counts it in, and ONE place that maps that bucket
 * to a colour/icon/label.
 *
 * P42 (ADR 0056, I53): the backend now serves the bucket itself
 * (`row.outcome`, precedence NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED >
 * WITHIN_YEAR > SPILLOVER > LEFT_OUT), and every count and share the page shows
 * is served (`counting_outcome_count`, `within_year_share_pct`, `queued_count`,
 * `not_scheduled_priority_count`). This module only maps the served bucket to
 * a colour/icon/label; it never ranks flags and never recounts rows. Queued and
 * not-scheduled projects do not count toward the year and sit outside every
 * within-year denominator.
 *
 * Colour semantics are the EXISTING ones (`@/components/shared/
 * schedule-outcome-meta.ts`, `within-year-panel.tsx`'s KPI tiles) reused
 * verbatim, not a new palette: within-year is the one favourable outcome
 * (success/emerald); spillover, left-out and blocked are all "needs attention"
 * (warning/amber), distinguished from each other by icon and label rather than
 * by inventing three new hues for three states the design system already tones
 * identically.
 */

export type OutcomeBucket =
  | 'not_scheduled'
  | 'queued'
  | 'blocked'
  | 'within_year'
  | 'spillover'
  | 'left_out'
  | 'unresolved';

/** P42 (API_CONTRACT_P42 §0): the served bucket → this surface's key. */
const SERVED_BUCKET: Record<ProjectRunOutcome, OutcomeBucket> = {
  NOT_SCHEDULED_PRIORITY: 'not_scheduled',
  QUEUED: 'queued',
  BLOCKED: 'blocked',
  WITHIN_YEAR: 'within_year',
  SPILLOVER: 'spillover',
  LEFT_OUT: 'left_out',
};

/**
 * P42 (ADR 0056, I53): the row's SERVED exclusive bucket (`row.outcome`), so
 * the precedence NOT_SCHEDULED_PRIORITY > QUEUED > BLOCKED > WITHIN_YEAR >
 * SPILLOVER > LEFT_OUT is the backend's alone — the browser no longer ranks the
 * flags itself. A row in no bucket (On Hold / Cancelled / Draft / data error)
 * is `unresolved`.
 */
export function outcomeOf(row: Pick<CompletingWithinYearRow, 'outcome'>): OutcomeBucket {
  return row.outcome === null ? 'unresolved' : SERVED_BUCKET[row.outcome];
}

/** P42: the row counts toward the year (stored flag): not queued, not P4. */
export function isCountingBucket(bucket: OutcomeBucket): boolean {
  return bucket !== 'queued' && bucket !== 'not_scheduled';
}

export interface OutcomeStyle {
  label: string;
  /** P17-R07: the label qualified wherever it could be confused with a
   *  same-worded project status (only `blocked`: "On Hold at a stage" vs the
   *  project status On Hold, ADR 0017 §3). Falls back to `label`. */
  qualifiedLabel?: string;
  Icon: React.ComponentType<{ className?: string }>;
  /** Solid fill for a progress track / chart series. */
  track: string;
  /** Tinted chip background + foreground pair (contrast-checked token pairs). */
  chip: string;
  /** The CSS custom property a chart reads for this bucket's stroke/gradient. */
  colorToken: string;
}

export const OUTCOME_STYLE: Record<OutcomeBucket, OutcomeStyle> = {
  within_year: {
    label: 'Within year',
    Icon: CalendarCheck,
    track: 'bg-success',
    chip: 'bg-success-subtle text-success-subtle-fg',
    colorToken: '--color-success',
  },
  spillover: {
    label: 'Spillover (past W52)',
    Icon: Clock,
    track: 'bg-warning',
    chip: 'bg-warning-subtle text-warning-subtle-fg',
    colorToken: '--color-warning',
  },
  // ADR 0024: a project the server could not place is presented inside the
  // spillover framing (it is certainly not done by W52); the bucket key and the
  // served `left_out_count` are unchanged.
  left_out: {
    label: 'Spillover · unplaced',
    Icon: CircleOff,
    track: 'bg-warning',
    chip: 'bg-warning-subtle text-warning-subtle-fg',
    colorToken: '--color-warning',
  },
  blocked: {
    // ADR 0017: bucket key stays `blocked`; shown as "On Hold".
    label: 'On Hold',
    qualifiedLabel: 'On Hold at a stage',
    Icon: CirclePause,
    track: 'bg-warning',
    chip: 'bg-warning-subtle text-warning-subtle-fg',
    colorToken: '--color-warning',
  },
  // P42 (R42-4): a P3 in queue — planned with spare capacity only, not counted.
  queued: {
    label: 'Queued',
    qualifiedLabel: 'Queued (not counted)',
    Icon: Hourglass,
    track: 'bg-primary/40',
    chip: 'bg-primary-subtle text-primary-subtle-fg',
    colorToken: '--color-primary',
  },
  // P42 (R42-3): a P4 / Q, never planned.
  not_scheduled: {
    label: 'Not scheduled (P4)',
    Icon: CircleSlash,
    track: 'bg-border-strong',
    chip: 'bg-surface-sunken text-text-muted',
    colorToken: '--color-border-strong',
  },
  unresolved: {
    label: 'No outcome flag',
    Icon: HelpCircle,
    track: 'bg-border-strong',
    chip: 'bg-surface-sunken text-text-muted',
    colorToken: '--color-border-strong',
  },
};

/* -------------------------------------------------------------------------- */
/* 52-week display framing (ADR 0024, client ask 2026-10-13)                  */
/* -------------------------------------------------------------------------- */

/**
 * The Dashboard presents three outcomes on the 52-week year: within year,
 * spillover (not done by W52) and on hold. The server's `left_out` bucket is
 * shown INSIDE spillover — a project with no slot is certainly not done by W52 —
 * never as a separate "beyond the 78-week horizon" concept. This is a display
 * grouping of the server's buckets, not a new verdict.
 */
export type DisplayOutcome = Exclude<OutcomeBucket, 'left_out'>;

export function displayOutcomeOf(row: CompletingWithinYearRow): DisplayOutcome {
  const bucket = outcomeOf(row);
  return bucket === 'left_out' ? 'spillover' : bucket;
}

/** Spillover past W52 for display: the served `spillover_count` plus the served
 *  `left_out_count` (both "not done by W52"). A sum of two server counts. */
export function spilloverPastYearCount(data: CompletingWithinYear): number {
  return data.spillover_count + data.left_out_count;
}

/** The Dashboard display label for an outcome bucket (qualified where needed). */
export function outcomeLabel(bucket: OutcomeBucket): string {
  const style = OUTCOME_STYLE[bucket];
  return style.qualifiedLabel ?? style.label;
}

/** The served counts the run-wide figures read (API_CONTRACT_P42 §8). */
export type OutcomeCounts = Pick<
  CompletingWithinYear,
  | 'within_year_count'
  | 'spillover_count'
  | 'left_out_count'
  | 'blocked_count'
  | 'counting_outcome_count'
  | 'within_year_share_pct'
>;

/**
 * P42 (I53): the projects counted toward the year — the SERVED
 * `counting_outcome_count` (within + spillover + left out + on hold, counting
 * rows only). The denominator of every within-year share on the page; queued
 * and not-scheduled projects are outside it.
 */
export function outcomeTotal(data: Pick<CompletingWithinYear, 'counting_outcome_count'>): number {
  return data.counting_outcome_count;
}

/**
 * THE within-year share of the active run, as a whole percent: the SERVED
 * `within_year_share_pct` rounded for display (P42, I53 — the browser no
 * longer divides). The KPI tile badge, the delivery gauge and the donut all
 * read it, so they can never disagree.
 */
export function withinYearSharePct(data: Pick<CompletingWithinYear, 'within_year_share_pct'>): number {
  return Math.round(data.within_year_share_pct);
}

/** A served bucket count as a whole-percent share of the served
 *  `counting_outcome_count`. 0 when nothing counts (never NaN). */
export function sharePct(count: number, data: Pick<CompletingWithinYear, 'counting_outcome_count'>): number {
  const total = outcomeTotal(data);
  return total === 0 ? 0 : Math.round((count / total) * 100);
}

/** The four counting buckets of one served `DeliveryRegionRow`. */
export type RegionOutcomeCounts = Pick<
  DeliveryRegionRow,
  'within_year_count' | 'spillover_count' | 'left_out_count' | 'blocked_count'
>;

/**
 * A country's counted projects: the sum of its four served counting buckets.
 * `regions[]` serves no per-country denominator (API_CONTRACT_P42 §8), and the
 * four buckets hold counting rows only, so this sum IS the country's counting
 * denominator; queued and not-scheduled counts are outside it.
 */
export function regionOutcomeTotal(row: RegionOutcomeCounts): number {
  return row.within_year_count + row.spillover_count + row.left_out_count + row.blocked_count;
}

/** A country's within-year share, whole percent, over `regionOutcomeTotal`. */
export function regionWithinYearSharePct(row: RegionOutcomeCounts): number {
  const total = regionOutcomeTotal(row);
  return total === 0 ? 0 : Math.round((row.within_year_count / total) * 100);
}
