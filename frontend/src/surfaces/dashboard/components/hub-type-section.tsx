import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheckBig } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { SectionBoundary } from '@/components/shared/section-boundary';
import type { LabRegion } from '@/types/enums';

import type { CompletingWithinYear, DashboardAnalytics, HubTypePipelineRow } from '../api/types';
import { CompletingHubTypeTable } from './completing-hub-type-table';
import { HubRankList } from './hub-rank-list';
import type { DrillTarget } from '../lib/drilldown';
import { HubTypeDrilldownDialog } from './hub-type-drilldown';
import { HubTypePipelineTable } from './hub-type-pipeline-table';

// Recharts consumer: lazy, like the other Dashboard charts (see DashboardPage).
const PipelineVsCompletingChart = React.lazy(async () => ({
  default: (await import('./pipeline-vs-completing-chart')).PipelineVsCompletingChart,
}));

/**
 * P17-R08: the Hub × Type row, directly after "Completing within the year"
 * (client's older app: pipeline summary | completing within year | pipeline vs
 * completing). At xl the two tables share one row (5 / 7 columns) and the chart
 * runs beneath them beside "Top hubs"; three columns at 1440 px squeezed the
 * completing table into a sideways scroll. Below xl everything stacks.
 *
 * Owns the drill-down dialog: one dialog for both tables, focus returns to the
 * figure that opened it.
 */
export interface HubTypeSectionProps {
  hubTypePipeline: UseQueryResult<HubTypePipelineRow[]>;
  analytics: UseQueryResult<DashboardAnalytics>;
  withinYear: CompletingWithinYear | null;
  pipelineTotal: number | null;
  hubId: string | null;
  region: LabRegion | null;
}

export function HubTypeSection({
  hubTypePipeline,
  analytics,
  withinYear,
  pipelineTotal,
  hubId,
  region,
}: HubTypeSectionProps): React.JSX.Element {
  const [target, setTarget] = React.useState<DrillTarget | null>(null);
  const triggerRef = React.useRef<HTMLElement | null>(null);
  const onDrill = React.useCallback((t: DrillTarget, trigger: HTMLElement) => {
    triggerRef.current = trigger;
    setTarget(t);
  }, []);

  const hasRun = analytics.data?.has_active_schedule_run === true;
  const runRows = withinYear?.has_active_schedule_run ? withinYear.rows : null;
  // The corner of the completing table: the served I9 count (ADR 0030: the
  // cross-tab sums to it exactly). Only when the run payload is the active one.
  const completingGrand = withinYear?.has_active_schedule_run ? withinYear.within_year_count : null;

  return (
    <section aria-label="Pipeline and within-year completion by hub and type" className="flex flex-col gap-gutter">
      <div className="grid grid-cols-[minmax(0,1fr)] gap-gutter xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-5">
          <SectionBoundary
            query={hubTypePipeline}
            title="Project pipeline summary: Hub × Type"
            errorDescription="The hub × type pipeline summary could not be loaded."
          >
            {(rows) => (
              <HubTypePipelineTable
                rows={rows}
                byHub={analytics.data?.by_hub ?? null}
                byType={analytics.data?.by_type ?? null}
                grandTotal={pipelineTotal}
                onDrill={onDrill}
              />
            )}
          </SectionBoundary>
        </div>
        <div className="min-w-0 xl:col-span-7">
          <SectionBoundary
            query={analytics}
            title="Completing within year: Hub × Type"
            errorDescription="The within-year completion by hub and type could not be loaded."
          >
            {(data) =>
              data.has_active_schedule_run ? (
                <CompletingHubTypeTable
                  cells={data.completing_hub_type}
                  byType={data.completing_by_type}
                  byHub={data.completing_by_hub}
                  grandTotal={completingGrand}
                  onDrill={runRows === null ? undefined : onDrill}
                />
              ) : (
                <BoltCard className="flex h-full items-center gap-s3 p-card">
                  <CircleCheckBig className="size-5 shrink-0 text-text-muted" aria-hidden="true" />
                  <p className="text-sm text-text-muted">
                    No active schedule run yet: completion within the year by hub and type appears after the first run.
                  </p>
                </BoltCard>
              )
            }
          </SectionBoundary>
        </div>
      </div>

      <div className="grid grid-cols-[minmax(0,1fr)] gap-gutter xl:grid-cols-12">
        {hasRun && analytics.data ? (
          <div className="min-w-0 xl:col-span-8 [&>*]:h-full">
            <React.Suspense fallback={<PanelSkeleton height="h-[20rem]" />}>
              <PipelineVsCompletingChart rows={analytics.data.completing_by_type} />
            </React.Suspense>
          </div>
        ) : null}
        <div className={hasRun ? 'min-w-0 xl:col-span-4 [&>*]:h-full' : 'min-w-0 xl:col-span-12'}>
          {hubTypePipeline.data ? <HubRankList rows={hubTypePipeline.data} /> : null}
        </div>
      </div>

      <HubTypeDrilldownDialog
        target={target}
        onClose={() => setTarget(null)}
        hubId={hubId}
        region={region}
        runRows={runRows}
        returnFocusTo={triggerRef}
      />
    </section>
  );
}
