import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowLeft, FolderKanban, X } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { MultiSelectDropdown, type MultiSelectOption } from '@/components/shared/multi-select-dropdown';
import { useCategories } from '@/lib/api/categories';
import { useMultiSearchParam } from '@/lib/multi-select-filter';
import { planYearLabels, usePlanYear, usePlanYearWindow, yearEndText } from '@/lib/plan-clock';
import { formatInteger, formatWeek } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { cn } from '@/lib/utils';

import type { CompletingWithinYear, CompletingWithinYearRow } from '../api/types';
import { typeCode } from '../lib/analytics';
import { MONTH_LABELS, planWeekMonth } from '../lib/plan-month';
import { OUTCOME_STYLE, outcomeOf } from '../lib/outcome';
import { useRevealOnce } from '../lib/use-reveal-once';
import {
  PROFILE_CATEGORY_PARAM,
  PROFILE_HUB_PARAM,
  PROFILE_TYPE_PARAM,
  isProfileFilterActive,
  matchesProfileFilter,
  profileFilterOptions,
} from '../lib/completion-profile-filter';
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
 *
 * Owner request 2026-11-16: Hub / Project type / Category multi-selects in the
 * header narrow the card's own rows (`lib/completion-profile-filter.ts`) BEFORE
 * the grouping above, so the bars, the month's weeks, the project list and every
 * count in the card come from the same kept rows. The selection lives in the URL
 * (`cp_hub`, `cp_type`, `cp_category`), like the other Dashboard filters.
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
      {/* The chart is aria-hidden (the buttons below are the control): no tabbable svg inside it. */}
      <BarChart accessibilityLayer={false} data={points} margin={{ top: 18, right: 8, bottom: 0, left: 0 }}>
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

/** One compact header filter: the shared multi-select, with a count badge on
 *  the trigger while anything is selected. */
