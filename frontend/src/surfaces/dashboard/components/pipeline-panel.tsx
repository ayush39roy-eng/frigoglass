import * as React from 'react';

import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import { DonutChart } from '@/components/ui/donut-chart';

import type { CompletingWithinYear } from '../api/types';
import { spilloverPastYearCount } from '../lib/outcome';
import type { BarDatum } from './bar-chart';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';

/**
 * Schedule-run outcome donut (within-year / spillover past W52 / on hold).
 *
 * P17 (ADR 0030): the pipeline COMPOSITION figures (spillover carry-over, newly
 * registered, unregistered, total) moved to `pipeline-row.tsx`. This panel is
 * only the active ScheduleRun snapshot via CompletingWithinYear (Invariant I9),
 * so the two senses of "spillover" never share a card.
 */

export interface PipelinePanelProps {
  /** `null` = the schedule-run figures are still loading or unavailable. */
  withinYear: CompletingWithinYear | null;
}

export function PipelinePanel({ withinYear }: PipelinePanelProps): React.JSX.Element {
  const outcomeBars: BarDatum[] = withinYear?.has_active_schedule_run
    ? [
        {
          key: 'within-year',
          label: 'Completing within year',
          value: withinYear.within_year_count,
          tone: 'success',
        },
        // ADR 0024: one spillover slice on the 52-week year — the served
        // spillover count plus the served left-out count (not done by W52).
        {
          key: 'spillover',
          label: 'Spillover (past W52)',
          value: spilloverPastYearCount(withinYear),
          tone: 'warning',
        },
        // P9-F02: the fourth mutually-exclusive bucket (Blocked wins outright
        // over the other three, per CompletingWithinYear.blocked_count) — kept
        // in the donut so "sum to the scheduled total" stays true.
        {
          key: 'blocked',
          // ADR 0017: bucket key stays `blocked`; shown as "On Hold".
          label: 'On Hold',
          value: withinYear.blocked_count,
          tone: 'warning',
        },
      ]
    : [];

  return (
    <BoltCard>
      <CardHeader>
        <CardTitle>Completion outcome</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
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
                  These figures are read from the active schedule run snapshot. Spillover (past
                  W52) is the run&apos;s spillover count plus its not-yet-placed count — both are
                  projects not done by week 52. Not recomputed in the browser (Invariant I9).
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
                ariaLabel="Active schedule run outcome: within year, spillover past week 52, on hold"
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
