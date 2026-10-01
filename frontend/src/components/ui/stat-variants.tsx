import * as React from 'react';
import { motion } from 'framer-motion';

import { formatInteger } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { cn } from '@/lib/utils';

/**
 * Per-surface stat styles (2026-10-01, client: "don't make the cards look the
 * same everywhere"). The Dashboard keeps the bold `kpi-card.tsx` feature row;
 * other surfaces use one of these lighter, distinct shapes instead:
 *
 *   - `StatStrip`  one bordered box split into segments (Registration, Timeline)
 *   - `MeterCard`  a value against a capacity, with a thick meter (Capacity)
 *   - `TileStat`   a compact horizontal tile with a solid icon block (Planning, Users)
 *
 * Every figure is passed in by the caller; nothing here computes a value
 * beyond the display percentage of a meter.
 */

export type StatAccent = 'primary' | 'success' | 'warning' | 'danger' | 'neutral';

const ACCENT_DOT: Record<StatAccent, string> = {
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  neutral: 'bg-text-subtle',
};

const ACCENT_BLOCK: Record<StatAccent, string> = {
  primary: 'bg-primary text-primary-fg',
  success: 'bg-success text-white',
  warning: 'bg-warning text-white',
  danger: 'bg-danger text-white',
  neutral: 'bg-text text-text-inverse',
};

const ACCENT_EDGE: Record<StatAccent, string> = {
  primary: 'border-b-primary',
  success: 'border-b-success',
  warning: 'border-b-warning',
  danger: 'border-b-danger',
  neutral: 'border-b-text-subtle',
};

function display(value: number | string): string {
  return typeof value === 'number' ? formatInteger(value) : value;
}

/* -------------------------------------------------------------------------- */

export interface StripSegment {
  label: string;
  value: number | string;
  accent?: StatAccent;
  hint?: string;
}

/** One box, several figures separated by dividers. */
export function StatStrip({
  segments,
  ariaLabel,
  className,
}: {
  segments: StripSegment[];
  ariaLabel: string;
  className?: string;
}): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={cn(
        'grid overflow-hidden rounded-card border-2 border-border-strong/60 bg-surface shadow-card',
        'grid-cols-2 divide-border md:auto-cols-fr md:grid-flow-col md:grid-cols-none md:divide-x-2',
        className,
      )}
    >
      {segments.map((seg) => (
        <div key={seg.label} className="min-w-0 px-card py-s4">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-text-subtle">
            <span className={cn('size-2.5 rounded-full', ACCENT_DOT[seg.accent ?? 'neutral'])} aria-hidden="true" />
            {seg.label}
          </p>
          <p className="mt-1 font-display text-3xl font-extrabold tabular-nums text-text" data-numeric="">
            {display(seg.value)}
          </p>
          {seg.hint ? <p className="truncate text-xs font-medium text-text-muted">{seg.hint}</p> : null}
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export interface MeterCardProps {
  label: string;
  value: number;
  capacity: number;
  unit: string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: StatAccent;
  /**
   * Formats `value` and `capacity`. Defaults to `formatInteger`, which is right
   * for counts — but NOT for the Capacity surface, whose supply figures are
   * specified to two decimals (ADR 0008 / Invariant I17) and are printed with
   * `formatDecimal` by every card and table beneath this row. Rounding here
   * would make the headline silently disagree with the rows a user sums by eye,
   * which is the same frontend-side distortion the 2026-10-01 Capacity reskin
   * declined `useCountUp` over. Same prop name and default rationale as
   * `surfaces/capacity/components/capacity-stat.tsx`'s own `formatValue`.
   */
  formatValue?: (value: number) => string;
}

/** A load figure against its capacity, with a thick animated meter. */
export function MeterCard({
  label,
  value,
  capacity,
  unit,
  icon: Icon,
  accent = 'primary',
  formatValue = formatInteger,
}: MeterCardProps): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const pct = capacity > 0 ? Math.round((value / capacity) * 100) : 0;
  const over = pct > 100;
  return (
    <div
      role="group"
      aria-label={label}
      className="flex flex-col gap-s3 rounded-card border-2 border-border-strong/60 bg-surface p-card shadow-card"
    >
      <div className="flex items-center justify-between gap-s3">
        <span className="flex items-center gap-s2 text-sm font-bold text-text">
          <Icon className="size-4 text-text-muted" aria-hidden="true" />
          {label}
        </span>
        <span
          className={cn(
            'rounded-pill px-2.5 py-0.5 text-2xs font-extrabold tabular-nums',
            over ? 'bg-drop text-drop-fg' : 'bg-pop text-pop-fg',
          )}
          data-numeric=""
        >
          {pct}% used
        </span>
      </div>
      <p className="flex items-baseline gap-s2" data-numeric="">
        <span className="font-display text-4xl font-extrabold tabular-nums text-text">{formatValue(value)}</span>
        <span className="text-sm font-semibold text-text-muted">
          / {formatValue(capacity)} {unit}
        </span>
      </p>
      <div className="relative h-4 overflow-hidden rounded-full border-2 border-border bg-surface-sunken">
        <motion.span
          className={cn('bg-hatch absolute inset-y-0 left-0 origin-left rounded-full', over ? 'bg-danger' : ACCENT_DOT[accent])}
          style={{ width: `${String(Math.min(100, pct))}%` }}
          {...(reduced
            ? {}
            : { initial: { scaleX: 0 }, animate: { scaleX: 1 }, transition: { duration: 0.9, ease: [0.16, 1, 0.3, 1] } })}
        />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

export interface TileStatProps {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  accent?: StatAccent;
  hint?: string;
}

/** Compact horizontal tile: solid icon block left, figure right, coloured bottom edge. */
export function TileStat({ label, value, icon: Icon, accent = 'primary', hint }: TileStatProps): React.JSX.Element {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex items-center gap-s4 rounded-card border-2 border-b-4 border-border-strong/60 bg-surface px-s4 py-s3 shadow-card',
        ACCENT_EDGE[accent],
      )}
    >
      <span className={cn('grid size-12 shrink-0 place-items-center rounded-xl', ACCENT_BLOCK[accent])}>
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <span className="min-w-0">
        <span className="block text-xs font-bold uppercase tracking-wider text-text-subtle">{label}</span>
        <span className="block font-display text-2xl font-extrabold tabular-nums text-text" data-numeric="">
          {display(value)}
        </span>
        {hint ? <span className="block truncate text-xs font-medium text-text-muted">{hint}</span> : null}
      </span>
    </div>
  );
}
