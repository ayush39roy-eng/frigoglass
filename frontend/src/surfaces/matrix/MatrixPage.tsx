import * as React from 'react';
import { ArrowUpFromLine, RotateCcw, TableProperties } from 'lucide-react';
import { useSearchParams } from 'react-router-dom';

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
import { useHubFilter } from '@/stores/hub-filter';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { formatInteger } from '@/lib/format';
import { SURFACES } from '@/app/nav';
import { effectivePendingEdits, useScenarioStore } from '@/stores/scenario';
import { usePermission, useSessionStore } from '@/stores/session';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { FxRateEditor } from './components/fx-rate-editor';
import { ChipFilter, ColumnFilterInput } from './components/matrix-toolbar';
import { MatrixCurrencyControl } from './components/matrix-currency-control';
import { MatrixViewPanel } from './components/matrix-view-panel';
import { ScoreChartsRow } from './components/score-charts';
import { CapacityFillPanel } from './components/capacity-fill-panel';
import { CompareBar, CompareDialog } from './components/compare-dialog';
import {
  CATEGORY_CHIPS,
  DEFAULT_MATRIX_VIEW,
  STATUS_CHIPS,
  TYPE_CHIPS,
  activeFilterCount,
  canEditFxRate,
  isDefaultView,
  type MatrixViewState,
} from './lib/matrix-view';
import { useCompareSelection } from './lib/compare-selection';
import { rowBand } from './lib/row-scores';
import { useGridMaxHeight, useSpaceBelow, useStuck } from './lib/use-stuck';
import { NARROW_QUERY, useMediaQuery } from './lib/use-media-query';
import { MatrixTable } from './components/matrix-table';
import { PortfolioSummaryPanel } from './components/portfolio-summary-panel';
import { ScenarioModeToggle, ScenarioPendingPanel } from './components/scenario-panel';
import { FetchedScoringModelProvider, ScoringTotalLine } from './scoring-model';
import { ScoringRubricPanel } from './components/scoring-rubric-panel';
import { liveRequestValuesFromRow, rowWithStaged } from './components/score-edit-schema';
import { ScoreEditDialog } from './components/score-edit-dialog';
import { VersionHistoryDialog } from './components/version-history-panel';
import {
  useMatrixCurrencies,
  usePriorityCapacityFill,
  usePriorityDistribution,
  usePriorityMatrix,
  usePrioritySummary,
  useUpdatePriorityScore,
} from './hooks/use-matrix';
import type { MatrixCurrencyCode, PriorityMatrixRow, PriorityScoreUpdateRequest } from './api/types';

const MATRIX_SURFACE = SURFACES.find((s) => s.path === '/matrix');
const SEARCH_MAX_LENGTH = 100;

/** P13-T14: the Hub / Leader column inputs narrow the SERVED rows in view
 *  (text match only — ranks and figures stay as served). An id with no
 *  name matches "unavailable". P21: the band picked on the distribution chart
 *  narrows by each row's SERVED band. */
