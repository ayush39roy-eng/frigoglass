import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { CircleCheckBig } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { cn } from '@/lib/utils';
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
 * completing). At xl all three share one row, equal height (owner ask,
 * 2026-10-22): 1 / 1.3 / 0.9, because the completing table's count-over-share
 * cells are the widest content and the chart reflows freely. "Top hubs" runs full width beneath. Below xl
 * everything stacks.
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
      <div className={cn('grid grid-cols-[minmax(0,1fr)] gap-gutter', hasRun ? 'xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_minmax(0,0.9fr)]' : 'xl:grid-cols-2')}>
        <div className="min-w-0 [&>*]:h-full">
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
        <div className="min-w-0 [&>*]:h-full">
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
        {hasRun && analytics.data ? (
          <div className="min-w-0 [&>*]:h-full">
            <React.Suspense fallback={<PanelSkeleton height="h-[20rem]" />}>
              <PipelineVsCompletingChart rows={analytics.data.completing_by_type} />
            </React.Suspense>
          </div>
        ) : null}
      </div>

      {hubTypePipeline.data ? <HubRankList rows={hubTypePipeline.data} /> : null}

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
