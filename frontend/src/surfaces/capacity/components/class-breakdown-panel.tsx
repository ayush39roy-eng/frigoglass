import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { CardInfo } from '@/components/ui/card-info';
import { EmptyState } from '@/components/shared/empty-state';

import type { ClassBreakdown, ClassBreakdownRow } from '../api/types';
import { ClassBreakdownChart } from './class-breakdown-chart';
import { ClassCard } from './class-card';
import { CollapsibleSection } from './collapsible-section';

/**
 * "A class breakdown (A+/A/B/C) of deliverable vs. left-out projects"
 * (`docs/PROJECT_AND_STACK.md` §2). Counts come verbatim from
 * `GET /capacity/class-breakdown`, which the backend sources from the active
 * schedule run's per-project outcomes (`left_out`). Nothing recomputed here.
 *
 * P19-T01: now the client's row of compact class cards directly under the KPI
 * row (one card per served category, A+/A/B/C and any OEM category the server
 * serves). The stacked-bar chart that used to follow is behind a collapsed
 * "Show class chart" disclosure, rendered only when opened.
 *
 * P19-T05 (owner ruling): that disclosure moved down the page, after the hub
 * summary table and utilization matrix (`ClassChartSection`, placed by
 * `CapacityPage`). The cards stay here under the KPI row.
 */

export interface ClassBreakdownPanelProps {
  data: ClassBreakdown;
}

export function ClassBreakdownPanel({ data }: ClassBreakdownPanelProps): React.JSX.Element {
  const version = data.schedule_run_version;
  const hasAny = data.rows.some((r) => r.deliverable_count + r.left_out_count > 0);

  return (
    <section aria-labelledby="capacity-class-heading" className="space-y-s3" data-testid="class-breakdown-panel">
      <div className="flex flex-wrap items-center gap-s2">
        <h2 id="capacity-class-heading" className="label-caps text-text-muted">
          Class breakdown — deliverable vs. left out
        </h2>
        {version === null ? null : (
          <Badge tone="neutral" className="rounded-pill">
            {`Run v${String(version)}`}
          </Badge>
        )}
        <CardInfo label="How deliverable and left out are defined">
          <p>
            <strong className="text-text">Deliverable</strong> = placed in the schedule (finishing
            within the year or as spillover past W52).{' '}
            <strong className="text-text">Left out</strong> = not placed yet, so not done by W52 —
            it spills over unscheduled.
          </p>
          <p>
            Source: active schedule run
            {version === null ? '' : ` v${String(version)}`}
            . Not recomputed in the browser.
          </p>
        </CardInfo>
      </div>

      {!data.has_active_schedule_run ? (
        <EmptyState
          title="No schedule computed yet"
          description="No active schedule run exists. The A+/A/B/C deliverable vs. left-out split appears once the schedule is calculated."
          className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
        />
      ) : (
        <>
          <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4" data-testid="class-cards">
            {data.rows.map((row: ClassBreakdownRow) => (
              <ClassCard key={row.category} row={row} />
            ))}
          </div>

          {hasAny ? null : (
            <EmptyState
              title="No categorised projects in this run"
              description="The active schedule run produced no A+/A/B/C project outcomes in your hub scope."
              className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
            />
          )}
        </>
      )}
    </section>
  );
}

/**
 * P19-T05: the class chart, collapsed and lazy, placed lower on the page (above
 * the chamber and engineer utilization disclosures). Rendered only when the
 * served breakdown has a run and at least one categorised project; the chart
 * itself mounts only when opened. Counts are served verbatim.
 */
export function ClassChartSection({ data }: ClassBreakdownPanelProps): React.JSX.Element | null {
  const hasAny = data.rows.some((r) => r.deliverable_count + r.left_out_count > 0);
  if (!data.has_active_schedule_run || !hasAny) return null;
  return (
    <CollapsibleSection
      showLabel="Show class chart"
      hint="Deliverable vs. left-out counts per category, as bars"
      testId="class-chart-section"
    >
      <ClassBreakdownChart rows={data.rows} />
    </CollapsibleSection>
  );
}
