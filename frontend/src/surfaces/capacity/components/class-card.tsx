import * as React from 'react';
import { Check, CircleCheck, TriangleAlert, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { CategoryTag } from '@/components/ui/category-tag';
import { formatInteger } from '@/lib/format';

import type { ClassBreakdownRow, PriorityCountSplit } from '../api/types';
import { BUCKET_SHORT, nonZeroBuckets } from '../lib/priority-split';

/**
 * P13-T11: one category card from the mock-up (Class A+/A/B/C …): the served
 * deliverable and left-out counts, each with its served priority split
 * ("P1: 32, Q: 5"), and the served per-hub ✓ deliverable / ✗ left-out counts.
 * Every number is one field of the served `ClassBreakdownRow`, including the
 * "Total" badge (served `total_count`, P13-T11 addendum); nothing is added up here.
 */
function SplitCaption({ split, label }: { split: PriorityCountSplit; label: string }): React.JSX.Element | null {
  const parts = nonZeroBuckets(split);
  if (parts.length === 0) return null;
  return (
    <span className="block text-[0.625rem] font-normal normal-case tracking-normal text-text-subtle" aria-label={`${label} by priority`} data-numeric="">
      ({parts.map((p) => `${BUCKET_SHORT[p.bucket]}: ${formatInteger(p.value)}`).join(', ')})
    </span>
  );
}

export function ClassCard({ row }: { row: ClassBreakdownRow }): React.JSX.Element {
  const titleId = React.useId();
  return (
    <section
      aria-labelledby={titleId}
      className="flex flex-col gap-s3 rounded-dash border border-dash-hairline bg-surface p-card-tight"
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
              <SplitCaption split={row.deliverable_by_priority} label="Deliverable" />
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
              <SplitCaption split={row.left_out_by_priority} label="Left out" />
            </span>
          </dt>
          <dd className="font-mono text-sm font-bold tabular-nums text-danger-subtle-fg" data-testid={`class-${row.category}-left-out`}>
            {formatInteger(row.left_out_count)}
          </dd>
        </div>
      </dl>

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
