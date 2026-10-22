import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, FolderKanban } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { DISPLAY_HORIZON_WEEKS, PLAN_YEAR, SPILLOVER_YEAR, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatInteger, formatWeek } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

import type { CompletingWithinYear, CompletingWithinYearRow } from '../api/types';
import { typeCode } from '../lib/analytics';
import { MONTH_LABELS, planWeekMonth } from '../lib/plan-month';
import { OUTCOME_STYLE, outcomeOf } from '../lib/outcome';
import { useRevealOnce } from '../lib/use-reveal-once';
import { CardInfo } from '@/components/ui/card-info';

/**
 * COMPLETION PROFILE: within-year finishes per calendar month of the plan year
 * (owner ask 2026-10-22: monthly bars only; select a month to open its weeks and
 * the projects behind them).
 *
 * THE SERIES IS REAL, AND IT IS NOT A HISTORY. The API has no per-run outcome
 * counts (`ScheduleRunSummary` is run metadata only) and `GET /dashboard/*` is a
 * single active-run snapshot, so no cross-run trend exists and none is drawn.
 * What is genuinely week-indexed is `CompletingWithinYear.rows[].last_step_end_week`,
 * the week each project's last scheduled step ends in the active run. Each bar
 * counts the within-year projects whose last step ends in that month (or week)
 * only, not cumulatively. Weeks map to months through `lib/plan-month.ts` (ISO
 * week of the plan year, month of its Thursday), so the twelve bars sum to the
 * within-year finishes. Spillover finishes after W52 by definition and is never
 * drawn on W53+ columns (ADR 0024).
 *
 * Membership uses `lib/outcome.ts`'s shared precedence, so a `blocked` row is
 * excluded here exactly as it is excluded from `within_year_count` (I9). The
 * project list is the same rows the bars count; nothing is fetched or derived
 * beyond grouping them.
 */

export interface CompletionProfileCardProps {
  data: CompletingWithinYear;
}

interface Finish {
  row: CompletingWithinYearRow;
  week: number;
  month: number;
}

interface BarPoint {
  key: number;
  label: string;
  completed: number;
}

const CHART_HEIGHT = 240;

const TOOLTIP_STYLE = {
  background: 'hsl(var(--color-surface))',
  color: 'hsl(var(--color-text))',
  border: '1px solid hsl(var(--color-dash-hairline))',
  borderRadius: '1rem',
  fontSize: 12,
  boxShadow: 'var(--shadow-pop)',
} as const;

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

function plural(n: number): string {
  return `${formatInteger(n)} ${n === 1 ? 'project' : 'projects'}`;
}

