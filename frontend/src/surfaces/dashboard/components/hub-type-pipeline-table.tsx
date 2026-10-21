import * as React from 'react';
import { Table2 } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardInfo } from '@/components/ui/card-info';
import { formatInteger } from '@/lib/format';
import { HUB_NAMES, PROJECT_TYPES, type HubName } from '@/types/enums';

import type { AnalyticsBucket, AnalyticsTypeKey, HubTypePipelineRow } from '../api/types';
import { typeCode, typeLabel } from '../lib/analytics';
import { pipelineDrillServed, type DrillTarget } from '../lib/drilldown';
import { DrillButton } from './hub-type-drilldown';

/**
 * "Project pipeline summary: Hub × Type" (PROJECT_AND_STACK.md §2; client's
 * older app). One served `GET /dashboard/hub-type-pipeline` count per (hub,
 * type), ADR 0030 all-projects basis, pivoted into a table.
 *
 * P17-R08: the bar chart that used to sit above this table is gone (owner
 * request). The totals are now SERVED, never summed here (I9): the Total
 * column is `/dashboard/analytics.by_hub`, the Total row is `by_type` and the
 * corner is `PipelineTotals.total_count`, all on the same basis and filter.
 * Every non-zero figure opens the project list behind it (`onDrill`).
 */

export interface HubTypePipelineTableProps {
  rows: HubTypePipelineRow[];
  /** Served per-hub totals (`analytics.by_hub`); null while unloaded. */
  byHub?: AnalyticsBucket[] | null | undefined;
  /** Served per-type totals (`analytics.by_type`); null while unloaded. */
  byType?: AnalyticsBucket[] | null | undefined;
  /** Served `PipelineTotals.total_count`; null while unloaded. */
  grandTotal?: number | null | undefined;
  onDrill?: ((target: DrillTarget, trigger: HTMLElement) => void) | undefined;
}

const UNMAPPED: AnalyticsTypeKey = 'Unmapped';

function hubOrder(hub: string): number {
  const i = (HUB_NAMES as readonly string[]).indexOf(hub);
  return i === -1 ? HUB_NAMES.length : i;
}

function typeOrder(key: string): number {
  const i = (PROJECT_TYPES as readonly string[]).indexOf(key);
  return i === -1 ? PROJECT_TYPES.length : i;
}

