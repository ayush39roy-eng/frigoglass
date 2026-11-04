import * as React from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  CalendarCheck,
  CalendarClock,
  CircleSlash,
  FileSpreadsheet,
  Layers,
  ListChecks,
  TrendingDown,
} from 'lucide-react';

import { BarChart } from '@/components/ui/bar-chart';
import { ExecKpiTile } from '@/surfaces/dashboard/components/executive/exec-kpi-tile';
import { ChartCard, HeroDonut, type Slice } from '@/surfaces/dashboard/components/executive/executive-charts';

import { int } from '../../components/figures';
import { OUTCOME_LABEL } from '../../components/outcome-meta';
import { ProjectRowsTable, WorkingsDisclosure, type RowColumn } from '../../components/result-parts';
import type { Breakdown, ImportChange, ImportSimulateResponse } from '../import-types';
import { useEffectiveYear } from '../use-year-filter';
import { planYearOf, weekOrDash } from '../week-labels';
import { breakdownFor, YEAR_ALL, YEAR_NOT_PLACED, yearOptions } from '../year-filter';
import { FeatureCard } from './feature-card';
import { IssueList, type IssueItem } from './issue-list';
import { ServedStackChart } from './served-stack-chart';

/**
 * Results → Executive (P32-R05 C2), modelled on the Dashboard Executive view (ADR 0039):
 * the same KPI tiles, hero donut and chart cards, fed by the served `breakdowns.by_year`
 * block the Year filter selects. Every figure is a served field (I9); a response without
 * `breakdowns` falls back to the served KPI figures.
 */

const OUTCOME_FILL: Record<keyof Breakdown['outcomes'], string> = {
  within_year: 'hsl(var(--color-success))',
  spillover: 'hsl(var(--color-warning))',
  left_out: 'hsl(var(--color-danger) / 0.7)',
  blocked: 'hsl(var(--color-border-strong))',
  data_error: 'hsl(var(--color-danger))',
  excluded: 'hsl(var(--color-text-subtle))',
};
const OUTCOME_KEYS = ['within_year', 'spillover', 'left_out', 'blocked', 'data_error', 'excluded'] as const;

function ChangeList({
  title,
  rows,
  empty,
  base,
  testId,
}: {
  title: string;
  rows: readonly ImportChange[];
  empty: string;
  base: number;
  testId: string;
}): React.JSX.Element {
  const columns: RowColumn<ImportChange>[] = [
    { header: 'Project', cell: (c) => <span className="font-medium">{c.name}</span> },
    { header: 'Hub', cell: (c) => c.hub },
    {
      header: 'Finish',
      cell: (c) => (
        <span className="whitespace-nowrap tabular-nums">
          {weekOrDash(c.before_finish_week, base)} <span aria-hidden="true">→</span>
          <span className="sr-only"> to </span> {weekOrDash(c.after_finish_week, base)}
        </span>
      ),
    },
  ];
  return (
    <FeatureCard
      icon={TrendingDown}
      title={`${title} (${int(rows.length)})`}
      hint="Plan projects only, whole plan (not filtered by year)"
      testId={testId}
    >
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">{empty}</p>
      ) : (
        <ProjectRowsTable rows={rows} columns={columns} rowKey={(c) => c.ref} label={title} />
      )}
    </FeatureCard>
  );
}

