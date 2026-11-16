import * as React from 'react';
import { Building2 } from 'lucide-react';

import { MultiSelectDropdown, type MultiSelectOption } from '@/components/shared/multi-select-dropdown';
import { useHubs } from '@/lib/api/reference';
import { hubPickerLabel } from '@/lib/hub-labels';
import { cn } from '@/lib/utils';
import { isLabRegion, useHubFilter } from '@/stores/hub-filter';
import { useSessionStore } from '@/stores/session';
import type { LabRegion } from '@/types/enums';

import { CountryFlag } from './country-flag';
import { hubsInScope, pruneHubSelection, regionsInScope, summarizeHubSelection } from './hub-scope';

/** Option values are prefixed so a hub id can never collide with a country name. */
const REGION_PREFIX = 'region:';
const HUB_PREFIX = 'hub:';

/**
 * The global hub / country filter in the app header (ADR 0020, ADR 0025;
 * multi-select per `docs/API_CONTRACT_MULTISELECT.md` §3): ONE multi-select
 * with "All hubs" (clears), a "Countries" group (each served `lab_region` with
 * at least one in-scope hub) and a "Hubs" group (every hub in the caller's
 * scope), all checkboxes. Ticking a country selects the COUNTRY (sent as
 * `region`), not each of its hubs; the server unions countries and hubs. The
 * trigger summarises ("India + R&D-Greece", "3 hubs"). The choice lives in
 * `stores/hub-filter.ts` (persisted per browser); hubs or countries that are no
 * longer in scope are dropped from it.
 */
export function HubFilterSelect({
  className,
  variant = 'header',
}: {
  className?: string;
  /** P40-T01: `toolbar` is the same global filter drawn as a compact toolbar
   *  dropdown (accessible name "Hub"), e.g. in the Timeline's one-row toolbar. */
  variant?: 'header' | 'toolbar';
}): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubsQuery = useHubs();
  const { hubIds, regions, setSelection } = useHubFilter();

  const options = React.useMemo(() => hubsInScope(me, hubsQuery.data), [me, hubsQuery.data]);
  const scopedRegions = React.useMemo(() => regionsInScope(options), [options]);

  React.useEffect(() => {
    const pruned = pruneHubSelection(hubIds, regions, options, scopedRegions);
    if (pruned) setSelection(pruned.hubIds, pruned.regions);
  }, [hubIds, regions, options, scopedRegions, setSelection]);

  const hubName = React.useCallback(
    (id: string) => hubsQuery.data?.find((h) => h.id === id)?.name ?? 'Selected hub',
    [hubsQuery.data],
  );

  const items = React.useMemo<MultiSelectOption[]>(() => {
    const out: MultiSelectOption[] = [];
    for (const r of scopedRegions ?? []) {
      out.push({ value: `${REGION_PREFIX}${r}`, label: r, group: 'Countries', icon: <CountryFlag region={r} /> });
    }
    for (const h of options ?? []) {
      // P29: a member hub reads "OEM-HCK (Greece)" (served capacity hub).
      out.push({ value: `${HUB_PREFIX}${h.id}`, label: hubPickerLabel(h, hubsQuery.data), group: 'Hubs' });
    }
    return out;
  }, [scopedRegions, options, hubsQuery.data]);

  const value = React.useMemo(
    () => [...regions.map((r) => `${REGION_PREFIX}${r}`), ...hubIds.map((id) => `${HUB_PREFIX}${id}`)],
    [regions, hubIds],
  );

  const onChange = (next: string[]): void => {
    const nextRegions: LabRegion[] = [];
    const nextHubs: string[] = [];
    for (const v of next) {
      if (v.startsWith(REGION_PREFIX)) {
        const r = v.slice(REGION_PREFIX.length);
        if (isLabRegion(r)) nextRegions.push(r);
      } else if (v.startsWith(HUB_PREFIX)) nextHubs.push(v.slice(HUB_PREFIX.length));
    }
    setSelection(nextHubs, nextRegions);
  };

  const active = hubIds.length > 0 || regions.length > 0;
  const onlyRegion = hubIds.length === 0 && regions.length === 1 ? regions[0] : undefined;

  return (
    <div
      className={cn('flex min-w-0 items-center', className)}
      data-testid={variant === 'toolbar' ? 'toolbar-hub-filter' : 'hub-filter'}
    >
      <MultiSelectDropdown
        label={variant === 'toolbar' ? 'Hub' : 'Hub filter'}
        hideLabel
        options={items}
        value={value}
        onChange={onChange}
        allLabel="All hubs"
        emptySummary={variant === 'toolbar' ? 'Hub' : undefined}
        summarize={() => summarizeHubSelection(hubIds, regions, hubName)}
        align={variant === 'toolbar' ? 'start' : 'end'}
        triggerIcon={
          onlyRegion ? <CountryFlag region={onlyRegion} /> : <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
        }
        triggerClassName={
          variant === 'toolbar'
            ? 'h-7 w-24 gap-1 px-2'
            : cn(
                'h-8 w-auto min-w-0 max-w-[10rem] gap-1.5 rounded-pill border-transparent bg-transparent px-s3 text-2xs font-semibold sm:max-w-52',
                'hover:bg-surface-sunken',
                active && 'bg-primary-subtle text-primary-subtle-fg hover:bg-primary-subtle',
              )
        }
        data-testid={variant === 'toolbar' ? 'toolbar-hub-filter-select' : 'hub-filter-select'}
      />
    </div>
  );
}
