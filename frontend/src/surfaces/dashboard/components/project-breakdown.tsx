import * as React from 'react';
import { FilterX, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CharterColumnsToggle } from '@/components/shared/charter-fields';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { hubsInScope } from '@/components/shared/hub-filter/hub-scope';
import { Skeleton } from '@/components/ui/skeleton';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { useHubs } from '@/lib/api/reference';
import { hubPickerLabel } from '@/lib/hub-labels';
import { formatInteger } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useHubFilter } from '@/stores/hub-filter';
import { MultiSelectDropdown } from '@/components/shared/multi-select-dropdown';
import { usePermission, useSessionStore } from '@/stores/session';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import {
  useCategoryChipOptions,
  selectionParam,
  TYPE_CHIP_OPTIONS_WITH_UNMAPPED,
} from '@/lib/multi-select-filter';
import { UI_PROJECT_STATUSES, type ProjectStatus } from '@/types/enums';

import { useDashboardProjects, useProjectFacets, useRegionSummary } from '../hooks/use-dashboard';
import type { ProjectFilterParams } from '../api/types';
import { useDashboardSelection } from '../lib/selection';
import { registerColumns, type RegisterRow } from './register-columns';
import { RegisterRegionSummary } from './register-region-summary';
import { VirtualDataTable } from './virtual-data-table';

/**
 * Deferred card view (2026-10-01). `project-card-grid.tsx` is the Dashboard's one
 * CROSS-SURFACE import — it embeds `@/surfaces/project-workspace/components/
 * ask-agent-panel`, which drags the Project Workspace's hooks and API types into
 * the Dashboard chunk. The table is the default view (`useState('table')` below),
 * so a static import made every Dashboard visitor pay for a panel most of them
 * never open. `React.lazy` defers it to the moment the Cards tab is chosen.
 */
const ProjectCardGrid = React.lazy(async () => ({
  default: (await import('./project-card-grid')).ProjectCardGrid,
}));

type BreakdownView = 'table' | 'cards';

/**
 * "Analytics breakdown with filters (by hub, category, status, priority)"
 * (PROJECT_AND_STACK.md §2). Filtering is server-side — the hooks pass the
 * params straight to `GET /dashboard/projects`, which is already hub-scoped by
 * RBAC. Nothing is computed here.
 */

/** Shared with `surfaces/projects/ProjectsPage.tsx` — the dedicated "all
 *  projects as cards" page filters the same `GET /dashboard/projects` rows
 *  with the same four controls, so it reuses these rather than forking them.
 *  Multi-select (owner ask 2026-11-13): every pick is sent as a repeated param;
 *  nothing picked = "All". */
export function FilterSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: readonly string[];
  onChange: (next: string[]) => void;
  options: { value: string; label: string }[];
  /** "All statuses"; defaults to "All". */
  allLabel?: string;
}): React.JSX.Element {
  return (
    <MultiSelectDropdown
      label={label}
      allLabel={allLabel ?? 'All'}
      pluralNoun={allLabel ? undefined : 'selected'}
      options={options}
      value={value}
      onChange={onChange}
      triggerClassName="h-8 w-40 rounded-pill"
    />
  );
}

/** The register's own filters (ADR 0025 §5). Hub and country are the global
 *  filter; P31: category and type are the Dashboard-wide selection
 *  (`lib/selection.ts`, URL state), so the register, the charts and every KPI
 *  are always cut the same way. Everything is sent to the server, nothing is
 *  filtered locally. */
interface RegisterFilters {
  status_: ProjectStatus[];
  leader: string[];
  step: string[];
}

const REGISTER_EMPTY: RegisterFilters = { status_: [], leader: [], step: [] };

/** Server limit on `q` (contract §3). */
const SEARCH_MAX = 100;

/** ADR 0028: a leader with no served name stays a distinct,
 *  selectable option, labelled by a short id suffix — never a resolved name. */
function leaderOptionLabel(leader: { id: string; name: string | null }): string {
  return leader.name ?? `Leader (name unavailable) · ${leader.id.slice(-4)}`;
}

/**
 * "All registered projects" (ADR 0025 §5, API_CONTRACT_P13 §4): the client
 * mock-up's full-width register, upgraded from the P4 "Project breakdown".
 *
 * - Per-country summary chips from `GET /dashboard/region-summary`.
 * - Filters — debounced search, Hub, Category, Type, Status, Leader, Current
 *   step — all sent to `GET /dashboard/projects`; Hub and country are the
 *   global filter (`stores/hub-filter.ts`). Leader / step options come from
 *   `/dashboard/projects/facets`, so they only offer values that exist.
 * - The row count is the served `total_count`. Nothing is filtered, counted or
 *   ranked in the browser (I9).
 * - Plant / Requesting department are not modelled (OQ #34) and not shown.
 *   No Delete here; Edit only where Registration write is permitted.
 */
