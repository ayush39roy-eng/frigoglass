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
 * RESTYLED 2026-10-01 to the Boltshift KPI pattern (spec §5), REPLACING the
 * 2026-09-30 glass treatment: `feature` (at most one per screen, unchanged
 * contract) is now the Boltshift GRADIENT tile — `--gradient-dash-primary`
 * (tokens.css "BOLTSHIFT LAYER", built from the EXISTING `--blue-700`/
 * `--blue-400` primitives, not a new hue) with white text, a translucent
 * circular icon chip and a soft radial highlight in the top-right corner — in
 * place of the flat `bg-feature` dark tile. `feature` deliberately does NOT
 * reuse the sitewide `--color-feature` token any more: that token still backs
 * `FeatureCard`/`MetricCard` (`@/components/ui/stat-card.tsx`,
 * `@/components/ui/metric-card.tsx`) on every OTHER surface, out of scope this
 * task, so this card now reads its own Dashboard-only gradient instead of
 * repointing a token those surfaces still depend on.
 *
 * Non-`feature` tiles drop the translucent glass surface for a plain opaque
 * white Boltshift card (`bg-surface`/`shadow-dashCard`/`border-dash-hairline` —
 * see `bolt-card.tsx`'s own doc comment for why this reads from Dashboard-only
 * tokens rather than the sitewide `--radius-card`/`--shadow-card`).
 *
 * ADAPTATION FROM THE GENERIC BRIEF: the forwarded Boltshift spec's example
 * dashboard cycles its icon-chip colour by POSITION (ink-900 / blue-600 /
 * violet, in no particular order, since its demo data carries no meaning). This
 * app's `tone` prop instead still encodes real status semantics (`warning` for
 * "this needs attention", `success`/`primary` for a positive or neutral fact) —
 * preserving that was judged more valuable than literal position-cycling, since
 * colour here is never decorative (`StatCard`'s own long-standing rule: "colour
 * pairs with an icon AND a label, never alone"). See docs/MEMORY.md "[2026-10-01]
 * Boltshift shell + Dashboard rebuild" for the full reasoning.
 *
 * Count-up (`useCountUp`) and the hover spring lift are unchanged in substance
 * from the prior pass — both already matched what Boltshift itself asks for
 * ("values count up on mount... card hover: y:-3 + shadow lift").
 */
export type StatTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

/** Icon chip: tinted background, solid foreground. Contrast-checked pairs only. */
const TONE_PILL: Record<StatTone, string> = {
  neutral: 'bg-surface-sunken text-text',
  primary: 'bg-primary-subtle text-primary-subtle-fg',
  success: 'bg-success-subtle text-success-subtle-fg',
  warning: 'bg-warning-subtle text-warning-subtle-fg',
  danger: 'bg-danger-subtle text-danger-subtle-fg',
};

/** Thick left accent rail on plain cards — the "distinguishing side" per tone. */
const TONE_RAIL: Record<StatTone, string> = {
  neutral: 'bg-border-strong',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

/**
 * Bold Blocks (2026-10-01) card variants:
 *   - `plain`   white card, coloured left rail + tinted icon chip
 *   - `feature` Frigoglass-blue gradient tile (at most one per row)
 *   - `ink`     near-black tile (inverts in dark mode) — the contrasting second accent
 */
export type StatVariant = 'plain' | 'feature' | 'ink';

/**
 * A small pill beside the figure — a share or delta. `pop` is the lime positive
 * pill, `drop` the red negative one, `neutral` a quiet grey one. Its text is the
 * caller's (already-derived) label; this component never computes it.
 */
export interface StatBadge {
  label: string;
  tone?: 'pop' | 'drop' | 'neutral';
}

const BADGE_TONE: Record<NonNullable<StatBadge['tone']>, string> = {
  pop: 'bg-pop text-pop-fg',
  drop: 'bg-drop text-drop-fg',
  neutral: 'bg-surface-sunken text-text',
};

export interface StatCardProps {
  label: string;
  value: number | string;
  tone?: StatTone;
  icon?: React.ComponentType<{ className?: string }>;
  /** Small clarifying text under the value (e.g. the counting rule). */
  caption?: React.ReactNode;
  /** Back-compat alias for `variant="feature"`. */
  feature?: boolean;
  variant?: StatVariant;
  badge?: StatBadge | null;
  className?: string;
}

export function StatCard({
  label,
  value,
  tone = 'neutral',
  icon: Icon,
  caption,
  feature = false,
  variant,
  badge,
  className,
}: StatCardProps): React.JSX.Element {
  const motionTokens = useMotionTokens();
  const kind: StatVariant = variant ?? (feature ? 'feature' : 'plain');
  const solid = kind !== 'plain';

  // Always called, unconditionally (Rules of Hooks) — only its RESULT is used
  // when `value` is numeric. `useCountUp` never invents a number.
  const countedValue = useCountUp(typeof value === 'number' ? value : 0);
  const displayValue = typeof value === 'number' ? formatInteger(countedValue) : value;

  // `exactOptionalPropertyTypes`: build motion props conditionally and spread,
  // rather than passing explicit `undefined`s.
  const hoverProps = motionTokens.reduced
    ? {}
    : { whileHover: { y: -6 }, whileTap: { scale: 0.985 } };
  const bgStyle =
    kind === 'feature'
      ? { style: { backgroundImage: 'var(--gradient-dash-primary)' } }
      : kind === 'ink'
        ? { style: { backgroundImage: 'var(--gradient-ink)' } }
        : {};

  const mutedText =
    kind === 'feature' ? 'text-white/80' : kind === 'ink' ? 'text-ink-fg/70' : 'text-text-muted';

  return (
    <motion.div
      role="group"
      aria-label={label}
      {...hoverProps}
      {...bgStyle}
      transition={{ type: 'spring', stiffness: 420, damping: 26 }}
      className={cn(
        'group relative flex min-h-[10.5rem] flex-col gap-s3 overflow-hidden rounded-dash p-card',
        'transition-shadow duration-base ease-ease-out-expo',
        kind === 'feature' && 'border-[1.5px] border-blue-900/40 text-white shadow-feature hover:shadow-feature',
        kind === 'ink' && 'border-[1.5px] border-transparent text-ink-fg shadow-ink',
        kind === 'plain' &&
          'border-[1.5px] border-dash-hairline bg-surface text-text shadow-dashCard hover:shadow-pop',
        className,
      )}
    >
      {/* Decorative dot field, right half — fades toward the figure side. */}
      <span
        aria-hidden="true"
        className={cn(
          'bg-dots pointer-events-none absolute inset-y-0 right-0 w-3/5',
          '[mask-image:linear-gradient(to_left,black_30%,transparent)]',
          kind === 'plain' ? 'text-text/[0.07]' : 'text-white/[0.14]',
        )}
      />
      {kind === 'plain' ? (
        <span aria-hidden="true" className={cn('absolute inset-y-4 left-0 w-1.5 rounded-r-full', TONE_RAIL[tone])} />
      ) : (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute -right-10 -top-12 size-40 rounded-full bg-white/15 blur-2xl transition-transform duration-slow group-hover:scale-125"
        />
      )}

      <div className="relative flex items-start justify-between gap-s2">
        {Icon ? (
          <span
            className={cn(
              'grid size-12 shrink-0 place-items-center rounded-2xl transition-transform duration-base ease-ease-out-expo group-hover:-rotate-6 group-hover:scale-105',
              kind === 'feature' && 'bg-white text-primary shadow-card',
              kind === 'ink' && 'bg-ink-fg/10 text-ink-fg ring-1 ring-ink-fg/20',
              kind === 'plain' && TONE_PILL[tone],
            )}
          >
            <Icon className="size-5" aria-hidden="true" />
          </span>
        ) : (
          <span />
        )}
        {badge ? (
          <span
            className={cn(
              'inline-flex items-center rounded-pill px-2.5 py-1 text-2xs font-bold tabular-nums',
              BADGE_TONE[badge.tone ?? 'neutral'],
            )}
            data-numeric=""
          >
            {badge.label}
          </span>
        ) : null}
      </div>

      <div className="relative mt-auto space-y-1">
        <span className={cn('block text-sm font-semibold', solid ? mutedText : 'text-text-muted')}>
          {label}
        </span>
        {/* font-display = Plus Jakarta Sans 800 at the density's display size;
            tabular-nums so the figure does not re-flow when it ticks. */}
        <span
          className={cn('block font-display text-display tabular-nums', solid ? 'text-inherit' : 'text-text')}
          data-numeric=""
        >
          {displayValue}
        </span>
      </div>

      {caption ? (
        <span
          className={cn(
            'relative border-t-[1.5px] pt-s2 text-xs font-medium',
            kind === 'plain' && 'border-dash-hairline',
            kind === 'feature' && 'border-white/20',
            kind === 'ink' && 'border-ink-fg/15',
            mutedText,
          )}
        >
          {caption}
        </span>
      ) : null}
    </motion.div>
  );
}

/**
 * A responsive row of KPI cards that staggers in on mount (Framer Motion).
 * Children are typically 3–5 `StatCard`s; give at most one `variant="feature"`.
 */
export function KpiRow({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const items = React.Children.toArray(children);
  return (
    <div
      className={cn(
        'grid gap-gutter sm:grid-cols-2',
        items.length >= 4 ? 'xl:grid-cols-4' : items.length === 3 ? 'lg:grid-cols-3' : '',
        className,
      )}
    >
      {items.map((child, i) =>
        reduced ? (
          <React.Fragment key={i}>{child}</React.Fragment>
        ) : (
          <motion.div
            key={i}
            className="min-w-0 [&>*]:h-full"
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 30, delay: i * 0.06 }}
          >
            {child}
          </motion.div>
        ),
      )}
    </div>
  );
}
