import * as React from 'react';

import { formatDecimal } from '@/lib/format';

import type { PriorityLoadSplit } from '../api/types';
import { BUCKET_SHORT, PRIORITY_BUCKETS } from '../lib/priority-split';

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
  split: PriorityLoadSplit;
  parts: { key: string; label: string; value: number }[];
  /** Says what `parts` are, e.g. "By hub" or "By lab region". */
  partsLabel: string;
}

export function KpiCaptions({ label, split, parts, partsLabel }: KpiCaptionsProps): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 border-t border-dash-hairline pt-s2 text-2xs text-text-muted" data-testid={`kpi-captions-${label}`}>
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
      </p>
      {parts.length > 0 ? (
        <p aria-label={`${label} ${partsLabel.toLowerCase()}`} data-numeric="">
          <span className="sr-only">{partsLabel}: </span>
          {parts.map((part, i) => (
            <React.Fragment key={part.key}>
              {i > 0 ? <span aria-hidden="true"> · </span> : null}
              <span className="whitespace-nowrap">
                {part.label}: <span className="tabular-nums">{formatDecimal(part.value)}</span>
              </span>
            </React.Fragment>
          ))}
        </p>
      ) : null}
    </div>
  );
}
