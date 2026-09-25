import * as React from 'react';

import { PageHeader } from '@/components/layout/page-header';
import { DownloadButton } from '@/components/shared/download-button';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { SURFACES } from '@/app/nav';
import { ApiError } from '@/lib/api/client';

import { AccessNotice } from './components/access-notice';
import { CapacityReportingNotice } from './components/capacity-reporting-notice';
import { ChamberUtilizationPanel } from './components/chamber-utilization-panel';
import { ClassBreakdownPanel } from './components/class-breakdown-panel';
import { HubLoadPanel } from './components/hub-load-panel';
import {
  useActiveScheduleRun,
  useClassBreakdown,
  useHubLoadVsCapacity,
  useUtilizationMatrix,
} from './hooks/use-capacity';

const CAPACITY_SURFACE = SURFACES.find((s) => s.path === '/capacity');

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

export default function CapacityPage(): React.JSX.Element {
  const hubLoad = useHubLoadVsCapacity();
  const classBreakdown = useClassBreakdown();
  const utilization = useUtilizationMatrix();

  const hasRun =
    hubLoad.data?.has_active_schedule_run === true ||
    classBreakdown.data?.has_active_schedule_run === true ||
    utilization.data?.has_active_schedule_run === true;
  const activeRun = useActiveScheduleRun(hasRun);

  const title = CAPACITY_SURFACE?.title ?? 'RPD Capacity';
  const description =
    CAPACITY_SURFACE?.summary ??
    'Design and lab load vs. capacity per hub, reconciled to the week against the active schedule run (Invariants I6 / I7).';

  const denied = authKind([hubLoad.error, classBreakdown.error, utilization.error]);

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          denied ? null : (
            <DownloadButton path="/exports/capacity" fallbackFilename="capacity-export" />
          )
        }
      />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <CapacityReportingNotice />

          <SectionBoundary
            query={hubLoad}
            title="Load vs. capacity per hub"
            errorDescription="Per-hub load and capacity could not be loaded from the active schedule run."
          >
            {(data) => <HubLoadPanel data={data} activeRun={activeRun.data} />}
          </SectionBoundary>

          <SectionBoundary
            query={classBreakdown}
            title="Class breakdown — deliverable vs. left out"
            errorDescription="The A+/A/B/C deliverable vs. left-out breakdown could not be loaded."
          >
            {(data) => <ClassBreakdownPanel data={data} />}
          </SectionBoundary>

          <SectionBoundary
            query={utilization}
            title="Resource utilization matrix"
            errorDescription="The chamber utilization matrix could not be loaded."
          >
            {(data) => <ChamberUtilizationPanel data={data} activeRun={activeRun.data} />}
          </SectionBoundary>
        </div>
      )}
    </>
  );
}
