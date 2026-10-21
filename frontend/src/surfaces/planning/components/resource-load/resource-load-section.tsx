import * as React from 'react';
import { Activity, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import type { Hub } from '@/lib/api/reference';
import { PROJECT_TYPE_LABELS, type ProjectType } from '@/types/enums';

import type { CapacityBasis, FilterOption, ResourceLoadFilters } from '../../api/types';
import { useResourceLoad, useResourceLoadOptions } from '../../hooks/use-planning';
import { BASIS_LABEL, type CapacityUnit } from '../../lib/figures';
import { LoadPanel, type LoadRow } from './load-panel';
import { MultiSelectFilter } from './multi-select-filter';

/**
 * "Resource load analytics" (P19-T04 add-on, the bottom of the client's
 * Configuration page): a filter bar, then engineer and chamber load vs
 * capacity (chart above a sortable table), side by side on wide screens.
 *
 * Personal data (ADR 0028): per-engineer load is audited server-side on every
 * read. So nothing is fetched until the section has scrolled into view
 * (IntersectionObserver; once seen it stays enabled), filter changes are
 * debounced, and the query does not refetch on window focus.
 *
 * Every figure is a served field of `GET /planning/resource-load` for the
 * page's basis and unit (I9/I19).
 */
const ALL = '__all__';
const DEBOUNCE_MS = 400;

const EMPTY_FILTERS: ResourceLoadFilters = {
  hubId: null,
  types: [],
  statuses: [],
  departments: [],
  categories: [],
  engineerIds: [],
};

function useSeen<T extends Element>(armed: boolean): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T>(null);
  // No IntersectionObserver (very old browser): fetch at once rather than never.
  const [seen, setSeen] = React.useState(() => typeof IntersectionObserver === 'undefined');
  React.useEffect(() => {
    if (seen || !armed) return;
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      { rootMargin: '200px 0px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, armed]);
  return [ref, seen];
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = React.useState(value);
  React.useEffect(() => {
    const t = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return debounced;
}

const plain = (list: readonly string[] | undefined): FilterOption[] => (list ?? []).map((v) => ({ value: v, label: v }));

export function ResourceLoadSection({
  basis,
  unit,
  hubs,
  armed = true,
}: {
  basis: CapacityBasis;
  unit: CapacityUnit;
  hubs: Hub[];
  /** Start watching for visibility only once the content above has rendered;
   *  while it loads, this section sits near the top and would fetch at once. */
  armed?: boolean;
}): React.JSX.Element {
  const [ref, seen] = useSeen<HTMLElement>(armed);
  const [filters, setFilters] = React.useState<ResourceLoadFilters>(EMPTY_FILTERS);
  const debounced = useDebounced(filters, DEBOUNCE_MS);

  const optionsQuery = useResourceLoadOptions(seen);
  const loadQuery = useResourceLoad(basis, debounced, seen);
  const options = optionsQuery.data;

  const hubOptions = React.useMemo(() => {
    const served = options?.hubs;
    // The options list names the hubs the caller can see; the filter sends the id.
    return hubs.filter((h) => (served ? served.includes(h.name) : true));
  }, [hubs, options?.hubs]);

  const typeOptions = React.useMemo<FilterOption[]>(
    () =>
      (options?.project_types ?? []).map((t) => ({
        value: t,
        label: t in PROJECT_TYPE_LABELS ? `${t} · ${PROJECT_TYPE_LABELS[t as ProjectType]}` : t,
      })),
    [options?.project_types],
  );
  const engineerOptions = React.useMemo<FilterOption[]>(
    () => (options?.engineers ?? []).map((e) => ({ value: e.engineer_id, label: `${e.name} (${e.hub})` })),
    [options?.engineers],
  );

  const set = <K extends keyof ResourceLoadFilters>(key: K) => (v: ResourceLoadFilters[K]) => setFilters((f) => ({ ...f, [key]: v }));
  const active =
    filters.hubId !== null ||
    filters.types.length + filters.statuses.length + filters.departments.length + filters.categories.length + filters.engineerIds.length > 0;

  const data = loadQuery.data;
  const engineerRows = React.useMemo<LoadRow[]>(
    () =>
      (data?.engineers ?? []).map((e) => ({
        id: e.engineer_id,
        name: e.name,
        group: e.hub,
        capacity: unit === 'weeks' ? e.capacity_weeks : e.capacity_days,
        load: unit === 'weeks' ? e.load_weeks : e.load_days,
        utilization: e.utilization_pct,
      })),
    [data?.engineers, unit],
  );
  const chamberRows = React.useMemo<LoadRow[]>(
    () =>
      (data?.chambers ?? []).map((c) => ({
        id: c.chamber_id,
        name: c.code,
        group: c.lab_region,
        capacity: unit === 'weeks' ? c.capacity_weeks : c.capacity_days,
        load: unit === 'weeks' ? c.load_weeks : c.load_days,
        utilization: c.utilization_pct,
      })),
    [data?.chambers, unit],
  );

  // P24-T02 (ADR 0035): the server serves the departments it holds and
  // `requesting_department_available`. True → a normal, enabled filter over the
  // served list. False → disabled with the tooltip. Never decided here.
  const deptUnavailable = options !== undefined && !options.requesting_department_available;

  return (
    <section ref={ref} aria-labelledby="resource-load-heading" className="flex flex-col gap-3" data-testid="resource-load">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-t border-border pt-4">
        <h2 id="resource-load-heading" className="flex items-center gap-2 font-display text-base font-bold text-text">
          <Activity aria-hidden="true" className="size-4" />
          Resource load analytics
        </h2>
        <p className="text-2xs text-text-muted">
          {BASIS_LABEL[basis]} · load from the active schedule
          {data?.schedule_run_version != null ? ` (run v${String(data.schedule_run_version)})` : ''}
        </p>
      </div>

      <div role="group" aria-label="Resource load filters" className="flex flex-wrap items-center gap-2 rounded-card border border-border bg-surface-sunken p-2">
        <div className="flex items-center gap-1.5">
          <Label htmlFor="rl-hub" className="text-2xs font-bold uppercase tracking-wide text-text-muted">
            Hub
          </Label>
          <Select value={filters.hubId ?? ALL} onValueChange={(v) => set('hubId')(v === ALL ? null : v)}>
            <SelectTrigger id="rl-hub" className="h-8 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All hubs</SelectItem>
              {hubOptions.map((h) => (
                <SelectItem key={h.id} value={h.id}>
                  {h.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <MultiSelectFilter label="Type" options={typeOptions} value={filters.types} onChange={set('types')} />
        <MultiSelectFilter label="Status" options={plain(options?.project_statuses)} value={filters.statuses} onChange={set('statuses')} />
        <MultiSelectFilter
          label="Dept"
          options={plain(options?.requesting_departments)}
          value={filters.departments}
          onChange={set('departments')}
          {...(deptUnavailable ? { disabled: true, disabledReason: 'No department data yet' } : {})}
        />
        <MultiSelectFilter label="Cat" options={plain(options?.categories)} value={filters.categories} onChange={set('categories')} />
        <MultiSelectFilter label="Engineer" options={engineerOptions} value={filters.engineerIds} onChange={set('engineerIds')} />
        {active ? (
          <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => setFilters(EMPTY_FILTERS)}>
            <X />
            Clear filters
          </Button>
        ) : null}
      </div>

      {!seen || (loadQuery.isPending && !data) ? (
        <div className="grid gap-3 xl:grid-cols-2" aria-busy="true" aria-label="Loading resource load">
          <Skeleton className="h-64" />
          <Skeleton className="h-64" />
        </div>
      ) : loadQuery.isError && !data ? (
        <ErrorState title="Resource load" description="The resource load could not be loaded." onRetry={() => void loadQuery.refetch()} />
      ) : (
        <>
          {data && !data.has_active_schedule_run ? (
            <p className="text-2xs text-text-muted">No schedule has been computed yet, so every load is zero.</p>
          ) : null}
          <div className="grid gap-3 xl:grid-cols-2" aria-busy={loadQuery.isFetching || undefined}>
            <LoadPanel
              title="Engineer load vs capacity"
              tone="primary"
              nameHeader="Engineer"
              groupHeader="Hub"
              rows={engineerRows}
              totals={data?.totals.engineers}
              unit={unit}
              emptyText="No engineers match these filters."
            />
            <LoadPanel
              title="Chamber load vs capacity"
              tone="success"
              nameHeader="Chamber"
              groupHeader="Region"
              rows={chamberRows}
              totals={data?.totals.chambers}
              unit={unit}
              emptyText="No chambers match these filters."
            />
          </div>
        </>
      )}
    </section>
  );
}
