import * as React from 'react';
import { motion } from 'framer-motion';

import { cn } from '@/lib/utils';
import { formatInteger } from '@/lib/format';
import { useCountUp } from '@/lib/use-count-up';
import { useMotionTokens } from '@/lib/motion';

/**
 * A single headline figure. Used for the four status-overview cards and the
 * schedule-outcome KPIs (within-year / spillover / left-out / blocked).
 *
 * RESTYLED 2026-09-08 to the reference-dashboard treatment: a large display figure,
 * a tinted pill carrying the icon, generous padding and a soft resting lift. The
 * public API is unchanged — every existing call site upgrades without an edit — with
 * two additive options, `feature` and `trend`.
 *
 * RESTYLED AGAIN 2026-09-30 (Dashboard "crazy-charts" polish, still fully
 * additive/backward-compatible):
 *  - Non-`feature` tiles now render on the glass surface (`bg-glass/60
 *    backdrop-blur-xl`, see `src/styles/tokens.css` "GLASS SURFACE LAYER")
 *    instead of the flat `bg-surface` card — the "pastel stat chips" reference
 *    treatment, expressed as translucency of the SAME surface/border tokens
 *    every other card uses, not a new colour. `feature` stays a fully opaque
 *    dark tile (unchanged) — a translucent dark tile over another dark tile
 *    reads as muddy, and `Card`'s own documented rule already reserves it as
 *    the one emphasised, fully-opaque tile per screen.
 *  - The numeric figure animates between values via `useCountUp` (never on
 *    first mount — see that hook's own doc comment for why) instead of
 *    appearing instantly, so a schedule re-run or filter change that moves this
 *    number is legible as a change, not just a new static fact.
 *  - A `framer-motion` spring lift on hover (`whileHover`/`whileTap`), gated by
 *    `useMotionTokens()` the same `prefers-reduced-motion` switch every other
 *    animated element in the app already reads from — CSS `hover:-translate-y-px`
 *    stays as the reduced-motion-safe fallback (Framer's own `transition:
 *    {duration: 0}` still lets the CSS transition read as the only motion).
 *
 * Tone still pairs colour with an icon AND a text label, never colour alone. The
 * tinted icon pill is what makes these read as designed rather than as bordered
 * boxes, and it carries the tone without staining the whole card: a card that is
 * entirely amber reads as an alert, and "24 projects spill over" is a fact, not an
 * alarm.
 */
export type StatTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

/** Icon pill: tinted background, solid foreground. Contrast-checked pairs only. */
const TONE_PILL: Record<StatTone, string> = {
  neutral: 'bg-surface-sunken text-text-muted',
  primary: 'bg-primary-subtle text-primary-subtle-fg',
  success: 'bg-success-subtle text-success-subtle-fg',
  warning: 'bg-warning-subtle text-warning-subtle-fg',
  danger: 'bg-danger-subtle text-danger-subtle-fg',
};

/**
 * A hairline of tone on the card edge. Deliberately faint — it is a secondary cue
 * behind the icon pill, not a second alarm.
 */
const TONE_BORDER: Record<StatTone, string> = {
  neutral: 'border-border',
  primary: 'border-primary/20',
  success: 'border-success/20',
  warning: 'border-warning/25',
  danger: 'border-danger/25',
};

export interface StatCardProps {
  label: string;
  value: number | string;
  tone?: StatTone;
  icon?: React.ComponentType<{ className?: string }>;
  /** Small clarifying text under the value (e.g. the counting rule). */
  caption?: React.ReactNode;
  /**
   * Render as the emphasised dark tile. At most ONE per screen — a second one means
   * neither is emphasised. Overrides `tone`, since the dark ground has too little
   * contrast with the subtle tone backgrounds to carry them.
   */
  feature?: boolean;
  className?: string;
}

export function StatCard({
  label,
  value,
  tone = 'neutral',
  icon: Icon,
  caption,
  feature = false,
  className,
}: StatCardProps): React.JSX.Element {
  const motionTokens = useMotionTokens();

  // Always called, unconditionally (Rules of Hooks) — only its RESULT is used
  // when `value` is numeric. `useCountUp` never invents a number: it settles
  // exactly on whatever `value` is, every time (see its own doc comment).
  const countedValue = useCountUp(typeof value === 'number' ? value : 0);
  const displayValue = typeof value === 'number' ? formatInteger(countedValue) : value;

  // `exactOptionalPropertyTypes` forbids passing `whileHover={undefined}`
  // explicitly (framer-motion's prop types don't include `undefined` in their
  // union) — building the props conditionally and spreading is the correct
  // way to "have no whileHover at all" under reduced motion, rather than an
  // explicit undefined value.
  const hoverProps = motionTokens.reduced
    ? {}
    : { whileHover: { y: -4, scale: 1.012 }, whileTap: { scale: 0.99 } };

  return (
    <motion.div
      role="group"
      aria-label={label}
      {...hoverProps}
      transition={motionTokens.spring}
      className={cn(
        'flex flex-col gap-s3 rounded-card border p-card',
        'transition-[box-shadow,transform] duration-fast ease-ease-out-expo hover:-translate-y-px hover:shadow-hover',
        feature
          ? 'border-transparent bg-feature text-feature-fg shadow-hover'
          : cn(
              'bg-glass/60 shadow-glass backdrop-blur-xl backdrop-saturate-150',
              TONE_BORDER[tone],
            ),
        className,
      )}
    >
      <div className="flex items-center justify-between gap-s2">
        <span
          className={cn('label-caps', feature ? 'text-feature-muted' : 'text-text-subtle')}
        >
          {label}
        </span>
        {Icon ? (
          <span
            className={cn(
              'grid size-8 shrink-0 place-items-center rounded-pill',
              feature ? 'bg-white/15 text-feature-fg' : TONE_PILL[tone],
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
        ) : null}
      </div>

      {/* font-display resolves per density zone: Space Grotesk 34px on Overview,
          Inter 24px on Working. tabular-nums so the figure does not re-flow when it
          ticks between values of different widths. */}
      <span
        className={cn(
          'font-display text-display leading-none tabular-nums',
          feature ? 'text-feature-fg' : 'text-text',
        )}
        data-numeric=""
      >
        {displayValue}
      </span>

      {caption ? (
        <span className={cn('text-2xs', feature ? 'text-feature-muted' : 'text-text-subtle')}>
          {caption}
        </span>
      ) : null}
    </motion.div>
  );
}