function CountBars({
  points,
  selected,
  onSelect,
  tooltipLabel,
  reducedMotion,
}: {
  points: BarPoint[];
  selected: number | null;
  onSelect: (key: number) => void;
  tooltipLabel: string;
  reducedMotion: boolean;
}): React.JSX.Element {
  const fill = `hsl(var(${OUTCOME_STYLE.within_year.colorToken}))`;
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={points} margin={{ top: 18, right: 8, bottom: 0, left: 0 }}>
        <CartesianGrid stroke="hsl(var(--color-dash-hairline))" strokeDasharray="4 4" horizontal vertical={false} />
        <XAxis
          dataKey="label"
          interval={0}
          tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          allowDecimals={false}
          width={34}
          tick={{ fill: 'hsl(var(--color-text-subtle))', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
        />
        <Tooltip
          cursor={{ fill: 'hsl(var(--color-surface-sunken))' }}
          formatter={(value: unknown) =>
            [typeof value === 'number' ? formatInteger(value) : String(value ?? ''), tooltipLabel] as [string, string]
          }
          contentStyle={TOOLTIP_STYLE}
          isAnimationActive={!reducedMotion}
        />
        <Bar
          dataKey="completed"
          radius={[6, 6, 0, 0]}
          maxBarSize={36}
          isAnimationActive={!reducedMotion}
          className="cursor-pointer"
          onClick={(entry: { payload?: BarPoint }) => {
            if (entry.payload && entry.payload.completed > 0) onSelect(entry.payload.key);
          }}
        >
          {points.map((p) => (
            <Cell key={p.key} fill={fill} fillOpacity={selected === null || selected === p.key ? 1 : 0.35} />
          ))}
          <LabelList
            dataKey="completed"
            position="top"
            offset={4}
            fontSize={10}
            fontWeight={700}
            fill="hsl(var(--color-text-muted))"
            formatter={(v: unknown) => (typeof v === 'number' && v > 0 ? formatInteger(v) : '')}
          />
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/** Keyboard / screen-reader route to the same selection the bars offer. The
 *  bars are a drawing (aria-hidden); these buttons are the accessible control,
 *  visible only while focused. */
function SelectButtons({
  points,
  label,
  describe,
  onSelect,
}: {
  points: BarPoint[];
  label: string;
  describe: (p: BarPoint) => string;
  onSelect: (key: number) => void;
}): React.JSX.Element {
  return (
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {points.map((p) => (
        <li key={p.key}>
          <button
            type="button"
            disabled={p.completed === 0}
            onClick={() => onSelect(p.key)}
            className="sr-only rounded-pill bg-dash-alt px-2 py-0.5 text-2xs font-semibold text-text focus:not-sr-only focus:ring-2 focus:ring-ring"
          >
            {describe(p)}
          </button>
        </li>
      ))}
    </ul>
  );
}

export function CompletionProfileCard({ data }: CompletionProfileCardProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const [chartRef, revealed] = useRevealOnce<HTMLDivElement>();
  const horizon = DISPLAY_HORIZON_WEEKS;
  const [month, setMonth] = React.useState<number | null>(null);
  const [week, setWeek] = React.useState<number | null>(null);

  const finishes = React.useMemo<Finish[]>(() => {
    const out: Finish[] = [];
    for (const row of data.rows) {
      // The server's within-year flag decides membership (I9); its finish week
      // only positions it on the W1–W52 axis.
      if (outcomeOf(row) !== 'within_year') continue;
      if (row.last_step_end_week === null) continue;
      const w = Math.min(Math.max(row.last_step_end_week, 1), horizon);
      out.push({ row, week: w, month: planWeekMonth(w) });
    }
    return out.sort((a, b) => a.week - b.week || a.row.project_name.localeCompare(b.row.project_name));
  }, [data.rows, horizon]);

  const months = React.useMemo<BarPoint[]>(
    () =>
      MONTH_LABELS.map((label, i) => ({
        key: i,
        label,
        completed: finishes.filter((f) => f.month === i).length,
      })),
    [finishes],
  );

  const weeks = React.useMemo<BarPoint[]>(() => {
    if (month === null) return [];
    const out: BarPoint[] = [];
    for (let w = 1; w <= horizon; w += 1) {
      if (planWeekMonth(w) !== month) continue;
      out.push({ key: w, label: formatWeek(w), completed: finishes.filter((f) => f.week === w).length });
    }
    return out;
  }, [finishes, month, horizon]);

  const listed = finishes.filter((f) => (week !== null ? f.week === week : f.month === month));

  const openMonth = (m: number): void => {
    setMonth(m);
    setWeek(null);
  };
  const toggleWeek = (w: number): void => setWeek((cur) => (cur === w ? null : w));
  const back = (): void => {
    setMonth(null);
    setWeek(null);
  };

  return (
    <BoltCard>
      <CardHeader className="flex-wrap">
        <CardTitle>Completion profile</CardTitle>
        <span className="inline-flex items-center rounded-pill bg-dash-alt px-2.5 py-1 text-2xs font-medium text-text-muted">
          Active run · {formatInteger(horizon)}-week year
        </span>
        <CardInfo label="Completion profile source">
          <p>
            Within-year projects whose last scheduled step ends in each month of the{' '}
            {formatInteger(horizon)}-week plan year, each month on its own (not cumulative). Counted from
            the <code>last_step_end_week</code> and outcome flags on the run&apos;s own project rows (
            <code>GET /dashboard/completing-within-year</code>). Select a month to see its weeks and the
            projects finishing in it; select a week to narrow the list.
          </p>
          <p>
            A plan week belongs to the month holding its Thursday (ISO 8601), so the twelve bars add up
            to the within-year total. This is a profile across one run&apos;s plan year, not a history
            across runs. No sample or illustrative data appears on this card.
          </p>
          <p>
            Spillover projects are not done by {formatWeek(WITHIN_YEAR_WEEK)} (they carry into{' '}
            {SPILLOVER_YEAR}, including any not yet placed), and on-hold projects have no finish week, so
            neither is plotted; their counts are on the cards below.
          </p>
        </CardInfo>
      </CardHeader>

      <CardContent>
        {finishes.length === 0 ? (
          <EmptyState
            title="No finishes by W52"
            description="No project in this run is scheduled to finish within the year."
          />
        ) : month === null ? (
          <div data-testid="completion-profile-monthly">
            <p className="mb-s3 text-2xs font-medium text-text-muted">
              Completed per month (that month only). Select a month to see its weeks and projects.
            </p>
            <div ref={chartRef} aria-hidden="true" className="w-full [&_*:focus]:outline-none" style={{ height: CHART_HEIGHT }}>
              {revealed ? (
                <CountBars
                  points={months}
                  selected={null}
                  onSelect={openMonth}
                  tooltipLabel="Completed this month"
                  reducedMotion={reducedMotion}
                />
              ) : null}
            </div>
            <SelectButtons
              points={months}
              label="Within-year projects completed per month"
              describe={(p) => `${MONTH_NAMES[p.key] ?? p.label}: ${formatInteger(p.completed)}`}
              onSelect={openMonth}
            />
          </div>
        ) : (
          <div data-testid="completion-profile-month-detail">
            <div className="mb-s3 flex flex-wrap items-center gap-s3">
              <button
                type="button"
                onClick={back}
                className="inline-flex items-center gap-1 rounded-pill border-[1.5px] border-dash-hairline px-2.5 py-1 text-2xs font-semibold text-text hover:bg-dash-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ArrowLeft className="size-3.5" aria-hidden="true" />
                All months
              </button>
              <h4 className="text-sm font-bold text-text">
                {MONTH_NAMES[month]} {PLAN_YEAR}
                <span className="ml-s2 font-medium text-text-muted">
                  {plural(months[month]?.completed ?? 0)}
                  {week !== null ? ` · ${formatWeek(week)}: ${plural(listed.length)}` : ''}
                </span>
              </h4>
            </div>
            <div className="grid gap-s5 lg:grid-cols-2">
              <div>
                <p className="mb-s2 text-2xs font-medium text-text-muted">
                  Per week. Select a week to narrow the list.
                </p>
                <div aria-hidden="true" className="w-full [&_*:focus]:outline-none" style={{ height: CHART_HEIGHT }}>
                  <CountBars
                    points={weeks}
                    selected={week}
                    onSelect={toggleWeek}
                    tooltipLabel="Completed this week"
                    reducedMotion={reducedMotion}
                  />
                </div>
                <SelectButtons
                  points={weeks}
                  label={`Within-year projects completed per week in ${MONTH_NAMES[month] ?? ''}`}
                  describe={(p) => `${p.label}: ${formatInteger(p.completed)}`}
                  onSelect={toggleWeek}
                />
              </div>
              <div className="min-w-0 lg:border-l lg:border-dash-hairline lg:pl-s5">
                <ul
                  aria-label={`Projects completing in ${week !== null ? formatWeek(week) : (MONTH_NAMES[month] ?? '')}`}
                  className="max-h-[272px] divide-y divide-dash-hairline overflow-y-auto pr-s1"
                >
                  {listed.map(({ row, week: w }) => (
                    <li key={row.project_id} className="flex items-center gap-s3 py-s2">
                      <span className="grid size-8 shrink-0 place-items-center rounded-xl bg-success-subtle text-success-subtle-fg">
                        <FolderKanban className="size-4" aria-hidden="true" />
                      </span>
                      <span className="min-w-0 flex-1">
                        <Link
                          to={`/projects/${row.project_id}`}
                          title={`${row.project_name}: open in Project Workspace`}
                          className="block truncate text-sm font-semibold text-text hover:text-primary hover:underline"
                        >
                          {row.project_name}
                        </Link>
                        <span className="block truncate text-2xs text-text-muted">
                          {row.hub}
                          {row.type !== null ? ` · ${typeCode(row.type)}` : ''}
                          {row.priority !== null ? ` · ${row.priority}` : ''}
                        </span>
                      </span>
                      <span
                        className={cn(
                          'shrink-0 rounded-pill px-2 py-0.5 text-2xs font-bold tabular-nums',
                          'bg-success-subtle text-success-subtle-fg',
                        )}
                        data-numeric=""
                      >
                        {formatWeek(w)}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </BoltCard>
  );
}
