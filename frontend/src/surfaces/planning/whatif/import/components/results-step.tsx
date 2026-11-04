import * as React from 'react';
import { ArrowLeft } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

import { WhatIfErrorNotice } from '../../components/whatif-error';
import { isMappedStatus } from '../import-rows';
import { useImportPlan, type ResultsTab } from '../import-store';
import type { ImportSimulateResponse } from '../import-types';
import { classifyImportError, type ImportSimulationState } from '../use-import';
import { ResultsCapacity } from './results-capacity';
import { ResultsGantt } from './results-gantt';
import { ResultsOverview } from './results-overview';
import { ResultsProjects } from './results-projects';

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
  // Owner rule (2026-11-04): On Hold file rows are never mapped. They are sent with
  // include=false and the server drops them; this only guards the drawing.
  const shown = React.useMemo(
    () => ({
      ...result,
      projects: result.projects.filter((p) => p.source !== 'file' || isMappedStatus(p.status)),
    }),
    [result],
  );
  return (
    <div className="space-y-s4" data-testid="import-results">
      <div className="flex flex-wrap items-center gap-s3">
        <Button type="button" size="sm" variant="secondary" onClick={() => setStep('review')}>
          <ArrowLeft />
          Back to review
        </Button>
        <p className="text-2xs text-text-muted">Your row changes and Gantt edits are kept. Nothing is saved.</p>
      </div>
      {simulation.error ? (
        <WhatIfErrorNotice
          info={classifyImportError(simulation.error, 'simulate')}
          errorToken={simulation.token}
          onRetry={onRetry}
        />
      ) : null}
      <Tabs value={tab} onValueChange={(v) => setTab(v as ResultsTab)}>
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="gantt">Gantt</TabsTrigger>
          <TabsTrigger value="capacity">Capacity</TabsTrigger>
          <TabsTrigger value="projects">Projects</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <ResultsOverview result={shown} />
        </TabsContent>
        <TabsContent value="gantt">
          <ResultsGantt result={shown} pending={simulation.pending} />
        </TabsContent>
        <TabsContent value="capacity">
          <ResultsCapacity result={result} />
        </TabsContent>
        <TabsContent value="projects">
          <ResultsProjects projects={shown.projects} baseYear={result.base_year} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
