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

import { ExecKpiTile } from '@/surfaces/dashboard/components/executive/exec-kpi-tile';
import { categoryRank, dashCatFill } from '@/lib/categorical-palette';
import { formatInteger } from '@/lib/format';
import { ChartCard, HeroDonut, type Slice } from '@/surfaces/dashboard/components/executive/executive-charts';

import { int } from '../../components/figures';
import { OUTCOME_LABEL } from '../../components/outcome-meta';
import { ProjectRowsTable, WorkingsDisclosure, type RowColumn } from '../../components/result-parts';
import type { Breakdown, BreakdownBucket, ImportChange, ImportSimulateResponse } from '../import-types';
import { bucketLabel } from '../bucket-label';
import { useEffectiveYear } from '../use-year-filter';
import { planYearOf, weekOrDash } from '../week-labels';
import { breakdownFor, YEAR_ALL, yearOptions } from '../year-filter';
import {
  bucketDrill,
  changeDrill,
  drillLabel,
  execTileDrill,
  outcomeDrill,
  quarterDrill,
  type BucketDim,
  type Drill,
  type ExecTile,
} from '../drilldown';
import { useDrill } from '../drill-store';
import { DrillNumber } from './drill-number';
import { FeatureCard } from './feature-card';
import { QuarterBars } from './quarter-bars';
import { IssueList, type IssueItem } from './issue-list';

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
type OutcomeKey = (typeof OUTCOME_KEYS)[number];

type DonutDim = 'by_category' | 'by_hub' | 'by_priority' | 'by_status';
const DONUTS: readonly (readonly [DonutDim, string])[] = [
  ['by_category', 'Projects by category'],
  ['by_hub', 'Projects by hub'],
  ['by_priority', 'Projects by priority'],
  ['by_status', 'Projects by status'],
];

/**
 * One Dashboard-style donut per dimension (owner 2026-11-05: "make pie chart as present in the
 * dashboard"): the Dashboard's `HeroDonut` with its palette, centre total and a read-only
 * legend. Slices are the served bucket `total`s, the centre is the served block total (Σ
 * buckets = total, C1), the tooltip prints the bucket's served within / spill / not-placed
 * counts. Counts only: the buckets serve no share, so none is shown.
 */
function BucketDonut({
  title,
  testId,
  dim,
  buckets,
  total,
  result,
  yearKey,
}: {
  title: string;
  testId: string;
  dim: DonutDim;
  buckets: readonly BreakdownBucket[];
  total: number;
  result: ImportSimulateResponse;
  yearKey: string;
}): React.JSX.Element {
  const open = useDrill((s) => s.open);
  const drillOf = (key: string): Drill => bucketDrill(result, yearKey, dim satisfies BucketDim, key);
  const slices: Slice[] = buckets.map((b, i) => ({
    key: b.key,
    label: bucketLabel(b.key),
    count: b.total,
    // Category keeps the Dashboard's fixed hue per category; the others go by served order.
    fill: dashCatFill(dim === 'by_category' ? categoryRank(b.key) : i),
    detail:
      `${formatInteger(b.within_year)} within the plan year · ${formatInteger(b.spillover)} spill over · ` +
      `${formatInteger(b.not_placed)} not placed`,
  }));
  return (
    <HeroDonut
      title={title}
      testId={testId}
      slices={slices}
      total={total}
      totalLabel="projects"
      legend
      onSliceOpen={(key, opener) => open(drillOf(key), opener)}
      sliceOpenLabel={(sl) => drillLabel(drillOf(sl.key))}
      info={
        <p>
          Projects in the selected year by {title.replace('Projects by ', '')}. Hover a slice for how many finish
          within the plan year, spill over or are not placed; click a slice or a chip to list its projects. Every
          count is served by the planner.
        </p>
      }
    />
  );
}