export function HubTypePipelineTable({
  rows,
  byHub = null,
  byType = null,
  grandTotal = null,
  onDrill,
}: HubTypePipelineTableProps): React.JSX.Element {
  const pivot = React.useMemo(() => {
    const hubSet = new Set<HubName>();
    const typeSet = new Set<AnalyticsTypeKey>();
    const cells = new Map<string, number>();
    for (const r of rows) {
      const key: AnalyticsTypeKey = r.type ?? UNMAPPED;
      hubSet.add(r.hub);
      typeSet.add(key);
      // One served row per (hub, type); a duplicate would be a server bug, so the
      // later row wins rather than being added up here.
      cells.set(`${r.hub}::${key}`, r.count);
    }
    return {
      hubs: [...hubSet].sort((a, b) => hubOrder(a) - hubOrder(b) || a.localeCompare(b)),
      types: [...typeSet].sort((a, b) => typeOrder(a) - typeOrder(b)),
      cell: (hub: string, type: string) => cells.get(`${hub}::${type}`) ?? 0,
    };
  }, [rows]);

  const hubTotal = React.useMemo(() => new Map((byHub ?? []).map((b) => [b.key, b.count])), [byHub]);
  const typeTotal = React.useMemo(() => new Map((byType ?? []).map((b) => [b.key, b.count])), [byType]);

  const figure = (target: DrillTarget, strong = false): React.ReactNode => {
    const text = formatInteger(target.count);
    const drillable = onDrill !== undefined && target.count > 0 && pipelineDrillServed(target.typeKey);
    if (!drillable) {
      return (
        <span
          className={strong ? 'font-bold text-text' : target.count === 0 ? 'text-text-subtle' : 'text-text'}
          title={
            target.count > 0 && !pipelineDrillServed(target.typeKey)
              ? 'The list of untyped projects is not available yet'
              : undefined
          }
        >
          {target.count === 0 ? '·' : text}
        </span>
      );
    }
    return (
      <DrillButton target={target} onDrill={onDrill} className={strong ? 'font-bold text-text' : 'font-semibold text-text'}>
        {text}
      </DrillButton>
    );
  };

  const servedTotal = (count: number | undefined | null, target: Omit<DrillTarget, 'count'>): React.ReactNode =>
    count === undefined || count === null ? (
      <span className="text-text-subtle" aria-label="Total not loaded">
        –
      </span>
    ) : (
      figure({ ...target, count }, true)
    );

  return (
    <BoltCard className="flex h-full flex-col gap-s4 p-card" data-testid="hub-type-pipeline-table">
      <div className="flex items-start justify-between gap-s3">
        <div className="flex items-center gap-s3">
          <span className="hidden size-10 shrink-0 place-items-center rounded-xl sm:grid bg-primary-subtle text-primary-subtle-fg">
            <Table2 className="size-5" aria-hidden="true" />
          </span>
          <div>
            <h3 className="font-display text-h2 font-bold tracking-tight text-text">
              Project pipeline summary: Hub × Type
            </h3>
            <p className="text-xs font-medium text-text-subtle">
              Every project, all statuses. Select a figure to list its projects.
            </p>
          </div>
        </div>
        <CardInfo label="About the project pipeline summary by hub and type">
          <p>
            One project count per hub and project type from <code>GET /dashboard/hub-type-pipeline</code>,
            on the same basis as the Project pipeline total (every project, Commercialized included).
          </p>
          <p>
            The Total column, Total row and corner are the server&apos;s own per-hub, per-type and pipeline
            totals for the current hub / country filter. A Hub Planner only sees their own hubs.
          </p>
        </CardInfo>
      </div>

      {pivot.hubs.length === 0 ? (
        <p className="py-s6 text-center text-sm text-text-muted">No projects in the pipeline for your hub scope.</p>
      ) : (
        <div
          className="overflow-x-auto rounded-xl border-[1.5px] border-dash-hairline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          tabIndex={0}
          role="region"
          aria-label="Project pipeline by hub and project type"
        >
          <table className="w-full border-collapse text-sm">
            <caption className="sr-only">Project pipeline by hub and project type</caption>
            <thead>
              <tr className="bg-ink text-ink-fg">
                <th scope="col" className="sticky left-0 z-10 bg-ink px-s3 py-s2 text-left text-2xs font-bold uppercase tracking-wider">
                  Hub
                </th>
                {pivot.types.map((t) => (
                  <th key={t} scope="col" className="px-s2 py-s2 text-center text-2xs font-bold uppercase tracking-wider">
                    <abbr title={typeLabel(t)} className="no-underline">
                      {typeCode(t)}
                    </abbr>
                  </th>
                ))}
                <th scope="col" className="border-l border-white/20 px-s2 py-s2 text-center text-2xs font-bold uppercase tracking-wider">
                  Total
                </th>
              </tr>
            </thead>
            <tbody>
              {pivot.hubs.map((hub) => (
                <tr key={hub} className="border-t border-dash-hairline odd:bg-surface even:bg-dash-alt">
                  <th scope="row" className="sticky left-0 z-10 whitespace-nowrap bg-inherit px-s3 py-1 text-left font-semibold text-text">
                    {hub}
                  </th>
                  {pivot.types.map((t) => (
                    <td key={t} className="px-s2 py-1 text-center" data-numeric="">
                      {figure({ source: 'pipeline', hub, typeKey: t, count: pivot.cell(hub, t) })}
                    </td>
                  ))}
                  <td className="border-l border-dash-hairline bg-primary-subtle/40 px-s2 py-1 text-center" data-numeric="">
                    {servedTotal(byHub === null ? null : (hubTotal.get(hub) ?? 0), { source: 'pipeline', hub, typeKey: null })}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-primary/40 bg-primary-subtle">
                <th scope="row" className="sticky left-0 z-10 bg-primary-subtle px-s3 py-1 text-left font-bold text-primary-subtle-fg">
                  Total
                </th>
                {pivot.types.map((t) => (
                  <td key={t} className="px-s2 py-1 text-center" data-numeric="">
                    {servedTotal(byType === null ? null : (typeTotal.get(t) ?? 0), { source: 'pipeline', hub: null, typeKey: t })}
                  </td>
                ))}
                <td className="border-l border-primary/30 px-s2 py-1 text-center" data-numeric="">
                  {servedTotal(grandTotal, { source: 'pipeline', hub: null, typeKey: null })}
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </BoltCard>
  );
}
