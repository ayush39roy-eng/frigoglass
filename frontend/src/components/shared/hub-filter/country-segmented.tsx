import * as React from 'react';
import { Globe2 } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useHubs } from '@/lib/api/reference';
import { cn } from '@/lib/utils';
import { isLabRegion, useHubFilter } from '@/stores/hub-filter';
import { useSessionStore } from '@/stores/session';
import { LAB_REGIONS } from '@/types/enums';

import { CountryFlag } from './country-flag';
import { hubsInScope, regionsInScope } from './hub-scope';

const ALL = 'all';

/**
 * The mock-up's Dashboard header buttons: All Hubs · Greece · India · Romania
 * (ADR 0025 §3, contract §4). Bound to the same global store as the header
 * select, so both always agree. Picking a country clears any hub; "All Hubs"
 * clears both. With a single hub selected none of the buttons is on — the
 * `HubFilterChip` beside it names the hub.
 *
 * Countries with no hub in the caller's scope are hidden once `/me` and
 * `GET /hubs` have loaded (all three show until then; the server ANDs the
 * country with the caller's scope, so an empty country gives zero rows, never
 * a wider set).
 */
export function CountrySegmented({ className }: { className?: string }): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubsQuery = useHubs();
  const { hubId, region, setRegion, clear } = useHubFilter();

  const regions = React.useMemo(() => regionsInScope(hubsInScope(me, hubsQuery.data)), [me, hubsQuery.data]);
  const shown = regions ?? LAB_REGIONS;

  const value = hubId !== null ? '' : (region ?? ALL);

  const onValueChange = (next: string): void => {
    // Radix lets a single-select group be emptied by re-clicking the active
    // item; keep the current choice instead.
    if (next === '') return;
    if (next === ALL) clear();
    else if (isLabRegion(next)) setRegion(next);
  };

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={onValueChange}
      aria-label="Country filter"
      data-testid="country-segmented"
      className={cn(
        'h-9 max-w-full divide-x-0 overflow-x-auto rounded-pill border-[1.5px] border-dash-hairline bg-surface p-0.5 shadow-dashCard',
        className,
      )}
    >
      <ToggleGroupItem
        value={ALL}
        className="h-full rounded-pill px-s3 text-2xs font-semibold text-text-muted data-[state=on]:text-primary-fg"
      >
        <Globe2 aria-hidden="true" />
        All Hubs
      </ToggleGroupItem>
      {shown.map((r) => (
        <ToggleGroupItem
          key={r}
          value={r}
          className="h-full rounded-pill px-s3 text-2xs font-semibold text-text-muted data-[state=on]:text-primary-fg"
        >
          <CountryFlag region={r} />
          {r}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
