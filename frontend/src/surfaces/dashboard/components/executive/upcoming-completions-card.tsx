import * as React from 'react';
import { Link } from 'react-router-dom';
import { CalendarCheck, CalendarClock } from 'lucide-react';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { CURRENT_WEEK, PLAN_YEAR } from '@/lib/domain-constants';
import { formatInteger, formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session';

import type { CompletingWithinYearRow } from '../../api/types';
import {
  noFinishWeekCount,
  planWeekQuarter,
  QUARTER_LABELS,
  quarterCounts,
  selectUpcomingCompletions,
  UPCOMING_LIST_CAP,
  UPCOMING_WINDOW_WEEKS,
} from '../../lib/upcoming-completions';

/**
 * "Upcoming completions" (owner ask 2026-10-23 — replaces "Hubs at a glance"
 * in the Executive view's middle slot). Answers the leadership question "what
 * lands next, and when does the year's value land?":
 *
 * - a Q1–Q4 strip: the active run's within-year finishes counted per quarter of
 *   the plan year (served `last_step_end_week`, ISO-Thursday month rule), led by
 *   a "Delivered" tile for within-year rows with no served finish week (no stage
 *   left), so the five tiles sum to the served `within_year_count` the KPI
 *   strip shows;
 * - the within-year projects finishing in the next `UPCOMING_WINDOW_WEEKS`
 *   weeks from the served `GET /me` `current_week` (the header WeekPill's
 *   figure), soonest first, each linking to its project.
 *
 * Membership and weeks are served fields of the rows the Dashboard already
 * fetches (`lib/upcoming-completions.ts`) — no endpoint, no recomputed verdict
 * (I9/I19).
 */
export function UpcomingCompletionsCard({
  rows,
}: {
  /** Served `CompletingWithinYear.rows` (`[]` without an active run / while loading). */
  rows: readonly CompletingWithinYearRow[];
}): React.JSX.Element {
  const headingId = React.useId();
  const currentWeek = useSessionStore((s) => s.me?.current_week) ?? CURRENT_WEEK;

  const upcoming = React.useMemo(() => selectUpcomingCompletions(rows, currentWeek), [rows, currentWeek]);
  const quarters = React.useMemo(() => quarterCounts(rows), [rows]);
  const delivered = React.useMemo(() => noFinishWeekCount(rows), [rows]);
  const currentQuarter = planWeekQuarter(Math.min(currentWeek, 52));
  const shown = upcoming.slice(0, UPCOMING_LIST_CAP);
  const more = upcoming.length - shown.length;
  const windowEnd = currentWeek + UPCOMING_WINDOW_WEEKS - 1;

  return (
    <BoltCard
      className="flex h-full flex-col gap-s3 p-s5"
      role="group"
      aria-labelledby={headingId}
      data-testid="exec-upcoming-card"
    >
      <div className="flex items-center justify-between gap-s2">
        <h3 id={headingId} className="flex items-center gap-1.5 label-caps text-text-subtle">
          <CalendarClock className="size-3.5" aria-hidden="true" />
          Upcoming completions
        </h3>
        <CardInfo label="About Upcoming completions">
          <p>
            Projects the active run completes <strong className="text-text">within the year</strong> (On hold
            excluded). <strong className="text-text">Delivered</strong> are those with no stage left in the
            run; the quarter tiles count the rest by the quarter of {String(PLAN_YEAR)} their last stage ends in
            (an ISO week belongs to the month holding its Thursday). Together they add up to the Within year
            figure. The list shows those finishing in
            the next {String(UPCOMING_WINDOW_WEEKS)} weeks from the current week, soonest first. Every week is
            the run&apos;s served finish week.
          </p>
        </CardInfo>
      </div>

      {/* Below `sm` (QA-F28-1) the five tiles do not fit one row of a phone-width
          card: "Delivered" takes a full-width row (label left, figure right)
          and the quarters sit 2 x 2, so every label renders in full (they may
          wrap between words, never inside one). From `sm` up: one row of five. */}
      <ol
        className="grid grid-cols-2 gap-s2 sm:grid-cols-5"
        data-testid="exec-upcoming-strip"
        aria-label={`Within-year completions by when they land in ${String(PLAN_YEAR)}`}
      >
        <li
          className="col-span-2 flex flex-row items-center justify-between gap-s2 rounded-lg border border-dash-hairline bg-success-subtle px-s2 py-1.5 sm:col-span-1 sm:flex-col sm:items-stretch sm:justify-start sm:gap-0"
          data-testid="exec-upcoming-delivered"
          aria-label={`Delivered (no stage left): ${formatInteger(delivered)}`}
        >
          <span className="label-caps text-[0.6rem] text-success-subtle-fg" aria-hidden="true">
            Delivered
          </span>
          <span className="text-lg font-extrabold leading-tight tabular-nums text-success-subtle-fg" data-numeric="" aria-hidden="true">
            {formatInteger(delivered)}
          </span>
        </li>
        {QUARTER_LABELS.map((q, i) => {
          const isCurrent = i === currentQuarter;
          const isPast = i < currentQuarter;
          return (
            <li
              key={q.key}
              className={cn(
                'flex flex-col rounded-lg border px-s2 py-1.5',
                isCurrent ? 'border-primary bg-primary-subtle' : 'border-dash-hairline bg-dash-alt',
              )}
              data-testid="exec-upcoming-quarter"
              data-current={isCurrent ? 'true' : undefined}
              aria-label={`${q.key} (${q.months}): ${formatInteger(quarters[i] ?? 0)} completing${isCurrent ? ', current quarter' : isPast ? ', past' : ''}`}
            >
              <span className="label-caps text-[0.6rem] text-text-subtle" aria-hidden="true">
                {q.key} · <span className="whitespace-nowrap">{q.months}</span>
              </span>
              <span
                className={cn('text-lg font-extrabold leading-tight tabular-nums', isPast ? 'text-text-muted' : 'text-text')}
                data-numeric=""
                aria-hidden="true"
              >
                {formatInteger(quarters[i] ?? 0)}
              </span>
            </li>
          );
        })}
      </ol>

      <div className="space-y-1">
        <h4 className="label-caps text-[0.6rem] text-text-subtle">
          Next {String(UPCOMING_WINDOW_WEEKS)} weeks · {formatWeek(currentWeek)}–{formatWeek(windowEnd)}
        </h4>
        {shown.length === 0 ? (
          <p className="flex items-center gap-1.5 text-xs text-text-muted" data-testid="exec-upcoming-empty">
            <CalendarCheck className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
            No within-year completions in the next {String(UPCOMING_WINDOW_WEEKS)} weeks.
          </p>
        ) : (
          <ul className="space-y-1" aria-label={`Completing in the next ${String(UPCOMING_WINDOW_WEEKS)} weeks`}>
            {shown.map(({ row, week }) => (
              // Below `sm` (QA-F28-1) the row stacks: line 1 is the week chip and
              // the full name (wrapping between words), line 2 is
              // "hub · priority". From `sm` up the meta wrapper is
              // `display: contents`, so hub and pill are the grid's 3rd and 4th
              // columns exactly as before.
              <li
                key={row.project_id}
                className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-s2 gap-y-1 rounded-lg border border-dash-hairline bg-dash-alt px-s3 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto] sm:gap-y-0"
                data-testid="exec-upcoming-row"
              >
                <span
                  className="rounded-sm bg-success-subtle px-1.5 py-0.5 text-2xs font-bold leading-none tabular-nums text-success-subtle-fg"
                  data-numeric=""
                  title={`Last stage ends ${formatWeek(week)}`}
                >
                  {formatWeek(week)}
                </span>
                <Link
                  to={`/projects/${row.project_id}`}
                  className="min-w-0 text-xs font-semibold leading-tight text-text underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {row.project_name}
                </Link>
                <span
                  className="col-start-2 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 sm:contents"
                  data-testid="exec-upcoming-row-meta"
                >
                  <span className="shrink-0 text-2xs text-text-muted">{row.hub}</span>
                  {row.priority ? (
                    <span className="inline-flex items-center gap-x-1.5 sm:contents">
                      <span className="text-2xs text-text-subtle sm:hidden" aria-hidden="true">·</span>
                      <PriorityBandPill priority={row.priority} />
                    </span>
                  ) : (
                    <span aria-hidden="true" />
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
        {more > 0 ? (
          <Link
            to="/projects"
            data-testid="exec-upcoming-more"
            className="inline-block text-2xs font-semibold text-primary underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            +{formatInteger(more)} more in the project register
          </Link>
        ) : null}
      </div>
    </BoltCard>
  );
}
