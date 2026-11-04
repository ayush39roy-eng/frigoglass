import * as React from 'react';

import {
  Callout,
  FigureTile,
  ProjectRowsTable,
  SectionHeading,
  WorkingsDisclosure,
  type RowColumn,
} from '../../components/result-parts';
import { int } from '../../components/figures';
import type { ImportChange, ImportSimulateResponse } from '../import-types';
import { planYearOf, weekOrDash } from '../week-labels';
import { IssueList, type IssueItem } from './issue-list';

export function ResultsOverview({ result }: { result: ImportSimulateResponse }): React.JSX.Element {
  const k = result.kpis;
  const base = result.base_year;
  const year = planYearOf(result.plan_year_end_week, base);
  const merge = result.mode === 'merge';
  // Every project the run placed or tried to place: the served outcome counts summed, so
  // excluded (commercialized / cancelled / on hold) projects are not counted as scheduled.
  const scheduled = k.within_plan_year + k.spillover + k.left_out + k.blocked + k.data_error;
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
  const changeColumns: RowColumn<ImportChange>[] = [
    {
      header: 'Project',
      cell: (c) => <span className="font-medium">{c.name}</span>,
    },
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
    <div className="space-y-s5" data-testid="import-overview">
      <section aria-label="Key figures" className="grid grid-cols-2 gap-s3 sm:grid-cols-4">
        <FigureTile
          label="Projects scheduled"
          value={int(scheduled)}
          hint={`${int(k.excluded)} not scheduled (commercialized / cancelled / on hold)`}
          testId="import-kpi-total"
        />
        <FigureTile
          label={`Finish in ${String(year)}`}
          value={int(k.within_plan_year)}
          hint={`${int(k.file_within_plan_year)} of ${int(k.file_scheduled)} file projects`}
          testId="import-kpi-within"
        />
        <FigureTile label="Spill over" value={int(k.spillover)} testId="import-kpi-spillover" />
        <FigureTile
          label="Not placed"
          value={int(k.left_out)}
          hint={`${int(k.blocked)} blocked · ${int(k.data_error)} data errors`}
          testId="import-kpi-leftout"
        />
      </section>
      {merge && k.before_within_plan_year !== null && k.after_within_plan_year_existing !== null ? (
        <section aria-label="Current plan before and after" className="grid grid-cols-2 gap-s3 sm:grid-cols-4">
          <FigureTile
            label={`Plan projects in ${String(year)} — before`}
            value={int(k.before_within_plan_year)}
            testId="import-kpi-before"
          />
          <FigureTile
            label={`Plan projects in ${String(year)} — after`}
            value={int(k.after_within_plan_year_existing)}
            testId="import-kpi-after"
          />
          <FigureTile label="Newly slipping" value={int(k.newly_slipping)} />
          <FigureTile label="Recovered" value={int(k.recovered)} />
        </section>
      ) : (
        <Callout tone="neutral" title="This file only">
          <p>The current plan is not included, so there is no before / after comparison.</p>
        </Callout>
      )}

      {merge ? (
        <>
          <section className="space-y-s2" aria-label="Newly slipping">
            <SectionHeading>
              Newly slipping out of {String(year)}{' '}
              <span className="font-normal text-text-muted">({int(result.changes.newly_slipping.length)})</span>
            </SectionHeading>
            {result.changes.newly_slipping.length === 0 ? (
              <p className="text-xs text-text-muted">No plan project slips out of the year.</p>
            ) : (
              <ProjectRowsTable
                rows={result.changes.newly_slipping}
                columns={changeColumns}
                rowKey={(c) => c.ref}
                label="Newly slipping"
              />
            )}
          </section>
          <section className="space-y-s2" aria-label="Recovered">
            <SectionHeading>
              Recovered into {String(year)}{' '}
              <span className="font-normal text-text-muted">({int(result.changes.recovered.length)})</span>
            </SectionHeading>
            {result.changes.recovered.length === 0 ? (
              <p className="text-xs text-text-muted">No plan project moves into the year.</p>
            ) : (
              <ProjectRowsTable
                rows={result.changes.recovered}
                columns={changeColumns}
                rowKey={(c) => c.ref}
                label="Recovered"
              />
            )}
          </section>
        </>
      ) : null}

      <section className="space-y-s2" aria-label="Issues">
        <SectionHeading>Issues</SectionHeading>
        <IssueList items={issues} label="Result issues" />
      </section>
      <WorkingsDisclosure lines={result.workings} />
    </div>
  );
}
