import * as React from 'react';

import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { useHubs } from '@/lib/api/reference';

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
  if (!region) return null;
  return (
    <span className={className} title={`Hub rank in ${hub}`} data-testid="hub-rank-flag">
      <CountryFlag region={region} />
    </span>
  );
}
