import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatInteger } from '@/lib/format';

import { DonutChart } from '@/components/ui/donut-chart';

import type { CompletingWithinYear, PipelineTotals } from '../api/types';
import { BarChart, type BarDatum } from './bar-chart';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';

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
        // P9-F02: the fourth mutually-exclusive bucket (Blocked wins outright
        // over the other three, per CompletingWithinYear.blocked_count) — kept
        // in the donut so "sum to the scheduled total" stays true.
        {
          key: 'blocked',
          label: 'Blocked',
          value: withinYear.blocked_count,
          tone: 'warning',
        },
      ]
    : [];

  return (
    <BoltCard>
      <CardHeader>
        <CardTitle>Pipeline &amp; completion</CardTitle>
        <Badge tone="neutral" data-numeric="">
          {formatInteger(totals.total_count)} active
        </Badge>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          {/* Client text cleanup, 2026-10-01: the two captions that used to sit
              under these sub-headings as loose body copy ("Every project except
              Commercialized. Source: live project registry." and the schedule-run
              / Invariant I9 line) are now info popovers on the sub-heading rows.
              Nothing was deleted — and because the "live project registry" vs
              "active schedule run" distinction is the one that keeps the two
              senses of the word "spillover" from blurring (see this file's own
              doc comment), each section ALSO keeps its source statement as
              `sr-only` text so it stays in the accessibility tree verbatim. */}
          <div className="flex items-center justify-between gap-s2">
            <h3 className="label-caps text-text-subtle">Pipeline composition</h3>
            <CardInfo label="Pipeline composition source">
              <p>
                Every project except <strong className="text-text">Commercialized</strong>. Source:
                the live project registry, not a schedule run.
              </p>
              <p>
                &quot;Carried over&quot; here means a project registered in a prior planning year —
                it is NOT the scheduling <strong className="text-text">Spillover</strong> outcome
                shown below, which is a property of the active schedule run.
              </p>
            </CardInfo>
          </div>
          <span className="sr-only">
            Every project except Commercialized. Source: live project registry.
          </span>
          <BarChart
            data={compositionBars}
            max={totals.total_count}
            ariaLabel="Pipeline composition: newly registered versus carried over"
          />
        </section>

        <section className="space-y-2 border-t border-dash-hairline pt-4">
          <div className="flex items-center justify-between gap-s2">
            <h3 className="label-caps text-text-subtle">Active schedule run outcome</h3>
            <div className="flex items-center gap-s2">
              {withinYear?.has_active_schedule_run && withinYear.schedule_run_version !== null ? (
                <span
                  className="inline-flex items-center rounded-pill bg-primary-subtle px-2.5 py-1 text-2xs font-medium text-primary-subtle-fg"
                  data-numeric=""
                >
                  Run v{withinYear.schedule_run_version}
                </span>
              ) : null}
              <CardInfo label="Schedule outcome source">
                <p>
                  These four figures are read from the active schedule run snapshot, one field
                  each. Not recomputed in the browser (Invariant I9).
                </p>
                <p>
                  They are mutually exclusive and sum to the scheduled total, which is why they are
                  drawn as a donut rather than bars.
                </p>
              </CardInfo>
            </div>
          </div>
          {withinYear === null ? (
            <p className="text-xs text-text-muted">Loading completion figures…</p>
          ) : withinYear.has_active_schedule_run ? (
            <>
              <span className="sr-only">
                Source: active schedule run
                {withinYear.schedule_run_version === null
                  ? ''
                  : ` v${String(withinYear.schedule_run_version)}`}{' '}
                (Invariant I9). Not recomputed in the browser.
              </span>
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
    </BoltCard>
  );
}
