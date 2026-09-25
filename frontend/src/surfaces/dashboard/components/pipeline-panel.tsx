import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInteger } from '@/lib/format';

import { DonutChart } from '@/components/ui/donut-chart';

import type { CompletingWithinYear, PipelineTotals } from '../api/types';
import { BarChart, type BarDatum } from './bar-chart';

/**
 * Pipeline totals (spillover / newly registered / total) + the pipeline-vs-
 * completing chart (PROJECT_AND_STACK.md §2).
 *
 * Two distinct data sources, kept visually and textually separate so the two
 * senses of "spillover" never blur (the backend PipelineTotals docstring flags
 * this exact collision):
 *  - Pipeline composition: `carry_over` vs new, off the live Project table.
 *  - Schedule outcome (within-year / spillover / left-out): the active
 *    ScheduleRun snapshot, via CompletingWithinYear. Invariant I9.
 */

export interface PipelinePanelProps {
  totals: PipelineTotals;
  /** `null` = the schedule-run figures are still loading or unavailable. */
  withinYear: CompletingWithinYear | null;
}

export function PipelinePanel({ totals, withinYear }: PipelinePanelProps): React.JSX.Element {
  const compositionBars: BarDatum[] = [
    {
      key: 'new',
      label: 'Newly registered',
      value: totals.new_count,
      tone: 'primary',
      hint: 'Registered this planning year',
    },
    {
      key: 'carry-over',
      label: 'Carried over',
      value: totals.spillover_count,
      tone: 'neutral',
      hint: 'Spillover from a prior year',
    },
  ];

  const outcomeBars: BarDatum[] = withinYear?.has_active_schedule_run
    ? [
        {
          key: 'within-year',
          label: 'Completing within year',
          value: withinYear.within_year_count,
          tone: 'success',
        },
        {
          key: 'spillover',
          label: 'Spillover',
          value: withinYear.spillover_count,
          tone: 'warning',
        },
        {
          key: 'left-out',
          label: 'Left out',
          value: withinYear.left_out_count,
          tone: 'warning',
        },
      ]
    : [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipeline &amp; completion</CardTitle>
        <Badge tone="neutral" data-numeric="">
          {formatInteger(totals.total_count)} active
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <h3 className="label-caps text-text-subtle">Pipeline composition</h3>
          <p className="text-2xs text-text-muted">
            Every project except Commercialized. Source: live project registry.
          </p>
          <BarChart
            data={compositionBars}
            max={totals.total_count}
            ariaLabel="Pipeline composition: newly registered versus carried over"
          />
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="label-caps text-text-subtle">Active schedule run outcome</h3>
          {withinYear === null ? (
            <p className="text-xs text-text-muted">Loading completion figures…</p>
          ) : withinYear.has_active_schedule_run ? (
            <>
              <p className="text-2xs text-text-muted">
                Source: active schedule run
                {withinYear.schedule_run_version === null
                  ? ''
                  : ` v${String(withinYear.schedule_run_version)}`}{' '}
                (Invariant I9). Not recomputed in the browser.
              </p>
              {/* A donut, not bars: within-year / spillover / left-out are mutually
                  exclusive and sum to the scheduled total, which is the one condition
                  that makes a donut the right chart. Three segments, well under the
                  six-segment ceiling, and the centre total answers "out of how many?"
                  without the reader summing the arcs. */}
              <DonutChart
                data={outcomeBars.map((bar) => ({
                  key: bar.key,
                  label: bar.label,
                  value: bar.value,
                }))}
                totalLabel="scheduled"
                ariaLabel="Active schedule run outcome: within year, spillover, left out"
              />
            </>
          ) : (
            <p className="text-xs text-text-muted">
              No active schedule run — completion figures appear once the schedule is calculated.
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
