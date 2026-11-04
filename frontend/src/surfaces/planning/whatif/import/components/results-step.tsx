import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

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
import { SaveScenarioButton } from './save-scenario-dialog';
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

export function ResultsStep({
  result,
  simulation,
  onRetry,
}: {
  result: ImportSimulateResponse;
  simulation: ImportSimulationState;
  onRetry: () => void;
}): React.JSX.Element {
  const tab = useImportPlan((s) => s.resultsTab);
  const setTab = useImportPlan((s) => s.setResultsTab);
  const setStep = useImportPlan((s) => s.setStep);
  const scenarioCount = useImportScenarios((s) => s.scenarios.length);
  const yearKey = useEffectiveYear(result);
  // "Show on Gantt" from a drill-down remounts the Gantt on the requested project (P32-R07).
  const ganttNonce = useImportPlan((s) => s.ganttFocusNonce);
  // Owner rule (2026-11-04): On Hold file rows are never mapped. They are sent with
  // include=false and the server drops them; this only guards the drawing.
  const shown = React.useMemo(
    () => ({
      ...result,
      projects: result.projects.filter((p) => p.source !== 'file' || isMappedStatus(p.status)),
    }),
    [result],
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
          <React.Suspense fallback={<TabFallback />}>
            <ResultsExecutive result={result} />
          </React.Suspense>
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
        <Button type="button" size="sm" variant="ghost" onClick={() => setStep('review')}>
          <ArrowLeft />
          Back to review
        </Button>
        <SaveScenarioButton disabled={simulation.pending} />
        <ScenarioBuilderButton onSaved={toCompare} />
        <span className="ml-auto inline-flex items-center gap-1.5 text-2xs text-text-muted" role="status" aria-live="polite">
          {simulation.pending ? (
            <>
              <Spinner className="size-3.5" label="Recomputing" />
              Recomputing…
            </>
          ) : (
            'Edits are kept · nothing is saved'
          )}
        </span>
      </ActionBar>
    </div>
  );
}
