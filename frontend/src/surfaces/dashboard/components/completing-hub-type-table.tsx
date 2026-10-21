import * as React from 'react';
import { CircleCheckBig } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { AnalyticsTypeKey, CompletingByHubRow, CompletingByTypeRow, CompletingHubTypeCell } from '../api/types';
import { formatServedPct, pivotCompleting, typeCode, typeLabel } from '../lib/analytics';
import type { DrillTarget } from '../lib/drilldown';
import { DrillButton } from './hub-type-drilldown';

/**
 * "Projects completing within year: Hub × Type" (P13-T10, mock-up image 7).
 *
 * Each cell is one served `completing_hub_type` row: completing count and its
 * served `completing_pct` (of that cell's pipeline). The Total row is the
 * served `completing_by_type`; the Total column is the served
 * `completing_by_hub`. Nothing is summed here (I9). The corner is the served
 * `CompletingWithinYear.within_year_count` (ADR 0030: the cross-tab sums to it
 * exactly) when the page passes it, otherwise it is left empty.
 *
 * P17-R08: every non-zero count opens the projects behind it (`onDrill`); the
 * percentage moves under the count so the table fits beside the pipeline table.
 */
export interface CompletingHubTypeTableProps {
  cells: CompletingHubTypeCell[];
  byType: CompletingByTypeRow[];
  /** Served per-hub totals (hubs with pipeline_count > 0). */
  byHub?: CompletingByHubRow[] | undefined;
  /** Served `within_year_count` (same filter); the corner cell. */
  grandTotal?: number | null | undefined;
  onDrill?: ((target: DrillTarget, trigger: HTMLElement) => void) | undefined;
}

