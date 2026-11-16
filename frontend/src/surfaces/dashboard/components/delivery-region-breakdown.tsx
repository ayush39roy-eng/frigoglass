import type * as React from 'react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { DeliveryRegionRow } from '../api/types';
import { outcomeTotal, withinYearSharePct } from '../lib/outcome';

/**
 * Per-country delivery rate under the overall gauge (owner ask 2026-11-16):
 * Greece, India and Romania, each with its within-year share, "within of
 * total" counts and a slim bar in the gauge's primary hue.
 *
 * Every input is a served count off `CompletingWithinYear.regions` (I9); the
 * share is the SAME `withinYearSharePct` formula the overall gauge uses, applied
 * to that country's served counts — never a recount of `rows`. Rows render in
 * the served order (always Greece, India, Romania).
 *
 * A country with no project in the run shows "—", not 0 %. Under a country
 * filter the server still sends all three rows, the others at zero — so the
 * others show "—", the same "all three countries, zero rows included"
 * behaviour as the KPI region chips (ADR 0025 §4, API_CONTRACT_P13 §2).
 *
 * OEM hubs (OEM-HCK, OEM-Seitek) have no country of their own; they are
 * counted in Greece (ADR 0025), which the Greece row says in visible text.
 */

export interface DeliveryRegionBreakdownProps {
  regions: readonly DeliveryRegionRow[];
  /** The Executive view's narrow column variant. */
  compact?: boolean;
}

export function DeliveryRegionBreakdown({ regions, compact = false }: DeliveryRegionBreakdownProps): React.JSX.Element {
  return (
    <div className={compact ? 'flex flex-col gap-1.5' : 'flex flex-col gap-s2'} data-testid="delivery-region-breakdown">
      <p className={cn('font-semibold text-text-muted', compact ? 'text-2xs' : 'text-xs')}>By country</p>
      <ul aria-label="Delivery rate by country" className={compact ? 'flex flex-col gap-1.5' : 'flex flex-col gap-s2'}>
        {regions.map((row) => (
          <RegionRow key={row.region} row={row} compact={compact} />
        ))}
      </ul>
      <p className="text-2xs font-medium text-text-subtle" data-testid="delivery-oem-note">
        OEM projects are counted under Greece.
      </p>
    </div>
  );
}

function RegionRow({ row, compact }: { row: DeliveryRegionRow; compact: boolean }): React.JSX.Element {
  const total = outcomeTotal(row);
  const empty = total === 0;
  const pct = withinYearSharePct(row);
  const oem = row.region === 'Greece';

  return (
    <li className="flex flex-col gap-1" data-testid={`delivery-region-${row.region}`}>
      <span className="sr-only">
        {empty
          ? `${row.region}${oem ? ' (including OEM)' : ''}: no projects in the run`
          : `${row.region}${oem ? ' (including OEM)' : ''}: ${String(pct)}% delivered, ${formatInteger(row.within_year_count)} of ${formatInteger(total)} within the year`}
      </span>
      <div className="flex items-center gap-1.5" aria-hidden="true">
        <CountryFlag region={row.region} />
        <span className={cn('min-w-0 truncate font-semibold text-text', compact ? 'text-2xs' : 'text-xs')}>
          {row.region}
          {oem ? <span className="ml-1 font-medium text-text-subtle">incl. OEM</span> : null}
        </span>
        <span
          className={cn('ml-auto font-display font-extrabold tabular-nums text-text', compact ? 'text-xs' : 'text-sm')}
          data-numeric=""
        >
          {empty ? '—' : `${String(pct)}%`}
        </span>
      </div>
      <div className="flex items-center gap-s2" aria-hidden="true">
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-pill bg-surface-sunken">
          {empty ? null : (
            <span className="absolute inset-y-0 left-0 rounded-pill bg-primary" style={{ width: `${String(pct)}%` }} />
          )}
        </span>
        <span className="text-2xs font-medium tabular-nums text-text-muted" data-numeric="">
          {empty ? '—' : `${formatInteger(row.within_year_count)} / ${formatInteger(total)}`}
        </span>
      </div>
    </li>
  );
}
