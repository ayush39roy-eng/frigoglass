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
}

export function RegionChips({ items, label, onSolid = false, className }: RegionChipsProps): React.JSX.Element {
  return (
    <ul
      aria-label={`${label} by country`}
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      data-testid="region-chips"
    >
      {items.map((item) => {
        const share =
          item.sharePct === null || item.sharePct === undefined ? null : `${formatDecimal(item.sharePct)}%`;
        return (
          <li
            key={item.region}
            title={`${item.region}: ${formatInteger(item.count)}${share ? ` (${share})` : ''}`}
            className={cn(
              'inline-flex items-center gap-1 rounded-pill border-[1.5px] px-2 py-0.5 text-2xs font-bold tabular-nums',
              onSolid ? 'border-white/20 bg-white/10 text-inherit' : 'border-dash-hairline bg-dash-alt text-text',
            )}
            data-numeric=""
          >
            <CountryFlag region={item.region} />
            <span className="sr-only">{item.region}:</span>
            <span>{formatInteger(item.count)}</span>
            {share ? (
              <span className={cn('font-semibold', onSolid ? 'opacity-75' : 'text-text-muted')}>({share})</span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
