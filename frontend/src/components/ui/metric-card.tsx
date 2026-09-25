import * as React from 'react';
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * THE METRIC CARD FAMILY — the KPI row the reference dashboards open with.
 *
 * Four variants, one shape:
 *
 *   <MetricCard>          the default white tile
 *   <MetricCard feature>  the single emphasised dark tile (one per screen, max)
 *   <StatCard>            the compact Working-zone version, no sparkline
 *   <Sparkline>           standalone, for embedding in tables
 *
 * DESIGN NOTES
 *
 * The figure is the hero and everything else is subordinate to it: a small uppercase
 * label above, a delta chip beside, an optional sparkline behind-right. That ordering
 * is what makes the reference cards readable in a glance — the eye lands on the
 * number, then picks up direction from the chip's arrow, then trend from the line.
 *
 * The delta chip never signals with colour alone. Green-up / red-down is reinforced
 * by an arrow glyph and a signed figure, so it survives both a colourblind reader
 * and a greyscale board print-out.
 *
 * "Good" is not always "up". A rising count of at-risk projects is bad news, so
 * `deltaMeaning` decouples direction from sentiment rather than assuming it.
 */

type DeltaMeaning = 'higher-is-better' | 'lower-is-better' | 'neutral';

export interface MetricCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Small uppercase eyebrow. Keep it to two or three words. */
  label: string;
  /** The hero figure, pre-formatted (this component does not format). */
  value: React.ReactNode;
  /** Optional unit or qualifier, rendered small and muted beside the figure. */
  unit?: string;
  /** Percentage or absolute change. Sign drives the arrow. */
  delta?: number;
  /** Formatted delta text. Defaults to a signed percentage. */
  deltaLabel?: string;
  deltaMeaning?: DeltaMeaning;
  /** Trend series for the sparkline. Under two points it is omitted. */
  trend?: readonly number[];
  /** One tile per screen. A second one means neither is emphasised. */
  feature?: boolean;
  /** Small glyph in the top-right, e.g. a category icon. */
  icon?: React.ComponentType<{ className?: string }>;
  /** Supporting line under the figure. */
  caption?: string;
}

function deltaTone(delta: number, meaning: DeltaMeaning): 'good' | 'bad' | 'flat' {
  if (delta === 0 || meaning === 'neutral') return 'flat';
  const isUp = delta > 0;
  return meaning === 'higher-is-better' ? (isUp ? 'good' : 'bad') : isUp ? 'bad' : 'good';
}

/**
 * The change chip. Arrow + sign + magnitude — three independent encodings of the
 * same fact, so no single failure (colourblindness, greyscale print, a tiny screen)
 * loses it.
 */
function DeltaChip({
  delta,
  label,
  meaning,
  onFeature,
}: {
  delta: number;
  // Explicit `| undefined`: the project runs exactExactOptionalPropertyTypes, so an
  // optional prop and a prop that may be undefined are different types.
  label: string | undefined;
  meaning: DeltaMeaning;
  onFeature: boolean;
}) {
  const tone = deltaTone(delta, meaning);
  const Icon = delta === 0 ? Minus : delta > 0 ? ArrowUpRight : ArrowDownRight;
  const text = label ?? `${delta > 0 ? '+' : ''}${delta.toFixed(1)}%`;

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-pill px-s2 py-0.5 text-2xs font-semibold tabular-nums',
        // On the dark feature tile the subtle status backgrounds have almost no
        // contrast, so the chip switches to a translucent white well instead.
        onFeature
          ? 'bg-white/15 text-feature-fg'
          : tone === 'good'
            ? 'bg-success-subtle text-success-subtle-fg'
            : tone === 'bad'
              ? 'bg-danger-subtle text-danger-subtle-fg'
              : 'bg-surface-sunken text-text-muted',
      )}
    >
      <Icon className="size-3" aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * Sparkline. Pure SVG, no charting dependency — it is a polyline and an area fill,
 * and pulling a library in for that would cost more than the entire card.
 *
 * `preserveAspectRatio="none"` lets one viewBox stretch to any card width, so the
 * card never has to measure itself to draw.
 */