function ProfileFilterDropdown({
  id,
  label,
  allLabel,
  pluralNoun,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  allLabel: string;
  pluralNoun: string;
  options: readonly MultiSelectOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  return (
    <MultiSelectDropdown
      id={id}
      label={label}
      hideLabel
      allLabel={allLabel}
      pluralNoun={pluralNoun}
      options={options}
      value={value}
      onChange={onChange}
      align="end"
      triggerClassName="h-7 w-auto min-w-[7.5rem] max-w-[11rem] rounded-pill text-2xs"
      triggerIcon={
        value.length > 0 ? (
          <span
            aria-hidden="true"
            data-testid={`${id}-badge`}
            className="grid h-4 min-w-4 shrink-0 place-items-center rounded-pill bg-primary px-1 text-[10px] font-bold leading-none text-primary-fg tabular-nums"
          >
            {formatInteger(value.length)}
          </span>
        ) : undefined
      }
      data-testid={id}
    />
  );
}

export function CompletionProfileCard({ data }: CompletionProfileCardProps): React.JSX.Element {
  const reducedMotion = usePrefersReducedMotion();
  const [chartRef, revealed] = useRevealOnce<HTMLDivElement>();
  // P53 (R53-1 / R53-6): the plan-year window is served; the card plots the
  // week OF the plan year (absolute − (plan_year_start_week − 1)), 1..52.
  const window = usePlanYearWindow();
  const offset = window ? window.start - 1 : 0;
  const horizon = window ? window.end - window.start + 1 : 52;
  const yearEnd = window?.end ?? null;
  // P37: the served plan year places a week in its month (ISO-Thursday rule).
  const planYear = usePlanYear();
  const yearLabels = planYearLabels(planYear);
  const [month, setMonth] = React.useState<number | null>(null);
  const [week, setWeek] = React.useState<number | null>(null);

  // Every plotted finish of the served rows, before the card's own filters.
  const allFinishes = React.useMemo<Finish[]>(() => {
    const out: Finish[] = [];
    if (planYear === null) return out;
    for (const row of data.rows) {
      // The server's within-year flag decides membership (I9); its finish week
      // only positions it on the W1–W52 axis.
      if (outcomeOf(row) !== 'within_year') continue;
      if (row.last_step_end_week === null) continue;
      const w = Math.min(Math.max(row.last_step_end_week - offset, 1), horizon);
      out.push({ row, week: w, month: planWeekMonth(w, planYear) });
    }
    return out.sort((a, b) => a.week - b.week || a.row.project_name.localeCompare(b.row.project_name));
  }, [data.rows, horizon, planYear, offset]);

  // Options: only values present among the plotted rows (already scoped to the
  // header hub / country filter), in canonical / served rank order.
  const { categories: categoryList } = useCategories();
  const options = React.useMemo(
    () => profileFilterOptions(allFinishes.map((f) => f.row), categoryList),
    [allFinishes, categoryList],
  );
  const hubValues = React.useMemo(() => options.hubs.map((o) => o.value), [options.hubs]);
  const typeValues = React.useMemo(() => options.types.map((o) => o.value), [options.types]);
  const categoryValues = React.useMemo(() => options.categories.map((o) => o.value), [options.categories]);
  // A URL value no longer among the options (e.g. after a header hub change) is ignored, not applied.
  const [hubs, setHubs] = useMultiSearchParam(PROFILE_HUB_PARAM, hubValues);
  const [types, setTypes] = useMultiSearchParam(PROFILE_TYPE_PARAM, typeValues);
  const [categories, setCategories] = useMultiSearchParam(PROFILE_CATEGORY_PARAM, categoryValues);
  const [, setParams] = useSearchParams();
  const filter = React.useMemo(() => ({ hubs, types, categories }), [hubs, types, categories]);
  const filterActive = isProfileFilterActive(filter);
  // One navigation for all three params (React Router's functional setter is not queued).
  const clearFilters = React.useCallback(() => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(PROFILE_HUB_PARAM);
        next.delete(PROFILE_TYPE_PARAM);
        next.delete(PROFILE_CATEGORY_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [setParams]);

  const finishes = React.useMemo(
    () => (filterActive ? allFinishes.filter((f) => matchesProfileFilter(f.row, filter)) : allFinishes),
    [allFinishes, filter, filterActive],
  );

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
    if (month === null || planYear === null) return [];
    const out: BarPoint[] = [];
    for (let w = 1; w <= horizon; w += 1) {
      if (planWeekMonth(w, planYear) !== month) continue;
      out.push({ key: w, label: formatWeek(w + offset), completed: finishes.filter((f) => f.week === w).length });
    }
    return out;
  }, [finishes, month, horizon, planYear, offset]);

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
            Spillover projects are not done by {yearEndText(yearEnd, formatWeek)} (they carry into{' '}
            {yearLabels.spilloverYear}, including any not yet placed), and on-hold projects have no finish week, so
            neither is plotted; their counts are on the cards below.
          </p>
          <p>
            The Hub, Type and Category filters on this card narrow its own projects only; every bar,
            week and list then counts the same narrowed projects.
          </p>
        </CardInfo>
        {allFinishes.length > 0 ? (
          <div
            role="group"
            aria-label="Completion profile filters"
            className="flex w-full flex-wrap items-center gap-s2"
            data-testid="completion-profile-filters"
          >
            <ProfileFilterDropdown
              id="cp-filter-hub"
              label="Hub"
              allLabel="All hubs"
              pluralNoun="hubs"
              options={options.hubs}
              value={hubs}
              onChange={setHubs}
            />
            <ProfileFilterDropdown
              id="cp-filter-type"
              label="Project type"
              allLabel="All types"
              pluralNoun="types"
              options={options.types}
              value={types}
              onChange={setTypes}
            />
            <ProfileFilterDropdown
              id="cp-filter-category"
              label="Category"
              allLabel="All categories"
              pluralNoun="categories"
              options={options.categories}
              value={categories}
              onChange={setCategories}
            />
            {filterActive ? (
              <>
                <button
                  type="button"
                  onClick={clearFilters}
                  aria-label="Clear completion profile filters"
                  className="inline-flex h-7 items-center gap-1 rounded-pill px-2 text-2xs font-semibold text-text-muted hover:bg-dash-alt hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3.5" aria-hidden="true" />
                  Clear
                </button>
                <p role="status" className="text-2xs font-medium text-text-muted" data-testid="completion-profile-filtered-note">
                  Filtered: {formatInteger(finishes.length)} of {formatInteger(allFinishes.length)} projects
                </p>
              </>
            ) : null}
          </div>
        ) : null}
      </CardHeader>

      <CardContent>
        {allFinishes.length === 0 ? (
          <EmptyState
            title="No finishes by W52"
            description="No project in this run is scheduled to finish within the year."
          />
        ) : finishes.length === 0 ? (
          <EmptyState
            title="No projects match these filters"
            description="No within-year finish in this run matches the selected hub, type and category."
            action={
              <button
                type="button"
                onClick={clearFilters}
                className="rounded-pill border-[1.5px] border-dash-hairline px-3 py-1 text-xs font-semibold text-text hover:bg-dash-alt focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Clear filters
              </button>
            }
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
                {MONTH_NAMES[month]} {planYear ?? ''}
                <span className="ml-s2 font-medium text-text-muted">
                  {plural(months[month]?.completed ?? 0)}
                  {week !== null ? ` · ${formatWeek(week + offset)}: ${plural(listed.length)}` : ''}
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
                {listed.length === 0 ? (
                  <p className="py-s2 text-xs text-text-muted" data-testid="completion-profile-list-empty">
                    No project {filterActive ? 'matching these filters ' : ''}finishes in{' '}
                    {week !== null ? formatWeek(week + offset) : (MONTH_NAMES[month] ?? '')}.
                  </p>
                ) : null}
                <ul
                  aria-label={`Projects completing in ${week !== null ? formatWeek(week + offset) : (MONTH_NAMES[month] ?? '')}`}
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
