import * as React from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { BookedFigure } from '@/components/shared/booking-status-chip';
import { Badge } from '@/components/ui/badge';
import { BarChart } from '@/components/ui/bar-chart';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDecimal, formatFraction } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { HubCapacityRow } from '../api/types';
import {
  pickFigures,
  pickUnitFigures,
  resourceUnitLong,
  servedWeekdays,
  type CapacityHorizon,
  type CapacityView,
  type ResourceFigures,
  type ResourceKind,
  type UnitFigures,
} from '../lib/pick-figures';
import { formatFigure } from '../lib/status-format';
import { CardInfo } from '@/components/ui/card-info';
import { CapacityStat } from './capacity-stat';

export type { CapacityHorizon } from '../lib/pick-figures';

/**
 * The client's capacity breakdown (ADR 0008, `docs/CLIENT_FORMULAS.md` §2), one
 * card per hub: a Design section and a Lab section, each with Load
 * (process-derived — the I6/I7 figure — with the hand-entered estimate as a
 * secondary figure), capacity, gap and completion % for either the FULL YEAR or
 * the REMAINING YEAR (segmented toggle), and an expandable "How this is
 * calculated" that shows FTE × working weeks and the per-chamber table.
 *
 * Every number here is one API field rendered verbatim (Invariant I17 — the
 * supply figures equal the ADR 0008 formulas evaluated server-side; the load
 * figures are I6/I7 sums over the active run). `pickFigures` only SELECTS which
 * of the served fields to show for the chosen horizon; it never combines them.
 *
 * P19-T05 (Weeks | Days): load and capacity (and their bars) follow the page's
 * unit, reading the SERVED day fields in Days. The estimated load and the gap
 * are served in weeks only, so in Days mode they keep their weeks and say so;
 * completion and booked % are unit-free. "How this is calculated" shows the
 * weeks formulas (that is what the workbook has) plus the served day figures.
 */

const HORIZON_LABEL: Record<CapacityHorizon, string> = {
  year: 'Yearly capacity',
  remaining: 'Remaining capacity',
};

function GapBadge({ gap, unit }: { gap: number; unit: string }): React.JSX.Element {
  // `gap` = load − capacity, served. Positive = shortfall, ≤ 0 = headroom.
  const shortfall = gap > 0;
  return shortfall ? (
    <Badge tone="warning" className="rounded-pill" title={`Load exceeds capacity by ${formatDecimal(gap)} ${unit}`}>
      <TriangleAlert aria-hidden="true" />
      Shortfall
    </Badge>
  ) : (
    <Badge
      tone="neutral"
      className="rounded-pill"
      title={`Capacity covers load with ${formatDecimal(Math.abs(gap))} ${unit} to spare`}
    >
      <CircleCheck aria-hidden="true" />
      Headroom
    </Badge>
  );
}

