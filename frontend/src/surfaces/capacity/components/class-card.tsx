import * as React from 'react';
import { Check, CircleCheck, Hourglass, TriangleAlert, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { formatInteger } from '@/lib/format';

import type { ClassBreakdownRow, PriorityBucketLabels, PriorityCountSplit } from '../api/types';
import { bucketLabel, nonZeroBuckets } from '../lib/priority-split';

/**
 * P13-T11: one category card from the mock-up (Class A+/A/B/C …): the served
 * deliverable and left-out counts, each with its served priority split
 * ("P1: 32, Q: 5"), and the served per-hub ✓ deliverable / ✗ left-out counts.
 * Every number is one field of the served `ClassBreakdownRow`, including the
 * "Total" badge (served `total_count`, P13-T11 addendum); nothing is added up here.
 */
function SplitCaption({
  split,
  label,
  labels,
}: {
  split: PriorityCountSplit;
  label: string;
  labels: PriorityBucketLabels | undefined;
}): React.JSX.Element | null {
  const parts = nonZeroBuckets(split);
  if (parts.length === 0) return null;
  return (
    <span className="block text-[0.625rem] font-normal normal-case tracking-normal text-text-subtle" aria-label={`${label} by priority`} data-numeric="">
      ({parts.map((p) => `${bucketLabel(p.bucket, labels)}: ${formatInteger(p.value)}`).join(', ')})
    </span>
  );
}

export function ClassCard({
  row,
  bucketLabels,
}: {
  row: ClassBreakdownRow;
  /** P42: the served `priority_bucket_labels` (`Queue` → "Q"). */
  bucketLabels?: PriorityBucketLabels;
}): React.JSX.Element {
  const titleId = React.useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-s3 rounded-dash border border-dash-hairline bg-surface p-card-tight shadow-dashCard"
      data-testid={`class-card-${row.category}`}
    >
      <div className="flex items-center justify-between gap-s2">
        <h3 id={titleId} className="flex items-center gap-s2 text-sm font-bold text-text">
          <CategoryTag category={row.category} />
          <span>Class {row.category}</span>
        </h3>
        <Badge tone="neutral" className="rounded-pill font-mono tabular-nums" data-testid={`class-${row.category}-total`}>
          Total: {formatInteger(row.total_count)}
        </Badge>
      </div>

      <dl className="flex flex-col gap-s2 rounded-dash border border-dash-hairline bg-dash-alt p-s3">
        <div className="flex items-start justify-between gap-s2">
          <dt className="flex items-start gap-1.5 label-caps text-text-muted">
            <CircleCheck className="mt-px size-3.5 shrink-0 text-success" aria-hidden="true" />
            <span>
              Deliverable
              <SplitCaption split={row.deliverable_by_priority} label="Deliverable" labels={bucketLabels} />
            </span>
          </dt>
          <dd className="font-mono text-sm font-bold tabular-nums text-success-subtle-fg" data-testid={`class-${row.category}-deliverable`}>
            {formatInteger(row.deliverable_count)}
          </dd>
        </div>
        <div className="flex items-start justify-between gap-s2">
          <dt className="flex items-start gap-1.5 label-caps text-text-muted">
            <TriangleAlert className="mt-px size-3.5 shrink-0 text-danger" aria-hidden="true" />
            <span>
              Left out
              <SplitCaption split={row.left_out_by_priority} label="Left out" labels={bucketLabels} />
            </span>
          </dt>
          <dd className="font-mono text-sm font-bold tabular-nums text-danger-subtle-fg" data-testid={`class-${row.category}-left-out`}>
            {formatInteger(row.left_out_count)}
          </dd>
        </div>
      </dl>

      {/* P42 (R42-6): served counts outside deliverable / left out / total —
          a queued P3 waits for spare capacity, a P4 is never planned; neither
          counts toward the year. */}
      {row.queued_count > 0 || row.not_scheduled_priority_count > 0 ? (
        <p className="flex flex-wrap items-center gap-x-s2 gap-y-0.5 text-2xs text-text-muted" data-testid={`class-${row.category}-not-counted`}>
          <Hourglass className="size-3 shrink-0" aria-hidden="true" />
          <span>Not counted this year:</span>
          {row.queued_count > 0 ? (
            <span data-testid={`class-${row.category}-queued`}>
              Queued <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">{formatInteger(row.queued_count)}</span>
            </span>
          ) : null}
          {row.not_scheduled_priority_count > 0 ? (
            <span data-testid={`class-${row.category}-not-scheduled`}>
              Not scheduled (P4){' '}
              <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">{formatInteger(row.not_scheduled_priority_count)}</span>
            </span>
          ) : null}
        </p>
      ) : null}

      {row.by_hub.length > 0 ? (
        <div className="flex flex-col gap-1">
          <h4 className="label-caps text-text-subtle">Hub breakdown</h4>
          <ul className="flex flex-col gap-1">
            {row.by_hub.map((h) => (
              <li
                key={h.hub}
                className="flex items-center justify-between gap-s2 rounded-dash border border-dash-hairline px-s2 py-1 text-xs"
                data-testid={`class-${row.category}-hub-${h.hub}`}
              >
                <span className="font-semibold text-text">{h.hub}</span>
                <span className="flex items-center gap-s2 font-mono tabular-nums">
                  <span className="inline-flex items-center gap-0.5 text-success-subtle-fg">
                    <Check className="size-3" aria-hidden="true" />
                    <span className="sr-only">Deliverable </span>
                    {formatInteger(h.deliverable)}
                  </span>
                  <span className="inline-flex items-center gap-0.5 text-danger-subtle-fg">
                    <X className="size-3" aria-hidden="true" />
                    <span className="sr-only">Left out </span>
                    {formatInteger(h.left_out)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
