import * as React from 'react';

import { formatDecimal } from '@/lib/format';

import type { PriorityLoadSplit } from '../api/types';
import { BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';
import { formatFigure } from '../lib/status-format';

/**
 * P13-T11: the mock-up's caption lines under a Capacity KPI — the load by
 * priority bucket ("P1: 926 · P2: 9 · …") and a per-hub (or per-lab-region)
 * line ("PD-India: 716 · R&D-India: 16 · …"). Every value is a served figure
 * (or the page's existing display aggregate of served figures, see
 * `lib/portfolio-totals.ts`), printed with `formatDecimal`.
 */
export interface KpiCaptionsProps {
  /** Accessible name prefix, e.g. "Design load". */
  label: string;
  /** Omitted for the capacity cards, which have a per-hub line but no priority split. */
  split?: PriorityLoadSplit;
  /** P19-T05: shown after the split when it is in a different unit from the card
   *  (the per-priority split is served in weeks only), e.g. "wks". */
  splitUnit?: string;
  /** A part's value is `null` when its served field is absent (prints "—"). */
  parts: { key: string; label: string; value: number | null }[];
  /** Says what `parts` are, e.g. "By hub" or "By lab region". */
  partsLabel: string;
  /** P30: the served run-booked weeks ("Booked in plan"), always in weeks. */
  inPlan?: { label: string; weeks: number; unit: string };
}

export function KpiCaptions({ label, split, splitUnit, parts, partsLabel, inPlan }: KpiCaptionsProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 text-2xs text-text-muted" data-testid={`kpi-captions-${label}`}>
      {split ? (
        <p aria-label={`${label} by priority`} data-numeric="">
          {PRIORITY_BUCKETS.map((bucket, i) => (
            <React.Fragment key={bucket}>
              {i > 0 ? <span aria-hidden="true"> · </span> : null}
              <span className="whitespace-nowrap">
                <span className="font-semibold text-text">{BUCKET_SHORT[bucket]}:</span>{' '}
                <span className="tabular-nums" data-testid={`kpi-${label}-${bucket}`}>
                  {formatDecimal(split[bucket])}
                </span>
              </span>
            </React.Fragment>
          ))}
          {splitUnit ? (
            <span className="whitespace-nowrap font-semibold text-text-subtle" data-testid={`kpi-${label}-split-unit`}>
              {' '}
              ({splitUnit})
            </span>
          ) : null}
        </p>
      ) : null}
      {parts.length > 0 ? (
        <p aria-label={`${label} ${partsLabel.toLowerCase()}`} data-numeric="">
          <span className="sr-only">{partsLabel}: </span>
          {parts.map((part, i) => (
            <React.Fragment key={part.key}>
              {i > 0 ? <span aria-hidden="true"> · </span> : null}
              <span className="whitespace-nowrap">
                {part.label}: <span className="tabular-nums">{formatFigure(part.value)}</span>
              </span>
            </React.Fragment>
          ))}
        </p>
      ) : null}
      {inPlan ? (
        <p data-numeric="" data-testid={`kpi-${label}-in-plan`}>
          <span className="font-semibold text-text">{inPlan.label}:</span>{' '}
          <span className="whitespace-nowrap tabular-nums">
            {formatDecimal(inPlan.weeks)} {inPlan.unit}
          </span>
        </p>
      ) : null}
    </div>
  );
}