function ResourceBlock({
  hub,
  kind,
  horizon,
  figures,
  shown,
  unit,
  note,
}: {
  hub: string;
  kind: ResourceKind;
  horizon: CapacityHorizon;
  /** The served weeks figures (estimate, gap, completion: weeks / unit-free only). */
  figures: ResourceFigures;
  /** Load and capacity in the page's unit (served days in Days; null if absent). */
  shown: UnitFigures;
  /** The page's long resource unit, e.g. "engineer-days". */
  unit: string;
  note?: string;
}): React.JSX.Element {
  const title = kind === 'design' ? 'Design' : 'Lab';
  const shortfall = figures.gap > 0;
  const weeksUnit = resourceUnitLong(kind, 'weeks');
  const inDays = unit !== weeksUnit;
  /** Names the weeks unit on figures that have no served day value, in Days mode only. */
  const weeksTag = inDays ? ' (wks)' : '';
  return (
    <section
      aria-label={`${hub} ${title.toLowerCase()} load vs. capacity`}
      className="space-y-s3 rounded-dash border border-dash-hairline bg-surface p-card-tight"
      data-testid={`capacity-${kind}`}
    >
      <header className="flex items-center justify-between gap-s2">
        <h4 className="label-caps text-text-muted">
          {title} <span className="normal-case tracking-normal text-text-subtle">· {unit}</span>
        </h4>
        <div className="flex items-center gap-1">
          <GapBadge gap={figures.gap} unit={weeksUnit} />
          {/* The lab caveat used to render as a line of prose under this block,
              once per hub card — six identical sentences on a full page. Same
              words, now one affordance per block (client text cleanup,
              2026-10-01). */}
          {note ? (
            <CardInfo label={`About these ${title.toLowerCase()} figures`} className="size-6">
              <p>{note}</p>
            </CardInfo>
          ) : null}
        </div>
      </header>

      <div className="grid gap-s2 sm:grid-cols-2">
        <CapacityStat
          label="Load (process-derived)"
          value={shown.load}
          data-testid={`${kind}-load`}
        />
        <CapacityStat
          label={`Load (estimated)${weeksTag}`}
          value={figures.loadEstimated}
          muted
          data-testid={`${kind}-load-estimated`}
        />
        <CapacityStat
          label={HORIZON_LABEL[horizon]}
          value={shown.capacity}
          data-testid={`${kind}-capacity`}
        />
        <CapacityStat
          label={inDays ? 'Gap, load − cap. (wks)' : 'Gap (load − capacity)'}
          value={figures.gap}
          renderValue={(text, rawValue) => (
            <span className={cn(shortfall ? 'text-warning-subtle-fg' : 'text-text')}>
              {rawValue > 0 ? '+' : ''}
              {text}
            </span>
          )}
          data-testid={`${kind}-gap`}
        />
        <CapacityStat
          label="Completion"
          value={figures.completionPct}
          formatValue={formatFraction}
          data-testid={`${kind}-completion`}
        />
        {/* P11 (ADR 0016): booked % = load / capacity × 100 and its Full / Near
            full / Available status, both served for this horizon (I19). */}
        <BookedFigure
          label="Booked"
          bookedPct={figures.bookedPct}
          status={figures.bookingStatus}
          size="sm"
          className="rounded-dash border border-dash-hairline bg-dash-alt px-s3 py-s2"
          data-testid={`${kind}-booked`}
        />
      </div>

      {shown.load === null || shown.capacity === null ? (
        <p className="text-2xs text-text-muted" data-testid={`${kind}-bars-unavailable`}>
          Load and capacity in {unit} are not served by this API version.
        </p>
      ) : (
        <BarChart
          ariaLabel={`${hub} ${title.toLowerCase()}: load versus ${HORIZON_LABEL[horizon].toLowerCase()}, in ${unit}`}
          formatValue={formatDecimal}
          data={[
            {
              key: 'load',
              label: 'Load (process-derived)',
              value: shown.load,
              tone: shortfall ? 'warning' : 'primary',
            },
            { key: 'capacity', label: HORIZON_LABEL[horizon], value: shown.capacity, tone: 'neutral' },
          ]}
        />
      )}
    </section>
  );
}

export interface HubSupplyDetailProps {
  row: HubCapacityRow;
  view: CapacityView;
}

/**
 * ONE hub's full figures (the old per-hub card, P19-T01): the hub facts, the Design
 * and Lab blocks with their bars, and "How this is calculated". Rendered inside the
 * summary table's Details dialog, so it exists in the DOM only while the dialog is open.
 */
