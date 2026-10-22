import * as React from 'react';
import { CalendarCheck, CirclePause, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { formatInteger, formatWeek } from '@/lib/format';
import { SPILLOVER_YEAR, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { sharePct, spilloverPastYearCount, withinYearSharePct } from '../lib/outcome';

import type { CompletingWithinYear, ScheduleRunSummary } from '../api/types';
import { ScheduledCountInfo, type ScheduledCountFigures } from './scheduled-count-info';
import { ScheduleRunProvenance } from './schedule-run-provenance';
import { StatCard } from './stat-card';

/**
 * The Invariant I9 surface region. Every figure here comes from a single field on
 * the `GET /dashboard/completing-within-year` response (which the backend sources
 * only from the active `ScheduleRun` snapshot) - nothing is recomputed here.
 */

export interface WithinYearKpisProps {
  data: CompletingWithinYear;
  activeRun: ScheduleRunSummary | null | undefined;
}

/** Share of the run's four served outcome buckets, as a display label ("51%").
 *  Same formula as the delivery gauge (`lib/outcome.ts::sharePct`). */
function shareLabel(count: number, data: CompletingWithinYear): string {
  return `${String(sharePct(count, data))}%`;
}

/**
 * Section heading + provenance chips + the four outcome KPI cards. Exported on
 * its own so the Dashboard can lay the KPI row and the outcome table out as two
 * separate boxes (Bold Blocks, 2026-10-01); `WithinYearPanel` below still
 * composes both for any caller that wants the original single block.
 */
export function WithinYearKpis({
  data,
  activeRun,
  pipelineTotal = null,
  cancelled = null,
  onHold = null,
  compact = false,
}: WithinYearKpisProps & ScheduledCountFigures & { compact?: boolean }): React.JSX.Element {
  const size = compact ? 'compact' : 'default';
  const totalCount =
    data.within_year_count +
    data.spillover_count +
    data.left_out_count +
    data.blocked_count;

  return (
    <section className="space-y-s4">
      <div className="flex flex-wrap items-end justify-between gap-s3">
        <div>
          <div className="flex flex-wrap items-center gap-s2">
            <h2 className={compact ? 'font-display text-h2 font-extrabold tracking-tight text-text' : 'font-display text-h1 font-extrabold tracking-tight text-text'}>
              Completing within the year
            </h2>
            {data.has_active_schedule_run ? (
              <Badge
                tone="neutral"
                data-numeric=""
                data-testid="within-year-total-projects"
                className="rounded-pill font-bold px-2.5 py-1 text-2xs"
              >
                {pipelineTotal !== null
                  ? `${formatInteger(totalCount)} scheduled of ${formatInteger(pipelineTotal)}`
                  : `${formatInteger(totalCount)} scheduled`}
              </Badge>
            ) : null}
            {data.has_active_schedule_run ? (
              <ScheduledCountInfo
                scheduled={totalCount}
                pipelineTotal={pipelineTotal}
                cancelled={cancelled}
                onHold={onHold}
                label="About the scheduled project count"
              />
            ) : null}
          </div>
          <p className="text-sm font-medium text-text-muted">
            Outcome of the scheduled projects in the active schedule run
          </p>
        </div>
        {data.has_active_schedule_run ? (
          <ScheduleRunProvenance scheduleRunVersion={data.schedule_run_version} activeRun={activeRun} />
        ) : null}
      </div>

      {!data.has_active_schedule_run ? (
        <EmptyState
          title="No schedule computed yet"
          description="Counts appear here once the schedule is calculated."
        />
      ) : (
        <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-3">
          {/* The one blue tile. "Within year" earns it: it is the number the whole
              application exists to produce. */}
          <StatCard
            size={size}
            variant="feature"
            label="Within year"
            value={data.within_year_count}
            icon={CalendarCheck}
            badge={{ label: `${String(withinYearSharePct(data))}% of run`, tone: 'pop' }}
            caption={`Complete by ${formatWeek(WITHIN_YEAR_WEEK)}`}
          />
          {/* ADR 0024 (client ask 2026-10-13): a 52-week year only. Everything not
              done by W52 is spillover — the served spillover count plus the served
              left-out count (no slot found yet), summed for display; never framed
              as "beyond the 78-week horizon". */}
          <StatCard
            size={size}
            label="Spillover (past W52)"
            value={spilloverPastYearCount(data)}
            tone="warning"
            icon={Clock}
            badge={{ label: shareLabel(spilloverPastYearCount(data), data), tone: 'neutral' }}
            caption={
              data.left_out_count > 0
                ? `Not done by ${formatWeek(WITHIN_YEAR_WEEK)} → ${String(SPILLOVER_YEAR)} · ${String(data.left_out_count)} not yet placed`
                : `Not done by ${formatWeek(WITHIN_YEAR_WEEK)} → ${String(SPILLOVER_YEAR)}`
            }
          />
          {/* P9-F02: mutually exclusive with the counts above — Blocked wins
              outright, so a project is never double-counted across tiles. The ink
              tile is the contrasting second accent of the row.
              P17-R07: "at a stage" keeps this schedule OUTCOME apart from the
              project STATUS On Hold (paused, not in the plan, ADR 0017 §3); the
              muted line quotes the served status count verbatim. */}
          <StatCard
            size={size}
            variant="ink"
            label="On Hold at a stage"
            value={data.blocked_count}
            icon={CirclePause}
            badge={{ label: shareLabel(data.blocked_count, data), tone: data.blocked_count > 0 ? 'drop' : 'pop' }}
            caption="In the plan, waiting at a stage"
            footer={
              onHold !== null && onHold > 0 ? (
                <p className="text-2xs font-medium text-ink-fg/70" data-testid="paused-projects-note">
                  Separately, {formatInteger(onHold)} {onHold === 1 ? 'project is' : 'projects are'} paused
                  (status On Hold) and {onHold === 1 ? 'is' : 'are'} not in the plan.
                </p>
              ) : null
            }
          />
        </div>
      )}
    </section>
  );
}
