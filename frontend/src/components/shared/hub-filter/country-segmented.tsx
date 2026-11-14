import * as React from 'react';
import { Globe2 } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useHubs } from '@/lib/api/reference';
import { cn } from '@/lib/utils';
import { isLabRegion, useHubFilter } from '@/stores/hub-filter';
import { useSessionStore } from '@/stores/session';
import { LAB_REGIONS, type LabRegion } from '@/types/enums';

import { CountryFlag } from './country-flag';
import { hubsInScope, regionsInScope } from './hub-scope';

const ALL = 'all';

/**
 * The mock-up's Dashboard header buttons: All Hubs · Greece · India · Romania
 * (ADR 0025 §3), multi-select (contract §3): each country is a toggle, so
 * several can be on at once; "All Hubs" clears the whole selection (countries
 * AND hubs) and is on when nothing is selected. Bound to the same global store
 * as the header select, so both always agree. Hubs picked in the header stay
 * selected beside the countries (the server unions them); the `HubFilterChip`
 * names the full selection.
 *
 * Countries with no hub in the caller's scope are hidden once `/me` and
 * `GET /hubs` have loaded (all three show until then; the server ANDs the
 * country with the caller's scope, so an empty country gives zero rows, never
 * a wider set).
 */
export function CountrySegmented({ className }: { className?: string }): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubsQuery = useHubs();
  const { hubIds, regions, setRegions, clear } = useHubFilter();

  const scoped = React.useMemo(() => regionsInScope(hubsInScope(me, hubsQuery.data)), [me, hubsQuery.data]);
  const shown = scoped ?? LAB_REGIONS;

  const nothing = hubIds.length === 0 && regions.length === 0;
  const value = nothing ? [ALL] : [...regions];

  const onValueChange = (next: string[]): void => {
    // "All Hubs" newly pressed (or everything un-pressed) clears the selection.
    if ((next.includes(ALL) && !nothing) || next.length === 0) {
      clear();
      return;
    }
    setRegions(next.filter((v): v is LabRegion => isLabRegion(v)));
  };

  return (
    <ToggleGroup
      type="multiple"
      role="group"
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
