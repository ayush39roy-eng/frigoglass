import * as React from 'react';
import { FlaskConical, PenTool } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import type { HubCapacityRow } from '../api/types';
import { labRegionRows } from '../lib/lab-region-rows';
import { pickFigures, type CapacityHorizon } from '../lib/pick-figures';
import { PriorityLoadChart } from './priority-load-chart';

/**
 * The client's two side-by-side charts (P19-T01): "Design Load vs Capacity by Hub"
 * and "Lab Load vs Capacity by Lab Region". Each column is a stacked P1 / P2 / P3 /
 * Queue load bar (served `*_load_by_priority`) inside an outline at the served
 * capacity for the page's horizon, with the served total on top
 * (`PriorityLoadChart`, P13-T11). Lab figures are region-level (shared chambers),
 * so the lab chart has one column per lab region, naming the hubs that share it;
 * calling it "by hub" would draw India's chambers three times.
 */
export interface LoadCapacityChartsProps {
  rows: HubCapacityRow[];
  horizon: CapacityHorizon;
}

export function LoadCapacityCharts({ rows, horizon }: LoadCapacityChartsProps): React.JSX.Element {
  const capacityLabel = horizon === 'year' ? 'Yearly capacity' : 'Remaining capacity';
  return (
    <section aria-label="Load versus capacity charts" className="grid gap-gutter lg:grid-cols-2" data-testid="load-capacity-charts">
      <BoltCard className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-s2">
            <PenTool className="size-4 text-primary" aria-hidden="true" />
            Design Load vs Capacity by Hub
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-s3">
          <PriorityLoadChart
            ariaLabel="Design load by priority versus capacity, per hub"
            unit="engineer-weeks"
            capacityLabel={capacityLabel}
            bars={rows.map((r) => ({
              key: r.hub,
              label: r.hub,
              split: r.design_load_by_priority,
              load: r.design_load_weeks,
              capacity: pickFigures(r, 'design', horizon).capacity,
            }))}
          />
        </CardContent>
      </BoltCard>
      <BoltCard className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-s2">
            <FlaskConical className="size-4 text-success" aria-hidden="true" />
            Lab Load vs Capacity by Lab Region
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-s3">
          <PriorityLoadChart
            ariaLabel="Lab load by priority versus capacity, per lab region"
            unit="chamber-weeks"
            capacityLabel={capacityLabel}
            bars={labRegionRows(rows).map((l) => ({
              key: l.region,
              label: l.region,
              sublabel: l.hubs.join(', '),
              split: l.row.lab_load_by_priority,
              load: l.row.lab_load_weeks,
              capacity: pickFigures(l.row, 'lab', horizon).capacity,
            }))}
          />
        </CardContent>
      </BoltCard>
    </section>
  );
}