export function ProjectBreakdown(): React.JSX.Element {
  const categoryChips = useCategoryChipOptions(true);
  const [filters, setFilters] = React.useState<RegisterFilters>(REGISTER_EMPTY);
  const [search, setSearch] = React.useState('');
  const [view, setView] = React.useState<BreakdownView>('table');
  const [showCharter, setShowCharter] = React.useState(false);
  // The two views share one always-mounted panel, so the active tab's aria-controls always
  // resolves (axe aria-valid-attr-value; Radix would point at TabsContent we never mount).
  const tabsId = React.useId();
  const panelId = `${tabsId}-panel`;
  const tabId = (v: BreakdownView): string => `${tabsId}-tab-${v}`;
  const { hubIds, regions, setHubIds } = useHubFilter();
  const hub = React.useMemo(() => ({ hubIds, regions }), [hubIds, regions]);
  const selection = useDashboardSelection();
  const me = useSessionStore((st) => st.me);
  const hubsQuery = useHubs();
  const canEdit = usePermission('project_registration').write;
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const searchId = React.useId();

  const params = React.useMemo<ProjectFilterParams>(() => {
    const next: ProjectFilterParams = {
      hub_id: selectionParam(hubIds),
      category: selectionParam(selection.categories),
      status_: selectionParam(filters.status_),
      priority: undefined,
    };
    // Optional P13 params are only present when set, so the unfiltered key
    // and request stay identical to P12's. Multi-select: repeated params.
    if (regions.length > 0) next.region = regions;
    if (debouncedSearch) next.q = debouncedSearch.slice(0, SEARCH_MAX);
    if (selection.types.length > 0) next.type = selection.types;
    if (filters.leader.length > 0) next.leader_engineer_id = filters.leader;
    if (filters.step.length > 0) next.current_step = filters.step;
    return next;
  }, [filters, hubIds, regions, debouncedSearch, selection.categories, selection.types]);

  const query = useDashboardProjects(params);
  const facets = useProjectFacets(hub, selection);
  const summary = useRegionSummary(hub, selection);

  // Every in-scope hub: hubs and countries are UNIONED (multi-select contract
  // §2), so a hub outside the picked countries is a valid addition.
  const hubOptions = React.useMemo(() => {
    const inScope = hubsInScope(me, hubsQuery.data) ?? [];
    return inScope.map((h) => ({ value: h.id, label: hubPickerLabel(h, hubsQuery.data) }));
  }, [me, hubsQuery.data]);

  const hasLocalFilter =
    debouncedSearch !== '' || Object.values(filters).some((v) => v.length > 0) || selection.active;
  const isFiltered = hasLocalFilter || hubIds.length > 0 || regions.length > 0;
  const rows = React.useMemo<RegisterRow[]>(
    () => (query.data?.rows ?? []).map((row, i) => ({ ...row, ordinal: i + 1 })),
    [query.data],
  );
  const columns = React.useMemo(() => registerColumns({ canEdit, showCharter }), [canEdit, showCharter]);

  const set = (key: keyof RegisterFilters) => (next: string[]) => setFilters((prev) => ({ ...prev, [key]: next }));
  const clearLocal = (): void => {
    setFilters(REGISTER_EMPTY);
    setSearch('');
    selection.clear();
  };

  return (
    /* `id` is the target of the Dashboard header's "All projects" button and
       of `<ProjectSpotlight>`'s "View all" link. */
    <BoltCard id="all-projects" className="scroll-mt-6" data-testid="all-projects-register">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>All registered projects</CardTitle>
          {query.data ? (
            <Badge tone="neutral" data-numeric="" data-testid="register-total">
              {formatInteger(query.data.total_count)} {query.data.total_count === 1 ? 'project' : 'projects'}
            </Badge>
          ) : null}
          <CardInfo label="All registered projects source">
            <p>
              Every project visible in your hub scope, from <code>GET /dashboard/projects</code>. The
              hub / country filter and every control here are sent to the server, which is
              already hub-scoped by RBAC. Nothing is filtered or counted in the browser.
            </p>
            <p>
              End wk is the project&apos;s finish week in the active schedule run. Priority shows the
              band and the rank by score within the filtered set.
            </p>
            <p>
              Workbook fields adds Plant, Requesting department and Product type, as written in the
              client workbook. They are read-only.
            </p>
          </CardInfo>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {view === 'table' ? <CharterColumnsToggle pressed={showCharter} onPressedChange={setShowCharter} /> : null}
          <Tabs value={view} onValueChange={(v) => setView(v as BreakdownView)}>
            <TabsList>
              <TabsTrigger value="table" id={tabId('table')} aria-controls={view === 'table' ? panelId : undefined}>
                Table
              </TabsTrigger>
              <TabsTrigger value="cards" id={tabId('cards')} aria-controls={view === 'cards' ? panelId : undefined}>
                Cards
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <DownloadButton
            path="/exports/dashboard"
            filters={{
              hub_id: params.hub_id,
              region: params.region,
              category: params.category,
              status_: params.status_,
              q: params.q,
              type: params.type,
              leader_engineer_id: params.leader_engineer_id,
              current_step: params.current_step,
            }}
            fallbackFilename="dashboard-export"
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {summary.data ? <RegisterRegionSummary summary={summary.data} /> : null}

        <div className="flex flex-wrap items-end gap-3">
          <div className="flex min-w-[12rem] flex-1 flex-col gap-1 sm:max-w-xs">
            <Label htmlFor={searchId} className="text-2xs text-text-muted">
              Search
            </Label>
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
                aria-hidden="true"
              />
              <Input
                id={searchId}
                type="search"
                value={search}
                maxLength={SEARCH_MAX}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Project name or code"
                className="h-8 rounded-pill pl-8"
              />
            </div>
          </div>
          <FilterSelect
            label="Hub"
            allLabel="All hubs"
            value={hubIds}
            onChange={setHubIds}
            options={hubOptions}
          />
          <FilterSelect
            label="Status"
            allLabel="All statuses"
            value={filters.status_}
            onChange={(next) => setFilters((prev) => ({ ...prev, status_: next as ProjectStatus[] }))}
            options={UI_PROJECT_STATUSES.map((st) => ({ value: st, label: st }))}
          />
          <FilterSelect
            label="Leader"
            allLabel="All leaders"
            value={filters.leader}
            onChange={set('leader')}
            options={(facets.data?.leaders ?? []).map((l) => ({ value: l.id, label: leaderOptionLabel(l) }))}
          />
          <FilterSelect
            label="Current step"
            allLabel="All steps"
            value={filters.step}
            onChange={set('step')}
            options={(facets.data?.steps ?? []).map((st) => ({ value: st.code, label: `${st.code} · ${st.name}` }))}
          />
          {hasLocalFilter ? (
            <Button variant="ghost" size="sm" onClick={clearLocal}>
              <FilterX />
              Clear
            </Button>
          ) : null}
        </div>

        {/* P31: multi-select category / type — the Dashboard-wide selection, so
            pressing a chip here re-cuts the charts and KPIs above as well. */}
        <div className="flex flex-col gap-2" data-testid="register-chip-filters">
          <MultiChipFilter
            label="Category"
            options={categoryChips}
            value={selection.categories}
            onChange={selection.setCategories}
            data-testid="register-category-chips"
          />
          <MultiChipFilter
            label="Type"
            options={TYPE_CHIP_OPTIONS_WITH_UNMAPPED}
            value={selection.types}
            onChange={selection.setTypes}
            data-testid="register-type-chips"
          />
          <p className="text-2xs text-text-muted">Category and type apply to the whole Dashboard.</p>
        </div>

        <div id={panelId} role="tabpanel" aria-labelledby={tabId(view)}>
          {query.isPending ? (
            <div className="space-y-2" aria-hidden="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-5/6" />
            </div>
          ) : query.isError ? (
            <ErrorState description="The project register could not be loaded." onRetry={() => void query.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              title={isFiltered ? 'No projects match these filters' : 'No projects'}
              description={
                isFiltered ? 'Try widening or clearing the filters above.' : 'There are no projects visible in your hub scope.'
              }
            />
          ) : view === 'cards' ? (
            <React.Suspense fallback={<PanelSkeleton height="h-[28rem]" />}>
              <ProjectCardGrid rows={query.data.rows} />
            </React.Suspense>
          ) : (
            <VirtualDataTable
              rows={rows}
              columns={columns}
              rowKey={(row) => row.project_id}
              caption="All registered projects"
              estimateRowHeight={60}
              maxHeight={560}
              headerTone="ink"
              tableClassName={showCharter ? 'min-w-[90rem]' : undefined}
            />
          )}
        </div>
      </CardContent>
    </BoltCard>
  );
}
