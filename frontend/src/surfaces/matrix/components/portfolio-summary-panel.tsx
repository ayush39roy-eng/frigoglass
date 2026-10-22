import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CardInfo } from '@/components/ui/card-info';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import type { PriorityPortfolioSummary } from '../api/types';

/**
 * "Portfolio decision summary" (`docs/PROJECT_AND_STACK.md` §2). Every number is
 * read verbatim from `GET /priorities/summary`.
 *
 * Owner ask 2026-10-22: compact. One grid, the bands across (P1–P4, Q) and three
 * rows down: Suggested (score band after the hub's P1 capacity fill, P25), Score
 * band (before the fill) and Committed (`Project.priority`). The two bar charts
 * are gone: the band distribution is drawn once, in the Score overview below.
 *
 * `suggested_band` and `set_priority` can differ (a Portfolio Manager may
 * override, or a hard gate may pin a project to P1 on "Apply Priorities"), so
 * the rows are labelled explicitly and never conflated. Suggested and Score
 * band have no Q column: Q is a committed priority only.
 */
export function PortfolioSummaryPanel({
  summary,
}: {
  summary: PriorityPortfolioSummary;
}): React.JSX.Element {
  // P25: absent from a pre-P25 API; then the Score band row is left out.
  const hasFill = typeof (summary as Partial<PriorityPortfolioSummary>).capacity_fill_count === 'number';

  const rows: { key: string; label: string; hint: string; value: (p: ProjectPriority) => number | null; muted?: boolean }[] = [
    {
      key: 'suggested',
      label: 'Suggested',
      hint: 'Score band, then the hub’s P1 capacity fill',
      value: (p) => (p === 'Q' ? null : (summary.suggested_band_counts[p] ?? 0)),
    },
    ...(hasFill
      ? [
          {
            key: 'score-band',
            label: 'Score band',
            hint: 'From the score alone, before the capacity fill',
            value: (p: ProjectPriority) => (p === 'Q' ? null : (summary.score_band_counts[p] ?? 0)),
            muted: true,
          },
        ]
      : []),
    {
      key: 'committed',
      label: 'Committed',
      hint: 'Today’s assigned priority (Project.priority)',
      value: (p) => summary.set_priority_counts[p] ?? 0,
    },
  ];

  return (
    <Card>
      <CardHeader className="flex-wrap gap-y-2">
        <CardTitle>Portfolio decision summary</CardTitle>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral" data-numeric="">
            {formatInteger(summary.scored_projects)} / {formatInteger(summary.total_projects)} scored
          </Badge>
          <Chip label="Not yet scored" value={summary.unscored_projects} />
          <Chip
            label="Hard-gate P1"
            value={summary.hard_gate_forced_count}
            title="Projects with an active hard gate, pinned to P1 regardless of score"
          />
          {hasFill ? (
            <span className="text-2xs text-text" data-testid="summary-fill-note">
              P1 {formatInteger(summary.suggested_band_counts.P1 ?? 0)}, of which{' '}
              <span className="font-semibold">{formatInteger(summary.capacity_fill_count)}</span> by capacity fill.
            </span>
          ) : null}
          <CardInfo label="About the portfolio decision summary">
            <p>
              Counts for projects in your hub scope, straight from <code>GET /priorities/summary</code>; none is
              recomputed in your browser.
            </p>
            <p>
              <strong>Suggested</strong> is the score band after each hub&apos;s P1 capacity fill;{' '}
              <strong>Score band</strong> is the band from the score alone; <strong>Committed</strong> is
              today&apos;s assigned priority. Editing a score changes only the computed band; applying priorities
              portfolio-wide is a separate action.
            </p>
          </CardInfo>
        </div>
      </CardHeader>
      <CardContent className="pt-0">
        {/* Scrolls sideways on phones: a focusable named region (axe scrollable-region-focusable). */}
        <div
          className="overflow-x-auto rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          role="region"
          aria-label="Projects per priority band"
          tabIndex={0}
        >
          <table className="w-auto min-w-[32rem] border-collapse text-sm" data-testid="portfolio-summary-grid">
            <caption className="sr-only">Projects per priority band: suggested, score band and committed</caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-1.5 pr-3 text-left text-2xs font-bold uppercase tracking-wider text-text-subtle">
                  <span className="sr-only">Measure</span>
                </th>
                {PROJECT_PRIORITIES.map((p) => (
                  <th key={p} scope="col" className="w-20 px-2 py-1.5 text-right">
                    <PriorityBandPill priority={p} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-b border-border/60 last:border-b-0">
                  <th scope="row" className="whitespace-nowrap py-1.5 pr-8 text-left font-normal" title={r.hint}>
                    <span className={cn('text-xs font-semibold', r.muted ? 'text-text-muted' : 'text-text')}>{r.label}</span>
                    <span className="ml-2 hidden text-2xs text-text-subtle xl:inline">{r.hint}</span>
                  </th>
                  {PROJECT_PRIORITIES.map((p) => {
                    const v = r.value(p);
                    return (
                      <td
                        key={p}
                        className={cn('px-2 py-1.5 text-right tnum', r.muted ? 'text-text-muted' : 'font-semibold text-text')}
                        data-numeric=""
                        data-testid={v === null ? undefined : `summary-${r.key}-${p}`}
                      >
                        {v === null ? <span className="text-text-subtle">–</span> : formatInteger(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}

function Chip({ label, value, title }: { label: string; value: number; title?: string }): React.JSX.Element {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-pill bg-surface-sunken px-2 py-0.5 text-2xs text-text-muted"
      title={title}
    >
      {label}
      <span className="tnum font-bold text-text" data-numeric="">
        {formatInteger(value)}
      </span>
    </span>
  );
}
