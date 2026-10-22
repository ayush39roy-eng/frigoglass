import * as React from 'react';

import { formatInteger } from '@/lib/format';
import { useCountUp } from '@/lib/use-count-up';
import { cn } from '@/lib/utils';

/**
 * One Executive KPI tile (P28 addendum, owner correction: "same width and
 * size"). Every tile renders the IDENTICAL fixed skeleton — a fixed-height
 * card with one top row `icon chip | label | badge slot` and the figure on the
 * bottom line — so no badge, label or footer can ever wrap a tile taller or
 * narrower than its siblings. The badge slot is always present (invisible when
 * a tile has no badge) to keep the top rows aligned across the strip.
 *
 * A tile with `onOpen` is a real <button> (keyboard-activatable,
 * `aria-haspopup="dialog"`) that opens the data behind its number; Radix
 * returns focus to it when the dialog closes. Without `onOpen` (the no-run
 * pipeline fallback) the same chrome renders as a non-interactive group.
 */

export type ExecTileVariant = 'plain' | 'feature' | 'ink';
export type ExecTileTone = 'neutral' | 'primary' | 'success' | 'warning' | 'danger';

const TONE_PILL: Record<ExecTileTone, string> = {
  neutral: 'bg-surface-sunken text-text',
  primary: 'bg-primary-subtle text-primary-subtle-fg',
  success: 'bg-success-subtle text-success-subtle-fg',
  warning: 'bg-warning-subtle text-warning-subtle-fg',
  danger: 'bg-danger-subtle text-danger-subtle-fg',
};

const TONE_RAIL: Record<ExecTileTone, string> = {
  neutral: 'bg-border-strong',
  primary: 'bg-primary',
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
};

export interface ExecKpiTileProps {
  label: string;
  /** The served figure ("—" while its source is unresolved). */
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  tone?: ExecTileTone;
  variant?: ExecTileVariant;
  /** Short badge text for the fixed top-right slot ("of 253", "18%"). */
  badge?: string;
  badgeTone?: 'pop' | 'neutral';
  /** Makes the tile a button opening its data dialog; receives the button
   *  element so the opener can return focus to it on close. */
  onOpen?: (tile: HTMLButtonElement) => void;
  /** Accessible name when clickable ("Scheduled: open the 227 projects"). */
  openLabel?: string;
  testId: string;
}

/** ONE fixed footprint for every tile (equal width comes from the strip's
 *  equal grid columns; equal height from this class). */
const TILE_FRAME =
  'relative flex h-[5.75rem] w-full flex-col overflow-hidden rounded-dash border-[1.5px] px-s4 py-s3 text-left transition-shadow duration-base';

export function ExecKpiTile({
  label,
  value,
  icon: Icon,
  tone = 'neutral',
  variant = 'plain',
  badge,
  badgeTone = 'neutral',
  onOpen,
  openLabel,
  testId,
}: ExecKpiTileProps): React.JSX.Element {
  // Count-up like the shared StatCard; never invents a number.
  const counted = useCountUp(typeof value === 'number' ? value : 0);
  const shown = typeof value === 'number' ? formatInteger(counted) : value;
  const solid = variant !== 'plain';

  const frame = cn(
    TILE_FRAME,
    variant === 'plain' && 'border-dash-hairline bg-surface text-text shadow-dashCard',
    variant === 'feature' && 'border-on-feature/15 text-on-feature shadow-feature',
    variant === 'ink' && 'border-transparent text-ink-fg shadow-ink',
    onOpen && 'cursor-pointer hover:shadow-pop focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  );
  const bgStyle =
    variant === 'feature'
      ? { backgroundImage: 'var(--gradient-dash-primary)' }
      : variant === 'ink'
        ? { backgroundImage: 'var(--gradient-ink)' }
        : undefined;

  const body = (
    <>
      {variant === 'plain' ? (
        <span aria-hidden="true" className={cn('absolute inset-y-3 left-0 w-1.5 rounded-r-full', TONE_RAIL[tone])} />
      ) : null}
      <span className="flex w-full items-center gap-s2">
        <span
          className={cn(
            'grid size-8 shrink-0 place-items-center rounded-xl',
            variant === 'feature' && 'bg-surface text-text shadow-card',
            variant === 'ink' && 'bg-ink-fg/10 text-ink-fg ring-1 ring-ink-fg/20',
            variant === 'plain' && TONE_PILL[tone],
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
        {/* The label never ellipsizes; it is short by design and may wrap
            within its own cell on very narrow tiles. */}
        <span className={cn('min-w-0 flex-1 text-xs font-semibold leading-tight', solid ? 'opacity-90' : 'text-text-muted')}>
          {label}
        </span>
        {/* FIXED badge slot: present on every tile so the rows align. */}
        <span
          className={cn(
            'inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-pill px-2 text-2xs font-bold tabular-nums',
            badge === undefined && 'invisible',
            variant === 'feature'
              ? 'bg-surface text-text'
              : badgeTone === 'pop'
                ? 'bg-pop text-pop-fg'
                : variant === 'ink'
                  ? 'bg-ink-fg/15 text-ink-fg'
                  : 'bg-surface-sunken text-text',
          )}
          data-numeric=""
          aria-hidden={badge === undefined ? true : undefined}
        >
          {badge ?? '—'}
        </span>
      </span>
      <span
        className={cn('mt-auto block font-display text-3xl font-extrabold leading-none tabular-nums', solid ? 'text-inherit' : 'text-text')}
        data-numeric=""
      >
        {shown}
      </span>
    </>
  );

  if (onOpen) {
    return (
      <button
        type="button"
        className={frame}
        style={bgStyle}
        onClick={(event) => { onOpen(event.currentTarget); }}
        aria-haspopup="dialog"
        aria-label={openLabel ?? label}
        data-testid={testId}
        data-exec-kpi-tile=""
      >
        {body}
      </button>
    );
  }
  return (
    <div className={frame} style={bgStyle} role="group" aria-label={label} data-testid={testId} data-exec-kpi-tile="">
      {body}
    </div>
  );
}
