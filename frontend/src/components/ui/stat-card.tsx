import * as React from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight, type LucideIcon } from 'lucide-react';

import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import { useDensity } from '@/components/layout/density-zone';

/**
 * THE CARD FAMILY.
 *
 * Four cards, each with one job. They share a border, a radius and a padding token,
 * and differ only in how much emphasis they claim:
 *
 *   FeatureCard  the single most important thing on the screen. ONE per screen.
 *   KpiCard      a headline figure with trend. Overview zone.
 *   StatCard     a compact figure. Working zone, or a dense row of secondary numbers.
 *   PanelCard    a titled container for a chart or table. (in card.tsx)
 *
 * All figures render in a tabular-numeral face and align right where they sit in a
 * column, so a row of cards has its decimal points on a shared axis.
 */

/* -------------------------------------------------------------------------- */
/* DeltaChip                                                                   */
/* -------------------------------------------------------------------------- */

export type DeltaDirection = 'up' | 'down' | 'flat';

export interface DeltaChipProps {
  /** Signed change. The sign determines direction; formatting is the caller's job. */
  value: number;
  /** Rendered text, e.g. "+12.7%". Falls back to a signed percentage. */
  label?: string;
  /**
   * Whether an increase is good. Defaults to true.
   *
   * This exists because "up" is not universally positive in this domain: projects
   * completing within the year going UP is good, engineer over-allocation going up
   * is bad. Hard-coding green-for-up would make half the dashboard lie.
   */
  higherIsBetter?: boolean;
  className?: string;
}

const DIRECTION_ICON: Record<DeltaDirection, LucideIcon> = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  flat: ArrowRight,
};

function directionOf(value: number): DeltaDirection {
  if (value > 0) return 'up';
  if (value < 0) return 'down';
  return 'flat';
}

/**
 * A signed change, as colour + arrow + text.
 *
 * Never colour alone: the arrow carries the same information for the ~8% of male
 * engineers with a colour vision deficiency, and the text carries it for everyone
 * reading a greyscale print of the board deck.
 */
