import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';

import type { ClassBreakdown, ClassBreakdownRow } from '../api/types';
import { CardInfo } from '@/components/ui/card-info';
import { ClassBreakdownChart } from './class-breakdown-chart';
import { ClassCard } from './class-card';

/**
 * "A class breakdown (A+/A/B/C) of deliverable vs. left-out projects"
 * (`docs/PROJECT_AND_STACK.md` §2). Counts come verbatim from
 * `GET /capacity/class-breakdown`, which the backend sources from the active
 * schedule run's per-project outcomes (`left_out`). Nothing recomputed here.
 */

export interface ClassBreakdownPanelProps {
  data: ClassBreakdown;
}

export function ClassBreakdownPanel({ data }: ClassBreakdownPanelProps): React.JSX.Element {
  const runBadge =
    data.schedule_run_version === null ? null : `Run v${String(data.schedule_run_version)}`;

  const hasAny = data.rows.some((r) => r.deliverable_count + r.left_out_count > 0);

  return (
    <BoltCard>
      <CardHeader className="flex-wrap gap-y-s2">
        <CardTitle>Class breakdown — deliverable vs. left out</CardTitle>
        <div className="flex flex-wrap items-center gap-s2">
          {runBadge ? (
            <Badge tone="neutral" className="rounded-pill">
              {runBadge}
            </Badge>
          ) : null}
          <CardInfo label="How deliverable and left out are defined">
            <p>
              <strong className="text-text">Deliverable</strong> = placed in the schedule (finishing
              within the year or as spillover past W52).{' '}
              <strong className="text-text">Left out</strong> = not placed yet, so not done by W52 —
              it spills over unscheduled.
            </p>
            <p>
              Source: active schedule run
              {data.schedule_run_version === null
                ? ''
                : ` v${String(data.schedule_run_version)}`}
              . Not recomputed in the browser.
            </p>
          </CardInfo>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.has_active_schedule_run ? (
          <EmptyState
            title="No schedule computed yet"
            description="No active schedule run exists. The A+/A/B/C deliverable vs. left-out split appears once the schedule is calculated."
            className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
          />
        ) : (
          <>
            {/* P13-T11: one card per category (mock-up), with the served priority
                split and per-hub ✓/✗ counts. Replaces the plain table; the same
                served counts are shown. */}
            <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4" data-testid="class-cards">
              {data.rows.map((row: ClassBreakdownRow) => (
                <ClassCard key={row.category} row={row} />
              ))}
            </div>

            {hasAny ? (
              <ClassBreakdownChart rows={data.rows} />
            ) : (
              <EmptyState
                title="No categorised projects in this run"
                description="The active schedule run produced no A+/A/B/C project outcomes in your hub scope."
                className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
              />
            )}
          </>
        )}
      </CardContent>
    </BoltCard>
  );
}