function narrowInView(rows: PriorityMatrixRow[], view: MatrixViewState): PriorityMatrixRow[] {
  const hub = view.hubText.trim().toLowerCase();
  const leader = view.leaderText.trim().toLowerCase();
  if (hub === '' && leader === '' && view.band === null && !view.capacityFill) return rows;
  return rows.filter((r) => {
    if (view.band !== null && rowBand(r) !== view.band) return false;
    if (view.capacityFill && r.capacity_fill !== true) return false;
    if (hub !== '' && !r.hub.toLowerCase().includes(hub)) return false;
    if (leader !== '') {
      const shown = r.leader_name ?? (r.leader_engineer_id ? 'unavailable' : '');
      if (!shown.toLowerCase().includes(leader)) return false;
    }
    return true;
  });
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
  const [view, setView] = React.useState<MatrixViewState>(DEFAULT_MATRIX_VIEW);
  const debouncedQ = useDebouncedValue(view.q, 300).trim();
  const setViewField = React.useCallback(
    <K extends keyof MatrixViewState>(key: K, value: MatrixViewState[K]) =>
      setView((v) => ({ ...v, [key]: value })),
    [],
  );
  const isAdmin = canEditFxRate(useSessionStore((s) => s.me?.roles));
  const [editRow, setEditRow] = React.useState<PriorityMatrixRow | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [writeForbidden, setWriteForbidden] = React.useState(false);

  const currenciesQuery = useMatrixCurrencies();
  const currencies = currenciesQuery.data;
  const selectedRate = currencies?.find((c) => c.currency_code === currency)?.rate_to_eur ?? null;
  const summaryQuery = usePrioritySummary(hubId, region);
  const serverFilters = {
    hubId: hubId ?? undefined,
    region: region ?? undefined,
    category: view.category ?? undefined,
    type: view.type ?? undefined,
    status: view.status ?? undefined,
    q: debouncedQ === '' ? undefined : debouncedQ,
  };
  const matrixQuery = usePriorityMatrix({ currency, ...serverFilters });
  const distributionQuery = usePriorityDistribution(serverFilters);
  // P25: per-hub P1 capacity fill (global hub / country filter only; the fill ignores row filters).
  const capacityFillQuery = usePriorityCapacityFill(hubId, region);

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
  // Below the grid: card padding + page gutter (+ the Compare bar when shown).
  const gridMaxHeight = useGridMaxHeight(sentinelRef, panelRef, stuck, compareItems.length > 0 ? 176 : 112);
  // P21-T05 fix: the board uses the same offset as the grid, so once scrolled to, its column
  // headers sit below the stuck View panel; the columns scroll inside that height.
  // The reserve is the measured space below the board, so at the bottom of the page the
  // board's top meets the stuck panel's bottom exactly: nothing above it (the hub load strip)
  // is left as a cut-off sliver between them.
  const boardWrapRef = React.useRef<HTMLDivElement>(null);
  const boardBelow = useSpaceBelow(boardWrapRef, onBoard);
  const boardHeight = useGridMaxHeight(sentinelRef, panelRef, stuck, boardBelow);
  const updateScore = useUpdatePriorityScore();

  // Scenario mode (P5-T01) — a genuinely different interaction model from the
  // immediate-write flow above, additive, not a replacement: while `active`,
  // `handleSubmit` stages the edit locally instead of PUTting it.
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

  const title = MATRIX_SURFACE?.title ?? 'Prioritization Matrix';
  const description =
    MATRIX_SURFACE?.summary ??
    'Scoring dimensions per project (the editable rubric), weighted score and band, with a server-driven currency toggle.';

  const denied = authKind([matrixQuery.error, summaryQuery.error]);
  const setSearch = React.useCallback((next: string) => setViewField('q', next), [setViewField]);
  const sharedBoardFilters = React.useMemo<SharedBoardFilters>(
    () => ({ category: view.category, type: view.type, status: view.status, search: view.q, onSearchChange: setSearch }),
    [view.category, view.type, view.status, view.q, setSearch],
  );
  // On the board only the shared filters count (the band and the Hub / Leader text narrow the grid only).
  const sharedFilterCount = [view.category, view.type, view.status].filter((v) => v !== null).length + (view.q.trim() !== '' ? 1 : 0);
  const panelFilterCount = onBoard ? sharedFilterCount : activeFilterCount(view);
  // P21-T05 fix: the board's toolbar lives in the View panel on wide screens.
  const [boardToolbarSlot, setBoardToolbarSlot] = React.useState<HTMLDivElement | null>(null);
  const isFiltered =
    hubId !== null ||
    region !== null ||
    view.category !== null ||
    view.type !== null ||
    view.status !== null ||
    view.band !== null ||
    view.capacityFill ||
    debouncedQ !== '' ||
    view.hubText.trim() !== '' ||
    view.leaderText.trim() !== '';

  const columnFilters = React.useMemo(
    () => ({
      project: (
        <ColumnFilterInput
          column="project name or code"
          placeholder="Search…"
          maxLength={SEARCH_MAX_LENGTH}
          value={view.q}
          onChange={(v) => setViewField('q', v)}
        />
      ),
      hub: <ColumnFilterInput column="hub" value={view.hubText} onChange={(v) => setViewField('hubText', v)} />,
      leader: (
        <ColumnFilterInput column="leader" value={view.leaderText} onChange={(v) => setViewField('leaderText', v)} />
      ),
    }),
    [view.q, view.hubText, view.leaderText, setViewField],
  );

  const resetView = React.useCallback(() => {
    setView(DEFAULT_MATRIX_VIEW);
    setCurrency('EUR');
  }, []);
  // Session table first (ADR 0010), server 403 second.
  const permission = usePermission('matrix');
  const canEdit = permission.write && !writeForbidden;

  const handleEdit = React.useCallback((row: PriorityMatrixRow) => {
    setEditRow(row);
    setDialogOpen(true);
  }, []);

  // In scenario mode, the dialog pre-fills from whatever is already staged
  // for this project (so re-opening the edit continues from the staged
  // value, not the stale live one) — `editRow` itself always stays the
  // ORIGINAL live row, used below to capture the diff baseline correctly.
  const dialogRow = React.useMemo<PriorityMatrixRow | null>(() => {
    if (!editRow) return null;
    const staged = scenarioActive ? scenarioPending[editRow.project_id] : undefined;
    return staged ? rowWithStaged(editRow, staged.next) : editRow;
  }, [editRow, scenarioActive, scenarioPending]);

  const handleSubmit = React.useCallback(
    async (projectId: string, body: PriorityScoreUpdateRequest) => {
      if (scenarioActive) {
        if (!editRow) return;
        // The dialog sends only what it changed; the staged `next` is the full
        // picture (live values, then anything staged before, then this edit).
        const live = liveRequestValuesFromRow(editRow);
        const prior = scenarioPending[projectId]?.next.scores ?? live.scores;
        stageScenarioEdit({
          projectId,
          projectName: editRow.project_name,
          hub: editRow.hub,
          liveValues: live,
          liveHasScore: editRow.has_score,
          next: { scores: { ...prior, ...body.scores }, hard_gates: body.hard_gates },
        });
        return;
      }
      try {
        await updateScore.mutateAsync({ projectId, body });
      } catch (err) {
        if (err instanceof ApiError && err.isForbidden) {
          setWriteForbidden(true);
          setDialogOpen(false);
        }
        throw err;
      }
    },
    [scenarioActive, editRow, scenarioPending, stageScenarioEdit, updateScore],
  );

  return (
    <FetchedScoringModelProvider>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            <CountrySegmented />
            <HubFilterChip />
          </>
        }
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
                <div className={cn('flex flex-wrap items-end gap-4', onBoard && !narrow && 'invisible')} data-grid-only={onBoard && !narrow ? 'hidden' : undefined}>
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
                <VersionHistoryDialog projectLookup={projectLookup} />
                <div className="ml-auto flex flex-wrap items-end gap-2">
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
                      category: view.category ?? undefined,
                    }}
                    fallbackFilename="matrix-export"
                  />
                  </GridOnly>
                </div>
              </>
            )}
            filters={
              <>
                <ChipFilter label="Cat" value={view.category} options={CATEGORY_CHIPS} onChange={(v) => setViewField('category', v)} />
                <ChipFilter label="Type" value={view.type} options={TYPE_CHIPS} onChange={(v) => setViewField('type', v)} />
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
          <ScoringRubricPanel />

          <SectionBoundary
            query={summaryQuery}
            title="Portfolio decision summary"
            errorDescription="The portfolio scoring summary could not be loaded."
          >
            {(summary) => <PortfolioSummaryPanel summary={summary} />}
          </SectionBoundary>

          {distributionQuery.data ? (
            <ScoreChartsRow
              distribution={distributionQuery.data}
              activeBand={view.band}
              onBandClick={(band) => setViewField('band', band)}
            />
          ) : distributionQuery.isPending ? (
            <Skeleton className="h-48 w-full rounded-card" aria-label="Loading score overview" />
          ) : (
            <p className="text-2xs text-text-muted" data-testid="matrix-chart-row-error">
              The score overview could not be loaded; the table below is unaffected.
            </p>
          )}

          <CapacityFillPanel
            data={capacityFillQuery.data}
            isPending={capacityFillQuery.isPending}
            isError={capacityFillQuery.isError}
          />

          <SectionBoundary
            query={matrixQuery}
            title="Scoring grid"
            errorDescription="The prioritization scoring grid could not be loaded."
          >
            {(served) => {
              const narrowed = narrowInView(served, view);
              const rows = [...narrowed].sort((a, b) => {
                if (a.rank !== null && b.rank !== null) {
                  if (a.rank !== b.rank) return a.rank - b.rank;
                  return a.project_name.localeCompare(b.project_name);
                }
                if (a.rank !== null) return -1;
                if (b.rank !== null) return 1;

                if (a.weighted_score !== null && b.weighted_score !== null) {
                  if (b.weighted_score !== a.weighted_score) return b.weighted_score - a.weighted_score;
                  return a.project_name.localeCompare(b.project_name);
                }
                if (a.weighted_score !== null) return -1;
                if (b.weighted_score !== null) return 1;

                return a.project_name.localeCompare(b.project_name);
              });
              return (
              <Card>
                <CardHeader className="flex-wrap">
                  <CardTitle>Scoring grid</CardTitle>
                  <span className="text-2xs text-text-muted" data-numeric="" data-testid="matrix-row-count">
                    {rows.length === served.length
                      ? `${formatInteger(served.length)} ${served.length === 1 ? 'project' : 'projects'}`
                      : `${formatInteger(rows.length)} of ${formatInteger(served.length)} projects shown`}{' '}
                    · ranked by score · scores 0–5 per dimension, total out of 100
                  </span>
                  <ScoringTotalLine />
                </CardHeader>
                <CardContent>
                  {rows.length === 0 && !isFiltered ? (
                    <EmptyState
                      title="No projects in scope"
                      description="There are no projects visible in your hub scope."
                    />
                  ) : (
                    <div className="flex flex-col gap-3">
                      {/* Kept while filtered, so the column filter inputs stay reachable. */}
                      <MatrixTable
                        rows={rows}
                        canEdit={canEdit}
                        selectedIds={selectedIds}
                        onToggleSelect={onToggleSelect}
                        maxHeight={gridMaxHeight}
                        narrow={narrow}
                        onEdit={handleEdit}
                        scenarioStagedProjectIds={scenarioActive ? scenarioStagedProjectIds : undefined}
                        detailed={view.detailed}
                        columnFilters={columnFilters}
                      />
                      {rows.length === 0 ? (
                        <EmptyState
                          title="No projects match these filters"
                          description="Try widening or clearing the filters, or use Reset view."
                        />
                      ) : null}
                    </div>
                  )}
                </CardContent>
              </Card>
              );
            }}
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

      <ScoreEditDialog
        row={dialogRow}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleSubmit}
        mode={scenarioActive ? 'scenario' : 'immediate'}
      />
    </FetchedScoringModelProvider>
  );
}
