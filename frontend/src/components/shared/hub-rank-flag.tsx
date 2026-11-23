import * as React from 'react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { useHubs } from '@/lib/api/reference';
import { cn } from '@/lib/utils';

/**
 * ADR 0068 (owner 2026-11-23): the hub rank is marked with the hub's country
 * flag, the global rank with a globe (`GlobalRankMarker`), so the two numbers
 * cannot be confused. Decorative: the rank's tooltip / sr text names the hub.
 */
export function HubRankFlag({ hub, className }: { hub: string | null | undefined; className?: string }): React.JSX.Element | null {
  const hubs = useHubs();
  if (!hub) return null;
  const list = Array.isArray(hubs.data) ? hubs.data : [];
  const region = list.find((h) => h.name === hub)?.lab_region;
  return (
    <span
      className={cn('inline-flex shrink-0 items-center gap-0.5 text-2xs font-semibold leading-none text-text-muted', className)}
      title={`Hub rank in ${hub}`}
      data-testid="hub-rank-flag"
    >
      {region ? <CountryFlag region={region} /> : null}
      <span aria-hidden="true">{hubShortName(hub)}</span>
    </span>
  );
}

/** "R&D-India" → "R&D", "PD-Romania" → "PD", "OEM-HCK" → "HCK": the hub's part
 *  that tells two hubs of one country apart (the flag shows the country). */
export function hubShortName(hub: string): string {
  const [head, ...rest] = hub.split('-');
  if (head === 'OEM' && rest.length > 0) return rest.join('-');
  return head ?? hub;
}