export function DeltaChip({ value, label, higherIsBetter = true, className }: DeltaChipProps) {
  const direction = directionOf(value);
  const Icon = DIRECTION_ICON[direction];

  const good = direction === 'flat' ? null : (direction === 'up') === higherIsBetter;
  const tone =
    good === null
      ? 'bg-surface-sunken text-text-muted'
      : good
        ? 'bg-success-subtle text-success-subtle-fg'
        : 'bg-danger-subtle text-danger-subtle-fg';

  const text = label ?? `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-label',
        tone,
        className,
      )}
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span className="tabular-nums">{text}</span>
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Sparkline                                                                   */
/* -------------------------------------------------------------------------- */

export interface SparklineProps {
  values: readonly number[];
  className?: string;
  /** Accessible description. Required — a sparkline is information, not decoration. */
  label: string;
}

/**
 * A trend shape, not a chart. No axes, no ticks, no tooltip: it answers "which way,
 * roughly how steadily", and anything more precise belongs in a real chart.
 *
 * Hand-built SVG rather than a charting library — it is 20 lines, and pulling a
 * chart library into the initial bundle for a decoration-sized mark would cost more
 * than every other card on the Dashboard combined.
 */
export function Sparkline({ values, className, label }: SparklineProps) {
  const path = React.useMemo(() => {
    if (values.length < 2) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    // A flat series has zero range; treat it as a centred horizontal line rather
    // than dividing by zero.
    const range = max - min || 1;
    const step = 100 / (values.length - 1);

    return values
      .map((v, i) => {
        const x = i * step;
        const y = 100 - ((v - min) / range) * 100;
        return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(' ');
  }, [values]);

  if (!path) return null;

  return (
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      className={cn('h-8 w-full overflow-visible text-primary', className)}
    >
      <path
        d={path}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        // Non-scaling stroke keeps the line 2px even though the viewBox is
        // stretched non-uniformly by preserveAspectRatio="none".
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* -------------------------------------------------------------------------- */
/* KpiCard                                                                     */
/* -------------------------------------------------------------------------- */

export interface KpiCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: string;
  /** Pre-formatted figure. Formatting belongs to the caller, who knows the unit. */
  value: React.ReactNode;
  unit?: string;
  delta?: DeltaChipProps;
  trend?: readonly number[];
  icon?: LucideIcon;
}

/**
 * The Overview headline figure: label, big number, optional delta and trend.
 *
 * The figure uses the display face (Space Grotesk on Overview, Inter on Working —
 * see tokens.css) at the density's display size, with tabular numerals so a row of
 * KpiCards has its digits on a shared grid rather than each card centring its own.
 */
export function KpiCard({
  label,
  value,
  unit,
  delta,
  trend,
  icon: Icon,
  className,
  ...props
}: KpiCardProps) {
  return (
    <Card className={cn('flex flex-col justify-between gap-s3 p-card', className)} {...props}>
      <div className="flex items-start justify-between gap-s2">
        <span className="label-caps text-text-subtle">{label}</span>
        {Icon ? <Icon aria-hidden="true" className="size-4 shrink-0 text-text-subtle" /> : null}
      </div>

      <div className="flex items-end gap-s2">
        <span className="font-display text-display tabular-nums leading-none text-text">
          {value}
        </span>
        {unit ? <span className="pb-0.5 text-body text-text-muted">{unit}</span> : null}
      </div>

      {(delta || trend) && (
        <div className="flex items-center justify-between gap-s3">
          {delta ? <DeltaChip {...delta} /> : <span />}
          {trend && trend.length > 1 ? (
            <Sparkline
              values={trend}
              label={`${label} trend`}
              className="h-6 w-20 shrink-0 opacity-70"
            />
          ) : null}
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* StatCard                                                                    */
/* -------------------------------------------------------------------------- */

export interface StatCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  label: string;
  value: React.ReactNode;
  hint?: string;
  icon?: LucideIcon;
}

/**
 * The compact sibling. Same information architecture as KpiCard, one third the
 * height — for the Working zone, and for rows of secondary figures on Overview
 * where a full KpiCard would claim more emphasis than the number deserves.
 */
export function StatCard({ label, value, hint, icon: Icon, className, ...props }: StatCardProps) {
  return (
    <Card className={cn('flex items-center gap-s3 p-card-tight', className)} {...props}>
      {Icon ? (
        <span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary-subtle text-primary-subtle-fg">
          <Icon aria-hidden="true" className="size-4" />
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="label-caps truncate text-text-subtle">{label}</div>
        <div className="font-mono text-figure tabular-nums font-semibold text-text">{value}</div>
      </div>
      {hint ? <span className="shrink-0 text-label text-text-subtle">{hint}</span> : null}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/* FeatureCard                                                                 */
/* -------------------------------------------------------------------------- */

export interface FeatureCardProps extends React.HTMLAttributes<HTMLDivElement> {
  eyebrow?: string;
  heading: string;
  description?: string;
  action?: React.ReactNode;
  icon?: LucideIcon;
}

/**
 * The one emphasised card per screen. Uses a flat brand fill — NOT a gradient.
 *
 * The reference dashboards all lean on gradient feature cards. A gradient reads as
 * expensive on a fintech landing page and cheap on an engineering tool, because the
 * tool's credibility comes from the data being legible rather than from the surface
 * being rich. Flat brand fill gets the same emphasis with none of the cost, keeps
 * text contrast constant across the whole card (a gradient makes the bottom-right
 * corner fail AA while the top-left passes), and prints correctly.
 *
 * "One per screen" is a real constraint, not a style note: two emphasised cards is
 * zero emphasised cards.
 */
export function FeatureCard({
  eyebrow,
  heading,
  description,
  action,
  icon: Icon,
  className,
  ...props
}: FeatureCardProps) {
  const density = useDensity();

  return (
    <Card
      className={cn(
        'flex flex-col justify-between gap-s3 border-transparent bg-primary p-card text-primary-fg',
        className,
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-s3">
        <div className="min-w-0">
          {eyebrow ? <div className="label-caps opacity-70">{eyebrow}</div> : null}
          <h3 className={cn('mt-1 font-semibold', density === 'working' ? 'text-h2' : 'text-h1')}>
            {heading}
          </h3>
        </div>
        {Icon ? (
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary-fg/15">
            <Icon aria-hidden="true" className="size-5" />
          </span>
        ) : null}
      </div>

      {description ? <p className="text-body opacity-85">{description}</p> : null}
      {action ? <div className="pt-s1">{action}</div> : null}
    </Card>
  );
}