export function Sparkline({
  data,
  className,
  strokeClassName = 'stroke-primary',
  fillClassName = 'fill-primary/10',
}: {
  data: readonly number[];
  className?: string;
  strokeClassName?: string;
  fillClassName?: string;
}): React.JSX.Element | null {
  if (data.length < 2) return null;

  const W = 100;
  const H = 32;
  const min = Math.min(...data);
  const max = Math.max(...data);
  // A flat series would divide by zero; render it as a centre line instead.
  const span = max - min || 1;

  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * W;
    const y = H - ((v - min) / span) * (H - 4) - 2;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className={cn('h-8 w-full', className)}
      aria-hidden="true"
      focusable="false"
    >
      <polygon className={fillClassName} points={`0,${H} ${points.join(' ')} ${W},${H}`} />
      <polyline
        className={strokeClassName}
        points={points.join(' ')}
        fill="none"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export const MetricCard = React.forwardRef<HTMLDivElement, MetricCardProps>(
  (
    {
      label,
      value,
      unit,
      delta,
      deltaLabel,
      deltaMeaning = 'higher-is-better',
      trend,
      feature = false,
      icon: Icon,
      caption,
      className,
      ...props
    },
    ref,
  ) => (
    <div
      ref={ref}
      className={cn(
        'group relative flex flex-col justify-between overflow-hidden rounded-card p-card',
        'transition-[box-shadow,transform] duration-fast ease-ease-out-expo hover:-translate-y-px hover:shadow-hover',
        feature
          ? 'bg-feature text-feature-fg shadow-hover'
          : 'border border-border bg-surface text-text shadow-card',
        className,
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-s3">
        <span
          className={cn(
            'label-caps',
            feature ? 'text-feature-muted' : 'text-text-subtle',
          )}
        >
          {label}
        </span>
        {Icon ? (
          <span
            className={cn(
              'grid size-7 shrink-0 place-items-center rounded-pill',
              feature ? 'bg-white/15 text-feature-fg' : 'bg-surface-sunken text-text-muted',
            )}
          >
            <Icon className="size-3.5" />
          </span>
        ) : null}
      </div>

      <div className="mt-s3 flex items-end gap-s2">
        {/* font-display follows the density zone: Space Grotesk at 34px on Overview,
            Inter at 24px on Working (see tokens.css). tabular-nums so a KPI row does
            not jitter when a value ticks over. */}
        <span className="font-display text-display leading-none tabular-nums">{value}</span>
        {unit ? (
          <span
            className={cn(
              'pb-0.5 text-body font-medium',
              feature ? 'text-feature-muted' : 'text-text-muted',
            )}
          >
            {unit}
          </span>
        ) : null}
        {delta !== undefined ? (
          <span className="pb-1">
            <DeltaChip
              delta={delta}
              label={deltaLabel}
              meaning={deltaMeaning}
              onFeature={feature}
            />
          </span>
        ) : null}
      </div>

      {caption ? (
        <p
          className={cn(
            'mt-s2 text-2xs',
            feature ? 'text-feature-muted' : 'text-text-subtle',
          )}
        >
          {caption}
        </p>
      ) : null}

      {trend && trend.length > 1 ? (
        <div className="-mx-card -mb-card mt-s3">
          <Sparkline
            data={trend}
            strokeClassName={feature ? 'stroke-white/70' : 'stroke-primary'}
            fillClassName={feature ? 'fill-white/10' : 'fill-primary/10'}
          />
        </div>
      ) : null}
    </div>
  ),
);
MetricCard.displayName = 'MetricCard';

export interface StatCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: string;
  value: React.ReactNode;
  delta?: number;
  deltaLabel?: string;
  deltaMeaning?: DeltaMeaning;
}

/**
 * The Working-zone stat: label and figure on one line, no sparkline, no icon.
 *
 * Not a `size` prop on MetricCard, because it is a different composition rather than
 * a smaller one — on a screen showing 236 rows, a KPI strip must cost one line of
 * vertical space, and the sparkline is the first thing that has to go.
 */
export const StatCard = React.forwardRef<HTMLDivElement, StatCardProps>(
  ({ label, value, delta, deltaLabel, deltaMeaning = 'higher-is-better', className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn(
        'flex items-center justify-between gap-s3 rounded-control border border-border bg-surface px-s3 py-s2',
        className,
      )}
      {...props}
    >
      <span className="label-caps truncate text-text-subtle">{label}</span>
      <span className="flex items-center gap-s2">
        <span className="font-mono text-figure font-semibold tabular-nums text-text">{value}</span>
        {delta !== undefined ? (
          <DeltaChip delta={delta} label={deltaLabel} meaning={deltaMeaning} onFeature={false} />
        ) : null}
      </span>
    </div>
  ),
);
StatCard.displayName = 'StatCard';
