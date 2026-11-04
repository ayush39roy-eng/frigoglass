import * as React from 'react';

import { formatInteger } from '@/lib/format';
import { ChartCard } from '@/surfaces/dashboard/components/executive/executive-charts';

import type { BreakdownBucket } from '../import-types';
import { bucketLabel, STACK_SEGMENTS } from '../stack-segments';

/**
 * A stacked bar per served bucket (within year · spillover · not placed), laid out like the
 * Dashboard Executive "Delivery by priority" card (ADR 0039): `[label] [bar 1fr] [numbers]`.
 * The segments are sized by CSS `flex-grow` = the served count, so the browser draws the
 * proportions and no share is computed; the numbers column prints the served counts.
 */

export function StackLegend(): React.JSX.Element {
  return (
    <ul className="flex flex-wrap gap-x-s3 gap-y-0.5 text-[0.6rem] font-semibold text-text-muted" aria-hidden="true">
      {STACK_SEGMENTS.map((seg) => (
        <li key={seg.key} className="flex items-center gap-1">
          <span className="size-2 rounded-sm" style={{ background: seg.fill }} />
          {seg.label}
        </li>
      ))}
    </ul>
  );
}

export function ServedStackChart({
  title,
  info,
  buckets,
  testId,
  labelOf = bucketLabel,
}: {
  title: string;
  info: React.ReactNode;
  buckets: readonly BreakdownBucket[];
  testId: string;
  labelOf?: (key: string) => string;
}): React.JSX.Element {
  const shown = buckets.filter((b) => b.total > 0);
  return (
    <ChartCard title={title} info={info} testId={testId}>
      {shown.length === 0 ? (
        <p className="text-xs text-text-muted">No projects in this selection.</p>
      ) : (
        <>
          <div className="flex flex-col gap-s2" aria-hidden="true">
            {shown.map((b) => (
              <div
                key={b.key}
                className="grid grid-cols-[minmax(3rem,7rem)_minmax(0,1fr)_auto] items-center gap-x-s2"
                data-testid={`${testId}-row`}
                data-key={b.key}
              >
                <span className="truncate text-xs font-bold text-text" title={labelOf(b.key)}>
                  {labelOf(b.key)}
                </span>
                <span className="flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken">
                  {STACK_SEGMENTS.map((seg) =>
                    b[seg.key] > 0 ? (
                      <span
                        key={seg.key}
                        className="block h-full"
                        style={{ flexGrow: b[seg.key], flexBasis: 0, background: seg.fill }}
                        data-segment={seg.key}
                      />
                    ) : null,
                  )}
                </span>
                <span className="whitespace-nowrap text-right text-2xs font-semibold tabular-nums text-text" data-numeric="">
                  {formatInteger(b.within_year)}/{formatInteger(b.total)}
                </span>
              </div>
            ))}
          </div>
          <StackLegend />
          <ul className="sr-only" aria-label={title}>
            {shown.map((b) => (
              <li key={b.key}>
                {labelOf(b.key)}: {formatInteger(b.total)} projects; {formatInteger(b.within_year)} within the plan
                year, {formatInteger(b.spillover)} spill over, {formatInteger(b.not_placed)} not placed.
              </li>
            ))}
          </ul>
        </>
      )}
    </ChartCard>
  );
}
