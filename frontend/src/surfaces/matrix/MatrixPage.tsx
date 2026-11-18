import * as React from 'react';
import { ArrowUpFromLine, PencilLine, RotateCcw, Star, TableProperties } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useStore } from 'zustand';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PriorityMoveProvider } from '@/components/shared/priority-move/priority-move-provider';
import { PriorityBoardView, type SharedBoardFilters } from '@/surfaces/priority-board/PriorityBoardPage';
import { BOARD_LAYOUT_PARAM } from '@/surfaces/priority-board/lib/board-layout';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { ApiError } from '@/lib/api/client';
import { CONFLICT_COPY, editConflicts } from '@/lib/api/edit-conflict';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { editFreshness } from '@/lib/use-edit-freshness';
import { useAnyEditInProgress, useEditSession } from '@/stores/edit-session';
import { useHubFilter } from '@/stores/hub-filter';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';
import { formatInteger } from '@/lib/format';
import { SURFACES } from '@/app/nav';
import { effectivePendingEdits, useScenarioStore } from '@/stores/scenario';
import { usePermission, useSessionStore } from '@/stores/session';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import {
  useCategoryChipOptions,
  selectionParam,
  TYPE_CHIP_OPTIONS,
  useCategoryTypeParams,
} from '@/lib/multi-select-filter';
import type { HardGateReason, ProjectCategory, ProjectType } from '@/types/enums';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { FxRateEditor } from './components/fx-rate-editor';
import { ChipFilter, TextFilterInput } from './components/matrix-toolbar';
import { MatrixCurrencyControl } from './components/matrix-currency-control';
import { MatrixViewPanel } from './components/matrix-view-panel';
import { ScoreChartsRow } from './components/score-charts';
import { CompareBar, CompareDialog } from './components/compare-dialog';
import {
  DEFAULT_MATRIX_VIEW,
  STATUS_CHIPS,
  activeFilterCount,
  canEditFxRate,
  isDefaultView,
  type MatrixViewState,
} from './lib/matrix-view';
import { useCompareSelection } from './lib/compare-selection';
import { distributionFromRows, narrowByBand, narrowExceptBand, sortMatrixRows } from './lib/matrix-rows';
import {
  applyTheirScores,
  buildGridApplyBody,
  changedProjectIds,
  setDraftGate,
  setDraftScore,
  type GridDraft,
  type GridDrafts,
} from './lib/grid-edit';
import { createTextFilterStore, TextFilterContext, type TextFilterField } from './lib/text-filters';
import { keepMineScoreBase, theirScoreValues } from './lib/score-base';
import { useGridMaxHeight, useSpaceBelow, useStuck } from './lib/use-stuck';
import { NARROW_QUERY, useMediaQuery } from './lib/use-media-query';
import { MatrixTable, type MatrixGridEdit } from './components/matrix-table';
import { GridEditBar, GridLeaveGuard } from './components/grid-edit-bar';
import { DiscardDialog } from './components/scoring-rubric-panel';
import { ScenarioModeToggle, ScenarioPendingPanel } from './components/scenario-panel';
import { FetchedScoringModelProvider, ScoringTotalLine } from './scoring-model';
import { ScoringRubricPanel } from './components/scoring-rubric-panel';
import { liveRequestValuesFromRow, rowWithStaged } from './components/score-edit-schema';
import { VersionHistoryDialog } from './components/version-history-panel';
import { useApplyScenario, useMatrixCurrencies, usePriorityMatrix, usePrioritySummary } from './hooks/use-matrix';
import type { DimensionScoreValue, MatrixCurrencyCode, PriorityMatrixRow } from './api/types';

const MATRIX_SURFACE = SURFACES.find((s) => s.path === '/matrix');
const SEARCH_MAX_LENGTH = 100;

/** P34-T02: the grid reserves this much more below it while the edit bar is shown. */
const EDIT_BAR_RESERVE = 64;

/** P34-T02: a failed grid save, in words. */
function saveErrorText(err: unknown): string {
  if (err instanceof ApiError && err.code === 'UNKNOWN_DIMENSION_KEY') {
    return 'The scoring rubric changed while you were editing: a dimension you changed is no longer active. Cancel and edit again.';
  }
  if (err instanceof ApiError && err.detail) return err.detail;
  return 'The scores could not be saved. Your edits are kept; please try again.';
}

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

