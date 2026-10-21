import * as React from 'react';
import { ArrowRight } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatPlanWeek } from '@/lib/format';

import type {
  ProjectChangeOut,
  ProjectResultOut,
  SimulateResponse,
  UtilizationRowOut,
  WhatIfOutcome,
} from '../../api/whatif-types';
import {
  BookedShift,
  FigureTile,
  ProjectRowsTable,
  ScopeNote,
  SectionHeading,
  WorkingsDisclosure,
} from './result-parts';
import { int, num } from './figures';
import { OUTCOME_LABEL, OUTCOME_ORDER, OUTCOME_TONE } from './outcome-meta';

function OutcomeBadge({ outcome }: { outcome: WhatIfOutcome }): React.JSX.Element {
  return <Badge tone={OUTCOME_TONE[outcome]}>{OUTCOME_LABEL[outcome]}</Badge>;
}

function week(w: number | null): string {
  return w === null ? 'Not scheduled' : formatPlanWeek(w);
}

function signed(n: number): string {
  return n > 0 ? `+${int(n)}` : int(n);
}

const CHANGE_COLUMNS = [
  { header: 'Project', cell: (r: ProjectChangeOut) => <span className="font-medium">{r.name}</span> },
  { header: 'Hub', cell: (r: ProjectChangeOut) => r.hub },
  {
    header: 'Outcome',
    cell: (r: ProjectChangeOut) => (
      <span className="inline-flex flex-wrap items-center gap-1.5">
        <OutcomeBadge outcome={r.before_outcome} />
        <ArrowRight className="size-3.5 text-text-subtle" aria-hidden="true" />
        <span className="sr-only">after</span>
        <OutcomeBadge outcome={r.after_outcome} />
      </span>
    ),
  },
  {
    header: 'Finish week',
    cell: (r: ProjectChangeOut) => (
      <span className="tabular-nums">
        {week(r.before_finish_week)} <span aria-hidden="true">→</span>
        <span className="sr-only"> to </span> {week(r.after_finish_week)}
      </span>
    ),
  },
];

function ChangeList({
  title,
  empty,
  rows,
  testId,
}: {
  title: string;
  empty: string;
  rows: readonly ProjectChangeOut[];
  testId: string;
}): React.JSX.Element {
  return (
    <section className="space-y-s2" data-testid={testId} aria-label={title}>
      <SectionHeading>
        {title} <span className="font-normal text-text-muted">({int(rows.length)})</span>
      </SectionHeading>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">{empty}</p>
      ) : (
        <ProjectRowsTable rows={rows} columns={CHANGE_COLUMNS} rowKey={(r) => r.project_id} label={title} />
      )}
    </section>
  );
}

const NEW_COLUMNS = [
  { header: 'New project', cell: (r: ProjectResultOut) => <span className="font-medium">{r.name}</span> },
  { header: 'Hub', cell: (r: ProjectResultOut) => r.hub },
  { header: 'Category', cell: (r: ProjectResultOut) => r.category ?? '—' },
  { header: 'Outcome', cell: (r: ProjectResultOut) => <OutcomeBadge outcome={r.outcome} /> },
  {
    header: 'Finish week',
    cell: (r: ProjectResultOut) => (
      <span className="tabular-nums">
        {week(r.finish_week)}
        {r.unconstrained_end_week !== null && r.unconstrained_end_week > 52 ? (
          <span className="block text-2xs text-text-muted">
            Earliest possible {formatPlanWeek(r.unconstrained_end_week)}
          </span>
        ) : null}
      </span>
    ),
  },
];

function pairUtilization(before: readonly UtilizationRowOut[], after: readonly UtilizationRowOut[]) {
  const afterByKey = new Map(after.map((r) => [`${r.scope}:${r.key}`, r] as const));
  return before.map((b) => ({ before: b, after: afterByKey.get(`${b.scope}:${b.key}`) ?? null }));
}

