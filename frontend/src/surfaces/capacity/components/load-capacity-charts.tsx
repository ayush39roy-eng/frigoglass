import * as React from 'react';
import { FlaskConical, PenTool } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import type { HubCapacityRow } from '../api/types';
import { labRegionRows } from '../lib/lab-region-rows';
import { DEMAND_LABEL, pickUnitFigures, resourceUnitLong, UNIT_SHORT, type CapacityView } from '../lib/pick-figures';
import { PriorityLoadChart } from './priority-load-chart';

/**
 * The client's two side-by-side charts (P19-T01): "Design Load vs Capacity by Hub"
 * and "Lab Load vs Capacity by Lab Region". Each column is a stacked P1 / P2 / P3 /
 * Queue load bar (served `*_load_by_priority`) inside an outline at the served
 * capacity for the page's horizon, with the served total on top
 * (`PriorityLoadChart`, P13-T11). Lab figures are region-level (shared chambers),
 * so the lab chart has one column per lab region, naming the hubs that share it;
 * calling it "by hub" would draw India's chambers three times.
 *
 * P19-T05: load and capacity follow the page's unit (served day fields in Days);
 * the axis title and value labels name the unit. The priority split stays weeks.
 *
 * P30 (ADR 0041, I19 rev.): each column is DEMAND: the full-year demand against
 * the yearly capacity, or the remaining demand against the remaining capacity.
 * The served priority split splits the full-year demand only, so the remaining
 * view draws plain columns (no split of the remaining demand is served).
 */
export interface LoadCapacityChartsProps {
  rows: HubCapacityRow[];
  view: CapacityView;
}

export function LoadCapacityCharts({ rows, view }: LoadCapacityChartsProps): React.JSX.Element {
  const capacityLabel = view.horizon === 'year' ? 'Yearly capacity' : 'Remaining capacity';
  const unitShort = UNIT_SHORT[view.unit];
  const year = view.horizon === 'year';
  const loadLabel = DEMAND_LABEL[view.horizon];
  return (
    <section aria-label="Demand versus capacity charts" className="grid gap-gutter lg:grid-cols-2" data-testid="load-capacity-charts">
      <BoltCard className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-s2">
            <PenTool className="size-4 text-primary" aria-hidden="true" />
            Design Demand vs Capacity by Hub
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-s3">
          <PriorityLoadChart
            ariaLabel={`Design ${loadLabel.toLowerCase()}${year ? ' by priority' : ''} versus capacity, per hub`}
            loadLabel={loadLabel}
            unit={resourceUnitLong('design', view.unit)}
            unitShort={unitShort}
            splitUnit={UNIT_SHORT.weeks}
            capacityLabel={capacityLabel}
            bars={rows.map((r) => {
              const f = pickUnitFigures(r, 'design', view);
              return {
                key: r.hub,
                label: r.hub,
                split: year ? r.design_load_by_priority : null,
                splitTotal: r.design_load_weeks,
                load: f.load,
                capacity: f.capacity,
              };
            })}
          />
        </CardContent>
      </BoltCard>
      <BoltCard className="min-w-0">
        <CardHeader>
          <CardTitle className="flex items-center gap-s2">
            <FlaskConical className="size-4 text-success" aria-hidden="true" />
            Lab Demand vs Capacity by Lab Region
          </CardTitle>
        </CardHeader>
        <CardContent className="pt-s3">
          <PriorityLoadChart
            ariaLabel={`Lab ${loadLabel.toLowerCase()}${year ? ' by priority' : ''} versus capacity, per lab region`}
            loadLabel={loadLabel}
            unit={resourceUnitLong('lab', view.unit)}
            unitShort={unitShort}
            splitUnit={UNIT_SHORT.weeks}
            capacityLabel={capacityLabel}
            bars={labRegionRows(rows).map((l) => {
              const f = pickUnitFigures(l.row, 'lab', view);
              return {
                key: l.region,
                label: l.region,
                sublabel: l.hubs.join(', '),
                split: year ? l.row.lab_load_by_priority : null,
                splitTotal: l.row.lab_load_weeks,
                load: f.load,
                capacity: f.capacity,
              };
            })}
          />
        </CardContent>
      </BoltCard>
    </section>
  );
}
