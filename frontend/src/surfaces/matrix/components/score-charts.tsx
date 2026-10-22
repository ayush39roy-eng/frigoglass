import * as React from 'react';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CardInfo } from '@/components/ui/card-info';
import type { ProjectPriority } from '@/types/enums';

import {
  BAND_THRESHOLDS,
  DISTRIBUTION_BANDS,
  type BandDistributionEntry,
  type DistributionBand,
  type PriorityDistribution,
  type ScoreHistogramBucket,
} from '../api/types';

/**
 * P21 chart row above the grid: the band distribution and the score histogram.
 * Both plot the SERVED `band_distribution` / `score_histogram` for the grid's
 * server filters. Counts and shares are rendered verbatim; the browser never
 * computes a share or re-buckets a score (I9). Bar lengths are only a visual
 * scale of served figures. Each chart has a keyboard-reachable data table.
 */

const BAND_BG: Record<DistributionBand, string> = {
  P1: 'bg-band-p1',
  P2: 'bg-band-p2',
  P3: 'bg-band-p3',
  P4: 'bg-band-p4',
  Q: 'bg-band-q',
  // Unscored: a neutral hatch so it is not read as a band colour.
  Unscored:
    'bg-surface-sunken bg-[repeating-linear-gradient(135deg,hsl(var(--color-border-strong))_0_2px,transparent_2px_6px)]',
};

const BAND_VAR: Record<ProjectPriority, string> = {
  P1: 'hsl(var(--color-band-p1))',
  P2: 'hsl(var(--color-band-p2))',
  P3: 'hsl(var(--color-band-p3))',
  P4: 'hsl(var(--color-band-p4))',
  Q: 'hsl(var(--color-band-q))',
};

const BAND_LABEL: Record<DistributionBand, string> = {
  P1: 'P1',
  P2: 'P2',
  P3: 'P3',
  P4: 'P4',
  Q: 'Q',
  Unscored: 'Unscored',
};

function DataTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: (string | number)[][];
}): React.JSX.Element {
  return (
    <details className="group text-2xs">
      <summary className="cursor-pointer rounded-sm font-semibold text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
        Data table
      </summary>
      <table className="mt-2 w-full border-collapse text-left">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-border text-text-muted">
            {head.map((h, i) => (
              <th key={h} scope="col" className={cn('py-1 pr-2 font-semibold', i > 0 && 'text-right')}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r[0])} className="border-b border-border/60 last:border-0">
              {r.map((cell, i) =>
                i === 0 ? (
                  <th key={i} scope="row" className="py-1 pr-2 font-medium text-text">
                    {cell}
                  </th>
                ) : (
                  <td key={i} className="tnum py-1 pr-2 text-right text-text" data-numeric="">
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

// --- Band distribution --------------------------------------------------------

export function BandDistributionPanel({
  entries,
  activeBand,
  onBandClick,
  capacityFillCount,
  hideHeading = false,
}: {
  entries: BandDistributionEntry[];
  activeBand: DistributionBand | null;
  onBandClick: (band: DistributionBand | null) => void;
  /** P25: served `capacity_fill_count` (inside the P1 bucket); undefined from a pre-P25 API. */
  capacityFillCount?: number | undefined;
  /** The card already titles it "Band distribution": keep the heading for assistive tech only. */
  hideHeading?: boolean;
}): React.JSX.Element {
  const ordered = DISTRIBUTION_BANDS.map((band) => entries.find((e) => e.band === band)).filter(
    (e): e is BandDistributionEntry => e !== undefined,
  );
  const total = ordered.reduce((sum, e) => sum + e.count, 0);

  return (
    <section aria-labelledby="matrix-band-dist-title" className="flex min-w-0 flex-col gap-2" data-testid="band-distribution">
      <div className="flex items-center justify-between gap-2">
        <h3 id="matrix-band-dist-title" className={cn('text-sm font-semibold text-text', hideHeading && 'sr-only')}>
          Band distribution
        </h3>
        {activeBand !== null ? (
          <Button variant="ghost" size="sm" onClick={() => onBandClick(null)}>
            <X aria-hidden="true" />
            Clear band filter ({BAND_LABEL[activeBand]})
          </Button>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="text-2xs text-text-muted">No projects in this filter.</p>
      ) : (
        <div className="flex h-6 w-full overflow-hidden rounded-pill bg-surface-sunken" aria-hidden="true">
          {ordered
            .filter((e) => e.count > 0)
            .map((e) => (
              <span
                key={e.band}
                className={cn(
                  'grid h-full place-items-center overflow-hidden border-r-2 border-surface text-[0.625rem] font-bold tabular-nums text-white last:border-0 transition-opacity motion-reduce:transition-none',
                  BAND_BG[e.band],
                  activeBand !== null && activeBand !== e.band && 'opacity-35',
                )}
                // Served share, used as the segment length only.
                style={{ width: `${String(e.share_pct)}%` }}
              >
                {e.share_pct >= 4 ? formatInteger(e.count) : null}
              </span>
            ))}
        </div>
      )}
      <ul className="flex flex-wrap gap-1" aria-label="Bands — choose one to filter the table">
        {ordered.map((e) => {
          if (e.band === 'Q') {
            // Q is a committed priority, never a score band: always 0, shown muted, not a filter.
            return (
              <li key={e.band}>
                <span
                  className="inline-flex items-center gap-1.5 rounded border border-dashed border-border px-2 py-1 text-2xs text-text-muted"
                  title="Q is a committed priority, not a score band, so no score falls in it"
                  data-testid="band-legend-Q"
                >
                  <span className={cn('size-2.5 shrink-0 rounded-sm', BAND_BG.Q)} aria-hidden="true" />
                  Q <span className="tnum" data-numeric="">{formatInteger(e.count)}</span>
                  <span className="sr-only">(a committed priority, not a score band)</span>
                </span>
              </li>
            );
          }
          const active = activeBand === e.band;
          return (
            <li key={e.band}>
              <button
                type="button"
                aria-pressed={active}
                onClick={() => onBandClick(active ? null : e.band)}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded border px-1.5 py-0.5 text-2xs text-text transition-colors motion-reduce:transition-none',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  active ? 'border-primary bg-primary-subtle font-semibold' : 'border-border hover:bg-surface-raised',
                )}
                data-testid={`band-legend-${e.band}`}
              >
                <span className={cn('size-2.5 shrink-0 rounded-sm', BAND_BG[e.band])} aria-hidden="true" />
                <span className="font-semibold">{BAND_LABEL[e.band]}</span>
                <span className="tnum" data-numeric="">
                  {formatInteger(e.count)}
                </span>
                <span className="tnum text-text-muted" data-numeric="">
                  ({formatDecimal(e.share_pct)}%)
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {capacityFillCount !== undefined ? (
        <p className="text-2xs text-text-muted" data-testid="band-distribution-fill-note">
          P1{' '}
          <span className="tnum" data-numeric="">
            {formatInteger(ordered.find((e) => e.band === 'P1')?.count ?? 0)}
          </span>
          , of which{' '}
          <span className="tnum font-semibold" data-numeric="">
            {formatInteger(capacityFillCount)}
          </span>{' '}
          by capacity fill.
        </p>
      ) : null}
      <DataTable
        caption="Projects per band, with share of the filtered set (served)"
        head={['Band', 'Projects', 'Share %']}
        rows={ordered.map((e) => [BAND_LABEL[e.band], formatInteger(e.count), formatDecimal(e.share_pct)])}
      />
    </section>
  );
}

// --- Score histogram ------------------------------------------------------------

function bandAt(value: number): ProjectPriority {
  for (const t of BAND_THRESHOLDS) if (value >= t.min) return t.band;
  return 'P4';
}

/** Band colour(s) a bucket spans under the fixed thresholds (display only:
 *  the 50–60 bucket straddles 55 and is drawn two-tone). */
function bucketFill(b: ScoreHistogramBucket): string {
  const low = bandAt(b.bucket_from);
  const high = bandAt(Math.max(b.bucket_from, b.bucket_to - 0.5));
  if (low === high) return BAND_VAR[low];
  return `linear-gradient(to right, ${BAND_VAR[low]} 0 50%, ${BAND_VAR[high]} 50% 100%)`;
}

function bucketLabel(b: ScoreHistogramBucket): string {
  return `${String(b.bucket_from)}–${String(b.bucket_to)}`;
}

export function ScoreHistogramPanel({ buckets }: { buckets: ScoreHistogramBucket[] }): React.JSX.Element {
  const sorted = [...buckets].sort((a, b) => a.bucket_from - b.bucket_from);
  // Visual scale only: the tallest served count fills the plot height.
  const peak = sorted.reduce((m, b) => Math.max(m, b.count), 0);

  return (
    <section aria-labelledby="matrix-histogram-title" className="flex min-w-0 flex-col gap-2" data-testid="score-histogram">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id="matrix-histogram-title" className="text-sm font-semibold text-text">
          Score histogram <span className="font-normal text-text-muted">(score /100, 10-point buckets)</span>
        </h3>
        <p className="flex flex-wrap gap-2 text-2xs text-text-muted" aria-label="Band thresholds">
          {BAND_THRESHOLDS.map((t, i) => (
            <span key={t.band} className="inline-flex items-center gap-1">
              <span className={cn('size-2 rounded-sm', BAND_BG[t.band])} aria-hidden="true" />
              {t.band} {i === BAND_THRESHOLDS.length - 1 ? `< ${String(BAND_THRESHOLDS[i - 1]?.min ?? 0)}` : `≥ ${String(t.min)}`}
            </span>
          ))}
        </p>
      </div>
      {peak === 0 ? (
        <p className="text-2xs text-text-muted">No scored projects in this filter.</p>
      ) : (
        <div className="flex h-24 items-end gap-1" aria-hidden="true">
          {sorted.map((b) => (
            <div key={b.bucket_from} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-0.5">
              <span className="tnum text-2xs font-semibold text-text">{b.count > 0 ? formatInteger(b.count) : ''}</span>
              <span
                className="w-full rounded-t-sm transition-[height] duration-300 motion-reduce:transition-none"
                style={{ height: `${String((b.count / peak) * 100)}%`, minHeight: b.count > 0 ? 2 : 0, background: bucketFill(b) }}
              />
            </div>
          ))}
        </div>
      )}
      {peak === 0 ? null : (
        <div className="-mt-2 flex gap-1 border-t border-border pt-1" aria-hidden="true">
          {sorted.map((b) => (
            <span key={b.bucket_from} className="tnum min-w-0 flex-1 truncate text-center text-[10px] text-text-muted">
              {b.bucket_from}
            </span>
          ))}
        </div>
      )}
      <DataTable
        caption="Scored projects per 10-point score bucket (served)"
        head={['Score /100', 'Projects']}
        rows={sorted.map((b) => [bucketLabel(b), formatInteger(b.count)])}
      />
    </section>
  );
}

// --- Row --------------------------------------------------------------------------

export function ScoreChartsRow({
  distribution,
  activeBand,
  onBandClick,
}: {
  distribution: PriorityDistribution;
  activeBand: DistributionBand | null;
  onBandClick: (band: DistributionBand | null) => void;
}): React.JSX.Element {
  return (
    <Card data-testid="matrix-chart-row">
      {/* Owner ask 2026-10-22: only the band distribution stays (the histogram is
          gone); it still filters the grid by band. */}
      <CardHeader>
        <CardTitle>Band distribution</CardTitle>
        <CardInfo label="About the band distribution">
          <p>
            Served counts for the Cat / Type / Status / Hub / search filters above: the suggested bands, after each
            hub&apos;s P1 capacity fill. Select a band to filter the grid.
          </p>
          <p>Shares are served and rounded each, so they may not add up to exactly 100%.</p>
        </CardInfo>
      </CardHeader>
      <CardContent className="pt-0">
        <BandDistributionPanel
          entries={distribution.band_distribution}
          activeBand={activeBand}
          onBandClick={onBandClick}
          capacityFillCount={(distribution as Partial<PriorityDistribution>).capacity_fill_count}
          hideHeading
        />
      </CardContent>
    </Card>
  );
}
