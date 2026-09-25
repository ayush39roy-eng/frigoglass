import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { SURFACES } from '@/app/nav';
import { ApiError } from '@/lib/api/client';

import {
  useCompletingWithinYear,
  useHubTypePipeline,
  usePipelineTotals,
  useStatusOverview,
  useActiveScheduleRun,
} from './hooks/use-dashboard';
import { AccessNotice } from './components/access-notice';
import { HubTypePipelineTable } from './components/hub-type-pipeline-table';
import { PipelinePanel } from './components/pipeline-panel';
import { ProjectBreakdown } from './components/project-breakdown';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { StatusOverviewCards } from './components/status-overview-cards';
import { WithinYearPanel } from './components/within-year-panel';

const DASHBOARD_SURFACE = SURFACES.find((s) => s.path === '/');

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

export default function DashboardPage(): React.JSX.Element {
  const withinYear = useCompletingWithinYear();
  const pipelineTotals = usePipelineTotals();
  const statusOverview = useStatusOverview();
  const hubTypePipeline = useHubTypePipeline();
  const activeRun = useActiveScheduleRun(withinYear.data?.has_active_schedule_run === true);

  const title = DASHBOARD_SURFACE?.title ?? 'Global RPD Dashboard';
  const description =
    DASHBOARD_SURFACE?.summary ??
    'Portfolio-wide view sourced from the active schedule run (Invariant I9).';

  const denied = authKind([
    withinYear.error,
    pipelineTotals.error,
    statusOverview.error,
    hubTypePipeline.error,
  ]);

  return (
    <>
      <PageHeader title={title} description={description} />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 xl:grid-cols-2">
            <SectionBoundary
              query={withinYear}
              title="Completing within the year"
              errorDescription="The within-year completion figures could not be loaded from the active schedule run."
            >
              {(data) => <WithinYearPanel data={data} activeRun={activeRun.data} />}
            </SectionBoundary>

            <SectionBoundary
              query={pipelineTotals}
              title="Pipeline & completion"
              errorDescription="Pipeline totals could not be loaded."
            >
              {(totals) => <PipelinePanel totals={totals} withinYear={withinYear.data ?? null} />}
            </SectionBoundary>
          </div>

          <SectionBoundary
            query={statusOverview}
            title="Status overview"
            errorDescription="Status overview counts could not be loaded."
          >
            {(data) => <StatusOverviewCards data={data} />}
          </SectionBoundary>

          <SectionBoundary
            query={hubTypePipeline}
            title="Hub × type pipeline"
            errorDescription="The hub × type pipeline summary could not be loaded."
          >
            {(data) => <HubTypePipelineTable rows={data} />}
          </SectionBoundary>

          <ProjectBreakdown />
        </div>
      )}
    </>
  );
}