function ChangeList({
  title,
  rows,
  empty,
  base,
  testId,
  drill,
}: {
  title: string;
  rows: readonly ImportChange[];
  empty: string;
  base: number;
  testId: string;
  drill: Drill;
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
      actions={
        <DrillNumber
          drill={drill}
          className="rounded-pill bg-surface-sunken px-2.5 py-0.5 text-2xs font-semibold text-text"
          testId={`${testId}-drill`}
        >
          {`${int(rows.length)} project${rows.length === 1 ? '' : 's'}`}
        </DrillNumber>
      }
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

  const open = useDrill((st) => st.open);
  // Every tile's figure and the projects behind it come from ONE selection (P32-R07,
  // `drilldown.ts`): the served block for the Year filter, else the served kpis.
  const tile = (t: ExecTile) => execTileDrill(result, key, t);
  const opener = (t: ExecTile) => {
    const d = tile(t);
    return { value: d.figure, onOpen: (el: HTMLButtonElement) => open(d, el), openLabel: drillLabel(d) };
  };
  const fileDrill = tile('file');
  const planDrill = tile('plan');
  const beforeDrill = tile('before');
  const afterDrill = tile('after');

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
          {...opener('total')}
          icon={Layers}
          tone="primary"
          variant="feature"
          testId="import-kpi-total"
        />
        <ExecKpiTile
          label={`Finish in ${String(year)}`}
          {...opener('within')}
          icon={CalendarCheck}
          tone="success"
          testId="import-kpi-within"
        />
        <ExecKpiTile
          label="Spill over"
          {...opener('spillover')}
          icon={CalendarClock}
          tone="warning"
          testId="import-kpi-spillover"
        />
        <ExecKpiTile label="Not placed" {...opener('not_placed')} icon={CircleSlash} tone="danger" testId="import-kpi-leftout" />
        <ExecKpiTile
          label="From the file"
          value={fileDrill.figure}
          valueNode={<DrillNumber drill={fileDrill} testId="import-kpi-file-drill" />}
          badgeNode={
            <DrillNumber drill={planDrill} testId="import-kpi-plan-drill">
              {`${int(planDrill.figure)} plan`}
            </DrillNumber>
          }
          icon={FileSpreadsheet}
          tone="neutral"
          testId="import-kpi-file"
        />
        {merge && k.before_within_plan_year !== null && k.after_within_plan_year_existing !== null ? (
          <ExecKpiTile
            label={`Plan in ${String(year)}: before → after`}
            value={`${int(k.before_within_plan_year)} → ${int(k.after_within_plan_year_existing)}`}
            valueNode={
              <>
                <DrillNumber drill={beforeDrill} testId="import-kpi-before-drill" />
                <span aria-hidden="true">{' → '}</span>
                <DrillNumber drill={afterDrill} testId="import-kpi-after-drill" />
              </>
            }
            icon={ArrowRightLeft}
            tone="neutral"
            variant="ink"
            testId="import-kpi-before-after"
          />
        ) : (
          <ExecKpiTile
            label="Not scheduled"
            {...opener('excluded')}
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
              legend
              onSliceOpen={(o, el) => open(outcomeDrill(result, key, o as OutcomeKey, OUTCOME_LABEL[o as OutcomeKey]), el)}
              sliceOpenLabel={(sl) =>
                drillLabel(outcomeDrill(result, key, sl.key as OutcomeKey, OUTCOME_LABEL[sl.key as OutcomeKey]))
              }
              info={
                <p>
                  Every project in the selection by its scheduled outcome; click a slice or a chip to list its
                  projects. Counts and the total are served by the planner for the selected year; nothing is counted
                  in the browser.
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
                <QuarterBars
                  ariaLabel="Finishes per quarter"
                  bars={block.by_finish_quarter.map((q) => ({ key: q.key, label: q.label, drill: quarterDrill(result, key, q.key) }))}
                />
              )}
            </ChartCard>
          </div>
          <section
            aria-label="Projects by category, hub, priority and status"
            className="grid gap-gutter md:grid-cols-2"
            data-testid="import-exec-donuts"
          >
            {DONUTS.map(([dim, title]) => (
              <div key={dim} className="min-w-0">
                <BucketDonut
                  title={title}
                  testId={`import-exec-${dim.replace('by_', '')}`}
                  dim={dim}
                  buckets={block[dim]}
                  total={block.total}
                  result={result}
                  yearKey={key}
                />
              </div>
            ))}
          </section>
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
            drill={changeDrill(result, 'newly_slipping', `Newly slipping out of ${String(year)}`)}
          />
          <ChangeList
            title={`Recovered into ${String(year)}`}
            rows={result.changes.recovered}
            empty="No plan project moves into the year."
            base={base}
            testId="import-recovered"
            drill={changeDrill(result, 'recovered', `Recovered into ${String(year)}`)}
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
