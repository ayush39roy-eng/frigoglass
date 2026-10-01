import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatDecimal } from '@/lib/format';

/**
 * The Boltshift-skinned compact stat chip for Capacity's load/capacity/gap/
 * completion figures (`<HubSupplyBreakdown>`'s `ResourceBlock`).
 *
 * Built LOCAL to Capacity rather than restyling the shared
 * `@/components/ui/metric-card.tsx` `StatCard` it replaces — same reasoning the
 * 2026-10-01 Dashboard rebuild gave for building its own
 * `surfaces/dashboard/components/stat-card.tsx` instead of touching that
 * shared file: `metric-card.tsx` is a generic `components/ui/` primitive that
 * could gain other surfaces as consumers later, so a one-surface visual
 * language belongs in that surface's own component, not in the shared file
 * (even though, as of this task, Capacity is its only real consumer).
 *
 * DELIBERATELY DOES NOT use `useCountUp` (`@/lib/use-count-up.ts`), despite the
 * task brief's general instruction to count up headline numbers. That hook
 * ALWAYS rounds its animated value to the nearest integer — including the
 * frame where the animation completes, which sets `display` to
 * `Math.round(value)` and never corrects it back to the exact `value` — so it
 * is only safe for quantities that are already integers by nature (Dashboard's
 * within-year/spillover/left-out COUNTS, where `Math.round` is a no-op). Every
 * figure this component renders (load/capacity/gap in engineer-weeks or
 * chamber-weeks, completion as a fraction) is specified to two-decimal
 * precision (ADR 0008, Invariant I17 — "to two decimals"). Running 179.75
 * through `useCountUp` renders "180" on first paint after the horizon toggle
 * (confirmed by `hub-load-panel.test.tsx` failing exactly this way during this
 * task) — a silent frontend-side rounding of a figure CLAUDE.md and I17 both
 * require to reach the screen verbatim. Rather than force the hook where it
 * corrupts the number, or patch the shared hook itself (out of scope, and a
 * behaviour change for its one other, correctly-integer, consumer), this
 * component renders the served figure directly. Same judgement call the task
 * brief itself invited ("if nothing fits honestly, don't force one — say so
 * and skip it") applied to count-up rather than to a chart type.
 */
export interface CapacityStatProps {
  label: string;
  /** Raw served figure. `null` renders "—" (e.g. completion % when load is 0). */
  value: number | null;
  /** Formats the numeric value. Defaults to `formatDecimal`. */
  formatValue?: (value: number) => string;
  /** Wraps the formatted text — e.g. Gap's sign + shortfall colour. */
  renderValue?: (text: string, value: number) => React.ReactNode;
  /** Secondary styling for a de-emphasised figure (e.g. the "estimated" comparison value). */
  muted?: boolean;
  className?: string;
  'data-testid'?: string;
}

export function CapacityStat({
  label,
  value,
  formatValue = formatDecimal,
  renderValue,
  muted = false,
  className,
  ...rest
}: CapacityStatProps): React.JSX.Element {
  const text = value === null ? '—' : formatValue(value);

  return (
    <div
      className={cn(
        'flex flex-col gap-0.5 rounded-dash border border-dash-hairline bg-dash-alt px-s3 py-s2',
        className,
      )}
      {...rest}
    >
      <span className="label-caps truncate text-text-subtle">{label}</span>
      <span
        className={cn(
          'font-mono text-figure font-semibold tabular-nums',
          muted ? 'text-text-muted' : 'text-text',
        )}
        data-numeric=""
      >
        {renderValue ? renderValue(text, value ?? 0) : text}
      </span>
    </div>
  );
}
