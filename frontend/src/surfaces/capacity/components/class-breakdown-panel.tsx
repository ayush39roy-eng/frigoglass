import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CategoryTag } from '@/components/ui/category-tag';
import { EmptyState } from '@/components/shared/empty-state';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInteger } from '@/lib/format';

import type { ClassBreakdown, ClassBreakdownRow } from '../api/types';
import { CapacityInfo } from './capacity-info';
import { ClassBreakdownChart } from './class-breakdown-chart';

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
          <CapacityInfo label="How deliverable and left out are defined">
            <p>
              <strong className="text-text">Deliverable</strong> = scheduled and not left out.{' '}
              <strong className="text-text">Left out</strong> = no feasible window before the
              78-week horizon.
            </p>
            <p>
              Source: active schedule run
              {data.schedule_run_version === null
                ? ''
                : ` v${String(data.schedule_run_version)}`}
              . Not recomputed in the browser.
            </p>
          </CapacityInfo>
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
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Deliverable</TableHead>
                    <TableHead className="text-right">Left out</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row: ClassBreakdownRow) => (
                    <TableRow key={row.category}>
                      <TableCell>
                        <CategoryTag category={row.category} />
                      </TableCell>
                      <TableCell className="text-right tnum text-text" data-numeric="">
                        {formatInteger(row.deliverable_count)}
                      </TableCell>
                      <TableCell className="text-right tnum text-text" data-numeric="">
                        {formatInteger(row.left_out_count)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
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