export function ResultsExecutive({ result }: { result: ImportSimulateResponse }): React.JSX.Element {
  const k = result.kpis;
  const base = result.base_year;
  const year = planYearOf(result.plan_year_end_week, base);
  const merge = result.mode === 'merge';
  const key = useEffectiveYear(result);
  const block = breakdownFor(result, key);
  const yearLabel = yearOptions(result).find((o) => o.key === key)?.label ?? 'All projects';

  const nameByRef = React.useMemo(() => new Map(result.projects.map((p) => [p.ref, p.name])), [result.projects]);
  const issues: IssueItem[] = React.useMemo(
    () =>
      result.issues.map((i, idx) => ({
        id: `${String(idx)}-${i.code}`,
        severity: i.severity,
        code: i.code,
        message: i.message,
        where: i.ref === null ? null : (nameByRef.get(i.ref) ?? null),
      })),
    [result.issues, nameByRef],
  );

  // "Not placed" (C1: left_out + blocked + data_error) is always one served figure: the
  // served `not_placed` block's total for All / Not placed; a finish-year block holds only
  // placed projects, so its served `left_out` (0) is shown.
  const notPlaced =
    block === null
      ? k.left_out
      : key === YEAR_ALL
        ? (breakdownFor(result, YEAR_NOT_PLACED)?.total ?? block.outcomes.left_out)
        : key === YEAR_NOT_PLACED
          ? block.total
          : block.outcomes.left_out;

  const slices: Slice[] = block
    ? OUTCOME_KEYS.map((o) => ({ key: o, label: OUTCOME_LABEL[o], count: block.outcomes[o], fill: OUTCOME_FILL[o] }))
    : [];

  return (
    <div className="space-y-s5" data-testid="import-executive" data-year={key}>
      <section
        aria-label="Key figures"
        className="grid grid-cols-2 gap-s3 sm:grid-cols-3 xl:grid-cols-6"
        data-testid="import-exec-kpis"
      >
        <ExecKpiTile
          label={key === YEAR_ALL ? 'Projects scheduled' : yearLabel}
          value={block ? block.total : k.projects_total}
          icon={Layers}
          tone="primary"
          variant="feature"
          testId="import-kpi-total"
        />
        <ExecKpiTile
          label={`Finish in ${String(year)}`}
          value={block ? block.outcomes.within_year : k.within_plan_year}
          icon={CalendarCheck}
          tone="success"
          testId="import-kpi-within"
        />
        <ExecKpiTile
          label="Spill over"
          value={block ? block.outcomes.spillover : k.spillover}
          icon={CalendarClock}
          tone="warning"
          testId="import-kpi-spillover"
        />
        <ExecKpiTile label="Not placed" value={notPlaced} icon={CircleSlash} tone="danger" testId="import-kpi-leftout" />
        <ExecKpiTile
          label="From the file"
          value={block ? block.file : k.file_projects}
          badge={`${int(block ? block.plan : k.plan_projects)} plan`}
          icon={FileSpreadsheet}
          tone="neutral"
          testId="import-kpi-file"
        />
        {merge && k.before_within_plan_year !== null && k.after_within_plan_year_existing !== null ? (
          <ExecKpiTile
            label={`Plan in ${String(year)}: before → after`}
            value={`${int(k.before_within_plan_year)} → ${int(k.after_within_plan_year_existing)}`}
            icon={ArrowRightLeft}
            tone="neutral"
            variant="ink"
            testId="import-kpi-before-after"
          />
        ) : (
          <ExecKpiTile
            label="Not scheduled"
            value={k.excluded}
            badge="on hold etc."
            icon={ListChecks}
            tone="neutral"
            testId="import-kpi-excluded"
          />
        )}
      </section>

      {block === null ? (
        <FeatureCard
          icon={AlertTriangle}
          title="Charts unavailable"
          hint="This server does not send the year breakdown; the figures above are for the whole plan."
          testId="import-exec-fallback"
        />
      ) : (
        <>
          <div className="grid gap-gutter lg:grid-cols-2">
            <HeroDonut
              title="Outcome"
              testId="import-exec-outcome"
              slices={slices}
              total={block.total}
              totalLabel="projects"
              info={
                <p>
                  Every project in the selection by its scheduled outcome. Counts and the total are served by the
                  planner for the selected year; nothing is counted in the browser.
                </p>
              }
            />
            <ChartCard
              title="Finishes per quarter"
              testId="import-exec-quarters"
              info={<p>Placed projects by the quarter they finish in, as served, in calendar order.</p>}
            >
              {block.by_finish_quarter.length === 0 ? (
                <p className="text-xs text-text-muted">No placed project in this selection.</p>
              ) : (
                <BarChart
                  ariaLabel="Finishes per quarter"
                  data={block.by_finish_quarter.map((q) => ({ key: q.key, label: q.label, value: q.count }))}
                />
              )}
            </ChartCard>
          </div>
          <div className="grid gap-gutter md:grid-cols-2">
            {(
              [
                ['by_category', 'By category'],
                ['by_hub', 'By hub'],
                ['by_priority', 'By priority'],
                ['by_status', 'By status'],
              ] as const
            ).map(([dim, title]) => (
              <ServedStackChart
                key={dim}
                title={title}
                testId={`import-exec-${dim.replace('by_', '')}`}
                buckets={block[dim]}
                info={
                  <p>
                    One bar per value: within the plan year, spill over and not placed, with the served count
                    finishing within the year out of the served total.
                  </p>
                }
              />
            ))}
          </div>
        </>
      )}

      {merge ? (
        <div className="grid gap-gutter lg:grid-cols-2">
          <ChangeList
            title={`Newly slipping out of ${String(year)}`}
            rows={result.changes.newly_slipping}
            empty="No plan project slips out of the year."
            base={base}
            testId="import-newly-slipping"
          />
          <ChangeList
            title={`Recovered into ${String(year)}`}
            rows={result.changes.recovered}
            empty="No plan project moves into the year."
            base={base}
            testId="import-recovered"
          />
        </div>
      ) : null}

      <FeatureCard icon={AlertTriangle} title="Issues" hint="What the planner flagged while placing the projects">
        <IssueList items={issues} label="Result issues" />
      </FeatureCard>
      <WorkingsDisclosure lines={result.workings} />
    </div>
  );
}