export function CompletingHubTypeTable({
  cells,
  byType,
  byHub = [],
  grandTotal = null,
  onDrill,
}: CompletingHubTypeTableProps): React.JSX.Element {
  const pivot = React.useMemo(() => pivotCompleting(cells, byType, byHub), [cells, byType, byHub]);
  const showHubTotals = byHub.length > 0;

  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card" data-testid="completing-hub-type-table">
      <div className="flex items-start justify-between gap-s3">
        <div className="flex items-center gap-s3">
          <span className="hidden size-10 shrink-0 place-items-center rounded-xl sm:grid bg-success-subtle text-success-subtle-fg">
            <CircleCheckBig className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-display text-h2 font-bold tracking-tight text-text">
              Completing within year: Hub × Type
            </h3>
            <p className="text-xs font-medium text-text-subtle">
              Projects the active run finishes by W52, with their share of each cell&apos;s pipeline.
              Counts every project in the pipeline, so the total equals the within-year KPI. Select a
              figure to list its projects.
            </p>
          </div>
        </div>
        <CardInfo label="About completing within year by hub and type">
          <p>
            Each cell is the number of that hub&apos;s projects of that type whose outcome in the active
            schedule run is within the year, and (in brackets) their share of the same cell&apos;s
            pipeline. The Total row is the per-type figure across the hubs in view.
          </p>
          <p>
            The pipeline basis counts every project, Commercialized included, so these totals equal the
            &quot;Completing within the year&quot; KPI card (Invariant I9). All figures are served by the API for the
            current hub / country filter.
          </p>
        </CardInfo>
      </div>

      {pivot.hubs.length === 0 ? (
        <p className="py-s6 text-center text-sm text-text-muted">No pipeline projects in view.</p>
      ) : (
        <div
          className="overflow-x-auto rounded-xl border-[1.5px] border-dash-hairline"
          tabIndex={0}
          role="region"
          aria-label="Projects completing within the year, by hub and project type"
        >
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">
              Projects completing within the year, by hub and project type
            </caption>
            <thead>
              <tr className="bg-ink text-ink-fg">
                <th scope="col" className="sticky left-0 z-10 bg-ink px-s3 py-s2 text-left text-2xs font-bold uppercase tracking-wider">
                  Hub
                </th>
                {pivot.types.map((t) => (
                  <th
                    key={t}
                    scope="col"
                    title={typeLabel(t)}
                    className="px-s2 py-s2 text-center text-2xs font-bold uppercase tracking-wider"
                  >
                    <abbr title={typeLabel(t)} className="no-underline">
                      {typeCode(t)}
                    </abbr>
                  </th>
                ))}
                {showHubTotals ? (
                  <th scope="col" className="border-l border-white/20 px-s2 py-s2 text-center text-2xs font-bold uppercase tracking-wider">
                    Total
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {pivot.hubs.map((hub) => (
                <tr key={hub} className="border-t border-dash-hairline odd:bg-surface even:bg-dash-alt">
                  <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-inherit px-s3 py-1 text-left font-semibold text-text">
                    {hub}
                  </th>
                  {pivot.types.map((t) => {
                    const c = pivot.cell(hub, t);
                    return (
                      <td key={t} className="px-s2 py-1 text-center" data-numeric="">
                        {c === null ? (
                          <span className="text-text-subtle" aria-label="No projects">
                            –
                          </span>
                        ) : (
                          <CellFigure
                            count={c.completing_count}
                            pct={c.completing_pct}
                            title={`${hub} · ${typeLabel(t)}: ${formatInteger(c.completing_count)} of ${formatInteger(c.pipeline_count)} pipeline projects complete within the year`}
                            target={{ source: 'completing', hub: c.hub, typeKey: t as AnalyticsTypeKey, count: c.completing_count }}
                            onDrill={onDrill}
                          />
                        )}
                      </td>
                    );
                  })}
                  {showHubTotals ? (
                    <td className="border-l border-dash-hairline bg-success-subtle/40 px-s2 py-1 text-center font-bold" data-numeric="">
                      {(() => {
                        const h = pivot.hubTotal(hub);
                        return h === null ? (
                          <span className="text-text-subtle">–</span>
                        ) : (
                          <CellFigure
                            count={h.completing_count}
                            pct={h.completing_pct}
                            strong
                            title={`${hub}: ${formatInteger(h.completing_count)} of ${formatInteger(h.pipeline_count)} pipeline projects complete within the year`}
                            target={{ source: 'completing', hub: h.key, typeKey: null, count: h.completing_count }}
                            onDrill={onDrill}
                          />
                        );
                      })()}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            {byType.length > 0 ? (
              <tfoot>
                <tr className="border-t-2 border-success/50 bg-success-subtle">
                  <th scope="row" className="sticky left-0 z-10 bg-success-subtle px-s3 py-1 text-left font-bold text-success-subtle-fg">
                    Total
                  </th>
                  {pivot.types.map((t) => {
                    const r = pivot.total(t);
                    return (
                      <td key={t} className="px-s2 py-1 text-center font-bold" data-numeric="">
                        {r === null ? (
                          <span className="text-text-subtle">–</span>
                        ) : (
                          <CellFigure
                            count={r.completing_count}
                            pct={r.completing_pct}
                            strong
                            title={`${typeLabel(t)}: ${formatInteger(r.completing_count)} of ${formatInteger(r.pipeline_count)} pipeline projects complete within the year`}
                            target={{ source: 'completing', hub: null, typeKey: r.key, count: r.completing_count }}
                            onDrill={onDrill}
                          />
                        )}
                      </td>
                    );
                  })}
                  {showHubTotals ? (
                    <td className="border-l border-success/30 px-s2 py-1 text-center font-bold" data-numeric="">
                      {grandTotal === null ? (
                        <span className="text-text-subtle" aria-label="No grand total served">
                          –
                        </span>
                      ) : (
                        <GrandFigure
                          count={grandTotal}
                          onDrill={onDrill}
                        />
                      )}
                    </td>
                  ) : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
        </div>
      )}
    </BoltCard>
  );
}

function CellFigure({
  count,
  pct,
  title,
  strong = false,
  target,
  onDrill,
}: {
  count: number;
  pct: number;
  title: string;
  strong?: boolean;
  target: DrillTarget;
  onDrill?: ((target: DrillTarget, trigger: HTMLElement) => void) | undefined;
}): React.JSX.Element {
  const countClass = cn(strong ? 'text-success-subtle-fg' : count === 0 ? 'text-text-subtle' : 'font-semibold text-text');
  return (
    <span title={title} className="inline-flex flex-col items-center whitespace-nowrap leading-tight tabular-nums">
      {onDrill !== undefined && count > 0 ? (
        <DrillButton target={target} onDrill={onDrill} className={countClass}>
          {formatInteger(count)}
        </DrillButton>
      ) : (
        <span className={countClass}>{formatInteger(count)}</span>
      )}{' '}
      <span className={cn('text-2xs', strong ? 'text-success-subtle-fg' : 'text-text-muted')}>
        ({formatServedPct(pct)})
      </span>
    </span>
  );
}

/** The served within-year total (no share is served for the corner). */
function GrandFigure({
  count,
  onDrill,
}: {
  count: number;
  onDrill?: ((target: DrillTarget, trigger: HTMLElement) => void) | undefined;
}): React.JSX.Element {
  const target: DrillTarget = { source: 'completing', hub: null, typeKey: null, count };
  return onDrill !== undefined && count > 0 ? (
    <DrillButton target={target} onDrill={onDrill} className="text-success-subtle-fg">
      {formatInteger(count)}
    </DrillButton>
  ) : (
    <span className="text-success-subtle-fg tabular-nums">{formatInteger(count)}</span>
  );
}
