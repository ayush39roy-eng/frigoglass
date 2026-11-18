import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { SimulatedWeekNotice } from '@/components/shared/plan-week-notice';

import { Callout } from '../../components/result-parts';
import { WhatIfErrorNotice } from '../../components/whatif-error';
import { isMappedStatus } from '../import-rows';
import { useImportPlan, type ResultsTab } from '../import-store';
import type { ImportSimulateResponse } from '../import-types';
import { useImportScenarios } from '../scenarios-store';
import { classifyImportError, type ImportSimulationState } from '../use-import';
import { useEffectiveYear } from '../use-year-filter';
import { projectInYear } from '../year-filter';
import { ActionBar } from './feature-card';
import { ResultsCapacity } from './results-capacity';
import { ResultsGantt } from './results-gantt';
import { ResultsProjects } from './results-projects';
import { ScenarioBar, ScenarioViewBanner } from './scenario-bar';
import { ScenarioBuilderButton } from './scenario-builder-dialog';
import { YearFilterBar } from './year-filter-bar';

// P32-R05: the chart-heavy tabs load on first open (the import view itself is lazy too).
const ResultsExecutive = React.lazy(() =>
  import('./results-executive').then((m) => ({ default: m.ResultsExecutive })),
);
const ResultsCompare = React.lazy(() => import('./results-compare').then((m) => ({ default: m.ResultsCompare })));

const YEAR_TABS: ReadonlySet<ResultsTab> = new Set(['executive', 'gantt', 'projects']);

