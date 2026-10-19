import * as React from 'react';
import { RotateCcw, TableProperties } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { CurrencyToggle } from '@/components/shared/currency-toggle';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
import type { CurrencyCode } from '@/types/enums';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { FxRateEditor } from './components/fx-rate-editor';
import { ChipFilter, ColumnFilterInput } from './components/matrix-toolbar';
import {
  CATEGORY_CHIPS,
  DEFAULT_MATRIX_VIEW,
  STATUS_CHIPS,
  TYPE_CHIPS,
  canEditFxRate,
  isDefaultView,
  type MatrixViewState,
} from './lib/matrix-view';
import { MatrixTable } from './components/matrix-table';
import { PortfolioSummaryPanel } from './components/portfolio-summary-panel';
import { ScenarioModeToggle, ScenarioPendingPanel } from './components/scenario-panel';
import { FetchedScoringModelProvider, ScoringTotalLine } from './scoring-model';
import { ScoringRubricPanel } from './components/scoring-rubric-panel';
import { liveRequestValuesFromRow } from './components/score-edit-schema';
import { ScoreEditDialog } from './components/score-edit-dialog';
import { VersionHistoryDialog } from './components/version-history-panel';
import {
  useCurrencyRates,
  usePriorityMatrix,
  usePrioritySummary,
  useUpdatePriorityScore,
} from './hooks/use-matrix';
import type { PriorityMatrixRow, PriorityScoreUpdateRequest } from './api/types';

const MATRIX_SURFACE = SURFACES.find((s) => s.path === '/matrix');
const SEARCH_MAX_LENGTH = 100;

/** P13-T14: the Hub / Leader column inputs narrow the SERVED rows in view
 *  (text match only — ranks and figures stay as served). An id with no
 *  name matches "unavailable". */
function narrowInView(rows: PriorityMatrixRow[], hubText: string, leaderText: string): PriorityMatrixRow[] {
  const hub = hubText.trim().toLowerCase();
  const leader = leaderText.trim().toLowerCase();
  if (hub === '' && leader === '') return rows;
  return rows.filter((r) => {
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

export default function MatrixPage(): React.JSX.Element {
  const [currency, setCurrency] = React.useState<CurrencyCode>('EUR');
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

  const ratesQuery = useCurrencyRates();
  const summaryQuery = usePrioritySummary(hubId, region);
  const matrixQuery = usePriorityMatrix({
    currency,
    hubId: hubId ?? undefined,
    region: region ?? undefined,
    category: view.category ?? undefined,
    type: view.type ?? undefined,
    status: view.status ?? undefined,
    q: debouncedQ === '' ? undefined : debouncedQ,
  });
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
    '13 scoring dimensions per project, weighted score and band, with a server-driven currency toggle.';

  const denied = authKind([matrixQuery.error, summaryQuery.error]);
  const isFiltered =
    hubId !== null ||
    region !== null ||
    view.category !== null ||
    view.type !== null ||
    view.status !== null ||
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
    return staged ? { ...editRow, ...staged.next } : editRow;
  }, [editRow, scenarioActive, scenarioPending]);

  const handleSubmit = React.useCallback(
    async (projectId: string, body: PriorityScoreUpdateRequest) => {
      if (scenarioActive) {
        if (!editRow) return;
        stageScenarioEdit({
          projectId,
          projectName: editRow.project_name,
          hub: editRow.hub,
          liveValues: liveRequestValuesFromRow(editRow),
          liveHasScore: editRow.has_score,
          next: body,
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
    [scenarioActive, editRow, stageScenarioEdit, updateScore],
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

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>View</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap items-end gap-4">
                <CurrencyToggle value={currency} onChange={setCurrency} rates={ratesQuery.data} />
                {/* P13-T14: editable FX rate, Admin / Super Admin only (PUT /currency-rates). */}
                {isAdmin && currency !== 'EUR' ? <FxRateEditor currency={currency} rates={ratesQuery.data} /> : null}
                <ScenarioModeToggle disabled={!canEdit} />
                <VersionHistoryDialog projectLookup={projectLookup} />
                <div className="ml-auto flex flex-wrap items-end gap-2">
                  <Button
                    variant={view.detailed ? 'primary' : 'secondary'}
                    size="sm"
                    aria-pressed={view.detailed}
                    onClick={() => setViewField('detailed', !view.detailed)}
                    title="Show the 13 score-dimension columns"
                  >
                    <TableProperties aria-hidden="true" />
                    Detailed view
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={resetView}
                    disabled={isDefaultView(view) && currency === 'EUR'}
                  >
                    <RotateCcw aria-hidden="true" />
                    Reset view
                  </Button>
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
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-border pt-3">
                <ChipFilter label="Cat" value={view.category} options={CATEGORY_CHIPS} onChange={(v) => setViewField('category', v)} />
                <ChipFilter label="Type" value={view.type} options={TYPE_CHIPS} onChange={(v) => setViewField('type', v)} />
                <div className="flex items-center gap-2">
                  <span className="text-2xs font-bold uppercase tracking-wider text-text-subtle">Hub</span>
                  <CountrySegmented />
                </div>
                <ChipFilter label="Status" value={view.status} options={STATUS_CHIPS} onChange={(v) => setViewField('status', v)} />
              </div>
            </CardContent>
          </Card>

          <ReadOnlyNotice surface="matrix" what="Score editing and scenario mode" />
          {writeForbidden ? <WriteForbiddenNotice /> : null}

          <ScenarioPendingPanel writeForbidden={writeForbidden || !permission.write} />

          <ScoringRubricPanel />

          <SectionBoundary
            query={summaryQuery}
            title="Portfolio decision summary"
            errorDescription="The portfolio scoring summary could not be loaded."
          >
            {(summary) => <PortfolioSummaryPanel summary={summary} />}
          </SectionBoundary>

          <SectionBoundary
            query={matrixQuery}
            title="Scoring grid"
            errorDescription="The prioritization scoring grid could not be loaded."
          >
            {(served) => {
              const narrowed = narrowInView(served, view.hubText, view.leaderText);
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
                <CardHeader>
                  <CardTitle>Scoring grid</CardTitle>
                  <span className="text-2xs text-text-muted" data-numeric="" data-testid="matrix-row-count">
                    {rows.length === served.length
                      ? `${formatInteger(served.length)} ${served.length === 1 ? 'project' : 'projects'}`
                      : `${formatInteger(rows.length)} of ${formatInteger(served.length)} projects shown`}{' '}
                    · ranked by score · financial columns in {currency} (converted server-side)
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
                        currency={currency}
                        canEdit={canEdit}
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
        </div>
      )}

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
