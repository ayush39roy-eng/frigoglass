import * as React from 'react';
import { FilterX } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { CurrencyToggle } from '@/components/shared/currency-toggle';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { useHubs } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { SURFACES } from '@/app/nav';
import { effectivePendingEdits, useScenarioStore } from '@/stores/scenario';
import { PROJECT_CATEGORIES, type CurrencyCode, type ProjectCategory } from '@/types/enums';

import { AccessNotice, WriteForbiddenNotice } from './components/access-notice';
import { MatrixTable } from './components/matrix-table';
import { PortfolioSummaryPanel } from './components/portfolio-summary-panel';
import { ScenarioModeToggle, ScenarioPendingPanel } from './components/scenario-panel';
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
const ALL = '__all__';

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
  const [hubId, setHubId] = React.useState<string>(ALL);
  const [category, setCategory] = React.useState<string>(ALL);
  const [editRow, setEditRow] = React.useState<PriorityMatrixRow | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [writeForbidden, setWriteForbidden] = React.useState(false);

  const ratesQuery = useCurrencyRates();
  const hubsQuery = useHubs();
  const summaryQuery = usePrioritySummary();
  const matrixQuery = usePriorityMatrix({
    currency,
    hubId: hubId === ALL ? undefined : hubId,
    category: category === ALL ? undefined : (category as ProjectCategory),
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
  const isFiltered = hubId !== ALL || category !== ALL;
  const canEdit = !writeForbidden;

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
    <>
      <PageHeader title={title} description={description} />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>View</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <CurrencyToggle value={currency} onChange={setCurrency} rates={ratesQuery.data} />
              <FilterSelect
                label="Hub"
                value={hubId}
                onChange={setHubId}
                options={(hubsQuery.data ?? []).map((h) => ({ value: h.id, label: h.name }))}
              />
              <FilterSelect
                label="Category"
                value={category}
                onChange={setCategory}
                options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }))}
              />
              {isFiltered ? (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setHubId(ALL);
                    setCategory(ALL);
                  }}
                >
                  <FilterX />
                  Clear
                </Button>
              ) : null}
              <ScenarioModeToggle disabled={!canEdit} />
              <VersionHistoryDialog projectLookup={projectLookup} />
              <DownloadButton
                path="/exports/matrix"
                filters={{
                  currency,
                  hub_id: hubId === ALL ? undefined : hubId,
                  category: category === ALL ? undefined : category,
                }}
                fallbackFilename="matrix-export"
                className="ml-auto"
              />
            </CardContent>
          </Card>

          {writeForbidden ? <WriteForbiddenNotice /> : null}

          <ScenarioPendingPanel writeForbidden={writeForbidden} />

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
            {(rows) => (
              <Card>
                <CardHeader>
                  <CardTitle>Scoring grid</CardTitle>
                  <span className="text-2xs text-text-muted" data-numeric="">
                    {formatInteger(rows.length)} {rows.length === 1 ? 'project' : 'projects'} ·{' '}
                    financial columns in {currency} (converted server-side)
                  </span>
                </CardHeader>
                <CardContent>
                  {rows.length === 0 ? (
                    <EmptyState
                      title={isFiltered ? 'No projects match these filters' : 'No projects in scope'}
                      description={
                        isFiltered
                          ? 'Try widening or clearing the hub / category filters.'
                          : 'There are no projects visible in your hub scope.'
                      }
                    />
                  ) : (
                    <MatrixTable
                      rows={rows}
                      currency={currency}
                      canEdit={canEdit}
                      onEdit={handleEdit}
                      scenarioStagedProjectIds={scenarioActive ? scenarioStagedProjectIds : undefined}
                    />
                  )}
                </CardContent>
              </Card>
            )}
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
    </>
  );
}

function FilterSelect({
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
        <SelectTrigger id={id} className="h-8 w-40">
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
