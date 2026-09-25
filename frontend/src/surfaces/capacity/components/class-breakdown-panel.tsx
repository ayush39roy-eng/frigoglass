import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
    <Card>
      <CardHeader>
        <CardTitle>Class breakdown — deliverable vs. left out</CardTitle>
        {runBadge ? <Badge tone="neutral">{runBadge}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.has_active_schedule_run ? (
          <EmptyState
            title="No schedule computed yet"
            description="No active schedule run exists. The A+/A/B/C deliverable vs. left-out split appears once the schedule is calculated."
          />
        ) : (
          <>
            <p className="text-2xs text-text-muted">
              Deliverable = scheduled and not left out. Left out = no feasible window before the
              78-week horizon. Source: active schedule run
              {data.schedule_run_version === null
                ? ''
                : ` v${String(data.schedule_run_version)}`}
              . Not recomputed in the browser.
            </p>

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
                        <Badge tone="outline">{row.category}</Badge>
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
              />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
