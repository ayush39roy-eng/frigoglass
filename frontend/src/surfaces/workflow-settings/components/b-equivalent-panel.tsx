import * as React from 'react';
import { FlaskConical, PencilRuler } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkflowId } from '@/types/enums';

import type { BEquivalentRow } from '../api/types';
import { formatRatio, referenceCategory } from '../lib/b-equivalent';

/**
 * B-equivalent workload (P13-T16, mock-up images 14 and 17).
 *
 * Each category's design and lab weeks and their ratio to the reference
 * category (B for PDD, B-OEM for OEM), all served by `GET /workflow-settings/
 * b-equivalent` (2 dp, I9). The bar under each ratio is only a visual scale
 * against the column's largest served ratio.
 */

export interface BEquivalentPanelProps {
  workflow: WorkflowId;
  rows: BEquivalentRow[];
}

export function BEquivalentPanel({ workflow, rows }: BEquivalentPanelProps): React.JSX.Element {
  const ref = referenceCategory(workflow);
  const refRow = rows.find((r) => r.category === ref) ?? null;
  const maxDesign = Math.max(0, ...rows.map((r) => r.design_ratio ?? 0));
  const maxLab = Math.max(0, ...rows.map((r) => r.lab_ratio ?? 0));

  return (
    <Card>
      <CardHeader className="flex-col items-start gap-1">
        <CardTitle>B-equivalent workload</CardTitle>
        <p className="text-2xs text-text-muted">
          Design and lab load per category against {ref} (1.00×). Design and lab are separate teams.
        </p>
      </CardHeader>
      <CardContent className="space-y-s3">
        {rows.length === 0 ? (
          <p className="py-s6 text-center text-sm text-text-muted">No categories configured for this workflow.</p>
        ) : (
          <table className="w-full border-separate border-spacing-y-1.5 text-sm">
            <caption className="sr-only">
              {workflow} B-equivalent workload, relative to {ref}
            </caption>
            <thead>
              <tr className="text-2xs font-bold uppercase tracking-wider text-text-subtle">
                <th scope="col" className="w-20 px-s2 text-left">
                  Category
                </th>
                <th scope="col" className="px-s2 text-center">
                  <span className="inline-flex items-center gap-1 text-primary-subtle-fg">
                    <PencilRuler className="size-3.5" aria-hidden="true" />
                    Design
                  </span>
                </th>
                <th scope="col" className="px-s2 text-center">
                  <span className="inline-flex items-center gap-1 text-success-subtle-fg">
                    <FlaskConical className="size-3.5" aria-hidden="true" />
                    Lab
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.category} data-testid={`beq-${r.category}`}>
                  <th
                    scope="row"
                    className={cn(
                      'rounded-l-lg bg-surface-sunken px-s2 py-s2 text-left font-bold text-text',
                      r.category === ref && 'text-primary-subtle-fg',
                    )}
                  >
                    {r.category}
                  </th>
                  <RatioCell tone="design" ratio={r.design_ratio} weeks={r.design_weeks} max={maxDesign} />
                  <RatioCell tone="lab" ratio={r.lab_ratio} weeks={r.lab_weeks} max={maxLab} last />
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {refRow ? (
          <p className="text-2xs text-text-muted" data-numeric="">
            <span className="font-semibold text-text">Design:</span> {ref} = {formatInteger(refRow.design_weeks)}w ·{' '}
            <span className="font-semibold text-text">Lab:</span> {ref} = {formatInteger(refRow.lab_weeks)}w
            <br />
            Ratio = category weeks ÷ {ref} weeks, computed by the server from the lead times in force.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function RatioCell({
  tone,
  ratio,
  weeks,
  max,
  last = false,
}: {
  tone: 'design' | 'lab';
  ratio: number | null;
  weeks: number;
  max: number;
  last?: boolean;
}): React.JSX.Element {
  const width = ratio === null || max <= 0 ? 0 : Math.min(100, (ratio / max) * 100);
  return (
    <td
      className={cn(
        'px-s3 py-s2 text-center',
        tone === 'design' ? 'bg-primary/10' : 'bg-success/10',
        last && 'rounded-r-lg',
      )}
      data-numeric=""
    >
      <span
        className={cn(
          'block font-display text-base font-extrabold tabular-nums',
          tone === 'design' ? 'text-primary-subtle-fg' : 'text-success-subtle-fg',
        )}
      >
        {formatRatio(ratio)}
      </span>
      <span className="block text-2xs tabular-nums text-text-muted">{formatInteger(weeks)}w</span>
      <span aria-hidden="true" className="mt-1 block h-1.5 overflow-hidden rounded-full bg-surface-sunken">
        <span
          className={cn('block h-full rounded-full', tone === 'design' ? 'bg-primary' : 'bg-success')}
          style={{ width: `${String(width)}%` }}
        />
      </span>
    </td>
  );
}
