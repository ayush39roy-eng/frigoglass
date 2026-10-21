import * as React from 'react';
import { motion } from 'framer-motion';
import { Layers, Target } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { formatInteger } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import type { CompletingWithinYearRow, PriorityDeliveryBand } from '../api/types';
import { displayOutcomeOf, type DisplayOutcome } from '../lib/outcome';
import { formatServedPct } from '../lib/analytics';
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
          <PriorityDeliveryBars bands={priorityDelivery} />
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
        <span className="hidden size-10 shrink-0 place-items-center rounded-xl bg-primary-subtle sm:grid text-primary-subtle-fg">
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

/* ---------------------------- delivery by priority ------------------------ */

const PRIORITY_DOT: Record<ProjectPriority, string> = {
  P1: 'bg-band-p1',
  P2: 'bg-band-p2',
  P3: 'bg-band-p3',
  P4: 'bg-band-p4',
  Q: 'bg-band-q',
};

export const PRIORITY_NOTE =
  'Projects that have not started cannot finish within the year however high their priority; in-flight and not-started work are shown separately.';

type SegmentKey =
  | 'in_flight_finishing'
  | 'in_flight_not_finishing'
  | 'not_started_finishing'
  | 'not_started_not_finishing'
  | 'delivered'
  | 'not_in_plan';

/**
 * P17-R08 (owner): one status colour scheme for every band (the band colour is
 * only the P-label dot). Finishing = green, not finishing = amber; in flight is
 * solid, not started is the light tint; delivered is blue, not in plan grey.
 */
const DELIVERY_SEGMENTS: { key: SegmentKey; label: string; fill: string }[] = [
  { key: 'in_flight_finishing', label: 'In flight, finishing this year', fill: 'bg-success' },
  { key: 'in_flight_not_finishing', label: 'In flight, not finishing', fill: 'bg-warning' },
  { key: 'not_started_finishing', label: 'Not started, finishing this year', fill: 'bg-success/40' },
  { key: 'not_started_not_finishing', label: 'Not started, not finishing', fill: 'bg-warning/40' },
  { key: 'delivered', label: 'Already delivered', fill: 'bg-primary' },
  { key: 'not_in_plan', label: 'Not in plan', fill: 'bg-border-strong' },
];

/** Segment sizes are served counts; the two "not finishing" parts are the
 *  difference of two served integers (owner ruling, P17-R08). */
function segmentCounts(b: PriorityDeliveryBand): Record<SegmentKey, number> {
  return {
    in_flight_finishing: b.in_flight_within_year,
    in_flight_not_finishing: b.in_flight_total - b.in_flight_within_year,
    not_started_finishing: b.not_started_within_year,
    not_started_not_finishing: b.not_started_total - b.not_started_within_year,
    delivered: b.delivered_total,
    not_in_plan: b.other_total,
  };
}

function bandParts(b: PriorityDeliveryBand): string[] {
  const parts: string[] = [];
  if (b.in_flight_total > 0) parts.push(`In flight: ${formatInteger(b.in_flight_within_year)} of ${formatInteger(b.in_flight_total)}`);
  if (b.not_started_total > 0) parts.push(`Not started: ${formatInteger(b.not_started_within_year)} of ${formatInteger(b.not_started_total)}`);
  if (b.delivered_total > 0) parts.push(`Already delivered: ${formatInteger(b.delivered_total)}`);
  if (b.other_total > 0) parts.push(`Not in plan: ${formatInteger(b.other_total)}`);
  return parts;
}

function PriorityDeliveryBars({ bands }: { bands: PriorityDeliveryBand[] }): React.JSX.Element {
  // Bands with no projects are hidden. Every figure is the server's (I19).
  const shown = React.useMemo(() => bands.filter((b) => b.total > 0), [bands]);

  return (
    <BoltCard className="flex flex-col gap-s4 p-card" data-testid="priority-delivery-card">
      <CardHead
        icon={Target}
        title="Delivery by priority"
        subtitle="How many projects in each priority band finish within the year"
        info={
          <>
            <p>
              One bar per priority band, as long as the band&apos;s projects. Green parts finish within
              the year in the active run, amber parts do not; solid is work in flight, the light tint
              is work not started yet. Commercialized projects are shown as already delivered. Paused
              (status On Hold), Cancelled and Draft projects are listed as not in plan.
            </p>
            <p className="mt-s2">{PRIORITY_NOTE}</p>
          </>
        }
      />
      {shown.length === 0 ? (
        <p className="text-sm text-text-muted">No prioritised projects in this run.</p>
      ) : (
        <>
          <ul className="flex flex-wrap gap-x-s4 gap-y-1 text-2xs font-semibold text-text-muted" aria-label="Bar segments">
            {DELIVERY_SEGMENTS.map((seg) => (
              <li key={seg.key} className="flex items-center gap-1.5">
                <span className={cn('size-2.5 rounded-sm', seg.fill)} aria-hidden="true" />
                {seg.label}
              </li>
            ))}
          </ul>
          <ul className="space-y-s3" aria-label="Delivery by priority band">
            {shown.map((b) => (
              <PriorityBandRow key={b.priority} band={b} />
            ))}
          </ul>
          <p className="text-xs font-medium text-text-muted" data-testid="priority-delivery-note">
            {PRIORITY_NOTE}
          </p>
        </>
      )}
    </BoltCard>
  );
}

function PriorityBandRow({ band: b }: { band: PriorityDeliveryBand }): React.JSX.Element {
  const counts = segmentCounts(b);
  const headline = `${formatInteger(b.within_year)} of ${formatInteger(b.total)} finishing this year`;
  const parts = bandParts(b);
  const aria = [`${b.priority}: ${headline}`, ...parts.map((p) => p.replace(': ', ' ').toLowerCase())].join('; ');
  return (
    <li aria-label={aria} data-testid={`priority-band-${b.priority}`}>
      <div className="flex flex-wrap items-baseline gap-x-s3 gap-y-0.5">
        <span className="flex items-center gap-1.5">
          <span className={cn('size-2.5 shrink-0 rounded-full', PRIORITY_DOT[b.priority])} aria-hidden="true" />
          <span className="text-sm font-bold text-text">{b.priority}</span>
        </span>
        <span className="text-sm font-semibold text-text" data-numeric="">
          {headline}
        </span>
        <span
          className="ml-auto font-display text-base font-extrabold tabular-nums text-text"
          data-numeric=""
          title="Share of the band finishing within the year"
        >
          {formatServedPct(b.within_year_share_pct)}
        </span>
      </div>
      <div className="mt-1 flex h-3 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
        {DELIVERY_SEGMENTS.map((seg) => {
          const n = counts[seg.key];
          if (n <= 0) return null;
          return (
            <span
              key={seg.key}
              className={cn('h-full border-r border-surface last:border-r-0', seg.fill)}
              style={{ flexGrow: n, flexBasis: 0 }}
              data-segment={seg.key}
              data-count={n}
              title={`${b.priority} · ${seg.label}: ${formatInteger(n)}`}
            />
          );
        })}
      </div>
      {parts.length > 0 ? (
        <p className="mt-1 text-2xs font-medium text-text-muted" data-numeric="">
          {parts.join(' · ')}
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
