import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

import type { EstimateResponse } from '../../api/whatif-types';
import { int, num } from './figures';
import { BookedShift, FigureTile, ScopeNote, SectionHeading, WorkingsDisclosure } from './result-parts';

const TOUCHED_ROW = 'border-l-4 border-l-primary bg-primary-subtle/30';

/** Touched rows first (stable within each group), as the server listed them otherwise. */
function touchedFirst<T>(rows: readonly T[], isTouched: (row: T) => boolean): T[] {
  return [...rows.filter(isTouched), ...rows.filter((r) => !isTouched(r))];
}

function TouchedMark(): React.JSX.Element {
  return (
    <Badge tone="primary" className="ml-2 align-middle" data-testid="est-touched-mark">
      Changed by scenario
    </Badge>
  );
}

/**
 * Estimate (`POST /whatif/estimate`): extra design- and lab-weeks, booked %
 * before and after per hub and lab region, and the least extra designers and
 * chambers. Every figure is a field of the response (I9/I19).
 */
export function EstimateView({ data }: { data: EstimateResponse }): React.JSX.Element {
  const basisLabel = data.basis === 'year' ? 'the full year' : 'the remaining weeks';
  const touchedHubs = new Set(data.touched_hubs);
  const touchedRegions = new Set(data.touched_lab_regions);
  const nothingTouched = data.touched_hubs.length === 0 && data.touched_lab_regions.length === 0;
  const designRows = touchedFirst(data.design, (r) => touchedHubs.has(r.hub));
  const labRows = touchedFirst(data.lab, (r) => touchedRegions.has(r.lab_region));
  return (
    <div className="space-y-s4" data-testid="whatif-estimate">
      <ScopeNote scope={data.scope} />
      <div className="space-y-1" data-testid="est-touched">
        <p className="text-xs font-semibold text-text">
          Needed for the hubs and regions this scenario touches
          {nothingTouched ? '' : ':'}
        </p>
        {nothingTouched ? (
          <p className="text-xs text-text-muted" data-testid="est-touched-none">
            This scenario changes nothing, so no extra capacity is needed because of it. The rows below show today&apos;s
            load; a row that is already short still shows its own need.
          </p>
        ) : (
          <p className="text-xs text-text-muted" data-testid="est-touched-list">
            Hubs: {data.touched_hubs.length > 0 ? data.touched_hubs.join(', ') : 'none'}. Lab regions:{' '}
            {data.touched_lab_regions.length > 0 ? data.touched_lab_regions.join(', ') : 'none'}. A hub or region that the
            scenario does not touch keeps its own deficit in its row below; it is not in these totals.
          </p>
        )}
      </div>
      <div className="grid gap-s3 sm:grid-cols-2 lg:grid-cols-4">
        <FigureTile label="Extra design-weeks" value={int(data.extra_design_weeks_total)} testId="est-design-weeks" />
        <FigureTile label="Extra lab-weeks" value={num(data.extra_lab_weeks_total)} testId="est-lab-weeks" />
        <FigureTile
          label="Designers needed"
          value={`${int(data.min_extra_designers_total)} more`}
          hint={`Fewest extra designers to stay below ${num(data.target_below_pct)} % booked`}
          testId="est-designers"
        />
        <FigureTile
          label="Chambers needed"
          value={`${int(data.min_extra_chambers_total)} more`}
          hint={`Fewest extra chambers to stay below ${num(data.target_below_pct)} % booked`}
          testId="est-chambers"
        />
      </div>
      <p className="text-2xs text-text-muted">
        Capacity is measured over {basisLabel}. This is a quick estimate from lead times; the Simulate view runs the real
        scheduler.
      </p>

      <section aria-labelledby="est-design-heading" className="space-y-s2">
        <SectionHeading id="est-design-heading">Design capacity by hub</SectionHeading>
        {data.design.length === 0 ? (
          <p className="text-xs text-text-muted">No hub is affected by this scenario.</p>
        ) : (
          <Table scrollLabel="Design capacity by hub" aria-labelledby="est-design-heading">
            <TableHeader>
              <TableRow>
                <TableHead>Hub</TableHead>
                <TableHead className="text-right">Added projects</TableHead>
                <TableHead className="text-right">Extra design-weeks</TableHead>
                <TableHead className="text-right">FTE before / after</TableHead>
                <TableHead>Booked before / after</TableHead>
                <TableHead>Needs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {designRows.map((r) => (
                <TableRow
                  key={r.hub}
                  data-testid="est-design-row"
                  data-touched={touchedHubs.has(r.hub) ? 'true' : 'false'}
                  className={touchedHubs.has(r.hub) ? TOUCHED_ROW : undefined}
                >
                  <TableCell className="font-medium">
                    {r.hub}
                    {touchedHubs.has(r.hub) ? <TouchedMark /> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{int(r.added_projects)}</TableCell>
                  <TableCell className="text-right tabular-nums">{int(r.extra_design_weeks)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {num(r.fte_before)} / {num(r.fte_after_scenario)}
                  </TableCell>
                  <TableCell>
                    <BookedShift
                      before={r.booked_pct_before}
                      after={r.booked_pct_after}
                      statusBefore={r.status_before}
                      statusAfter={r.status_after}
                    />
                  </TableCell>
                  <TableCell>
                    {!r.reachable ? (
                      <Badge tone="warning">A designer adds no capacity here</Badge>
                    ) : r.min_extra_designers > 0 ? (
                      <span className="font-semibold">
                        need {int(r.min_extra_designers)} more designer{r.min_extra_designers === 1 ? '' : 's'}
                        <span className="font-normal text-text-muted"> ({num(r.designer_fte)} FTE each)</span>
                      </span>
                    ) : (
                      <span className="text-text-muted">No extra designers</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <section aria-labelledby="est-lab-heading" className="space-y-s2">
        <SectionHeading id="est-lab-heading">Lab capacity by region</SectionHeading>
        {data.lab.length === 0 ? (
          <p className="text-xs text-text-muted">No lab region is affected by this scenario.</p>
        ) : (
          <Table scrollLabel="Lab capacity by region" aria-labelledby="est-lab-heading">
            <TableHeader>
              <TableRow>
                <TableHead>Lab region</TableHead>
                <TableHead className="text-right">Added projects</TableHead>
                <TableHead className="text-right">Extra lab-weeks</TableHead>
                <TableHead className="text-right">Chambers before / after</TableHead>
                <TableHead>Booked before / after</TableHead>
                <TableHead>Needs</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {labRows.map((r) => (
                <TableRow
                  key={r.lab_region}
                  data-testid="est-lab-row"
                  data-touched={touchedRegions.has(r.lab_region) ? 'true' : 'false'}
                  className={touchedRegions.has(r.lab_region) ? TOUCHED_ROW : undefined}
                >
                  <TableCell className="font-medium">
                    {r.lab_region}
                    {touchedRegions.has(r.lab_region) ? <TouchedMark /> : null}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{int(r.added_projects)}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(r.extra_lab_weeks)}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {int(r.chambers_before)} / {int(r.chambers_after_scenario)}
                  </TableCell>
                  <TableCell>
                    <BookedShift
                      before={r.booked_pct_before}
                      after={r.booked_pct_after}
                      statusBefore={r.status_before}
                      statusAfter={r.status_after}
                    />
                  </TableCell>
                  <TableCell>
                    {!r.reachable ? (
                      <Badge tone="warning">A chamber adds no capacity here</Badge>
                    ) : r.min_extra_chambers > 0 ? (
                      <span className="font-semibold">
                        need {int(r.min_extra_chambers)} more chamber{r.min_extra_chambers === 1 ? '' : 's'}
                      </span>
                    ) : (
                      <span className="text-text-muted">No extra chambers</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>

      <WorkingsDisclosure lines={data.workings} />
    </div>
  );
}
