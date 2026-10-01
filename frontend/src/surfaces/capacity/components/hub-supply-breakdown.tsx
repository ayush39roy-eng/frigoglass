import * as React from 'react';
import { motion } from 'framer-motion';
import { CircleCheck, TriangleAlert } from 'lucide-react';

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
import { useMotionTokens } from '@/lib/motion';
import { cn } from '@/lib/utils';

import type { HubCapacityRow } from '../api/types';
import { pickFigures, type CapacityHorizon, type ResourceFigures, type ResourceKind } from '../lib/pick-figures';
import { CapacityInfo } from './capacity-info';
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
  unit,
  note,
}: {
  hub: string;
  kind: ResourceKind;
  horizon: CapacityHorizon;
  figures: ResourceFigures;
  unit: string;
  note?: string;
}): React.JSX.Element {
  const title = kind === 'design' ? 'Design' : 'Lab';
  const shortfall = figures.gap > 0;
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
          <GapBadge gap={figures.gap} unit={unit} />
          {/* The lab caveat used to render as a line of prose under this block,
              once per hub card — six identical sentences on a full page. Same
              words, now one affordance per block (client text cleanup,
              2026-10-01). */}
          {note ? (
            <CapacityInfo label={`About these ${title.toLowerCase()} figures`} className="size-6">
              <p>{note}</p>
            </CapacityInfo>
          ) : null}
        </div>
      </header>

      <div className="grid gap-s2 sm:grid-cols-2">
        <CapacityStat
          label="Load (process-derived)"
          value={figures.load}
          data-testid={`${kind}-load`}
        />
        <CapacityStat
          label="Load (estimated)"
          value={figures.loadEstimated}
          muted
          data-testid={`${kind}-load-estimated`}
        />
        <CapacityStat
          label={HORIZON_LABEL[horizon]}
          value={figures.capacity}
          data-testid={`${kind}-capacity`}
        />
        <CapacityStat
          label="Gap (load − capacity)"
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
          className="sm:col-span-2"
          data-testid={`${kind}-completion`}
        />
      </div>

      <BarChart
        ariaLabel={`${hub} ${title.toLowerCase()}: load versus ${HORIZON_LABEL[horizon].toLowerCase()}, in ${unit}`}
        formatValue={formatDecimal}
        data={[
          {
            key: 'load',
            label: 'Load (process-derived)',
            value: figures.load,
            tone: shortfall ? 'warning' : 'primary',
          },
          { key: 'capacity', label: HORIZON_LABEL[horizon], value: figures.capacity, tone: 'neutral' },
        ]}
      />
    </section>
  );
}

export interface HubSupplyBreakdownProps {
  rows: HubCapacityRow[];
  horizon: CapacityHorizon;
}

export function HubSupplyBreakdown({ rows, horizon }: HubSupplyBreakdownProps): React.JSX.Element {
  const motionTokens = useMotionTokens();

  return (
    <div className="space-y-s4" data-testid="hub-supply-breakdown">
      {rows.map((row, index) => {
        const design = pickFigures(row, 'design', horizon);
        const lab = pickFigures(row, 'lab', horizon);
        const headingId = `capacity-hub-${row.hub.replace(/[^a-z0-9]+/gi, '-')}`;
        // `exactOptionalPropertyTypes` forbids `whileHover={undefined}` explicitly
        // (framer-motion's prop types don't include `undefined` in their union) —
        // build the hover prop conditionally and spread, same pattern as the
        // Dashboard's `StatCard`.
        const hoverProps = motionTokens.reduced ? {} : { whileHover: { y: -3 } };
        return (
          <motion.article
            key={row.hub}
            aria-labelledby={headingId}
            initial={motionTokens.reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...motionTokens.transition, delay: motionTokens.reduced ? 0 : index * 0.04 }}
            {...hoverProps}
            className="space-y-s3 rounded-dash border border-dash-hairline bg-surface p-card shadow-dashCard transition-shadow duration-fast ease-ease-out-expo hover:shadow-pop"
            data-testid="capacity-hub-card"
          >
            <header className="flex flex-wrap items-baseline justify-between gap-s2">
              <h3 id={headingId} className="text-h2 text-text">
                {row.hub}
              </h3>
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
              </span>
            </header>

            <div className="grid gap-s3 lg:grid-cols-2">
              <ResourceBlock hub={row.hub} kind="design" horizon={horizon} figures={design} unit="engineer-weeks" />
              <ResourceBlock
                hub={row.hub}
                kind="lab"
                horizon={horizon}
                figures={lab}
                unit="chamber-weeks"
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
          </motion.article>
        );
      })}
    </div>
  );
}
