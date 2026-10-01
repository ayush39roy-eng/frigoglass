import * as React from 'react';

import { BarChart } from '@/components/ui/bar-chart';
import { formatDecimal } from '@/lib/format';

import type { HubCapacityRow } from '../api/types';
import { pickFigures, type CapacityHorizon } from '../lib/pick-figures';

/**
 * Cross-hub overview: one horizontal bar per hub for one resource kind, so the
 * eye can rank hubs before reading the per-hub cards. Hand-built `BarChart`
 * (chart-theme tokens; Recharts dropped from this surface in P9-T04). Visual aid
 * only — the verbatim figures live in `<HubSupplyBreakdown>`.
 */
export interface HubLoadChartProps {
  rows: HubCapacityRow[];
  metric: 'design' | 'lab';
  horizon: CapacityHorizon;
}

export function HubLoadChart({ rows, metric, horizon }: HubLoadChartProps): React.JSX.Element {
  const unit = metric === 'design' ? 'engineer-weeks' : 'chamber-weeks';
  const data = rows.map((r) => {
    const f = pickFigures(r, metric, horizon);
    return {
      key: r.hub,
      label: r.hub,
      value: f.load,
      hint: `${horizon === 'year' ? 'yearly' : 'remaining'} capacity ${formatDecimal(f.capacity)}`,
      tone: f.gap > 0 ? ('warning' as const) : ('primary' as const),
    };
  });
  return (
    <BarChart
      ariaLabel={`${metric === 'design' ? 'Design' : 'Lab'} load per hub, in ${unit}`}
      data={data}
      formatValue={formatDecimal}
    />
  );
}
