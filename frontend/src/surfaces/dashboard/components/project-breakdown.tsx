import * as React from 'react';
import { FilterX, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { hubsInScope } from '@/components/shared/hub-filter/hub-scope';
import { Skeleton } from '@/components/ui/skeleton';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { useHubs } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useHubFilter } from '@/stores/hub-filter';
import { usePermission, useSessionStore } from '@/stores/session';
import {
  PROJECT_CATEGORIES,
  PROJECT_STATUSES,
  PROJECT_TYPE_LABELS,
  PROJECT_TYPES,
  type ProjectCategory,
  type ProjectStatus,
  type ProjectType,
} from '@/types/enums';

import { useDashboardProjects, useProjectFacets, useRegionSummary } from '../hooks/use-dashboard';
import type { ProjectFilterParams } from '../api/types';
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
 *  with the same four controls, so it reuses these rather than forking them. */
export const ALL = '__all__';

/** The local filters. The hub is NOT here: since P12 (ADR 0020) it is the
 *  global header hub filter (`stores/hub-filter.ts`), shared by every surface. */
export interface FilterState {
  category: string;
  status_: string;
  priority: string;
}

export const EMPTY: FilterState = { category: ALL, status_: ALL, priority: ALL };

export function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-8 w-40 rounded-pill">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** The register's own filters (ADR 0025 §5). Hub and country are the global
 *  filter; everything here is sent to the server, nothing is filtered locally. */
interface RegisterFilters {
  category: string;
  type: string;
  status_: string;
  leader: string;
  step: string;
}

const REGISTER_EMPTY: RegisterFilters = { category: ALL, type: ALL, status_: ALL, leader: ALL, step: ALL };

/** Server limit on `q` (contract §3). */
const SEARCH_MAX = 100;

/** ADR 0028: a leader with no served name stays a distinct,
 *  selectable option, labelled by a short id suffix — never a resolved name. */
function leaderOptionLabel(leader: { id: string; name: string | null }): string {
  return leader.name ?? `Leader (name unavailable) · ${leader.id.slice(-4)}`;
}

function pick<T extends string>(value: string): T | undefined {
  return value === ALL ? undefined : (value as T);
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
  const [filters, setFilters] = React.useState<RegisterFilters>(REGISTER_EMPTY);
  const [search, setSearch] = React.useState('');
  const [view, setView] = React.useState<BreakdownView>('table');
  // The two views share one always-mounted panel, so the active tab's aria-controls always
  // resolves (axe aria-valid-attr-value; Radix would point at TabsContent we never mount).
  const tabsId = React.useId();
  const panelId = `${tabsId}-panel`;
  const tabId = (v: BreakdownView): string => `${tabsId}-tab-${v}`;
  const { hubId, region, setHubId } = useHubFilter();
  const me = useSessionStore((st) => st.me);
  const hubsQuery = useHubs();
  const canEdit = usePermission('project_registration').write;
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const searchId = React.useId();

  const params = React.useMemo<ProjectFilterParams>(() => {
    const next: ProjectFilterParams = {
      hub_id: hubId ?? undefined,
      category: pick<ProjectCategory>(filters.category),
      status_: pick<ProjectStatus>(filters.status_),
      priority: undefined,
    };
    // Optional P13 params are only present when set, so the unfiltered key
    // and request stay identical to P12's.
    if (region) next.region = region;
    if (debouncedSearch) next.q = debouncedSearch.slice(0, SEARCH_MAX);
    if (filters.type !== ALL) next.type = filters.type as ProjectType;
    if (filters.leader !== ALL) next.leader_engineer_id = filters.leader;
    if (filters.step !== ALL) next.current_step = filters.step;
    return next;
  }, [filters, hubId, region, debouncedSearch]);

  const query = useDashboardProjects(params);
  const facets = useProjectFacets(hubId, region);
  const summary = useRegionSummary(hubId, region);

  const hubOptions = React.useMemo(() => {
    const inScope = hubsInScope(me, hubsQuery.data) ?? [];
    return inScope.filter((h) => region === null || h.lab_region === region).map((h) => ({ value: h.id, label: h.name }));
  }, [me, hubsQuery.data, region]);

  const hasLocalFilter = debouncedSearch !== '' || Object.values(filters).some((v) => v !== ALL);
  const isFiltered = hasLocalFilter || hubId !== null || region !== null;
  const rows = React.useMemo<RegisterRow[]>(
    () => (query.data?.rows ?? []).map((row, i) => ({ ...row, ordinal: i + 1 })),
    [query.data],
  );
  const columns = React.useMemo(() => registerColumns({ canEdit }), [canEdit]);

  const set = (key: keyof RegisterFilters) => (next: string) => setFilters((prev) => ({ ...prev, [key]: next }));
  const clearLocal = (): void => {
    setFilters(REGISTER_EMPTY);
    setSearch('');
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
            <p>Plant and requesting department are not recorded yet, so they are not shown.</p>
          </CardInfo>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
            value={hubId ?? ALL}
            onChange={(next) => {
              if (next !== ALL) setHubId(next);
              else if (hubId !== null) setHubId(null);
            }}
            options={hubOptions}
          />
          <FilterSelect
            label="Category"
            value={filters.category}
            onChange={set('category')}
            options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }))}
          />
          <FilterSelect
            label="Type"
            value={filters.type}
            onChange={set('type')}
            options={PROJECT_TYPES.map((t) => ({ value: t, label: `${t} · ${PROJECT_TYPE_LABELS[t]}` }))}
          />
          <FilterSelect
            label="Status"
            value={filters.status_}
            onChange={set('status_')}
            options={PROJECT_STATUSES.map((st) => ({ value: st, label: st }))}
          />
          <FilterSelect
            label="Leader"
            value={filters.leader}
            onChange={set('leader')}
            options={(facets.data?.leaders ?? []).map((l) => ({ value: l.id, label: leaderOptionLabel(l) }))}
          />
          <FilterSelect
            label="Current step"
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
            />
          )}
        </div>
      </CardContent>
    </BoltCard>
  );
}
