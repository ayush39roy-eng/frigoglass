import * as React from 'react';
import { ArrowLeft, Calculator, UserRoundSearch } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';

import { Callout, FigureTile, SectionHeading } from '../../components/result-parts';
import { NativeSelect } from '../../components/form-controls';
import { int } from '../../components/figures';
import { WhatIfErrorNotice } from '../../components/whatif-error';
import { computeBlockedReason, rowErrors } from '../import-schema';
import { isMappedStatus } from '../import-rows';
import { useImportPlan } from '../import-store';
import type { ImportMode, ImportParseIssue, ImportParseResponse, PlanYearEndWeek } from '../import-types';
import { classifyImportError, type ImportSimulationState } from '../use-import';
import { planYearOf } from '../week-labels';
import { IssueList, type IssueItem } from './issue-list';
import { ReviewTable } from './review-table';

export function ReviewStep({
  parsed,
  simulation,
  onCompute,
  onRetry,
}: {
  parsed: ImportParseResponse;
  simulation: ImportSimulationState;
  onCompute: () => void;
  onRetry: () => void;
}): React.JSX.Element {
  const rows = useImportPlan((s) => s.rows);
  const options = useImportPlan((s) => s.options);
  const setOptions = useImportPlan((s) => s.setOptions);
  const updateRow = useImportPlan((s) => s.updateRow);
  const setStep = useImportPlan((s) => s.setStep);
  const reset = useImportPlan((s) => s.reset);
  const hasResult = useImportPlan((s) => s.result !== null);
  const [onlyIssues, setOnlyIssues] = React.useState(false);

  const issuesByRow = React.useMemo(() => {
    const m = new Map<string, ImportParseIssue[]>();
    for (const i of parsed.issues) {
      if (i.row_key === null) continue;
      m.set(i.row_key, [...(m.get(i.row_key) ?? []), i]);
    }
    return m;
  }, [parsed.issues]);
  const nameByKey = React.useMemo(() => new Map(parsed.rows.map((r) => [r.key, r.name])), [parsed.rows]);
  const issueItems: IssueItem[] = React.useMemo(
    () =>
      parsed.issues.map((i, idx) => ({
        id: `${String(idx)}-${i.code}`,
        severity: i.severity,
        code: i.code,
        message: i.message,
        where:
          i.file_row !== null
            ? `Row ${String(i.file_row)}${i.row_key && nameByKey.get(i.row_key) ? ` (${nameByKey.get(i.row_key) ?? ''})` : ''}`
            : null,
      })),
    [parsed.issues, nameByKey],
  );

  const errors = React.useMemo(() => rowErrors(rows), [rows]);
  const blocked = computeBlockedReason(rows);
  // One definition for the tile and the banner: rows that WILL be scheduled (included, so
  // never On Hold) whose engineer is still auto-assign. The parse's `counts.auto_assign` counts
  // every file row, On Hold ones included, so it is shown only as the tile's hint.
  const noEngineer = rows.filter((r) => r.include && isMappedStatus(r.status) && r.leader.kind === 'auto').length;
  const shownRows = onlyIssues ? rows.filter((r) => issuesByRow.has(r.key) || errors[r.key]) : rows;
  const mappedRows = shownRows.filter((r) => isMappedStatus(r.status));
  const notMappedRows = shownRows.filter((r) => !isMappedStatus(r.status));
  const notMappedTotal = rows.filter((r) => !isMappedStatus(r.status)).length;
  const c = parsed.counts;
  const year = planYearOf(options.planYearEndWeek, parsed.base_year);
  const y0 = parsed.base_year;

  return (
    <div className="space-y-s5" data-testid="import-review">
      <div className="flex flex-wrap items-center justify-between gap-s3">
        <p className="text-sm text-text-muted">
          <span className="font-medium text-text">{parsed.file_name}</span> · sheet “{parsed.projects_sheet}”
          {parsed.steps_sheet
            ? ` · lead times from “${parsed.steps_sheet}”`
            : ' · no Process steps sheet (app lead times)'}
        </p>
        <Button type="button" size="sm" variant="ghost" onClick={reset}>
          <ArrowLeft />
          Upload another file
        </Button>
      </div>

      <section
        aria-label="File summary"
        className="grid grid-cols-2 gap-s3 sm:grid-cols-4 xl:grid-cols-7"
        data-testid="import-counts"
      >
        <FigureTile label="Rows" value={int(c.rows)} />
        <FigureTile label="Schedulable" value={int(c.schedulable)} />
        <FigureTile label="Not scheduled" value={int(c.not_scheduled)} hint="On hold or finished" />
        <FigureTile label="Matched to plan" value={int(c.matched)} />
        <FigureTile label="New projects" value={int(c.new)} />
        <FigureTile
          label="Auto-assign"
          value={int(noEngineer)}
          hint={
            noEngineer === c.auto_assign
              ? 'Rows to schedule with no engineer'
              : `Rows to schedule with no engineer (${int(c.auto_assign)} in the file, incl. rows not mapped or excluded)`
          }
          testId="import-auto-tile"
        />
        <FigureTile label="New designers" value={int(c.new_designers)} />
      </section>

      {notMappedTotal > 0 ? (
        <Callout
          tone="neutral"
          title={`${int(notMappedTotal)} On Hold project${notMappedTotal === 1 ? '' : 's'} not mapped`}
          testId="import-not-mapped-banner"
          role="status"
        >
          <p>
            On Hold (and cancelled or commercialized) rows are listed below but not scheduled. Change a row&apos;s
            status to include it.
          </p>
        </Callout>
      ) : null}

      {noEngineer > 0 ? (
        <Callout
          tone="warning"
          title={`${int(noEngineer)} project${noEngineer === 1 ? ' has' : 's have'} no engineer — choose one or keep auto-assign`}
          testId="import-engineer-banner"
          role="status"
        >
          <p className="flex items-center gap-1">
            <UserRoundSearch className="size-3.5" aria-hidden="true" />
            Auto-assign gives each one the designer of its hub with the least work per FTE. The highlighted rows are
            listed first in the engineer column.
          </p>
        </Callout>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Issues found in the file</CardTitle>
        </CardHeader>
        <CardContent>
          <IssueList items={issueItems} label="File issues" />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rows</CardTitle>
        </CardHeader>
        <CardContent className="space-y-s3">
          <div className="flex items-center gap-s2">
            <Checkbox id="import-only-issues" checked={onlyIssues} onCheckedChange={(v) => setOnlyIssues(v === true)} />
            <Label htmlFor="import-only-issues" className="text-xs">
              Show only rows with issues
            </Label>
          </div>
          {mappedRows.length === 0 ? (
            <p className="text-xs text-text-muted">No rows to show.</p>
          ) : (
            <ReviewTable
              rows={mappedRows}
              parsed={parsed}
              issuesByRow={issuesByRow}
              errors={errors}
              update={updateRow}
            />
          )}
          {notMappedRows.length > 0 ? (
            <details
              className="group rounded-md border border-border bg-surface-sunken/40"
              data-testid="import-not-mapped"
            >
              <summary className="cursor-pointer list-none rounded-md px-s3 py-s2 text-xs font-semibold text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
                {`Not mapped (On Hold) — ${int(notMappedRows.length)}`}
              </summary>
              <div className="p-s2">
                <ReviewTable
                  rows={notMappedRows}
                  parsed={parsed}
                  issuesByRow={issuesByRow}
                  errors={errors}
                  update={updateRow}
                  label="Rows not mapped (On Hold)"
                />
              </div>
            </details>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Options</CardTitle>
        </CardHeader>
        <CardContent className="space-y-s4">
          <div className="grid gap-s4 sm:grid-cols-3">
            <div className="flex flex-col gap-1">
              <Label htmlFor="import-mode" className="text-2xs text-text-muted">
                Mode
              </Label>
              <NativeSelect
                id="import-mode"
                value={options.mode}
                onChange={(e) => setOptions({ mode: e.target.value as ImportMode })}
              >
                <option value="merge">Merge with the current plan</option>
                <option value="file_only">This file only</option>
              </NativeSelect>
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="import-year" className="text-2xs text-text-muted">
                Plan year
              </Label>
              <NativeSelect
                id="import-year"
                value={String(options.planYearEndWeek)}
                onChange={(e) =>
                  setOptions({
                    planYearEndWeek: Number(e.target.value) as PlanYearEndWeek,
                  })
                }
              >
                <option value="104">{String(y0 + 1)}</option>
                <option value="52">{String(y0)}</option>
              </NativeSelect>
            </div>
            <div className="flex items-center gap-s2 self-end pb-1.5">
              <Checkbox
                id="import-expand"
                checked={options.expandMulti}
                onCheckedChange={(v) => setOptions({ expandMulti: v === true })}
              />
              <Label htmlFor="import-expand" className="text-xs">
                Expand “Num of Projects” (a row of n becomes n projects)
              </Label>
            </div>
          </div>
          <SectionHeading>Compute the plan for {String(year)}</SectionHeading>
          {simulation.error ? (
            <WhatIfErrorNotice
              info={classifyImportError(simulation.error, 'simulate')}
              errorToken={simulation.token}
              onRetry={onRetry}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-s3">
            <Button type="button" onClick={onCompute} disabled={blocked !== null || simulation.pending}>
              {simulation.pending ? <Spinner className="size-4" /> : <Calculator />}
              {simulation.pending ? 'Computing…' : 'Compute plan'}
            </Button>
            {blocked ? (
              <p className="text-2xs text-text-muted" data-testid="import-compute-hint">
                {blocked}
              </p>
            ) : null}
            {!simulation.pending && hasResult ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => setStep('results')}>
                Back to the last results
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