function UtilizationTable({
  heading,
  pairs,
  unitLabel,
  testId,
}: {
  heading: string;
  pairs: { before: UtilizationRowOut; after: UtilizationRowOut | null }[];
  unitLabel: string;
  testId: string;
}): React.JSX.Element | null {
  if (pairs.length === 0) return null;
  return (
    <section className="space-y-s2" data-testid={testId}>
      <SectionHeading>{heading}</SectionHeading>
      <Table scrollLabel={heading} aria-label={heading}>
        <TableHeader>
          <TableRow>
            <TableHead>{unitLabel}</TableHead>
            <TableHead className="text-right">Units before / after</TableHead>
            <TableHead>Booked, full year (before / after)</TableHead>
            <TableHead>Booked, remaining weeks (before / after)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pairs.map(({ before, after }) => (
            <TableRow key={`${before.scope}:${before.key}`} data-testid="whatif-util-row">
              <TableCell className="font-medium">{before.key}</TableCell>
              <TableCell className="text-right tabular-nums">
                {num(before.units)} / {after ? num(after.units) : '—'}
              </TableCell>
              <TableCell>
                {after ? (
                  <BookedShift
                    before={before.booked_pct_year}
                    after={after.booked_pct_year}
                    statusBefore={before.status_year}
                    statusAfter={after.status_year}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
              <TableCell>
                {after ? (
                  <BookedShift
                    before={before.booked_pct_remaining}
                    after={after.booked_pct_remaining}
                    statusBefore={before.status_remaining}
                    statusAfter={after.status_remaining}
                  />
                ) : (
                  '—'
                )}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

/**
 * Simulate (`POST /whatif/simulate`): the real greedy scheduler run twice. The
 * within-year count, the diff lists and the utilization are the server's
 * (I9/I19); this view only lays them out.
 */
export function SimulateView({ data, compact = false }: { data: SimulateResponse; compact?: boolean }): React.JSX.Element {
  const d = data.diff;
  const newProjects = data.projects.filter((p) => p.is_new);
  const hubPairs = pairUtilization(
    data.utilization_before.filter((r) => r.scope === 'hub'),
    data.utilization_after.filter((r) => r.scope === 'hub'),
  );
  const regionPairs = pairUtilization(
    data.utilization_before.filter((r) => r.scope === 'lab_region'),
    data.utilization_after.filter((r) => r.scope === 'lab_region'),
  );
  return (
    <div className="space-y-s4" data-testid="whatif-simulate">
      {compact ? null : <ScopeNote scope={data.scope} />}
      <div className="grid gap-s3 sm:grid-cols-2 lg:grid-cols-4">
        <FigureTile
          label="Finishing within the year"
          value={`${int(d.within_year_before)} → ${int(d.within_year_after)}`}
          hint={`Change ${signed(d.within_year_delta)}`}
          testId="sim-within-year"
        />
        <FigureTile
          label="Existing projects within the year"
          value={`${int(d.existing_within_year_before)} → ${int(d.existing_within_year_after)}`}
          testId="sim-existing"
        />
        <FigureTile
          label="New projects within the year"
          value={`${int(d.new_projects_within_year)} of ${int(d.new_projects_total)}`}
          testId="sim-new"
        />
        <FigureTile
          label="Scheduler runs"
          value={int(data.greedy_runs)}
          hint="Before and after the change"
          testId="sim-runs"
        />
      </div>

      <section className="space-y-s2" aria-label="Outcome counts" data-testid="sim-outcomes">
        <SectionHeading>Outcomes before and after</SectionHeading>
        <p className="text-2xs text-text-muted" data-testid="sim-outcomes-note">
          Counted by outcome class. The &quot;within the year&quot; figure above is the Dashboard&apos;s count and can be
          higher, because it also counts commercialized projects.
        </p>
        <Table scrollLabel="Outcome counts" aria-label="Outcome counts before and after">
          <TableHeader>
            <TableRow>
              <TableHead>Outcome</TableHead>
              <TableHead className="text-right">Before</TableHead>
              <TableHead className="text-right">After</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {OUTCOME_ORDER.map((o) => (
              <TableRow key={o}>
                <TableCell>{OUTCOME_LABEL[o]}</TableCell>
                <TableCell className="text-right tabular-nums">{int(data.outcome_counts_before[o] ?? 0)}</TableCell>
                <TableCell className="text-right tabular-nums">{int(data.outcome_counts_after[o] ?? 0)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>

      <ChangeList
        title="Newly slipping"
        empty="No existing project newly slips past the year."
        rows={d.newly_slipping}
        testId="sim-slipping"
      />
      <ChangeList title="Recovered" empty="No existing project is pulled back inside the year." rows={d.recovered} testId="sim-recovered" />
      <ChangeList title="Moved" empty="No other existing project changes its finish week." rows={d.moved} testId="sim-moved" />

      {newProjects.length > 0 ? (
        <section className="space-y-s2" data-testid="sim-new-projects" aria-label="New projects">
          <SectionHeading>
            New projects <span className="font-normal text-text-muted">({int(newProjects.length)})</span>
          </SectionHeading>
          <ProjectRowsTable rows={newProjects} columns={NEW_COLUMNS} rowKey={(r) => r.project_id} label="New projects" />
        </section>
      ) : null}

      <UtilizationTable heading="Design booking by hub" pairs={hubPairs} unitLabel="Hub (FTE)" testId="sim-util-hubs" />
      <UtilizationTable
        heading="Lab booking by region"
        pairs={regionPairs}
        unitLabel="Lab region (chambers)"
        testId="sim-util-regions"
      />

      <WorkingsDisclosure lines={data.workings} />
    </div>
  );
}
