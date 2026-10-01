import * as React from 'react';
import { motion } from 'framer-motion';
import { Building2 } from 'lucide-react';

import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { useMotionTokens } from '@/lib/motion';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { HubTypePipelineRow } from '../api/types';
import { buildHubTotals } from '../lib/hub-geo';
import { dashRankBg, dashRankSoftBg, dashRankText } from '../lib/dash-chart-theme';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from './card-info';

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
}

export function HubRankList({ rows }: HubRankListProps): React.JSX.Element {
  const motionTokens = useMotionTokens();
  const totals = React.useMemo(() => buildHubTotals(rows), [rows]);
  const maxCount = totals.reduce((max, t) => Math.max(max, t.count), 0);

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
            registry, so Invariant I9 does not apply to them. The percentage is each hub&apos;s
            count against the largest hub&apos;s, for bar length only.
          </p>
        </CardInfo>
      </CardHeader>
      <CardContent>
        {totals.length === 0 ? (
          <EmptyState
            title="No hubs in scope"
            description="There are no projects in the hub × type pipeline for your hub scope."
          />
        ) : (
          <ol aria-label="Real project count per hub, ranked" className="flex flex-col gap-s4">
            {totals.map((total, index) => {
              const pct = maxCount > 0 ? Math.round((total.count / maxCount) * 100) : 0;
              return (
                <li key={total.hub} className="flex flex-col gap-s2">
                  <div className="flex items-center justify-between gap-s2 text-body">
                    <span className="flex min-w-0 items-center gap-s2 truncate font-medium text-text">
                      <Building2
                        className={cn('size-4 shrink-0', dashRankText(index))}
                        aria-hidden="true"
                      />
                      <span className="truncate">{total.hub}</span>
                      <span className="shrink-0 text-2xs font-normal text-text-subtle">
                        {total.country}
                      </span>
                    </span>
                    <span className="flex shrink-0 items-center gap-s2">
                      <span className="tnum font-mono text-xs text-text-muted" data-numeric="">
                        {formatInteger(total.count)}
                      </span>
                      <span
                        className={cn(
                          'rounded-pill px-2 py-0.5 text-2xs font-semibold tabular-nums',
                          dashRankSoftBg(index),
                          dashRankText(index),
                        )}
                      >
                        {pct}%
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
