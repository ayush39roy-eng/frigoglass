import * as React from 'react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { LabRegion } from '@/types/enums';

/**
 * Per-country chips under a Dashboard KPI card (ADR 0025 §4, contract §4):
 * flag, count and (share %), as on the client mock-up.
 *
 * Every figure is one served field of `GET /dashboard/region-summary` (I9):
 * `count` and `sharePct` are read, never summed or divided here. A share the
 * server does not serve for a figure is simply not shown.
 */

export interface RegionChipItem {
  region: LabRegion;
  count: number;
  /** Served share, 0–100 with 2 dp. `null`/absent = not served → not shown. */
  sharePct?: number | null;
}

export interface RegionChipsProps {
  items: RegionChipItem[];
  /** What the chips break down, for the accessible group label. */
  label: string;
  /** On the solid (ink / feature) KPI tiles the chips invert. */
  onSolid?: boolean;
  className?: string;
  /** When set, each chip is a button that lists that country's projects
   *  (owner ask 2026-11-13). Chips sit above a card-wide `CardOpenButton`. */
  onSelect?: ((item: RegionChipItem, el: HTMLButtonElement) => void) | undefined;
}

export function RegionChips({ items, label, onSolid = false, className, onSelect }: RegionChipsProps): React.JSX.Element {
  return (
    <ul
      aria-label={`${label} by country`}
      // Only the chips themselves take clicks: the gaps between them fall
      // through to the card-wide open button underneath.
      className={cn(
        'relative z-[2] flex flex-wrap items-center gap-1.5',
        onSelect && 'pointer-events-none [&_button]:pointer-events-auto',
        className,
      )}
      data-testid="region-chips"
    >
      {items.map((item) => {
        const share =
          item.sharePct === null || item.sharePct === undefined ? null : `${formatDecimal(item.sharePct)}%`;
        const title = `${item.region}: ${formatInteger(item.count)}${share ? ` (${share})` : ''}`;
        const chipClass = cn(
          'inline-flex items-center gap-1 rounded-pill border-[1.5px] px-2 py-0.5 text-2xs font-bold tabular-nums',
          onSolid ? 'border-white/20 bg-white/10 text-inherit' : 'border-dash-hairline bg-dash-alt text-text',
        );
        const body = (
          <>
            <CountryFlag region={item.region} />
            <span className="sr-only">{item.region}:</span>
            <span>{formatInteger(item.count)}</span>
            {share ? (
              <span className={cn('font-semibold', onSolid ? 'opacity-75' : 'text-text-muted')}>({share})</span>
            ) : null}
          </>
        );
        return (
          <li key={item.region} title={title} className={onSelect ? 'inline-flex' : chipClass} data-numeric="">
            {onSelect ? (
              <button
                type="button"
                aria-haspopup="dialog"
                aria-label={`${label}, ${title}: list the projects`}
                onClick={(event) => { onSelect(item, event.currentTarget); }}
                className={cn(
                  chipClass,
                  'cursor-pointer transition-colors duration-fast hover:border-primary/50 hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                )}
              >
                {body}
              </button>
            ) : (
              body
            )}
          </li>
        );
      })}
    </ul>
  );
}
