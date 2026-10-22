import * as React from 'react';
import { Building2 } from 'lucide-react';

import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useHubs } from '@/lib/api/reference';
import { hubPickerLabel } from '@/lib/hub-labels';
import { cn } from '@/lib/utils';
import { isLabRegion, useHubFilter } from '@/stores/hub-filter';
import { useSessionStore } from '@/stores/session';

import { CountryFlag } from './country-flag';
import { hubsInScope, regionsInScope, shouldResetHub, shouldResetRegion } from './hub-scope';

/** Radix Select needs a non-empty value for the "All hubs" item. Countries and
 *  hubs are prefixed so a hub id can never collide with a country name. */
const ALL = '__all_hubs__';
const REGION_PREFIX = 'region:';
const HUB_PREFIX = 'hub:';

/**
 * The global hub / country filter in the app header (ADR 0020, ADR 0025):
 * "All hubs", then a "Countries" group (each served `lab_region` holding at
 * least one in-scope hub), then a "Hubs" group (every hub in the caller's
 * scope). The choice lives in `stores/hub-filter.ts` (persisted per browser);
 * every portfolio surface reads it and sends `hub_id` / `region`. A persisted
 * hub or country that is no longer in scope resets to "All hubs".
 */
export function HubFilterSelect({ className }: { className?: string }): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubsQuery = useHubs();
  const { hubId, region, setHubId, setRegion, clear } = useHubFilter();
  const id = React.useId();

  const options = React.useMemo(() => hubsInScope(me, hubsQuery.data), [me, hubsQuery.data]);
  const regions = React.useMemo(() => regionsInScope(options), [options]);

  React.useEffect(() => {
    if (shouldResetHub(hubId, options)) setHubId(null);
  }, [hubId, options, setHubId]);
  React.useEffect(() => {
    if (shouldResetRegion(region, regions)) setRegion(null);
  }, [region, regions, setRegion]);

  const value = hubId !== null ? `${HUB_PREFIX}${hubId}` : region !== null ? `${REGION_PREFIX}${region}` : ALL;
  // Explicit trigger text: while the hub list loads, a persisted id has no
  // matching item yet, and Radix would otherwise print nothing.
  const label =
    hubId !== null
      ? (hubsQuery.data?.find((h) => h.id === hubId)?.name ?? 'Selected hub')
      : region !== null
        ? region
        : 'All hubs';

  const onValueChange = (next: string): void => {
    if (next.startsWith(HUB_PREFIX)) setHubId(next.slice(HUB_PREFIX.length));
    else if (next.startsWith(REGION_PREFIX)) {
      const r = next.slice(REGION_PREFIX.length);
      if (isLabRegion(r)) setRegion(r);
    } else clear();
  };

  return (
    <div className={cn('flex min-w-0 items-center', className)} data-testid="hub-filter">
      <Label htmlFor={id} className="sr-only">
        Hub filter
      </Label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id={id}
          className={cn(
            'h-8 w-auto min-w-0 max-w-[8.5rem] gap-1.5 rounded-pill border-transparent bg-transparent px-s3 text-2xs font-semibold sm:max-w-44',
            'hover:bg-surface-sunken',
            value !== ALL && 'bg-primary-subtle text-primary-subtle-fg hover:bg-primary-subtle',
          )}
        >
          {region !== null && hubId === null ? (
            <CountryFlag region={region} />
          ) : (
            <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
          )}
          <span className="min-w-0 truncate">
            <SelectValue>{label}</SelectValue>
          </span>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectItem value={ALL}>All hubs</SelectItem>
          {regions && regions.length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Countries</SelectLabel>
                {regions.map((r) => (
                  <SelectItem key={r} value={`${REGION_PREFIX}${r}`}>
                    <span className="inline-flex items-center gap-2">
                      <CountryFlag region={r} />
                      {r}
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
          {options && options.length > 0 ? (
            <>
              <SelectSeparator />
              <SelectGroup>
                <SelectLabel>Hubs</SelectLabel>
                {options.map((h) => (
                  <SelectItem key={h.id} value={`${HUB_PREFIX}${h.id}`}>
                    {/* P29: a member hub reads "OEM-HCK (Greece)" (served capacity hub). */}
                    {hubPickerLabel(h, hubsQuery.data)}
                  </SelectItem>
                ))}
              </SelectGroup>
            </>
          ) : null}
        </SelectContent>
      </Select>
    </div>
  );
}
