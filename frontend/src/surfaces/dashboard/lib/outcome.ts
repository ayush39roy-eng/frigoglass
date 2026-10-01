import type * as React from 'react';
import { CalendarCheck, CircleOff, CirclePause, Clock, HelpCircle } from 'lucide-react';

import type { CompletingWithinYearRow } from '../api/types';

/**
 * ONE place that resolves a `CompletingWithinYearRow`'s raw outcome booleans into
 * the single bucket the backend counts it in, and ONE place that maps that bucket
 * to a colour/icon/label.
 *
 * WHY A PRECEDENCE AT ALL — and why THIS precedence. The row carries four
 * independent booleans (`blocked`, `within_year`, `spillover`, `left_out`) and
 * more than one can be true at once, but `CompletingWithinYear`'s four aggregate
 * counts are mutually exclusive: P9-F02 made `blocked` win outright, so a project
 * whose row has BOTH `blocked` and `within_year` set is counted in
 * `blocked_count` only, never in `within_year_count`. Any per-row presentation
 * that picked a different winner (e.g. "within year beats blocked") would draw a
 * set of cards or a chart series that silently disagreed with the KPI tiles above
 * it. So this function mirrors the backend's documented precedence exactly —
 * blocked > within_year > spillover > left_out — and every consumer on this
 * surface uses it rather than re-deciding.
 *
 * This is a CLASSIFICATION of flags the API already set, not a recomputation of
 * them (Invariant I9): nothing here looks at a week number, a duration or a
 * horizon to decide an outcome. It reads the booleans the schedule run stored.
 *
 * Colour semantics are the EXISTING ones (`@/components/shared/
 * schedule-outcome-meta.ts`, `within-year-panel.tsx`'s KPI tiles) reused
 * verbatim, not a new palette: within-year is the one favourable outcome
 * (success/emerald); spillover, left-out and blocked are all "needs attention"
 * (warning/amber), distinguished from each other by icon and label rather than
 * by inventing three new hues for three states the design system already tones
 * identically.
 */

export type OutcomeBucket = 'blocked' | 'within_year' | 'spillover' | 'left_out' | 'unresolved';

export function outcomeOf(row: CompletingWithinYearRow): OutcomeBucket {
  if (row.blocked) return 'blocked';
  if (row.within_year) return 'within_year';
  if (row.spillover) return 'spillover';
  if (row.left_out) return 'left_out';
  return 'unresolved';
}

export interface OutcomeStyle {
  label: string;
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
    label: 'Spillover',
    Icon: Clock,
    track: 'bg-warning',
    chip: 'bg-warning-subtle text-warning-subtle-fg',
    colorToken: '--color-warning',
  },
  left_out: {
    label: 'Left out',
    Icon: CircleOff,
    track: 'bg-warning',
    chip: 'bg-warning-subtle text-warning-subtle-fg',
    colorToken: '--color-warning',
  },
  blocked: {
    label: 'Blocked',
    Icon: CirclePause,
    track: 'bg-warning',
    chip: 'bg-warning-subtle text-warning-subtle-fg',
    colorToken: '--color-warning',
  },
  unresolved: {
    label: 'No outcome flag',
    Icon: HelpCircle,
    track: 'bg-border-strong',
    chip: 'bg-surface-sunken text-text-muted',
    colorToken: '--color-border-strong',
  },
};
