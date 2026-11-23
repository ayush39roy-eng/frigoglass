import * as React from 'react';
import { useQueries, useQueryClient } from '@tanstack/react-query';
import { FilterX, Plus, Search, SlidersHorizontal, Star } from 'lucide-react';
import { Link } from 'react-router-dom';

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
import { PriorityMoveContext } from '@/components/shared/priority-move/priority-move-context';
import { usePriorityMoveFlow } from '@/components/shared/priority-move/use-priority-move-flow';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { useHubs } from '@/lib/api/reference';
import { hubPickerLabel } from '@/lib/hub-labels';
import { formatInteger } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { captureBase, forgetBase, type BaseSnapshots } from '@/lib/api/edit-conflict';
import { editFreshness } from '@/lib/use-edit-freshness';
import { useEditSession } from '@/stores/edit-session';
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
  NOT_APPLICABLE_FILTER_VALUE,
  NOT_APPLICABLE_LABEL,
  PRIORITY_FILTER_VALUES,
  type PriorityFilterValue,
} from '@/lib/priority-applicability';
import { UI_PROJECT_STATUSES, type ProjectStatus } from '@/types/enums';

import { FilterSelect } from '@/surfaces/dashboard/components/project-breakdown';
import { useDashboardProjects, useProjectFacets } from '@/surfaces/dashboard/hooks/use-dashboard';
import type { ProjectFilterParams, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { fetchEngineerOptions, type EngineerOption } from '@/surfaces/registration/api/engineers-api';
import { fetchProject } from '@/surfaces/registration/api/registration-api';
import type { ProjectRead } from '@/surfaces/registration/api/types';
import { WriteForbiddenNotice } from '@/surfaces/registration/components/access-notice';
import { useEditDeepLink } from '@/surfaces/registration/hooks/use-edit-deep-link';

import {
  fetchRegisterSteps,
  REGISTER_EDITS_MAX,
  type RegisterEditError,
  type RegisterStepsResponse,
} from './api/register-edits';
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
  conflictBaseKeys,
  draftBaseKeys,
  registerSnapshotValues,
  stepBaseKey,
  withoutConflictFields,
  dropDraftExclusions,
  fieldChanged,
  setDraftBulk,
  toggleDraftExclusion,
  setDraftField,
  valuesFor,
  type EditableField,
  type RegisterDraft,
  type RegisterDrafts,
  type RegisterRow,
  type RegisterValues,
} from './lib/register-edit';
import { projectStepLock, servedLockReason } from './lib/register-popup';
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
 * - "Register project" opens the registration form in a side drawer
 *   (`registration-drawer.tsx`), shown only with Registration write; the
 *   server still decides every write;
 * - P44-T01 (owner 2026-11-18): each row's "Edit" edits THAT row in the list
 *   (the P35 cells plus hub, lab testing, current step and the priority's
 *   preview); "Done" leaves it with its draft kept; one Save bar saves every
 *   changed row in ONE `POST /projects/register-edits`. There is no toolbar
 *   Edit and the row no longer opens the drawer: the project folder's Edit
 *   keeps the full popup (step exclusions, identity fields, Draft submit);
 * - one Export menu with both old exports.
 *
 * - ADR 0040: a star before each name pins / unpins VIP
 *   (`PUT /projects/{id}/vip`, Registration write; the server decides). VIP
 *   projects are listed first, each group in the served order, and the "VIP"
 *   toggle narrows the served rows to `is_vip` (a missing `is_vip` is false).
 *
 * `/register` and `/register/:id` redirect here (`app/routes.tsx`);
 * `?edit=<id>` (P44-T01) opens that row in inline edit, scrolls to it and
 * focuses its first editable cell; a project not in the list shown (filters,
 * hub) or not editable here gets a note with a link to its project folder.
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
  priority: PriorityFilterValue[];
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

  /** Rows in inline edit (their "Edit" pressed, not yet "Done"). */
  const [editingIds, setEditingIds] = React.useState<ReadonlySet<string>>(() => new Set());
  const [drafts, setDrafts] = React.useState<RegisterDrafts>({});
  /** P47 (ADR 0059): the values each row's edit started from (`base`),
   *  captured per field the first time it is changed. */
  const [editBases, setEditBases] = React.useState<BaseSnapshots>({});
  // P47: refetch on focus and every 60 s, but never while a row is in edit,
  // holds a draft or the popup is open, so a refetch never replaces a draft's
  // served values.
  const editInProgress = editingIds.size > 0 || Object.keys(drafts).length > 0 || drawer !== null;
  const query = useDashboardProjects(params, editFreshness(editInProgress));
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

  // ---- P44-T01: per-row inline edit (P35-T02 cells, D35-2 save) ------------

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
  const hubById = React.useMemo(() => new Map((hubsQuery.data ?? []).map((h) => [h.id, h])), [hubsQuery.data]);
  const scopedHubs = React.useMemo(() => hubsInScope(me, hubsQuery.data) ?? [], [me, hubsQuery.data]);

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

  // The served reads a row in edit needs beyond the list row: the lab flag and
  // frozen (`GET /projects/{id}`) and the steps (current-step pick, chips),
  // also for rows holding a draft so its base stays known. The Steps column
  // shares the steps' cache entries.
  const detailIds = React.useMemo(
    () => [...new Set([...editingIds, ...Object.keys(drafts)])].sort(),
    [editingIds, drafts],
  );
  const stepIds = detailIds;
  const detailQueries = useQueries({
    queries: detailIds.map((id) => ({
      queryKey: queryKeys.project(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchProject(id, { signal }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const stepQueries = useQueries({
    queries: stepIds.map((id) => ({
      queryKey: queryKeys.projectRegisterSteps(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRegisterSteps(id, { signal }),
      retry: false,
      staleTime: 30_000,
    })),
  });
  const detailById = React.useMemo(() => {
    const out = new Map<string, ProjectRead>();
    detailIds.forEach((id, i) => {
      const data = detailQueries[i]?.data;
      if (data) out.set(id, data);
    });
    return out;
  }, [detailIds, detailQueries]);
  const stepsById = React.useMemo(() => {
    const out = new Map<string, { data: RegisterStepsResponse | undefined; pending: boolean; error: boolean }>();
    stepIds.forEach((id, i) => {
      const q = stepQueries[i];
      out.set(id, { data: q?.data, pending: q?.isPending ?? true, error: q?.isError ?? false });
    });
    return out;
  }, [stepIds, stepQueries]);

  /** The list row plus the served values it does not carry (null = unknown). */
  const enrich = React.useCallback(
    (row: ProjectFilterRow): RegisterRow => {
      const steps = stepsById.get(row.project_id)?.data?.steps;
      return {
        ...row,
        hub_id: hubIdByName.get(row.hub) ?? null,
        certification_testing_required: detailById.get(row.project_id)?.certification_testing_required ?? null,
        ...(steps
          ? {
              excluded: Object.fromEntries(steps.map((st) => [st.step_code, st.step_excluded])),
              step_order: steps.map((st) => st.step_code),
            }
          : {}),
      };
    },
    [hubIdByName, detailById, stepsById],
  );

  // The design resource list per hub (`GET /engineers?hub_id=`: the server maps an
  // OEM hub to its capacity hub's engineers, ADR 0042), fetched only for the hubs
  // of rows in edit, holding a draft or ticked (and a draft's new hub).
  const editHubIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const r of rows ?? []) {
      const id = r.project_id;
      if (!editingIds.has(id) && !(id in drafts) && !selected.has(id)) continue;
      const served = hubIdByName.get(r.hub);
      if (served !== undefined) ids.add(served);
      const drafted = drafts[id]?.hub_id;
      if (drafted) ids.add(drafted);
    }
    return [...ids].sort();
  }, [rows, editingIds, drafts, selected, hubIdByName]);
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
      // The leader list follows the row's draft hub (as the popup does).
      const id = drafts[row.project_id]?.hub_id ?? hubIdByName.get(row.hub);
      return (id !== undefined && id !== null ? engineersByHub.get(id) : undefined) ?? { options: undefined, loading: true };
    },
    [engineersByHub, hubIdByName, drafts],
  );

  const rowById = React.useMemo(() => new Map((query.data?.rows ?? []).map((r) => [r.project_id, r])), [query.data]);
  /** Every row a draft points at: the served row if still listed, else the one staged against. */
  const draftBaseRows = React.useMemo(
    () =>
      Object.keys(drafts)
        .map((id) => rowById.get(id) ?? draftRows[id])
        .filter((r): r is ProjectFilterRow => r !== undefined)
        .map(enrich),
    [drafts, rowById, draftRows, enrich],
  );
  const changedIds = React.useMemo(() => changedProjectIds(drafts, draftBaseRows), [drafts, draftBaseRows]);
  const changedSet = React.useMemo(() => new Set(changedIds), [changedIds]);
  /** Some row is in edit or holds unsaved changes. */
  const sessionActive = editingIds.size > 0 || changedIds.length > 0;
  // P49-R01 (ADR 0060 R1, W49-1a): inline edits and the open drawer hold an
  // auto reload (the "new version" bar shows instead of the browser's prompt).
  useEditSession(sessionActive || drawer !== null);
  const unsavedEdits = changedIds.length > 0;

  const clearRowError = (id: string): void =>
    setRowErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const onField = React.useCallback(
    <F extends EditableField>(row: ProjectFilterRow, field: F, value: RegisterValues[F]) => {
      const base = enrich(row);
      // P47: the value this field's edit started from (kept once captured).
      setEditBases((b) => captureBase(b, row.project_id, registerSnapshotValues(base), [field]));
      setDrafts((d) => {
        let next = setDraftField(d, base, field, value);
        if (field === 'hub_id') {
          // A hub of the other workflow re-points the steps on Save: a staged
          // current step and exclusions belong to the served workflow, so they
          // are dropped (the popup's rule).
          const served = base.hub_id ? hubById.get(base.hub_id) : undefined;
          const picked = typeof value === 'string' ? hubById.get(value) : undefined;
          if (served && picked && served.is_oem !== picked.is_oem) {
            next = setDraftField(next, base, 'current_step_code', base.current_step_code);
            next = dropDraftExclusions(next, base, null);
          }
        }
        if (field === 'certification_testing_required') {
          // The lab steps' N/A marks are re-decided by the server on Save.
          const labCodes = (stepsById.get(row.project_id)?.data?.steps ?? [])
            .filter((st) => st.kind === 'lab')
            .map((st) => st.step_code);
          next = dropDraftExclusions(next, base, labCodes);
        }
        return next;
      });
      setDraftRows((r) => ({ ...r, [row.project_id]: row }));
      clearRowError(row.project_id);
    },
    [enrich, hubById, stepsById],
  );

  const onToggleStep = React.useCallback(
    (row: ProjectFilterRow, stepCode: string) => {
      const base = enrich(row);
      if (base.excluded === undefined) return; // the served flags are not loaded yet
      setEditBases((b) => captureBase(b, row.project_id, registerSnapshotValues(base), [stepBaseKey(stepCode)]));
      setDrafts((d) => toggleDraftExclusion(d, base, stepCode));
      setDraftRows((r) => ({ ...r, [row.project_id]: row }));
      clearRowError(row.project_id);
    },
    [enrich],
  );

  const leaveEditMode = React.useCallback(() => {
    setEditingIds(new Set());
    setDrafts({});
    setEditBases({});
    setDraftRows({});
    setRowErrors({});
    setSelected(new Set());
    setSaveError(null);
    setConfirmCancel(false);
  }, []);
  // A 403 for the whole batch (or a lost write permission) ends the session.
  if (!canWrite && (editingIds.size > 0 || Object.keys(drafts).length > 0)) leaveEditMode();

  const requestCancel = (): void => {
    if (changedIds.length > 0) setConfirmCancel(true);
    else leaveEditMode();
  };

  const onToggleEdit = React.useCallback((row: ProjectFilterRow, on: boolean) => {
    setEditingIds((prev) => {
      const next = new Set(prev);
      if (on) next.add(row.project_id);
      else next.delete(row.project_id);
      return next;
    });
  }, []);

  // ---- P44-T01: `?edit=<id>` opens that row in inline edit and scrolls to it --

  const [deepLink, setDeepLink] = React.useState<{ id: string; name: string } | null>(null);
  const [deepLinkMiss, setDeepLinkMiss] = React.useState<{ id: string; name: string } | null>(null);
  const [focusRequest, setFocusRequest] = React.useState<{ id: string; nonce: number } | null>(null);
  useEditDeepLink(registration.write, (project) => setDeepLink({ id: project.id, name: project.name }));
  // Resolved during render once the list, the hubs and the session are known.
  if (deepLink !== null && rows !== undefined && hubsQuery.data !== undefined && me) {
    const target = rows.find((r) => r.project_id === deepLink.id);
    setDeepLink(null);
    if (target && isWritable(target)) {
      setEditingIds((prev) => new Set([...prev, target.project_id]));
      setFocusRequest((prev) => ({ id: target.project_id, nonce: (prev?.nonce ?? 0) + 1 }));
      setDeepLinkMiss(null);
    } else {
      // Not in the list shown (filters, hub) or not editable here: the folder.
      setDeepLinkMiss(deepLink);
    }
  }

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
      setEditBases((b) =>
        tickedRows.reduce(
          (acc, row) => captureBase(acc, row.project_id, registerSnapshotValues(enrich(row)), draftBaseKeys(patch)),
          b,
        ),
      );
      setDrafts((d) => setDraftBulk(d, tickedRows.map(enrich), patch));
      setDraftRows((r) => ({ ...r, ...Object.fromEntries(tickedRows.map((row) => [row.project_id, row])) }));
      setRowErrors((prev) => {
        const next = { ...prev };
        for (const row of tickedRows) delete next[row.project_id];
        return next;
      });
    },
    [tickedRows, enrich],
  );

  // ---- P35-T02: Save -------------------------------------------------------

  const tooMany =
    changedIds.length > REGISTER_EDITS_MAX
      ? `Save at most ${String(REGISTER_EDITS_MAX)} projects at a time (${formatInteger(changedIds.length)} changed). Undo some edits, save, then continue.`
      : null;

  const saveEdits = async (): Promise<void> => {
    const body = buildRegisterEditsBody(drafts, draftBaseRows, editBases);
    if (body.edits.length === 0 || body.edits.length > REGISTER_EDITS_MAX) return;
    setSaveError(null);
    const res = await registerSave.save(body);
    if (res.ok) {
      leaveEditMode();
      return;
    }
    if (res.conflictChoice === 'theirs') {
      // P47 (ADR 0059 C2): drop my value for the conflicting fields only; every
      // other edit stays in the buffer, unsaved, and the forgotten bases are
      // re-captured from the reloaded rows on the next edit.
      const byId = new Map<string, string[]>();
      for (const c of res.conflicts) byId.set(c.id, [...(byId.get(c.id) ?? []), c.field]);
      setEditBases((b) => {
        let next = b;
        for (const [id, fields] of byId) next = forgetBase(next, id, conflictBaseKeys(fields, drafts[id]));
        return next;
      });
      setDrafts((d) => {
        const next: Record<string, RegisterDraft> = { ...d };
        for (const [id, fields] of byId) {
          const draft = next[id];
          if (!draft) continue;
          const kept = withoutConflictFields(draft, fields);
          if (Object.keys(kept).length > 0) next[id] = kept;
          else delete next[id];
        }
        return next;
      });
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

  const gridEdit = React.useMemo<RegisterGridEdit | undefined>(() => {
    if (!canWrite) return undefined;
    const allHubs = hubsQuery.data ?? [];
    return {
      active: sessionActive,
      isWritable,
      isEditing: (row) => editingIds.has(row.project_id),
      hasDraft: (row) => changedSet.has(row.project_id),
      onToggleEdit,
      values: (row) => valuesFor(drafts, enrich(row)),
      changed: (row, field) => fieldChanged(drafts, enrich(row), field),
      onField,
      leaderOptions,
      hubs: scopedHubs,
      allHubs,
      extras: (row) => {
        const base = enrich(row);
        const detail = detailById.get(row.project_id);
        const steps = stepsById.get(row.project_id);
        const draftHub = drafts[row.project_id]?.hub_id;
        const served = base.hub_id ? hubById.get(base.hub_id) : undefined;
        const picked = draftHub ? hubById.get(draftHub) : undefined;
        return {
          certification: base.certification_testing_required ?? null,
          frozen: detail?.frozen ?? false,
          steps: steps?.data?.steps,
          stepsPending: steps?.pending ?? true,
          stepsError: steps?.error ?? false,
          workflowChange: served !== undefined && picked !== undefined && served.is_oem !== picked.is_oem,
        };
      },
      draftExclusions: (row) => drafts[row.project_id]?.excluded ?? {},
      onToggleStep,
      // The popup chips' locks (register-popup-section.tsx): served N/A / Done /
      // frozen / closed / not excludable, then a pending workflow or lab change.
      stepLock: (row, step) => {
        const detail = detailById.get(row.project_id);
        if (!detail) return 'loading';
        const served = step.step_excluded;
        let reason = servedLockReason(step, served, projectStepLock(detail));
        const draftHub = drafts[row.project_id]?.hub_id;
        const servedHub = hubById.get(detail.hub_id);
        const pickedHub = draftHub ? hubById.get(draftHub) : undefined;
        if (reason === null && servedHub && pickedHub && servedHub.is_oem !== pickedHub.is_oem) {
          reason = 'the new hub uses another workflow';
        }
        if (reason === null && step.kind === 'lab' && fieldChanged(drafts, enrich(row), 'certification_testing_required')) {
          reason = 'lab testing change not saved yet';
        }
        return reason;
      },
      rowErrors,
      selected,
      onToggleSelect,
      onToggleAll,
      allSelected,
    };
  }, [
    onToggleStep,
    canWrite,
    hubsQuery.data,
    sessionActive,
    isWritable,
    editingIds,
    changedSet,
    onToggleEdit,
    drafts,
    enrich,
    onField,
    leaderOptions,
    scopedHubs,
    detailById,
    stepsById,
    hubById,
    rowErrors,
    selected,
    onToggleSelect,
    onToggleAll,
    allSelected,
  ]);

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
        description="Every project in your hub scope. Register new projects here; a row's Edit edits it in the list."
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
                  disabled={sessionActive}
                  title={sessionActive ? 'Save or cancel your edits to switch view' : undefined}
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
              options={PRIORITY_FILTER_VALUES.map((p) => ({ value: p, label: p === NOT_APPLICABLE_FILTER_VALUE ? NOT_APPLICABLE_LABEL : p }))}
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
        {deepLinkMiss ? (
          <p
            role="status"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-2xs text-text"
            data-testid="deep-link-miss"
          >
            <span>{`“${deepLinkMiss.name}” is not in the list shown here, so it cannot be edited in the list.`}</span>
            <Link
              to={`/projects/${deepLinkMiss.id}`}
              className="font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Open its project folder
            </Link>
            <Button type="button" variant="ghost" size="sm" className="h-6 px-2 text-2xs" onClick={() => setDeepLinkMiss(null)}>
              Dismiss
            </Button>
          </p>
        ) : null}
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
            {gridEdit && sessionActive ? (
              <p className="mb-2 text-2xs font-semibold text-warning-subtle-fg" data-testid="register-edit-mode">
                {editingIds.size > 0
                  ? `Editing ${formatInteger(editingIds.size)} ${editingIds.size === 1 ? 'row' : 'rows'}: status, hub, leader, actual dates, design / lab time, lab testing and current step. `
                  : ''}
                Done keeps a row&apos;s changes until Save; tick rows to set a value on several at once. Step exclusions
                and the other registration fields are in each project&apos;s folder.
              </p>
            ) : null}
            {gridEdit && sessionActive && tickedRows.length > 0 ? (
              <BulkEditBar
                selectedCount={tickedRows.length}
                draftCount={tickedRows.filter((r) => r.status === 'Draft').length}
                leaderOptions={bulkLeaders.options}
                leaderNote={bulkLeaders.note}
                onApply={applyBulk}
                onClearSelection={() => setSelected(new Set())}
              />
            ) : null}
            {/* A row in edit moves its priority through the page's preview dialog (ADR 0026). */}
            <PriorityMoveContext.Provider value={moveFlow.api}>
              <ProjectsTable
                rows={rows}
                canPinVip={registration.write}
                canEdit={canWrite}
                highlightId={highlight?.id ?? null}
                highlightLabel={highlight?.mode === 'create' ? 'New' : 'Updated'}
                showCharter={showCharter}
                edit={gridEdit}
                canReadSteps={registration.read}
                focusRequest={focusRequest}
                hiddenColumns={columnPrefs.prefs.hidden}
                columnWidths={columnPrefs.prefs.widths}
                onColumnWidth={columnPrefs.setWidth}
              />
            </PriorityMoveContext.Provider>
          </>
        )}
        {gridEdit && sessionActive ? (
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
            registerSave={registerSave.save}
            row={drawer?.mode === 'edit' ? rowById.get(drawer.projectId) : undefined}
          />
        </React.Suspense>
      ) : null}
      {moveFlow.element}
      {registerSave.conflictDialog}
      <RegisterSavePanel
        flow={registerSave.flow}
        runState={registerSave.runState}
        changes={registerSave.changes}
        watchingFollowUp={registerSave.watchingFollowUp}
        onClose={registerSave.close}
        effChanges={registerSave.effChanges}
        projectName={(id) => rowById.get(id)?.project_name}
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
