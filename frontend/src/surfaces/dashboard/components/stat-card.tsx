import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatInteger } from '@/lib/format';

/**
 * A single headline figure. Used for the four status-overview cards and the
 * three schedule-outcome KPIs (within-year / spillover / left-out).
 *
 * RESTYLED 2026-09-08 to the reference-dashboard treatment: a large display figure,
 * a tinted pill carrying the icon, generous padding and a soft resting lift. The
 * public API is unchanged — every existing call site upgrades without an edit — with
 * two additive options, `feature` and `trend`.
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
  return (
    <div
      role="group"
      aria-label={label}
      className={cn(
        'flex flex-col gap-s3 rounded-card border p-card',
        'transition-[box-shadow,transform] duration-fast ease-ease-out-expo hover:-translate-y-px hover:shadow-hover',
        feature
          ? 'border-transparent bg-feature text-feature-fg shadow-hover'
          : cn('bg-surface shadow-card', TONE_BORDER[tone]),
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
        {typeof value === 'number' ? formatInteger(value) : value}
      </span>

      {caption ? (
        <span className={cn('text-2xs', feature ? 'text-feature-muted' : 'text-text-subtle')}>
          {caption}
        </span>
      ) : null}
    </div>
  );
}