export function HubSupplyDetail({ row, view }: HubSupplyDetailProps): React.JSX.Element {
  const { horizon } = view;
  const design = pickFigures(row, 'design', horizon);
  const lab = pickFigures(row, 'lab', horizon);
  const designShown = pickUnitFigures(row, 'design', view);
  const labShown = pickUnitFigures(row, 'lab', view);
  const designDays = pickUnitFigures(row, 'design', { horizon, unit: 'days' });
  const labDays = pickUnitFigures(row, 'lab', { horizon: 'year', unit: 'days' });
  const labDaysRemaining = pickUnitFigures(row, 'lab', { horizon: 'remaining', unit: 'days' });
  const designDaysYear = pickUnitFigures(row, 'design', { horizon: 'year', unit: 'days' });
  const designDaysRemaining = pickUnitFigures(row, 'design', { horizon: 'remaining', unit: 'days' });
  return (
    <div className="space-y-s3" data-testid="capacity-hub-card">
            <header className="flex flex-wrap items-baseline justify-between gap-s2">
              <span className="flex flex-wrap items-center gap-s2 text-2xs text-text-muted">
                <Badge tone="outline" className="rounded-pill">
                  Lab region: {row.lab_region}
                </Badge>
                <span data-numeric="">
                  Σ FTE <strong className="text-text">{formatDecimal(row.engineer_fte_total)}</strong>
                </span>
                <span data-numeric="">
                  Working weeks / engineer{' '}
                  <strong className="text-text">{formatDecimal(row.working_weeks_per_engineer)}</strong>
                </span>
                <span data-numeric="">
                  Remaining fraction{' '}
                  <strong className="text-text">{formatDecimal(row.remaining_fraction)}</strong>
                </span>
                <span data-numeric="" data-testid="detail-weekdays">
                  Working days / week{' '}
                  <strong className="text-text">{formatFigure(servedWeekdays(row, 'design'))}</strong>
                  {' '}(lab region{' '}
                  <strong className="text-text">{formatFigure(servedWeekdays(row, 'lab'))}</strong>)
                </span>
              </span>
            </header>

            <div className="grid gap-s3 lg:grid-cols-2">
              <ResourceBlock
                hub={row.hub}
                kind="design"
                horizon={horizon}
                figures={design}
                shown={designShown}
                unit={resourceUnitLong('design', view.unit)}
              />
              <ResourceBlock
                hub={row.hub}
                kind="lab"
                horizon={horizon}
                figures={lab}
                shown={labShown}
                unit={resourceUnitLong('lab', view.unit)}
                note={`Lab figures are for the ${row.lab_region} lab region and repeat on every hub of that region.`}
              />
            </div>

            <details className="group rounded-dash border border-dash-hairline bg-dash-alt px-s3 py-s2 text-2xs text-text-muted">
              <summary className="cursor-pointer select-none font-semibold text-text">
                How this is calculated
              </summary>
              <div className="mt-s2 space-y-s3">
                <p className="text-text-subtle">
                  The client&rsquo;s formulas (ADR&nbsp;0008), evaluated on the server from the hub
                  work calendar and chamber downtime. Shown as an equation so the figures can be
                  checked against the planning workbook; nothing is recalculated in the browser.
                </p>
                <dl className="grid gap-x-s4 gap-y-1 sm:grid-cols-2" data-testid="design-derivation">
                  <div>
                    <dt className="text-text-subtle">Yearly design capacity</dt>
                    <dd data-numeric="" className="text-text">
                      {formatDecimal(row.engineer_fte_total)} FTE ×{' '}
                      {formatDecimal(row.working_weeks_per_engineer)} working weeks ={' '}
                      <strong>{formatDecimal(row.design_capacity_year)}</strong> engineer-weeks
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-subtle">Remaining design capacity</dt>
                    <dd data-numeric="" className="text-text">
                      remaining fraction {formatDecimal(row.remaining_fraction)} of the year, net of
                      leave → <strong>{formatDecimal(row.design_capacity_remaining)}</strong>{' '}
                      engineer-weeks
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-subtle">Yearly lab capacity ({row.lab_region})</dt>
                    <dd data-numeric="" className="text-text">
                      Σ efficient lab weeks over the region&rsquo;s chambers ={' '}
                      <strong>{formatDecimal(row.lab_capacity_year)}</strong> chamber-weeks
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-subtle">Remaining lab capacity</dt>
                    <dd data-numeric="" className="text-text">
                      {formatDecimal(row.lab_capacity_year)} × {formatDecimal(row.remaining_fraction)}{' '}
                      = <strong>{formatDecimal(row.lab_capacity_remaining)}</strong> chamber-weeks
                    </dd>
                  </div>
                  <div className="sm:col-span-2" data-testid="days-derivation">
                    <dt className="text-text-subtle">In working days (served)</dt>
                    <dd data-numeric="" className="text-text">
                      Design capacity {formatFigure(designDaysYear.capacity)} (year) /{' '}
                      {formatFigure(designDaysRemaining.capacity)} (remaining) engineer-days at{' '}
                      {formatFigure(servedWeekdays(row, 'design'))} days a week; lab capacity{' '}
                      {formatFigure(labDays.capacity)} / {formatFigure(labDaysRemaining.capacity)} chamber-days at{' '}
                      {formatFigure(servedWeekdays(row, 'lab'))} days a week (the {row.lab_region} region calendar).
                      Load {formatFigure(designDays.load)} engineer-days, {formatFigure(labDays.load)} chamber-days.
                      Each is the served weeks figure × the served working days, computed on the server.
                    </dd>
                  </div>
                </dl>

                {row.chambers.length === 0 ? (
                  <p className="text-text-subtle">No chambers in the {row.lab_region} lab region.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Chamber</TableHead>
                        <TableHead className="text-right">Platforms</TableHead>
                        <TableHead className="text-right">Efficiency</TableHead>
                        <TableHead className="text-right">Working weeks</TableHead>
                        <TableHead className="text-right">Efficient lab weeks</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {row.chambers.map((c) => (
                        <TableRow key={c.chamber_id}>
                          <TableCell className="font-medium text-text">{c.code}</TableCell>
                          <TableCell className="text-right" data-numeric="">
                            {formatDecimal(c.platforms)}
                          </TableCell>
                          <TableCell className="text-right" data-numeric="">
                            {formatDecimal(c.efficiency)}
                          </TableCell>
                          <TableCell className="text-right" data-numeric="">
                            {formatDecimal(c.working_weeks_per_chamber)}
                          </TableCell>
                          <TableCell className="text-right" data-numeric="">
                            {formatDecimal(c.efficient_lab_weeks)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </details>
    </div>
  );
}
