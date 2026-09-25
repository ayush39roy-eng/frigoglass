import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatInteger } from '@/lib/format';
import { PRIORITY_BANDS, PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import type { PriorityPortfolioSummary } from '../api/types';
import { BandDistributionChart, type BandDatum } from './band-distribution-chart';

/**
 * "Portfolio decision summary" (`docs/PROJECT_AND_STACK.md` §2). Every number is
 * read verbatim from `GET /priorities/summary`. The table is authoritative; the
 * bar chart plots the identical `suggested_band_counts` values.
 *
 * `suggested_band` = what the current 13-dimension score computes to (server-
 * side). `set_priority` = the priority currently *committed* on the project
 * (`Project.priority`). They can differ — a Portfolio Manager may override, or a
 * hard gate may pin a project to P1 on "Apply Priorities". Labelled explicitly
 * so the two are never conflated.
 */
export function PortfolioSummaryPanel({
  summary,
}: {
  summary: PriorityPortfolioSummary;
}): React.JSX.Element {
  const bandData: BandDatum[] = PRIORITY_BANDS.map((band) => ({
    band,
    count: summary.suggested_band_counts[band] ?? 0,
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>Portfolio decision summary</CardTitle>
        <Badge tone="neutral" data-numeric="">
          {formatInteger(summary.scored_projects)} / {formatInteger(summary.total_projects)} scored
        </Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-2xs text-text-muted">
          Counts are for projects in your hub scope. All figures come straight from{' '}
          <code>GET /priorities/summary</code> — none is recomputed in your browser.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Stat label="Scored" value={summary.scored_projects} />
          <Stat label="Not yet scored" value={summary.unscored_projects} />
          <Stat
            label="Hard-gate forced to P1"
            value={summary.hard_gate_forced_count}
            hint="Projects with an active hard gate — pinned to P1 regardless of score (DOMAIN_RULES.md)."
          />
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Computed band (from current score)
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Band</TableHead>
                  <TableHead className="text-right">Scored projects</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PRIORITY_BANDS.map((band) => (
                  <TableRow key={band}>
                    <TableCell>
                      <PriorityBandPill priority={band} />
                    </TableCell>
                    <TableCell className="text-right tnum text-text" data-numeric="">
                      {formatInteger(summary.suggested_band_counts[band] ?? 0)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <BandDistributionChart data={bandData} />
          </section>

          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Committed priority (Project.priority)
            </h3>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Priority</TableHead>
                  <TableHead className="text-right">Projects</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {PROJECT_PRIORITIES.map((p: ProjectPriority) => (
                  <TableRow key={p}>
                    <TableCell>
                      <PriorityBandPill priority={p} />
                    </TableCell>
                    <TableCell className="text-right tnum text-text" data-numeric="">
                      {formatInteger(summary.set_priority_counts[p] ?? 0)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            <p className="text-2xs text-text-subtle">
              &ldquo;Committed&rdquo; is today&rsquo;s assigned priority. Editing a score here changes
              only the computed band — applying priorities portfolio-wide is a separate action.
            </p>
          </section>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: number;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-border bg-surface-raised px-3 py-2">
      <p className="text-2xs text-text-muted">{label}</p>
      <p className="tnum text-lg font-semibold text-text" data-numeric="">
        {formatInteger(value)}
      </p>
      {hint ? <p className="mt-0.5 text-2xs text-text-subtle">{hint}</p> : null}
    </div>
  );
}
