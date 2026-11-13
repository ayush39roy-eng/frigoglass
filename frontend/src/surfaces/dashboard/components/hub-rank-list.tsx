import * as React from 'react';
import { motion } from 'framer-motion';
import { Building2 } from 'lucide-react';

import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { useMotionTokens } from '@/lib/motion';
import { formatDecimal, formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { HubTypePipelineRow, RegionSummary } from '../api/types';
import { buildHubTotals, useHubCountry } from '../lib/hub-geo';
import { pipelineRegionItems } from '../lib/region-summary';
import { CardOpenButton, useOpenProjectList } from './project-list-dialog';
import { RegionChips } from './region-chips';
import { dashRankBg, dashRankSoftBg, dashRankText } from '../lib/dash-chart-theme';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';

/**
 * "Top hubs by project count" — Boltshift spec §5's ranked-list-with-coloured-
 * progress-track pattern, REPLACING the hub globe (`hub-globe.tsx`,
 * `hub-globe-panel.tsx`, `cobe`; 2026-09-30 "crazy-charts" polish, deleted in this
 * change) per the task's own explicit instruction — "Boltshift explicitly bans 3D
 * globes". Every number is the same real per-hub total the globe's legend used to
 * show (`buildHubTotals()`, `GET /dashboard/hub-type-pipeline`); only the
 * presentation changed, not the data source (Invariant I9 is not implicated here —
 * this is portfolio composition, not a schedule outcome, same as the table it sits
 * beside — but the "no fabricated number" discipline is identical either way).
 *
 * Bars animate width 0→value with a stagger on mount, gated by `useMotionTokens()`
 * (the sitewide `prefers-reduced-motion` switch) exactly like every other animated
 * Dashboard element.
 */

export interface HubRankListProps {
  rows: HubTypePipelineRow[];
  /** Served `pipeline-totals.total_count` (every project in scope). Each hub's
   *  percentage is its share of THIS total (owner ask 2026-11-13); until it
   *  loads, the hub rows' own sum is used (the same set, same scope). */
  pipelineTotal?: number | null | undefined;
  /** Served per-country totals and shares, shown above the hubs. */
  regionSummary?: RegionSummary | null | undefined;
}

export function HubRankList({ rows, pipelineTotal = null, regionSummary = null }: HubRankListProps): React.JSX.Element {
  const motionTokens = useMotionTokens();
  const country = useHubCountry();
  const openList = useOpenProjectList();
  const totals = React.useMemo(() => buildHubTotals(rows, country), [rows, country]);
  const total = pipelineTotal ?? totals.reduce((sum, t) => sum + t.count, 0);

  return (
    <BoltCard>
      <CardHeader>
        <CardTitle>Top hubs by project count</CardTitle>
        {/* Client text cleanup, 2026-10-01: the caveat that used to be a footnote
            under this list ("Sized by each hub's share of the live pipeline…
            positions are approximate") now lives in this popover — the list itself
            carries only its heading, its labels and its figures. */}
        <CardInfo label="Hub ranking source">
          <p>
            One row per hub, sized by that hub&apos;s share of the live pipeline (
            <code>GET /dashboard/hub-type-pipeline</code>) — the same rows the hub × type table
            beside this list pivots.
          </p>
          <p>
            Portfolio composition, not a schedule outcome: these counts come from the project
            registry, so Invariant I9 does not apply to them. The percentage (and the bar) is each
            hub&apos;s share of all projects in view (Total projects), so the hubs add up to 100%.
            The country chips are the server&apos;s per-country totals and shares of that total.
            Click a hub or a country to list its projects.
          </p>
        </CardInfo>
      </CardHeader>
      <CardContent>
        {totals.length > 0 ? (
          <div className="mb-s4 flex flex-wrap items-center gap-s2 border-b border-dash-hairline pb-s3" data-testid="hub-rank-summary">
            <span className="text-sm font-semibold text-text">
              <span className="tabular-nums" data-numeric="">{formatInteger(total)}</span> projects
            </span>
            {regionSummary ? (
              <RegionChips
                label="Projects"
                items={pipelineRegionItems(regionSummary, 'total')}
                onSelect={
                  openList
                    ? (item, el) => {
                        openList(
                          { title: `All projects · ${item.region}`, expected: item.count, match: (row) => row.region === item.region },
                          el,
                        );
                      }
                    : undefined
                }
              />
            ) : null}
          </div>
        ) : null}
        {totals.length === 0 ? (
          <EmptyState
            title="No hubs in scope"
            description="There are no projects in the hub × type pipeline for your hub scope."
          />
        ) : (
          <ol aria-label="Real project count per hub, ranked" className="flex flex-col gap-s4">
            {totals.map((hubTotal, index) => {
              // Share of all projects in view, 2 dp like every other Dashboard share.
              const pct = total > 0 ? Math.round((hubTotal.count / total) * 10000) / 100 : 0;
              return (
                <li
                  key={hubTotal.hub}
                  className={cn(
                    'relative flex flex-col gap-s2 rounded-lg',
                    openList && '-mx-s2 px-s2 py-s1 transition-colors duration-base hover:bg-dash-alt',
                  )}
                >
                  {openList ? (
                    <CardOpenButton
                      label={`${hubTotal.hub}: list the ${formatInteger(hubTotal.count)} projects`}
                      testId={`hub-rank-open-${hubTotal.hub}`}
                      onOpen={(el) => {
                        openList(
                          { title: hubTotal.hub, expected: hubTotal.count, match: (row) => row.hub === hubTotal.hub },
                          el,
                        );
                      }}
                    />
                  ) : null}
                  <div className="flex items-center justify-between gap-s2 text-body">
                    <span className="flex min-w-0 items-center gap-s2 truncate font-medium text-text">
                      <Building2
                        className={cn('size-4 shrink-0', dashRankText(index))}
                        aria-hidden="true"
                      />
                      <span className="truncate">{hubTotal.hub}</span>
                      <span className="shrink-0 text-2xs font-normal text-text-subtle">
                        {hubTotal.country}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-s2">
                      <span className="tnum font-mono text-xs text-text-muted" data-numeric="">
                        {formatInteger(hubTotal.count)}
                      </span>
                      <span
                        className={cn(
                          'rounded-pill px-2 py-0.5 text-2xs font-semibold tabular-nums',
                          dashRankSoftBg(index),
                          dashRankText(index),
                        )}
                      >
                        {formatDecimal(pct)}%
                      </span>
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-pill bg-dash-alt">
                    <motion.div
                      className={cn('h-full rounded-pill', dashRankBg(index))}
                      initial={motionTokens.reduced ? false : { width: 0 }}
                      animate={{ width: `${String(pct)}%` }}
                      transition={{ ...motionTokens.transition, delay: motionTokens.reduced ? 0 : index * 0.04 }}
                    />
                  </div>
                </li>
              );
            })}
          </ol>
        )}
      </CardContent>
    </BoltCard>
  );
}