function TabFallback(): React.JSX.Element {
  return (
    <div className="space-y-s3" aria-busy="true">
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

interface ResultsStepProps {
  /**
   * The current (served) result. P48: null when no workbook is loaded and the planner opened
   * saved scenarios from the upload step; only stored results are then shown.
   */
  result: ImportSimulateResponse | null;
  simulation: ImportSimulationState;
  onRetry: () => void;
}

export function ResultsStep({ result: current, simulation, onRetry }: ResultsStepProps): React.JSX.Element {
  // P41: a scenario opened from the Scenario bar or the library is shown read-only on every
  // tab, exactly as served / stored; the current result is untouched underneath.
  const view = useImportPlan((s) => s.view);
  const result = view?.result ?? current;
  if (result === null) return <SavedOnlyCompare simulation={simulation} onRetry={onRetry} />;
  return <ResultsTabs result={result} current={current} simulation={simulation} onRetry={onRetry} />;
}

/**
 * P48: back to the upload step (and its saved-scenario panel). Used where there is no
 * workbook to review.
 */
function BackToUpload(): React.JSX.Element {
  const setStep = useImportPlan((s) => s.setStep);
  const closeView = useImportPlan((s) => s.closeView);
  return (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      onClick={() => {
        closeView();
        setStep('upload');
      }}
    >
      <ArrowLeft />
      Back to upload
    </Button>
  );
}

/**
 * P48: saved scenarios only (no workbook, nothing open): the Compare tab on its own, or the
 * progress of "Re-run on today's plan" until its result is served.
 */
function SavedOnlyCompare({ simulation, onRetry }: Omit<ResultsStepProps, 'result'>): React.JSX.Element {
  const rerunNonce = useImportPlan((s) => s.rerunNonce);
  const rerunning = simulation.pending || (rerunNonce > 0 && simulation.error === null);
  return (
    <div className="space-y-s4" data-testid="import-saved-only">
      {simulation.error ? (
        <WhatIfErrorNotice
          info={classifyImportError(simulation.error, 'simulate')}
          errorToken={simulation.token}
          onRetry={onRetry}
        />
      ) : null}
      {rerunning ? (
        <Callout tone="primary" title="Re-running the saved scenario on today’s plan…" testId="import-rerun-pending" role="status">
          <span className="inline-flex items-center gap-1.5">
            <Spinner className="size-3.5" label="Recomputing" />
            The stored request is simulated again; the saved record is not changed.
          </span>
        </Callout>
      ) : (
        <React.Suspense fallback={<TabFallback />}>
          <ResultsCompare />
        </React.Suspense>
      )}
      <ActionBar label="Results actions" testId="import-results-actions">
        <BackToUpload />
        <span className="ml-auto text-2xs text-text-muted">Saved scenarios are read-only · the real plan is never changed</span>
      </ActionBar>
    </div>
  );
}

function ResultsTabs({
  result,
  current,
  simulation,
  onRetry,
}: Omit<ResultsStepProps, 'result'> & {
  /** What the tabs show: the open scenario's stored result, else the current one. */
  result: ImportSimulateResponse;
  current: ImportSimulateResponse | null;
}): React.JSX.Element {
  const tab = useImportPlan((s) => s.resultsTab);
  const setTab = useImportPlan((s) => s.setResultsTab);
  const setStep = useImportPlan((s) => s.setStep);
  const hasWorkbook = useImportPlan((s) => s.parsed !== null);
  const scenarioCount = useImportScenarios((s) => s.scenarios.length);
  const view = useImportPlan((s) => s.view);
  const viewing = view !== null;
  const yearKey = useEffectiveYear(result);
  // "Show on Gantt" from a drill-down remounts the Gantt on the requested project (P32-R07).
  const ganttNonce = useImportPlan((s) => s.ganttFocusNonce);
  // Owner rule (2026-11-04): On Hold file rows are never mapped. They are sent with
  // include=false and the server drops them; this only guards the drawing.
  const shown = React.useMemo(
    () => ({
      ...result,
      projects: result.projects
        .filter((p) => p.source !== 'file' || isMappedStatus(p.status))
        // A viewed scenario is read-only: its bars cannot be dragged (display flag only).
        .map((p) => (viewing ? { ...p, steps: p.steps.map((st) => ({ ...st, editable: 'none' as const })) } : p)),
    }),
    [result, viewing],
  );
  // The Year filter on the Projects rows (served finish week / outcome; rows only).
  const yearProjects = React.useMemo(
    () => shown.projects.filter((p) => projectInYear(p, yearKey, result.base_year)),
    [shown.projects, yearKey, result.base_year],
  );
  const toCompare = () => setTab('compare');

  return (
    <div className="space-y-s4" data-testid="import-results">
      {simulation.error ? (
        <WhatIfErrorNotice
          info={classifyImportError(simulation.error, 'simulate')}
          errorToken={simulation.token}
          onRetry={onRetry}
        />
      ) : null}
      <ScenarioViewBanner current={current} />
      {/* R37-3: the result's own input week against the active run's. */}
      <SimulatedWeekNotice simulatedWeek={result.current_week} />
      <Tabs value={tab} onValueChange={(v) => setTab(v as ResultsTab)}>
        <div className="flex flex-wrap items-center justify-between gap-s3">
          <TabsList aria-label="Results" className="max-w-full flex-wrap">
            <TabsTrigger value="executive">Executive</TabsTrigger>
            <TabsTrigger value="gantt">Gantt</TabsTrigger>
            <TabsTrigger value="capacity">Capacity</TabsTrigger>
            <TabsTrigger value="projects">Projects</TabsTrigger>
            <TabsTrigger value="compare">
              Compare{scenarioCount > 0 ? ` (${String(scenarioCount)})` : ''}
            </TabsTrigger>
          </TabsList>
          {YEAR_TABS.has(tab) ? <YearFilterBar result={result} /> : null}
        </div>
        <TabsContent value="executive">
          <div className="space-y-s5">
            {current === null ? null : <ScenarioBar pending={simulation.pending} />}
            <React.Suspense fallback={<TabFallback />}>
              <ResultsExecutive result={result} />
            </React.Suspense>
          </div>
        </TabsContent>
        <TabsContent value="gantt">
          <ResultsGantt key={ganttNonce} result={shown} pending={simulation.pending} yearKey={yearKey} />
        </TabsContent>
        <TabsContent value="capacity">
          <ResultsCapacity result={result} />
        </TabsContent>
        <TabsContent value="projects">
          <ResultsProjects projects={yearProjects} baseYear={result.base_year} />
        </TabsContent>
        <TabsContent value="compare">
          <React.Suspense fallback={<TabFallback />}>
            <ResultsCompare />
          </React.Suspense>
        </TabsContent>
      </Tabs>
      <ActionBar label="Results actions" testId="import-results-actions">
        {hasWorkbook ? (
          <Button type="button" size="sm" variant="ghost" onClick={() => setStep('review')}>
            <ArrowLeft />
            Back to review
          </Button>
        ) : (
          <BackToUpload />
        )}
        {current === null ? null : <ScenarioBuilderButton onSaved={toCompare} />}
        <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-text-muted" role="status" aria-live="polite">
          {current === null ? (
            'Saved scenarios are read-only · the real plan is never changed'
          ) : simulation.pending ? (
            <>
              <Spinner className="size-3.5" label="Recomputing" />
              Recomputing…
            </>
          ) : (
            'Edits are kept · the real plan is never changed'
          )}
        </span>
      </ActionBar>
    </div>
  );
}
