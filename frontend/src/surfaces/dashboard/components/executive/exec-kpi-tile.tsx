import * as React from 'react';

import { formatInteger } from '@/lib/format';
import { useCountUp } from '@/lib/use-count-up';
import { cn } from '@/lib/utils';

/**
 * One Executive KPI tile (P28 addendum, owner correction: "same width and
 * size"). Every tile renders the IDENTICAL fixed skeleton — a fixed-height
 * card with a top row `icon chip | label` and the figure line `number | badge
 * slot` at the bottom — so no badge, label or footer can ever wrap a tile
 * taller or narrower than its siblings. The badge slot is always present
 * (invisible when a tile has no badge) to keep the figure lines aligned.
 * (QA-F28-3, 2026-10-23: the badge moved from the label row to the figure
 * line, so it can never cover the label at any width.)
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
  /** Short badge text shown after the figure ("of 253", "18%"). */
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
 *  equal grid columns; equal height from this class). Below `md` (QA-F28-2:
 *  ~100 px tiles in the phone 2-column strip, ~150 px in the 640–767 px
 *  3-column strip) there is no icon chip and the badge sits under the number,
 *  so the frame is taller there; it is still ONE fixed height for every tile. */
const TILE_FRAME =
  'relative flex h-[7.5rem] w-full flex-col overflow-hidden rounded-dash border-[1.5px] px-s3 py-s3 text-left transition-shadow duration-base md:h-[5.75rem] md:px-s4';

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
      {/* Header: icon chip + label only (QA-F28-3: the badge no longer shares
          this row at ANY width, so the label always has the tile's full
          width less the icon). Below `md` the icon chip is hidden too. */}
      <span className="flex w-full items-center gap-s2" data-testid="exec-kpi-tile-header">
        <span
          className={cn(
            'hidden size-8 shrink-0 place-items-center rounded-xl md:grid',
            variant === 'feature' && 'bg-surface text-text shadow-card',
            variant === 'ink' && 'bg-ink-fg/10 text-ink-fg ring-1 ring-ink-fg/20',
            variant === 'plain' && TONE_PILL[tone],
          )}
        >
          <Icon className="size-4" aria-hidden="true" />
        </span>
        {/* The label never ellipsizes; it is short by design and may wrap
            between words on narrow tiles. */}
        <span data-testid="exec-kpi-tile-label" className={cn('min-w-0 flex-1 text-xs font-semibold leading-tight', solid ? 'opacity-90' : 'text-text-muted')}>
          {label}
        </span>
      </span>
      {/* Figure line: the number, then the badge. Below `md` (~100–150 px
          tiles) the badge sits on its own line under the number; from `md` up
          it follows the number on the same line ("272 [of 330]"). The badge
          slot is always present (invisible without a badge) so the figures of
          every tile sit on the same line. */}
      <span
        className="mt-auto flex flex-col items-start gap-1 md:flex-row md:items-center md:gap-s2"
        data-testid="exec-kpi-tile-figure-line"
      >
        <span
          className={cn('block shrink-0 font-display text-3xl font-extrabold leading-none tabular-nums', solid ? 'text-inherit' : 'text-text')}
          data-numeric=""
        >
          {shown}
        </span>
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
          data-testid="exec-kpi-tile-badge"
          aria-hidden={badge === undefined ? true : undefined}
        >
          {badge ?? '—'}
        </span>
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