/**
 * P21-T05: a grid-only View panel control (currency, FX rate, Detailed view,
 * Download). On the board tab it keeps its place but is hidden
 * (`visibility: hidden`: not shown, not focusable, not announced), so the
 * sticky panel keeps its height and nothing jumps when switching tabs. In the
 * narrow bottom sheet it is simply left out.
 */
function GridOnly({
  onBoard,
  narrow,
  compact,
  children,
}: {
  onBoard: boolean;
  narrow: boolean;
  compact: boolean;
  children: React.ReactNode;
}): React.JSX.Element | null {
  if (!onBoard) return <>{children}</>;
  // Narrow sheet, or the one-line stuck panel: left out, so the board toolbar fits on that line.
  if (narrow || compact) return null;
  return (
    <div className="contents [&>*]:invisible" data-grid-only="hidden">
      {children}
    </div>
  );
}

/** P21-T05: the two views of the page, reflected in `?view=` (grid is the default, no param). */
export type MatrixTab = 'grid' | 'board';
export const MATRIX_VIEW_PARAM = 'view';

function useMatrixTab(): [MatrixTab, (next: string) => void] {
  const [params, setParams] = useSearchParams();
  const tab: MatrixTab = params.get(MATRIX_VIEW_PARAM) === 'board' ? 'board' : 'grid';
  const setTab = React.useCallback(
    (next: string) => {
      setParams(
        (prev) => {
          const out = new URLSearchParams(prev);
          if (next === 'board') out.set(MATRIX_VIEW_PARAM, 'board');
          else {
            out.delete(MATRIX_VIEW_PARAM);
            // The board's `layout` means nothing on the grid; the board restores it from storage.
            out.delete(BOARD_LAYOUT_PARAM);
          }
          return out;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  return [tab, setTab];
}

/**
 * `/matrix`: the Prioritization Matrix with two tabs (P21-T05) — "Scoring grid"
 * (grid, charts, compare) and "Priority board" (the P12 Kanban, moved here from
 * `/priority-board`, which redirects to `?view=board`). The sticky View panel's
 * Category / Type / Status filters, the project search and the global hub /
 * country filter apply to both; currency, charts and compare are grid-only.
 * The move-flow host wraps both tabs so a running recalculation survives a
 * tab switch.
 */
export default function MatrixPage(): React.JSX.Element {
  return (
    <PriorityMoveProvider>
      <MatrixSurface />
    </PriorityMoveProvider>
  );
}

function MatrixSurface(): React.JSX.Element {
  const [tab, setTab] = useMatrixTab();
  const onBoard = tab === 'board';
  const [currency, setCurrency] = React.useState<MatrixCurrencyCode>('EUR');
  // P12 (ADR 0020): the hub is the global header filter (was a local select).
  const { hubId, region } = useHubFilter();
  const [localView, setView] = React.useState<MatrixViewState>(DEFAULT_MATRIX_VIEW);
  // P34-T02 (D34-3): Project search, Hub and Leader text live in a per-page store;
  // the inputs subscribe to it, so typing never rebuilds the grid columns.
  const [textStore] = React.useState(createTextFilterStore);
  const q = useStore(textStore, (st) => st.q);
  const hubText = useStore(textStore, (st) => st.hubText);
  const leaderText = useStore(textStore, (st) => st.leaderText);
  // P31: Category / Type are multi-select URL state (`?category=A%2B&type=NM`,
  // old single-value links still parse), shared by the grid and the board.
  const chips = useCategoryTypeParams();
  const categoryChips = useCategoryChipOptions();
  const view = React.useMemo<MatrixViewState>(
    () => ({ ...localView, category: chips.categories, type: chips.types, q, hubText, leaderText }),
    [localView, chips.categories, chips.types, q, hubText, leaderText],
  );
  // The filter pipeline reads deferred text, so the inputs stay instant.
  const deferredQ = React.useDeferredValue(q);
  const deferredHub = React.useDeferredValue(hubText);
  const deferredLeader = React.useDeferredValue(leaderText);
  const { setCategories, setTypes, clear: clearChips } = chips;
  const setViewField = React.useCallback(
    <K extends keyof MatrixViewState>(key: K, value: MatrixViewState[K]) => {
      if (key === 'category') setCategories(value as ProjectCategory[]);
      else if (key === 'type') setTypes(value as ProjectType[]);
      else if (key === 'q' || key === 'hubText' || key === 'leaderText') {
        textStore.getState().set(key as TextFilterField, value as string);
      } else setView((v) => ({ ...v, [key]: value }));
    },
    [setCategories, setTypes, textStore],
  );
  const isAdmin = canEditFxRate(useSessionStore((s) => s.me?.roles));
  const [writeForbidden, setWriteForbidden] = React.useState(false);

  const currenciesQuery = useMatrixCurrencies();
  const currencies = currenciesQuery.data;
  const selectedRate = currencies?.find((c) => c.currency_code === currency)?.rate_to_eur ?? null;
  const summaryQuery = usePrioritySummary(hubId, region);
  // D34-3: the project search is no longer a server param (it runs over the loaded rows).
  // P47 (ADR 0059): refetch on focus and every 60 s while nobody edits.
  const editInProgress = useAnyEditInProgress();
  const matrixQuery = usePriorityMatrix(
    {
      currency,
      hubId: hubId ?? undefined,
      region: region ?? undefined,
      category: selectionParam(view.category),
      type: selectionParam(view.type),
      status: view.status ?? undefined,
    },
    editFreshness(editInProgress),
  );

  // P21 §1: a currency whose rate was removed meanwhile answers 422
  // CURRENCY_NOT_CONFIGURED. Fall back to EUR, say why, and re-read the list.
  const [unconfigured, setUnconfigured] = React.useState<MatrixCurrencyCode | null>(null);
  const matrixError = matrixQuery.error;
  if (matrixError instanceof ApiError && matrixError.code === 'CURRENCY_NOT_CONFIGURED' && currency !== 'EUR') {
    // Adjusting state while rendering (React's documented pattern): converges on EUR.
    setUnconfigured(currency);
    setCurrency('EUR');
  }
  const refetchCurrencies = currenciesQuery.refetch;
  React.useEffect(() => {
    if (unconfigured !== null) void refetchCurrencies();
  }, [unconfigured, refetchCurrencies]);

  // P21 sticky View panel + layout.
  const narrow = useMediaQuery(NARROW_QUERY);
  const sentinelRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLElement>(null);
  const stuck = useStuck(sentinelRef);

  // P21 Compare selection (session-persisted, survives filters).
  const compareItems = useCompareSelection((s) => s.items);
  const toggleCompare = useCompareSelection((s) => s.toggle);
  const selectedIds = React.useMemo(() => new Set(compareItems.map((i) => i.id)), [compareItems]);
  const onToggleSelect = React.useCallback(
    (row: PriorityMatrixRow) => toggleCompare({ id: row.project_id, name: row.project_name, hub: row.hub }),
    [toggleCompare],
  );
  const [compareOpen, setCompareOpen] = React.useState(false);

  // P34-T02 (D34-1): inline edit mode.
  const [editMode, setEditMode] = React.useState(false);
  const [drafts, setDrafts] = React.useState<GridDrafts>({});
  /** P47 (ADR 0059): each project's values when its first cell was edited (`base`). */
  const [gridReads, setGridReads] = React.useState<Readonly<Record<string, GridDraft>>>({});
  useEditSession(editMode);
  const conflict = useEditConflict();
  const askConflict = conflict.ask;
  const queryClient = useQueryClient();
  const [editNotes, setEditNotes] = React.useState('');
  const [saveError, setSaveError] = React.useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = React.useState(false);
  const [savedNotice, setSavedNotice] = React.useState<string | null>(null);
  const applyMutation = useApplyScenario();

  // Below the grid: card padding + page gutter (+ the Compare bar, + the edit bar when shown).
  const gridMaxHeight = useGridMaxHeight(
    sentinelRef,
    panelRef,
    stuck,
    (compareItems.length > 0 ? 176 : 112) + (editMode ? EDIT_BAR_RESERVE : 0),
  );
  // P21-T05 fix: the board uses the same offset as the grid, so once scrolled to, its column
  // headers sit below the stuck View panel; the columns scroll inside that height.
  // The reserve is the measured space below the board, so at the bottom of the page the
  // board's top meets the stuck panel's bottom exactly: nothing above it (the hub load strip)
  // is left as a cut-off sliver between them.
  const boardWrapRef = React.useRef<HTMLDivElement>(null);
  const boardBelow = useSpaceBelow(boardWrapRef, onBoard);
  const boardHeight = useGridMaxHeight(sentinelRef, panelRef, stuck, boardBelow);

  // Scenario mode (P5-T01): while `active`, grid edits stage into the scenario
  // store instead of being applied.
  const scenarioActive = useScenarioStore((s) => s.active);
  const scenarioPending = useScenarioStore((s) => s.pending);
  const stageScenarioEdit = useScenarioStore((s) => s.stageEdit);
  const scenarioStagedProjectIds = React.useMemo(
    () => new Set(effectivePendingEdits(scenarioPending).map((e) => e.projectId)),
    [scenarioPending],
  );

  // Versions & History (P5-T03) display-only lookup — built from the grid's
  // own already-fetched rows, never an independent fetch. A version's change
  // may reference a project outside the current hub/category filter (or
  // outside the caller's scope entirely); the history panel falls back to
  // the raw project id in that case.
  const projectLookup = React.useMemo(() => {
    const lookup: Record<string, { name: string; hub: string } | undefined> = {};
    for (const row of matrixQuery.data ?? []) {
      lookup[row.project_id] = { name: row.project_name, hub: row.hub };
    }
    return lookup;
  }, [matrixQuery.data]);
  // P34 (D34-4): the "changed" marker opens Version history at its version.
  const [history, setHistory] = React.useState<{ open: boolean; version: number | null }>({ open: false, version: null });
  const openVersion = React.useCallback((version: number) => setHistory({ open: true, version }), []);
  const onHistoryOpenChange = React.useCallback(
    (open: boolean) => setHistory((h) => (open ? { open: true, version: h.version } : { open: false, version: null })),
    [],
  );

  // D34-2 / D34-3: the row pipeline over the served rows, memoised, sorted once.
  const served = matrixQuery.data;
  const capacityFillOnly = view.capacityFill;
  const vipOnly = view.vipOnly;
  const exceptBand = React.useMemo(
    () =>
      served
        ? narrowExceptBand(served, {
            q: deferredQ,
            hubText: deferredHub,
            leaderText: deferredLeader,
            capacityFill: capacityFillOnly,
            vipOnly,
          })
        : [],
    [served, deferredQ, deferredHub, deferredLeader, capacityFillOnly, vipOnly],
  );
  const shownDistribution = React.useMemo(() => distributionFromRows(exceptBand), [exceptBand]);
  const band = view.band;
  const gridRows = React.useMemo(() => sortMatrixRows(narrowByBand(exceptBand, band)), [exceptBand, band]);

  const title = MATRIX_SURFACE?.title ?? 'Prioritization Matrix';
  const description =
    MATRIX_SURFACE?.summary ??
    'Scoring dimensions per project (the editable rubric), weighted score and band, with a server-driven currency toggle.';

  const denied = authKind([matrixQuery.error, summaryQuery.error]);
  const setSearch = React.useCallback((next: string) => textStore.getState().set('q', next), [textStore]);
  const sharedBoardFilters = React.useMemo<SharedBoardFilters>(
    () => ({ category: view.category, type: view.type, status: view.status, search: q, onSearchChange: setSearch }),
    [view.category, view.type, view.status, q, setSearch],
  );
  // On the board only the shared filters count (the band and the Hub / Leader text narrow the grid only).
  const sharedFilterCount =
    (view.category.length > 0 ? 1 : 0) +
    (view.type.length > 0 ? 1 : 0) +
    (view.status !== null ? 1 : 0) +
    (q.trim() !== '' ? 1 : 0);
  const panelFilterCount = onBoard ? sharedFilterCount : activeFilterCount(view);
  // P21-T05 fix: the board's toolbar lives in the View panel on wide screens.
  const [boardToolbarSlot, setBoardToolbarSlot] = React.useState<HTMLDivElement | null>(null);
  const isFiltered =
    hubId !== null ||
    region !== null ||
    view.category.length > 0 ||
    view.type.length > 0 ||
    view.status !== null ||
    view.band !== null ||
    view.capacityFill ||
    view.vipOnly ||
    q.trim() !== '' ||
    hubText.trim() !== '' ||
    leaderText.trim() !== '';

  // Stable elements: each input reads its own field from the text store.
  const columnFilters = React.useMemo(
    () => ({
      project: <TextFilterInput field="q" column="project name or code" placeholder="Search…" maxLength={SEARCH_MAX_LENGTH} />,
      hub: <TextFilterInput field="hubText" column="hub" />,
      leader: <TextFilterInput field="leaderText" column="leader" />,
    }),
    [],
  );

  const resetView = React.useCallback(() => {
    setView(DEFAULT_MATRIX_VIEW);
    textStore.getState().reset();
    clearChips();
    setCurrency('EUR');
  }, [clearChips, textStore]);
  // Session table first (ADR 0010), server 403 second.
  const permission = usePermission('matrix');
  const canEdit = permission.write && !writeForbidden;
  // `PUT /projects/{id}/vip` is a Project Registration write; the server still decides per project.
  const canPinVip = usePermission('project_registration').write;

  // --- P34-T02 edit mode --------------------------------------------------------
  // The base a draft is compared to: the served row, or in scenario mode the row
  // with its staged edit applied (re-editing continues from the staged value).
  const baseRow = React.useCallback(
    (row: PriorityMatrixRow): PriorityMatrixRow => {
      const staged = scenarioActive ? scenarioPending[row.project_id] : undefined;
      return staged ? rowWithStaged(row, staged.next) : row;
    },
    [scenarioActive, scenarioPending],
  );
  const captureRead = React.useCallback(
    (row: PriorityMatrixRow) =>
      // The SERVED row, never the scenario-staged one (P47 gate advisory A4).
      setGridReads((r) => (r[row.project_id] ? r : { ...r, [row.project_id]: liveRequestValuesFromRow(row) })),
    [],
  );
  const onScore = React.useCallback(
    (row: PriorityMatrixRow, key: string, value: DimensionScoreValue) => {
      captureRead(row);
      setDrafts((d) => setDraftScore(d, baseRow(row), key, value));
    },
    [baseRow, captureRead],
  );
  const onGate = React.useCallback(
    (row: PriorityMatrixRow, gate: HardGateReason, on: boolean) => {
      captureRead(row);
      setDrafts((d) => setDraftGate(d, baseRow(row), gate, on));
    },
    [baseRow, captureRead],
  );
  const gridEdit = React.useMemo<MatrixGridEdit | undefined>(
    () => (editMode && canEdit ? { drafts, baseRow, onScore, onGate } : undefined),
    [editMode, canEdit, drafts, baseRow, onScore, onGate],
  );
  const changedIds = React.useMemo(
    () => changedProjectIds(drafts, (served ?? []).map(baseRow)),
    [drafts, served, baseRow],
  );
  const unsavedEdits = editMode && changedIds.length > 0;

  const leaveEditMode = React.useCallback(() => {
    setEditMode(false);
    setDrafts({});
    setGridReads({});
    setEditNotes('');
    setSaveError(null);
    setConfirmCancel(false);
  }, []);
  // A 403 elsewhere (or a lost write permission) ends the edit session.
  if (editMode && !canEdit) leaveEditMode();

  const startEditMode = React.useCallback(() => {
    setSavedNotice(null);
    setEditMode(true);
  }, []);
  const requestCancel = React.useCallback(() => {
    if (changedIds.length > 0) setConfirmCancel(true);
    else leaveEditMode();
  }, [changedIds.length, leaveEditMode]);

  const saveEdits = React.useCallback(async () => {
    const live = served ?? [];
    setSaveError(null);
    if (scenarioActive) {
      // Stage each changed project (same as the old dialog's scenario submit).
      for (const id of changedIds) {
        const row = live.find((r) => r.project_id === id);
        const next = drafts[id];
        if (!row || !next) continue;
        stageScenarioEdit({
          projectId: id,
          projectName: row.project_name,
          hub: row.hub,
          liveValues: liveRequestValuesFromRow(row),
          liveHasScore: row.has_score,
          next: { scores: { ...next.scores }, hard_gates: [...next.hard_gates] },
          labels: Object.fromEntries(row.dimension_scores.map((d) => [d.key, d.label])),
        });
      }
      setSavedNotice(
        `${formatInteger(changedIds.length)} ${changedIds.length === 1 ? 'project' : 'projects'} staged in the scenario. Nothing is saved until you Apply it.`,
      );
      leaveEditMode();
      return;
    }
    const body = buildGridApplyBody(drafts, live, editNotes, gridReads);
    if (body.priority_scores.length === 0) {
      leaveEditMode();
      return;
    }
    try {
      let sent = body;
      let res: Awaited<ReturnType<typeof applyMutation.mutateAsync>>;
      for (;;) {
        try {
          res = await applyMutation.mutateAsync(sent);
          break;
        } catch (err) {
          const conflicts = editConflicts(err);
          if (conflicts === null) throw err;
          // P47 (ADR 0059 C2): nothing was written; ask whose value to keep.
          const choice = await askConflict(conflicts, sent.priority_scores.length > 1 ? CONFLICT_COPY.batchNote : undefined);
          if (choice === 'mine') {
            sent = {
              ...sent,
              priority_scores: sent.priority_scores.map((c) => {
                const mine = conflicts.filter((x) => x.id === c.project_id);
                return mine.length > 0 && c.base ? { ...c, base: keepMineScoreBase(c.base, mine) } : c;
              }),
            };
            continue;
          }
          if (choice === 'theirs') {
            // Drop my value for the conflicting cells only; every other edit stays.
            let nextDrafts = drafts;
            let nextReads = gridReads;
            for (const id of new Set(conflicts.map((c) => c.id))) {
              const theirs = theirScoreValues(conflicts.filter((c) => c.id === id));
              ({ drafts: nextDrafts, reads: nextReads } = applyTheirScores(nextDrafts, nextReads, id, theirs));
            }
            setDrafts(nextDrafts);
            setGridReads(nextReads);
            void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
          }
          setSaveError(choice === 'theirs' ? CONFLICT_COPY.batchTheirs : CONFLICT_COPY.dismissed);
          return;
        }
      }
      const n = body.priority_scores.length;
      setSavedNotice(
        `Saved ${formatInteger(n)} ${n === 1 ? 'project' : 'projects'} as version ${String(res.run.version)}. Scores and bands are re-read from the server.`,
      );
      leaveEditMode();
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setWriteForbidden(true);
        leaveEditMode();
        return;
      }
      setSaveError(saveErrorText(err));
    }
  }, [served, scenarioActive, changedIds, drafts, stageScenarioEdit, leaveEditMode, editNotes, applyMutation, gridReads, askConflict, queryClient]);

  // The rubric card never depends on the grid's filters: keep its element stable.
  const rubricPanel = React.useMemo(() => <ScoringRubricPanel />, []);

  return (
    <TextFilterContext.Provider value={textStore}>
    <FetchedScoringModelProvider>
      <PageHeader
        title={title}
        description={description}
        // The country / hub selector lives in the View panel's filter row
        // (owner ask 2026-10-22: no duplicate in the header).
        actions={<HubFilterChip />}
      />

      <Tabs value={tab} onValueChange={setTab}>
      <TabsList aria-label="Prioritization views" className="mb-4" data-testid="matrix-tabs">
        <TabsTrigger value="grid">Scoring grid</TabsTrigger>
        <TabsTrigger value="board">Priority board</TabsTrigger>
      </TabsList>
      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <div ref={sentinelRef} aria-hidden="true" className="-mb-4 h-0" data-testid="matrix-view-sentinel" />
          <MatrixViewPanel
            panelRef={panelRef}
            stuck={stuck}
            narrow={narrow}
            filterCount={panelFilterCount}
            summary={`${onBoard ? 'Board' : currency} · ${panelFilterCount === 0 ? 'no filters' : `${String(panelFilterCount)} filters`}`}
            renderControls={(compact) => (
              <>
                {/* P21-T05 fix: one stacked cell. The currency control keeps the cell's size on
                    both tabs (hidden on the board), and on the board the board's own toolbar
                    (Search, Leader, Cards | List) is portalled on top of it, so the panel keeps
                    its height and the space is used. */}
                <div className="grid [&>*]:[grid-area:1/1]" data-testid="matrix-controls-stack">
                <div className={cn('flex flex-wrap items-center gap-4', onBoard && !narrow && 'invisible')} data-grid-only={onBoard && !narrow ? 'hidden' : undefined}>
                {onBoard && narrow ? null : (
                <MatrixCurrencyControl
                  value={currency}
                  onChange={(next) => {
                    setUnconfigured(null);
                    setCurrency(next);
                  }}
                  currencies={currencies}
                  compact={compact}
                />
                )}
                {/* P13-T14: editable FX rate, Admin / Super Admin only (PUT /currency-rates). */}
                {isAdmin && currency !== 'EUR' && !compact && !onBoard ? <FxRateEditor currency={currency} rate={selectedRate} /> : null}
                </div>
                {onBoard && !narrow ? (
                  <div ref={setBoardToolbarSlot} className="flex items-end" data-testid="board-toolbar-slot" />
                ) : null}
                </div>
                <ScenarioModeToggle disabled={!canEdit} />
                <VersionHistoryDialog
                  projectLookup={projectLookup}
                  open={history.open}
                  onOpenChange={onHistoryOpenChange}
                  initialVersion={history.version}
                />
                <div className="ml-auto flex flex-wrap items-center gap-2">
                  <GridOnly onBoard={onBoard} narrow={narrow} compact={compact}>
                  <Button
                    variant={view.detailed ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={view.detailed}
                    onClick={() => setViewField('detailed', !view.detailed)}
                    title="Show Leader, Type and Committed, and each dimension's points"
                  >
                    <TableProperties aria-hidden="true" />
                    Detailed view
                  </Button>
                  </GridOnly>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={resetView}
                    disabled={isDefaultView(view) && currency === 'EUR'}
                  >
                    <RotateCcw aria-hidden="true" />
                    Reset view
                  </Button>
                  <GridOnly onBoard={onBoard} narrow={narrow} compact={compact}>
                  <DownloadButton
                    path="/exports/matrix"
                    filters={{
                      currency,
                      hub_id: hubId ?? undefined,
                      region: region ?? undefined,
                      // P31: the export carries the multi-select (repeated params).
                      category: selectionParam(view.category),
                      type: selectionParam(view.type),
                    }}
                    fallbackFilename="matrix-export"
                  />
                  </GridOnly>
                </div>
              </>
            )}
            filters={
              <>
                <MultiChipFilter
                  label="Category"
                  options={categoryChips}
                  value={view.category}
                  onChange={(v) => setViewField('category', v)}
                  data-testid="matrix-category-chips"
                />
                <MultiChipFilter
                  label="Type"
                  options={TYPE_CHIP_OPTIONS}
                  value={view.type}
                  onChange={(v) => setViewField('type', v)}
                  data-testid="matrix-type-chips"
                />
                <div className="flex max-w-full items-center gap-2 overflow-x-auto">
                  <span className="text-2xs font-bold uppercase tracking-wider text-text-subtle">Hub</span>
                  <CountrySegmented />
                </div>
                <ChipFilter label="Status" value={view.status} options={STATUS_CHIPS} onChange={(v) => setViewField('status', v)} />
                <GridOnly onBoard={onBoard} narrow={narrow} compact={false}>
                  <Button
                    variant={view.capacityFill ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={view.capacityFill}
                    onClick={() => setViewField('capacityFill', !view.capacityFill)}
                    title="Show only projects promoted to P1 by their hub's capacity fill (served)"
                    data-testid="capacity-fill-filter"
                  >
                    <ArrowUpFromLine aria-hidden="true" />
                    Capacity fill
                  </Button>
                  <Button
                    variant={view.vipOnly ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={view.vipOnly}
                    onClick={() => setViewField('vipOnly', !view.vipOnly)}
                    title="Show only VIP projects"
                    data-testid="vip-filter"
                  >
                    <Star aria-hidden="true" className={view.vipOnly ? 'fill-current' : undefined} />
                    VIP
                  </Button>
                </GridOnly>
              </>
            }
          />

          {unconfigured && !onBoard ? (
            <p role="status" className="rounded border border-warning/40 bg-warning-subtle px-3 py-2 text-xs text-text" data-testid="currency-not-configured">
              No exchange rate is configured for {unconfigured}, so figures are shown in EUR. An Admin can set the rate.
            </p>
          ) : null}

          <ReadOnlyNotice surface="matrix" what="Score editing and scenario mode" />
          {writeForbidden ? <WriteForbiddenNotice /> : null}

          <ScenarioPendingPanel writeForbidden={writeForbidden || !permission.write} />

          <TabsContent value="grid" className="mt-0 flex flex-col gap-4">
          {/* P26-T03: the rubric is read and edited (Admins, served `can_edit`) in this card only. */}
          {rubricPanel}

          {/* Owner ask 2026-10-22: of the summary, histogram and capacity-fill
              panels only the band distribution stays (it filters the grid).
              P34-T02 (D34-2): it counts the served bands of the rows shown. */}
          {served ? (
            <ScoreChartsRow
              distribution={shownDistribution}
              activeBand={view.band}
              onBandClick={(next) => setViewField('band', next)}
            />
          ) : matrixQuery.isPending ? (
            <Skeleton className="h-48 w-full rounded-card" aria-label="Loading score overview" />
          ) : null}

          {savedNotice ? (
            <p role="status" className="rounded border border-success/40 bg-success-subtle px-3 py-2 text-xs text-text" data-testid="grid-saved-notice">
              {savedNotice}
            </p>
          ) : null}

          <SectionBoundary
            query={matrixQuery}
            title="Scoring grid"
            errorDescription="The prioritization scoring grid could not be loaded."
          >
            {(servedRows) => (
              <Card>
                <CardHeader className="flex-wrap">
                  <CardTitle>Scoring grid</CardTitle>
                  <span className="text-2xs text-text-muted" data-numeric="" data-testid="matrix-row-count">
                    {gridRows.length === servedRows.length
                      ? `${formatInteger(servedRows.length)} ${servedRows.length === 1 ? 'project' : 'projects'}`
                      : `${formatInteger(gridRows.length)} of ${formatInteger(servedRows.length)} projects shown`}{' '}
                    · ranked by score · scores 0–5 per dimension, total out of 100
                  </span>
                  <ScoringTotalLine />
                  {canEdit && !editMode ? (
                    <Button variant="secondary" size="sm" className="ml-auto" onClick={startEditMode} data-testid="grid-edit-start">
                      <PencilLine aria-hidden="true" />
                      Edit scores
                    </Button>
                  ) : null}
                  {editMode ? (
                    <span className="ml-auto text-2xs font-semibold text-warning-subtle-fg" data-testid="grid-edit-mode">
                      Editing: type 0–5 (empty = not scored), arrows move, tick the hard gates
                    </span>
                  ) : null}
                </CardHeader>
                <CardContent>
                  {gridRows.length === 0 && !isFiltered ? (
                    <EmptyState
                      title="No projects in scope"
                      description="There are no projects visible in your hub scope."
                    />
                  ) : (
                    <div className="flex flex-col gap-3">
                      {/* Kept while filtered, so the column filter inputs stay reachable. */}
                      <MatrixTable
                        canPinVip={canPinVip}
                        rows={gridRows}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        maxHeight={gridMaxHeight}
                        narrow={narrow}
                        scenarioStagedProjectIds={scenarioActive ? scenarioStagedProjectIds : undefined}
                        detailed={view.detailed}
                        columnFilters={columnFilters}
                        edit={gridEdit}
                        onOpenVersion={openVersion}
                      />
                      {gridRows.length === 0 ? (
                        <EmptyState
                          title="No projects match these filters"
                          description="Try widening or clearing the filters, or use Reset view."
                        />
                      ) : null}
                      {editMode ? (
                        <GridEditBar
                          changedCount={changedIds.length}
                          notes={editNotes}
                          onNotesChange={setEditNotes}
                          onSave={() => void saveEdits()}
                          onCancel={requestCancel}
                          saving={applyMutation.isPending}
                          scenario={scenarioActive}
                          error={saveError}
                        />
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}
          </SectionBoundary>

          <CompareBar onOpen={() => setCompareOpen(true)} />
          </TabsContent>
          <TabsContent value="board" className="mt-0" ref={boardWrapRef}>
            <PriorityBoardView
              shared={sharedBoardFilters}
              toolbarSlot={narrow ? null : boardToolbarSlot}
              compactToolbar={stuck}
              height={boardHeight}
              scenarioActive={scenarioActive}
              scenarioStagedIds={scenarioStagedProjectIds}
            />
          </TabsContent>
        </div>
      )}
      </Tabs>

      <CompareDialog
        open={compareOpen}
        onOpenChange={setCompareOpen}
        canEdit={canEdit}
        scenarioActive={scenarioActive}
        onForbidden={() => setWriteForbidden(true)}
      />

      <DiscardDialog
        open={confirmCancel}
        title="Discard your score edits?"
        description={`${formatInteger(changedIds.length)} ${changedIds.length === 1 ? 'project has' : 'projects have'} unsaved score edits. Nothing has been saved.`}
        onKeep={() => setConfirmCancel(false)}
        onDiscard={leaveEditMode}
        testId="grid-discard-dialog"
      />
      {conflict.dialog}
      <GridLeaveGuard when={unsavedEdits} />
    </FetchedScoringModelProvider>
    </TextFilterContext.Provider>
  );
}
