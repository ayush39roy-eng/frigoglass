import * as React from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { FilterX, PencilLine, Plus, Search, SlidersHorizontal, Star } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { CharterColumnsToggle } from '@/components/shared/charter-fields';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { hubsInScope } from '@/components/shared/hub-filter/hub-scope';
import { usePriorityMoveFlow } from '@/components/shared/priority-move/use-priority-move-flow';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { useHubs } from '@/lib/api/reference';
import { hubPickerLabel } from '@/lib/hub-labels';
import { formatInteger } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { useHubFilter } from '@/stores/hub-filter';
import { usePermission, useSessionStore } from '@/stores/session';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import {
  useCategoryChipOptions,
  selectionParam,
  TYPE_CHIP_OPTIONS_WITH_UNMAPPED,
  TYPE_FILTER_VALUES,
  UNMAPPED_TYPE,
  useCategoryTypeParams,
  type CategoryFilterValue,
  type TypeFilterValue,
} from '@/lib/multi-select-filter';
import {
  PROJECT_PRIORITIES,
  UI_PROJECT_STATUSES,
  type ProjectPriority,
  type ProjectStatus,
} from '@/types/enums';

import { FilterSelect } from '@/surfaces/dashboard/components/project-breakdown';
import { useDashboardProjects, useProjectFacets } from '@/surfaces/dashboard/hooks/use-dashboard';
import type { ProjectFilterParams, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { fetchEngineerOptions, type EngineerOption } from '@/surfaces/registration/api/engineers-api';
import { WriteForbiddenNotice } from '@/surfaces/registration/components/access-notice';
import { useEditDeepLink } from '@/surfaces/registration/hooks/use-edit-deep-link';

import { REGISTER_EDITS_MAX, type RegisterEditError } from './api/register-edits';
import { BulkEditBar } from './components/bulk-edit-bar';
import { ColumnMenu } from './components/column-menu';
import { ProjectsExportMenu, type ExportSource } from './components/projects-export-menu';
import { ProjectsTable, type RegisterGridEdit } from './components/projects-table';
import { RegisterDiscardDialog, RegisterEditBar, RegisterLeaveGuard } from './components/register-edit-bar';
import { RegisterSavePanel } from './components/register-save-panel';
import { useRegisterSave } from './hooks/use-register-save';
import { useColumnPrefs } from './hooks/use-column-prefs';
import { HIDEABLE_COLUMNS } from './lib/columns';
import {
  buildRegisterEditsBody,
  changedProjectIds,
  setDraftBulk,
  setDraftField,
  type EditableField,
  type RegisterDraft,
  type RegisterDrafts,
  type RegisterValues,
} from './lib/register-edit';
import { orderForDisplay } from './lib/vip-order';
import type { RegistrationDrawerState, RegistrationSaved } from './components/registration-drawer';

/**
 * `/projects` — Projects (P22-T01, owner request "club the project
 * registration and all project page"). One page for the portfolio register and
 * Project Registration:
 *
 * - the list / cards of every project in the caller's hub scope, from
 *   `GET /dashboard/projects` (`dashboard` read, so Executive Viewers keep it),
 *   with every filter and the sort sent to the server (P23-T01: the Status
 *   filter offers `UI_PROJECT_STATUSES`, no In Buyoff / Draft; the Drafts chip
 *   is gone). The
 *   count is the served `total_count`; nothing is counted in the browser (I9);
 * - "Register project" and each row's "Edit registration" open the
 *   registration form in a side drawer (`registration-drawer.tsx`), shown only
 *   with Registration write; the server still decides every write;
 * - one Export menu with both old exports.
 *
 * - ADR 0040: a star before each name pins / unpins VIP
 *   (`PUT /projects/{id}/vip`, Registration write; the server decides). VIP
 *   projects are listed first, each group in the served order, and the "VIP"
 *   toggle narrows the served rows to `is_vip` (a missing `is_vip` is false).
 *
 * `/register` and `/register/:id` redirect here (`app/routes.tsx`);
 * `?edit=<id>` opens the drawer for that project (`use-edit-deep-link.ts`).
 */

const RegistrationDrawer = React.lazy(() => import('./components/registration-drawer'));

/** Deferred like the Dashboard register: the cards embed "Ask the agent". */
const ProjectsCardGrid = React.lazy(async () => ({
  default: (await import('./components/projects-card-grid')).ProjectsCardGrid,
}));

type View = 'list' | 'cards';
type Sort = 'name' | 'priority';

/** P31: category and type are NOT here — they are multi-select URL state
 *  (`?category=A%2B&category=B&type=NM`, `useCategoryTypeParams`). */
interface Filters {
  /** Multi-select (owner ask 2026-11-13): repeated params; empty = all. */
  status_: ProjectStatus[];
  priority: ProjectPriority[];
  leader: string[];
  step: string[];
}

const EMPTY_FILTERS: Filters = { status_: [], priority: [], leader: [], step: [] };

/** Server limit on `q` (API_CONTRACT_P13 §3). */
const SEARCH_MAX = 100;
/** How long a just-saved row stays highlighted. */
const HIGHLIGHT_MS = 12_000;

const SORT_LABELS: Record<Sort, string> = { name: 'Name (A–Z)', priority: 'Priority rank' };

/** ADR 0028: a leader with no served name stays selectable by an id suffix. */
function leaderOptionLabel(leader: { id: string; name: string | null }): string {
  return leader.name ?? `Leader (name unavailable) · ${leader.id.slice(-4)}`;
}

interface Highlight {
  id: string;
  name: string;
  mode: 'create' | 'edit';
}

export default function ProjectsPage(): React.JSX.Element {
  const queryClient = useQueryClient();
  const [filters, setFilters] = React.useState<Filters>(EMPTY_FILTERS);
  // `/dashboard/projects` is a Dashboard endpoint: `Unmapped` is accepted on both lists (P31).
  const chips = useCategoryTypeParams<TypeFilterValue, CategoryFilterValue>(TYPE_FILTER_VALUES, {
    withUnmappedCategory: true,
  });
  const categoryChips = useCategoryChipOptions(true);
  const [search, setSearch] = React.useState('');
  const [sort, setSort] = React.useState<Sort>('name');
  const [view, setView] = React.useState<View>('list');
  /** P24-T02: the optional read-only workbook columns (ADR 0035). */
  const [showCharter, setShowCharter] = React.useState(false);
  /** ADR 0040: show only VIP projects (narrows the served rows). */
  const [vipOnly, setVipOnly] = React.useState(false);
  const debouncedSearch = useDebouncedValue(search.trim(), 300);
  const { hubIds, regions, setHubIds, setHubId } = useHubFilter();
  const me = useSessionStore((st) => st.me);
  const hubsQuery = useHubs();

  const registration = usePermission('project_registration');
  const [writeForbidden, setWriteForbidden] = React.useState(false);
  const canWrite = registration.write && !writeForbidden;

  const [drawer, setDrawer] = React.useState<RegistrationDrawerState>(null);
  const [drawerLoaded, setDrawerLoaded] = React.useState(false);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const [highlight, setHighlight] = React.useState<Highlight | null>(null);
  const moveFlow = usePriorityMoveFlow();

  // Narrow screens: the select filters fold behind a "Filters" toggle so the
  // list is not pushed a full screen down; from `sm` up they are always shown.
  const [filtersOpen, setFiltersOpen] = React.useState(false);
  const filtersId = React.useId();
  const searchId = React.useId();
  const sortId = React.useId();
  const tabsId = React.useId();
  const panelId = `${tabsId}-panel`;
  const tabId = (v: View): string => `${tabsId}-tab-${v}`;

  const params = React.useMemo<ProjectFilterParams>(() => {
    const next: ProjectFilterParams = {
      hub_id: selectionParam(hubIds),
      category: selectionParam(chips.categories),
      status_: selectionParam(filters.status_),
      priority: selectionParam(filters.priority),
    };
    // Optional params only when set, so the unfiltered key matches the Dashboard's.
    if (regions.length > 0) next.region = regions;
    if (debouncedSearch) next.q = debouncedSearch.slice(0, SEARCH_MAX);
    if (chips.types.length > 0) next.type = chips.types;
    if (filters.leader.length > 0) next.leader_engineer_id = filters.leader;
    if (filters.step.length > 0) next.current_step = filters.step;
    if (sort !== 'name') next.sort = sort;
    return next;
  }, [filters, hubIds, regions, debouncedSearch, sort, chips.categories, chips.types]);

  const query = useDashboardProjects(params);
  const hubSelection = React.useMemo(() => ({ hubIds, regions }), [hubIds, regions]);
  const facets = useProjectFacets(hubSelection);

  // Every in-scope hub: hubs and countries are UNIONED server-side.
  const hubOptions = React.useMemo(() => {
    const inScope = hubsInScope(me, hubsQuery.data) ?? [];
    return inScope.map((h) => ({ value: h.id, label: hubPickerLabel(h, hubsQuery.data) }));
  }, [me, hubsQuery.data]);

  const hasLocalFilter =
    vipOnly ||
    debouncedSearch !== '' ||
    Object.values(filters).some((v) => v.length > 0) ||
    chips.categories.length > 0 ||
    chips.types.length > 0;
  const isFiltered = hasLocalFilter || hubIds.length > 0 || regions.length > 0;

  const set = (key: keyof Filters) => (next: string[]) => setFilters((prev) => ({ ...prev, [key]: next }));
  const clearChips = chips.clear;
  const clearLocal = (): void => {
    setFilters(EMPTY_FILTERS);
    setSearch('');
    setVipOnly(false);
    clearChips();
  };

  // ---- Drawer ------------------------------------------------------------

  const openDrawer = React.useCallback((next: RegistrationDrawerState, trigger: HTMLElement | null) => {
    triggerRef.current = trigger;
    setDrawerLoaded(true);
    setDrawer(next);
  }, []);

  const handleRegister = (event: React.MouseEvent<HTMLButtonElement>): void => {
    openDrawer({ mode: 'create' }, event.currentTarget);
  };

  const handleEdit = React.useCallback(
    (row: ProjectFilterRow, trigger: HTMLElement) => openDrawer({ mode: 'edit', projectId: row.project_id }, trigger),
    [openDrawer],
  );

  // P13 deep link, now `/projects?edit=<id>` (and `/register?edit=` via the redirect).
  useEditDeepLink(registration.write, (project) => openDrawer({ mode: 'edit', projectId: project.id }, null));

  const refreshList = React.useCallback(() => {
    // The register, its facets and every Dashboard figure read the project set.
    void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  }, [queryClient]);

  const handleDrawerClose = React.useCallback(
    (saved: RegistrationSaved | null) => {
      setDrawer(null);
      if (saved?.project) {
        setHighlight({ id: saved.project.id, name: saved.project.name, mode: saved.mode });
        refreshList();
      } else if (saved) {
        refreshList();
      }
    },
    [refreshList],
  );

  const handleForbidden = React.useCallback(() => {
    setWriteForbidden(true);
    setDrawer(null);
  }, []);

  React.useEffect(() => {
    if (highlight === null) return;
    const t = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [highlight]);

  const rows = React.useMemo(
    () => (query.data ? orderForDisplay(query.data.rows, vipOnly) : undefined),
    [query.data, vipOnly],
  );
  const highlightVisible = highlight !== null && rows !== undefined && rows.some((r) => r.project_id === highlight.id);

  // ---- P35-T08: per-user column layout ------------------------------------

  const columnPrefs = useColumnPrefs(me?.user_id);

  // ---- P35-T02: register Edit mode (D35-2) ---------------------------------

  const [editMode, setEditMode] = React.useState(false);
  const [drafts, setDrafts] = React.useState<RegisterDrafts>({});
  /** The row each draft was staged against, so a draft hidden by a filter
   *  change is still saved (and still counted). */
  const [draftRows, setDraftRows] = React.useState<Readonly<Record<string, ProjectFilterRow>>>({});
  const [rowErrors, setRowErrors] = React.useState<Readonly<Record<string, readonly RegisterEditError[]>>>({});
  const [forbiddenIds, setForbiddenIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const registerSave = useRegisterSave();

  const hubIdByName = React.useMemo(() => new Map((hubsQuery.data ?? []).map((h) => [h.name, h.id])), [hubsQuery.data]);

  /** The caller's role may write Registration and the row's hub is in their
   *  hub scope (the server still decides per row: a 403 names the rows). */
  const isWritable = React.useCallback(
    (row: ProjectFilterRow): boolean => {
      if (!canWrite || !me || forbiddenIds.has(row.project_id)) return false;
      const hub = hubIdByName.get(row.hub);
      if (hub === undefined) return false;
      return me.hub_scope_all || me.hub_ids.includes(hub);
    },
    [canWrite, me, forbiddenIds, hubIdByName],
  );

  // The design resource list per hub (`GET /engineers?hub_id=`: the server maps an
  // OEM hub to its capacity hub's engineers, ADR 0042), fetched only while editing.
  const editHubIds = React.useMemo(() => {
    if (!editMode || !rows) return [];
    const ids = new Set<string>();
    for (const r of rows) {
      const id = hubIdByName.get(r.hub);
      if (id !== undefined) ids.add(id);
    }
    return [...ids].sort();
  }, [editMode, rows, hubIdByName]);
  const engineerQueries = useQueries({
    queries: editHubIds.map((id) => ({
      queryKey: queryKeys.engineers(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchEngineerOptions(id, { signal }),
      staleTime: 60_000,
    })),
  });
  const engineersByHub = React.useMemo(() => {
    const out = new Map<string, { options: EngineerOption[] | undefined; loading: boolean }>();
    editHubIds.forEach((id, i) => {
      const q = engineerQueries[i];
      out.set(id, { options: q?.data, loading: q?.isPending ?? true });
    });
    return out;
  }, [editHubIds, engineerQueries]);
  const leaderOptions = React.useCallback(
    (row: ProjectFilterRow) => {
      const id = hubIdByName.get(row.hub);
      return (id !== undefined ? engineersByHub.get(id) : undefined) ?? { options: undefined, loading: true };
    },
    [engineersByHub, hubIdByName],
  );

  const rowById = React.useMemo(() => new Map((query.data?.rows ?? []).map((r) => [r.project_id, r])), [query.data]);
  /** Every row a draft points at: the served row if still listed, else the one staged against. */
  const draftBaseRows = React.useMemo(
    () =>
      Object.keys(drafts)
        .map((id) => rowById.get(id) ?? draftRows[id])
        .filter((r): r is ProjectFilterRow => r !== undefined),
    [drafts, rowById, draftRows],
  );
  const changedIds = React.useMemo(() => changedProjectIds(drafts, draftBaseRows), [drafts, draftBaseRows]);
  const unsavedEdits = editMode && changedIds.length > 0;

  const clearRowError = (id: string): void =>
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const onField = React.useCallback(
    <F extends EditableField>(row: ProjectFilterRow, field: F, value: RegisterValues[F]) => {
      setDrafts((d) => setDraftField(d, row, field, value));
      setDraftRows((r) => ({ ...r, [row.project_id]: row }));
      clearRowError(row.project_id);
    },
    [],
  );

  const leaveEditMode = React.useCallback(() => {
    setEditMode(false);
    setDrafts({});
    setDraftRows({});
    setRowErrors({});
    setSelected(new Set());
    setSaveError(null);
    setConfirmCancel(false);
  }, []);
  // A 403 for the whole batch (or a lost write permission) ends the session.
  if (editMode && !canWrite) leaveEditMode();

  const requestCancel = (): void => {
    if (changedIds.length > 0) setConfirmCancel(true);
    else leaveEditMode();
  };

  // ---- P35-T08: ticked rows and the bulk bar --------------------------------

  const shownWritable = React.useMemo(() => (rows ?? []).filter(isWritable), [rows, isWritable]);
  const tickedRows = React.useMemo(() => shownWritable.filter((r) => selected.has(r.project_id)), [shownWritable, selected]);
  const allSelected: boolean | 'indeterminate' =
    tickedRows.length === 0 ? false : tickedRows.length === shownWritable.length ? true : 'indeterminate';

  const onToggleSelect = React.useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const onToggleAll = React.useCallback(
    (on: boolean) => setSelected(on ? new Set(shownWritable.map((r) => r.project_id)) : new Set()),
    [shownWritable],
  );

  /** Engineers valid for every ticked row: the served list of their hub, or the
   *  engineers common to the served lists of several hubs. */
  const bulkLeaders = React.useMemo((): { options: EngineerOption[] | null; note: string | null } => {
    if (tickedRows.length === 0) return { options: null, note: null };
    const lists = [...new Set(tickedRows.map((r) => hubIdByName.get(r.hub)))].map((id) =>
      id === undefined ? undefined : engineersByHub.get(id),
    );
    if (lists.some((l) => l === undefined || l.loading || l.options === undefined)) {
      return { options: null, note: 'Loading the design resources…' };
    }
    const [first, ...rest] = lists.map((l) => l?.options ?? []);
    const common = (first ?? []).filter((e) => rest.every((list) => list.some((o) => o.id === e.id)));
    return common.length > 0
      ? { options: common, note: null }
      : { options: null, note: 'The ticked rows share no design resource: tick rows of one hub to set one.' };
  }, [tickedRows, engineersByHub, hubIdByName]);

  const applyBulk = React.useCallback(
    (patch: RegisterDraft) => {
      setDrafts((d) => setDraftBulk(d, tickedRows, patch));
      setDraftRows((r) => ({ ...r, ...Object.fromEntries(tickedRows.map((row) => [row.project_id, row])) }));
      setRowErrors((prev) => {
        const next = { ...prev };
        for (const row of tickedRows) delete next[row.project_id];
        return next;
      });
    },
    [tickedRows],
  );

  // ---- P35-T02: Save -------------------------------------------------------

  const tooMany =
    changedIds.length > REGISTER_EDITS_MAX
      ? `Save at most ${String(REGISTER_EDITS_MAX)} projects at a time (${formatInteger(changedIds.length)} changed). Undo some edits, save, then continue.`
      : null;

  const saveEdits = async (): Promise<void> => {
    const body = buildRegisterEditsBody(drafts, draftBaseRows);
    if (body.edits.length === 0 || body.edits.length > REGISTER_EDITS_MAX) return;
    setSaveError(null);
    const res = await registerSave.save(body);
    if (res.ok) {
      leaveEditMode();
      return;
    }
    if (res.forbidden) {
      setWriteForbidden(true);
      return;
    }
    const grouped: Record<string, RegisterEditError[]> = {};
    for (const e of res.rowErrors) (grouped[e.project_id] ??= []).push(e);
    setRowErrors(grouped);
    // Rows the server says the caller cannot write become read-only, and their
    // changes are dropped (they could never be saved); their error stays shown.
    const forbidden = res.rowErrors.filter((e) => e.code === 'FORBIDDEN_PROJECT').map((e) => e.project_id);
    if (forbidden.length > 0) {
      setForbiddenIds((prev) => new Set([...prev, ...forbidden]));
      setDrafts((d) => {
        const next = { ...d };
        for (const id of forbidden) delete next[id];
        return next;
      });
    }
    setSaveError(res.message);
  };

  const gridEdit = React.useMemo<RegisterGridEdit | undefined>(
    () =>
      editMode && canWrite
        ? {
            drafts,
            isWritable,
            onField,
            leaderOptions,
            rowErrors,
            selected,
            onToggleSelect,
            onToggleAll,
            allSelected,
          }
        : undefined,
    [editMode, canWrite, drafts, isWritable, onField, leaderOptions, rowErrors, selected, onToggleSelect, onToggleAll, allSelected],
  );

  // ---- Export ------------------------------------------------------------

  const exportSources = React.useMemo<ExportSource[]>(() => {
    const sources: ExportSource[] = [
      {
        id: 'projects',
        label: 'Projects list',
        hint: 'The rows shown here, with every filter and the sort.',
        path: '/exports/dashboard',
        filters: {
          hub_id: params.hub_id,
          region: params.region,
          category: params.category,
          status_: params.status_,
          priority: params.priority,
          q: params.q,
          type: params.type,
          leader_engineer_id: params.leader_engineer_id,
          current_step: params.current_step,
          sort: params.sort,
        },
        fallbackFilename: 'projects-export',
      },
    ];
    if (registration.read) {
      sources.push({
        id: 'registration',
        label: 'Registration register',
        hint: 'Every registration field, financials included where your role may see them. Filters: hub, search, category, type, status, priority.',
        path: '/exports/project-registration',
        filters: {
          hub_id: params.hub_id,
          q: params.q,
          status_: params.status_,
          priority: params.priority,
          // P31: `type` (repeated) on this endpoint too; `Unmapped` is a 422 there, so it is left out.
          category: selectionParam((params.category ?? []).filter((c) => c !== UNMAPPED_TYPE)),
          type: selectionParam((params.type ?? []).filter((t) => t !== UNMAPPED_TYPE)),
        },
        fallbackFilename: 'project-registration-export',
      });
    }
    return sources;
  }, [params, registration.read]);

  // ---- Render ------------------------------------------------------------

  return (
    <>
      <PageHeader
        title="Projects"
        description="Every project in your hub scope. Register new projects and edit their registration here."
        actions={
          <>
            {/* At 390 px the country buttons are wider than the page; scroll them. */}
            <div className="max-w-full overflow-x-auto scrollbar-thin">
              <CountrySegmented />
            </div>
            <HubFilterChip />
            {query.data && rows ? (
              <Badge tone="neutral" data-numeric="" data-testid="projects-total">
                {vipOnly
                  ? `${formatInteger(rows.length)} VIP of ${formatInteger(query.data.total_count)} projects`
                  : `${formatInteger(query.data.total_count)} ${query.data.total_count === 1 ? 'project' : 'projects'}`}
              </Badge>
            ) : null}
            <Tabs value={view} onValueChange={(v) => setView(v as View)}>
              <TabsList aria-label="View">
                <TabsTrigger value="list" id={tabId('list')} aria-controls={view === 'list' ? panelId : undefined}>
                  List
                </TabsTrigger>
                <TabsTrigger
                  value="cards"
                  id={tabId('cards')}
                  aria-controls={view === 'cards' ? panelId : undefined}
                  disabled={editMode}
                  title={editMode ? 'Save or cancel your edits to switch view' : undefined}
                >
                  Cards
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <ProjectsExportMenu sources={exportSources} />
            {canWrite ? (
              <Button type="button" size="sm" onClick={handleRegister}>
                <Plus aria-hidden="true" />
                Register project
              </Button>
            ) : null}
          </>
        }
      />

      <div className="mb-gutter flex flex-col gap-s3">
        <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter projects">
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
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="rounded-pill sm:hidden"
            aria-expanded={filtersOpen}
            aria-controls={filtersId}
            onClick={() => setFiltersOpen((o) => !o)}
          >
            <SlidersHorizontal aria-hidden="true" />
            Filters
          </Button>
          <div
            id={filtersId}
            className={cn('flex-wrap items-end gap-3 sm:contents', filtersOpen ? 'flex w-full' : 'hidden')}
          >
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
              onChange={set('status_')}
              options={UI_PROJECT_STATUSES.map((st) => ({ value: st, label: st }))}
            />
            <FilterSelect
              label="Priority"
              allLabel="All priorities"
              value={filters.priority}
              onChange={set('priority')}
              options={PROJECT_PRIORITIES.map((p) => ({ value: p, label: p }))}
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
            <div className="flex flex-col gap-1">
              <Label htmlFor={sortId} className="text-2xs text-text-muted">
                Sort
              </Label>
              <Select value={sort} onValueChange={(v) => setSort(v as Sort)}>
                <SelectTrigger id={sortId} className="h-8 w-40 rounded-pill">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(Object.keys(SORT_LABELS) as Sort[]).map((s) => (
                    <SelectItem key={s} value={s}>
                      {SORT_LABELS[s]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
          <Button
            type="button"
            variant={vipOnly ? 'primary' : 'secondary'}
            size="sm"
            className="rounded-pill"
            aria-pressed={vipOnly}
            onClick={() => setVipOnly((v) => !v)}
            title="Show only VIP projects"
            data-testid="vip-filter"
          >
            <Star aria-hidden="true" className={vipOnly ? 'fill-current' : undefined} />
            VIP
          </Button>
          {view === 'list' ? <CharterColumnsToggle pressed={showCharter} onPressedChange={setShowCharter} /> : null}
          {view === 'list' ? (
            <ColumnMenu
              columns={HIDEABLE_COLUMNS}
              hidden={columnPrefs.prefs.hidden}
              onToggle={columnPrefs.setVisible}
              onReset={columnPrefs.reset}
            />
          ) : null}
          {view === 'list' && canWrite && !editMode ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="rounded-pill"
              onClick={() => setEditMode(true)}
              title="Edit status, leader, actual dates and design / lab time in the list"
              data-testid="register-edit-start"
            >
              <PencilLine aria-hidden="true" />
              Edit
            </Button>
          ) : null}
          {hasLocalFilter ? (
            <Button type="button" variant="ghost" size="sm" onClick={clearLocal}>
              <FilterX aria-hidden="true" />
              Clear
            </Button>
          ) : null}
        </div>

        {/* P31: multi-select category / type "tabs" (URL state, sent as repeated params). */}
        <div className="flex flex-col gap-2" data-testid="projects-chip-filters">
          <MultiChipFilter
            label="Category"
            options={categoryChips}
            value={chips.categories}
            onChange={chips.setCategories}
            data-testid="projects-category-chips"
          />
          <MultiChipFilter
            label="Type"
            options={TYPE_CHIP_OPTIONS_WITH_UNMAPPED}
            value={chips.types}
            onChange={chips.setTypes}
            data-testid="projects-type-chips"
          />
        </div>

        <ReadOnlyNotice surface="project_registration" what="Registering or editing projects" />
        {writeForbidden ? <WriteForbiddenNotice /> : null}

        <div role="status" aria-live="polite" className="empty:hidden" data-testid="projects-saved-status">
          {highlight ? (
            <p className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/30 bg-primary-subtle px-3 py-2 text-2xs text-primary-subtle-fg">
              <span>
                {highlight.mode === 'create'
                  ? `Registered “${highlight.name}”.`
                  : `Saved the registration of “${highlight.name}”.`}
                {rows !== undefined && !highlightVisible ? ' It is not in the current filtered view.' : null}
              </span>
              {rows !== undefined && !highlightVisible && isFiltered ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-2xs"
                  onClick={() => {
                    clearLocal();
                    setHubId(null);
                  }}
                >
                  Clear filters
                </Button>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>

      <div id={panelId} role="tabpanel" aria-labelledby={tabId(view)}>
        {query.isPending ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-5/6" />
          </div>
        ) : query.isError ? (
          <ErrorState description="The project list could not be loaded." onRetry={() => void query.refetch()} />
        ) : rows === undefined || rows.length === 0 ? (
          <EmptyState
            title={isFiltered ? 'No projects match these filters' : 'No projects'}
            description={
              isFiltered
                ? 'Try widening or clearing the filters above.'
                : canWrite
                  ? 'Register the first project to get started.'
                  : 'There are no projects visible in your hub scope.'
            }
            action={
              canWrite && !isFiltered ? (
                <Button type="button" size="sm" onClick={handleRegister}>
                  <Plus aria-hidden="true" />
                  Register project
                </Button>
              ) : undefined
            }
          />
        ) : view === 'cards' ? (
          <React.Suspense fallback={<PanelSkeleton height="h-[28rem]" />}>
            <ProjectsCardGrid rows={rows} canPinVip={registration.write} />
          </React.Suspense>
        ) : (
          <>
            {gridEdit ? (
              <p className="mb-2 text-2xs font-semibold text-warning-subtle-fg" data-testid="register-edit-mode">
                Editing: change status, leader, actual dates and design / lab time; tick rows to edit several at once.
                Read-only rows are outside what you may edit.
              </p>
            ) : null}
            {gridEdit && tickedRows.length > 0 ? (
              <BulkEditBar
                selectedCount={tickedRows.length}
                draftCount={tickedRows.filter((r) => r.status === 'Draft').length}
                leaderOptions={bulkLeaders.options}
                leaderNote={bulkLeaders.note}
                onApply={applyBulk}
                onClearSelection={() => setSelected(new Set())}
              />
            ) : null}
            <ProjectsTable
              rows={rows}
              canPinVip={registration.write}
              canEdit={canWrite}
              onEdit={handleEdit}
              highlightId={highlight?.id ?? null}
              highlightLabel={highlight?.mode === 'create' ? 'New' : 'Updated'}
              showCharter={showCharter}
              edit={gridEdit}
              hiddenColumns={columnPrefs.prefs.hidden}
              columnWidths={columnPrefs.prefs.widths}
              onColumnWidth={columnPrefs.setWidth}
            />
          </>
        )}
        {gridEdit ? (
          <RegisterEditBar
            changedCount={changedIds.length}
            onSave={() => void saveEdits()}
            onCancel={requestCancel}
            saving={registerSave.saving}
            error={saveError}
            tooMany={tooMany}
          />
        ) : null}
      </div>

      {drawerLoaded ? (
        <React.Suspense fallback={null}>
          <RegistrationDrawer
            state={drawer}
            onClose={handleDrawerClose}
            hubs={hubsQuery.data ?? []}
            moveApi={moveFlow.api}
            onForbidden={handleForbidden}
            onSubmitted={refreshList}
            returnFocusTo={triggerRef}
          />
        </React.Suspense>
      ) : null}
      {moveFlow.element}
      <RegisterSavePanel
        flow={registerSave.flow}
        runState={registerSave.runState}
        changes={registerSave.changes}
        watchingFollowUp={registerSave.watchingFollowUp}
        onClose={registerSave.close}
      />
      <RegisterDiscardDialog
        open={confirmCancel}
        title="Discard your register edits?"
        description={`${formatInteger(changedIds.length)} ${changedIds.length === 1 ? 'project has' : 'projects have'} unsaved edits. Nothing has been saved.`}
        onKeep={() => setConfirmCancel(false)}
        onDiscard={leaveEditMode}
        testId="register-discard-dialog"
      />
      <RegisterLeaveGuard when={unsavedEdits} />
    </>
  );
}
