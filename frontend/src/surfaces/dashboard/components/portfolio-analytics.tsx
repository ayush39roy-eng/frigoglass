import * as React from 'react';
import { motion } from 'framer-motion';
import { Layers, Target } from 'lucide-react';
import { PolarAngleAxis, RadialBar, RadialBarChart, ResponsiveContainer } from 'recharts';

import { BoltCard } from '@/components/ui/bolt-card';
import { formatInteger } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import type { CompletingWithinYearRow, PriorityDeliveryBand } from '../api/types';
import { displayOutcomeOf, type DisplayOutcome } from '../lib/outcome';
import { CardInfo } from '@/components/ui/card-info';

/**
 * Portfolio analytics (2026-10-01, client ask: "lots of graphs, fascinating").
 * Two views of the SAME `completing-within-year` rows the run
 * lists. Every figure is a COUNT of those rows (grouped by hub or
 * priority); no schedule figure is recomputed (Invariant I9). The per-project
 * outcome flags and finish weeks are the run's own.
 */

export interface PortfolioAnalyticsProps {
  rows: CompletingWithinYearRow[];
  /** Server-counted bands for "Delivery by priority" (P17-R03, I19). */
  priorityDelivery: PriorityDeliveryBand[];
}

export function PortfolioAnalytics({ rows, priorityDelivery }: PortfolioAnalyticsProps): React.JSX.Element {
  return (
    <section className="space-y-s4" aria-labelledby="portfolio-analytics-heading">
      <div>
        <h2
          id="portfolio-analytics-heading"
          className="font-display text-h1 font-extrabold tracking-tight text-text"
        >
          Portfolio analytics
        </h2>
        <p className="text-sm font-medium text-text-muted">
          The active run&apos;s project outcomes, sliced by priority and hub
        </p>
      </div>
      <div className="grid gap-gutter xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-6">
          <PriorityDeliveryRings bands={priorityDelivery} />
        </div>
        <div className="min-w-0 xl:col-span-6">
          <HubOutcomeStack rows={rows} />
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */

function CardHead({
  icon: Icon,
  title,
  subtitle,
  info,
  right,
}: {
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  subtitle: string;
  info: React.ReactNode;
  right?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex items-start justify-between gap-s3">
      <div className="flex items-center gap-s3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary-subtle text-primary-subtle-fg">
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h3 className="font-display text-h2 font-bold tracking-tight text-text">{title}</h3>
          <p className="text-xs font-medium text-text-subtle">{subtitle}</p>
        </div>
      </div>
      <div className="flex items-center gap-s2">
        {right}
        <CardInfo label={`About ${title}`}>{info}</CardInfo>
      </div>
    </div>
  );
}

/* ---------------------------- priority delivery rings ---------------------- */

const PRIORITY_COLOR: Record<ProjectPriority, string> = {
  P1: 'hsl(var(--color-band-p1))',
  P2: 'hsl(var(--color-band-p2))',
  P3: 'hsl(var(--color-band-p3))',
  P4: 'hsl(var(--color-band-p4))',
  Q: 'hsl(var(--color-band-q))',
};

export const PRIORITY_NOTE =
  'Projects that have not started cannot finish within the year however high their priority; in-flight and not-started work are shown separately.';

interface RingDatum {
  priority: ProjectPriority;
  pct: number;
  fill: string;
}

function PriorityDeliveryRings({ bands }: { bands: PriorityDeliveryBand[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  // Bands with no projects are hidden. Every figure is the server's (I19).
  const shown = React.useMemo(() => bands.filter((b) => b.total > 0), [bands]);
  // The ring is the in-flight share, so a band with nothing in flight has no ring.
  const rings = React.useMemo<RingDatum[]>(
    () =>
      shown
        .filter((b) => b.in_flight_total > 0)
        .map((b) => ({
          priority: b.priority,
          pct: b.in_flight_within_year_share_pct,
          fill: PRIORITY_COLOR[b.priority],
        })),
    [shown],
  );

  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card">
      <CardHead
        icon={Target}
        title="Delivery by priority"
        subtitle="In-flight work finishing within the year, by priority band"
        info={
          <>
            <p>
              Each ring is one priority band: the filled arc is the share of that band&apos;s
              in-flight projects the active run flags as within-year. Not-started projects have
              their own bar, and Commercialized projects are listed as already delivered, outside
              the rings. Paused (status On Hold), Cancelled and Draft projects are listed as not in
              plan.
            </p>
            <p className="mt-s2">{PRIORITY_NOTE}</p>
          </>
        }
      />
      {shown.length === 0 ? (
        <p className="text-sm text-text-muted">No prioritised projects in this run.</p>
      ) : (
        <>
          <div className="grid flex-1 items-center gap-s4 sm:grid-cols-[minmax(0,12rem)_1fr]">
            {rings.length > 0 ? (
              <figure
                aria-label="In-flight within-year share by priority band"
                className="mx-auto h-48 w-full max-w-[12rem]"
              >
                <ResponsiveContainer width="100%" height="100%">
                  <RadialBarChart
                    data={[...rings].reverse()}
                    innerRadius="28%"
                    outerRadius="100%"
                    startAngle={90}
                    endAngle={-270}
                    barSize={12}
                  >
                    <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
                    <RadialBar
                      dataKey="pct"
                      cornerRadius={8}
                      background={{ fill: 'hsl(var(--color-surface-sunken))' }}
                      isAnimationActive={!reduced}
                      animationDuration={1100}
                    />
                  </RadialBarChart>
                </ResponsiveContainer>
              </figure>
            ) : (
              <p className="text-sm text-text-muted">No in-flight projects in these bands.</p>
            )}
            <ul className="space-y-s2" aria-label="Delivery by priority band">
              {shown.map((b) => (
                <PriorityBandItem key={b.priority} band={b} />
              ))}
            </ul>
          </div>
          <p className="text-xs font-medium text-text-muted" data-testid="priority-delivery-note">
            {PRIORITY_NOTE}
          </p>
        </>
      )}
    </BoltCard>
  );
}

function PriorityBandItem({ band: b }: { band: PriorityDeliveryBand }): React.JSX.Element {
  const fill = PRIORITY_COLOR[b.priority];
  const inFlight = `in flight ${formatInteger(b.in_flight_within_year)} of ${formatInteger(b.in_flight_total)}`;
  const notStarted = `not started ${formatInteger(b.not_started_within_year)} of ${formatInteger(b.not_started_total)}`;
  return (
    <li
      className="rounded-xl border-[1.5px] border-dash-hairline bg-dash-alt px-s3 py-s2"
      aria-label={`${b.priority}: ${inFlight}, ${notStarted}, ${formatInteger(b.total)} projects`}
    >
      <div className="flex items-center gap-s3">
        <span className="size-3 shrink-0 rounded-full" style={{ background: fill }} aria-hidden="true" />
        <span className="w-7 text-sm font-bold text-text">{b.priority}</span>
        <span className="text-2xs font-medium text-text-subtle" data-numeric="">
          {formatInteger(b.total)} projects
        </span>
        <span
          className="ml-auto font-display text-base font-extrabold tabular-nums text-text"
          data-numeric=""
          title="Share of in-flight projects finishing within the year"
        >
          {b.in_flight_total > 0 ? `${String(Math.round(b.in_flight_within_year_share_pct))}%` : '–'}
        </span>
      </div>
      <p className="mt-1 text-2xs font-medium text-text-muted" data-numeric="">
        {b.priority} · {inFlight} · {notStarted}
      </p>
      {b.not_started_total > 0 ? (
        <div
          className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-sunken"
          role="img"
          aria-label={`${b.priority} not started: ${formatInteger(b.not_started_within_year)} of ${formatInteger(b.not_started_total)} finish within the year`}
          title={`Not started: ${formatInteger(b.not_started_within_year)} of ${formatInteger(b.not_started_total)} within the year`}
        >
          <div
            className="h-full rounded-full"
            style={{ width: `${String(b.not_started_within_year_share_pct)}%`, background: fill }}
          />
        </div>
      ) : null}
      {b.delivered_total > 0 ? (
        <p className="mt-1 text-2xs text-text-subtle" data-numeric="">
          Already delivered: {formatInteger(b.delivered_total)}
        </p>
      ) : null}
      {b.other_total > 0 ? (
        <p className="text-2xs text-text-subtle" data-numeric="">
          Not in plan: {formatInteger(b.other_total)}
        </p>
      ) : null}
    </li>
  );
}

/* ---------------------------- outcomes by hub ------------------------------ */

// ADR 0024: three outcomes on the 52-week year; a left-out project sits in the
// spillover segment (not done by W52), never in a separate "left out" one.
const STACK_ORDER: { bucket: DisplayOutcome; label: string; fill: string; dot: string }[] = [
  { bucket: 'within_year', label: 'Within year', fill: 'bg-success', dot: 'bg-success' },
  { bucket: 'spillover', label: 'Spillover (past W52)', fill: 'bg-warning', dot: 'bg-warning' },
  { bucket: 'blocked', label: 'On Hold at a stage', fill: 'bg-text-muted', dot: 'bg-text-muted' },
];

function HubOutcomeStack({ rows }: { rows: CompletingWithinYearRow[] }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  const hubs = React.useMemo(() => {
    const map = new Map<string, Record<DisplayOutcome, number>>();
    for (const row of rows) {
      const entry =
        map.get(row.hub) ??
        ({ within_year: 0, spillover: 0, blocked: 0, unresolved: 0 } as Record<DisplayOutcome, number>);
      entry[displayOutcomeOf(row)] += 1;
      map.set(row.hub, entry);
    }
    return [...map.entries()]
      .map(([hub, counts]) => ({
        hub,
        counts,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      }))
      .sort((a, b) => b.total - a.total);
  }, [rows]);
  const max = hubs.reduce((m, h) => Math.max(m, h.total), 0);

  return (
    <BoltCard className="flex flex-col gap-s4 p-card">
      <CardHead
        icon={Layers}
        title="Outcomes by hub"
        subtitle="Every project in the run, stacked by its outcome"
        info={
          <p>
            One bar per hub, sized by how many of its projects are in the active run, split by each
            project&apos;s outcome flag. A project appears in exactly one segment.
          </p>
        }
        right={
          <span className="hidden flex-wrap items-center gap-s3 text-2xs font-semibold text-text-muted md:flex">
            {STACK_ORDER.map((s) => (
              <span key={s.bucket} className="flex items-center gap-1.5">
                <span className={cn('size-2.5 rounded-full', s.dot)} aria-hidden="true" />
                {s.label}
              </span>
            ))}
          </span>
        }
      />
      <ul className="space-y-s3" aria-label="Outcome counts per hub">
        {hubs.map((h, i) => (
          <li key={h.hub} className="grid items-center gap-s3 sm:grid-cols-[9rem_1fr_3rem]">
            <span className="truncate text-sm font-bold text-text">{h.hub}</span>
            <div className="h-7 overflow-hidden rounded-full bg-surface-sunken">
              <motion.div
                className="flex h-full overflow-hidden rounded-full"
                style={{ width: `${String(max === 0 ? 0 : (h.total / max) * 100)}%`, transformOrigin: 'left' }}
                {...(reduced
                  ? {}
                  : {
                      initial: { scaleX: 0 },
                      whileInView: { scaleX: 1 },
                      viewport: { once: true, margin: '-40px' },
                      transition: { duration: 0.9, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] },
                    })}
              >
                {STACK_ORDER.map((s) => {
                  const n = h.counts[s.bucket];
                  if (n === 0) return null;
                  return (
                    <span
                      key={s.bucket}
                      className={cn(
                        'grid h-full place-items-center border-r-2 border-surface text-2xs font-bold text-white last:border-r-0',
                        s.fill,
                      )}
                      style={{ width: `${String((n / h.total) * 100)}%` }}
                      title={`${h.hub}: ${String(n)} ${s.label.toLowerCase()}`}
                    >
                      {n}
                    </span>
                  );
                })}
              </motion.div>
            </div>
            <span className="text-right font-display text-base font-extrabold tabular-nums text-text" data-numeric="">
              {h.total}
            </span>
          </li>
        ))}
      </ul>
    </BoltCard>
  );
}
