import * as React from 'react';
import {
  PolarAngleAxis,
  PolarGrid,
  PolarRadiusAxis,
  Radar,
  RadarChart,
  ResponsiveContainer,
  Tooltip as ChartTooltip,
} from 'recharts';
import { GitCompareArrows, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';

import {
  COMPARE_MAX,
  COMPARE_MIN,
  type DimensionScore,
  type PriorityCompareProject,
} from '../api/types';
import type { ProjectPriority } from '@/types/enums';
import { usePriorityCompare } from '../hooks/use-matrix';
import { useCompareSelection, type CompareItem } from '../lib/compare-selection';
import { sortByPillar } from '../lib/pillars';
import { formatOutOf100, formatPoints } from '../lib/row-scores';

/**
 * P21 Compare: a sticky "Compare (n)" bar for the 2–5 selected projects and a
 * dialog with a radar of the 13 dimension scores (one colour per project, with
 * a legend that toggles series) and a dimension × project table. Every figure
 * is from `GET /priorities/compare`; the table only marks each row's highest
 * served value, it computes nothing.
 */

/** Distinct categorical hues (design tokens), one per compared project. */
const SERIES = ['--dash-cat-1', '--dash-cat-2', '--dash-cat-4', '--dash-cat-5', '--dash-cat-6'] as const;
const seriesColor = (i: number) => `hsl(var(${SERIES[i % SERIES.length] ?? '--dash-cat-1'}))`;

// --- Bar ------------------------------------------------------------------------

export function CompareBar({ onOpen }: { onOpen: () => void }): React.JSX.Element | null {
  const items = useCompareSelection((s) => s.items);
  const capHit = useCompareSelection((s) => s.capHit);
  const remove = useCompareSelection((s) => s.remove);
  const clear = useCompareSelection((s) => s.clear);
  if (items.length === 0) return null;
  const n = items.length;
  const ready = n >= COMPARE_MIN;

  return (
    <div
      className="sticky bottom-3 z-20 flex flex-wrap items-center gap-2 rounded-dash border-[1.5px] border-primary/40 bg-surface px-3 py-2 shadow-pop"
      role="region"
      aria-label="Compare selection"
      data-testid="compare-bar"
    >
      <GitCompareArrows className="size-4 text-primary" aria-hidden="true" />
      <ul className="flex min-w-0 flex-1 flex-wrap gap-1.5" aria-label="Selected projects">
        {items.map((it) => (
          <li
            key={it.id}
            className="inline-flex max-w-[14rem] items-center gap-1 rounded border border-border bg-surface-sunken py-0.5 pl-2 pr-0.5 text-2xs text-text"
          >
            <span className="truncate" title={`${it.name} (${it.hub})`}>
              {it.name}
            </span>
            <button
              type="button"
              onClick={() => remove(it.id)}
              className="rounded-sm p-0.5 text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label={`Remove ${it.name} from compare`}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <p className="text-2xs text-text-muted" role="status" data-testid="compare-message">
        {capHit
          ? `Up to ${String(COMPARE_MAX)} projects can be compared. Remove one to add another.`
          : ready
            ? `${String(n)} of ${String(COMPARE_MAX)} selected`
            : `Select at least ${String(COMPARE_MIN)} projects to compare`}
      </p>
      <Button variant="secondary" size="sm" onClick={clear}>
        Clear
      </Button>
      <Button size="sm" onClick={onOpen} disabled={!ready}>
        Compare ({n})
      </Button>
    </div>
  );
}

// --- Dialog -----------------------------------------------------------------------

export function CompareDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const items = useCompareSelection((s) => s.items);
  const ids = React.useMemo(() => items.map((i) => i.id), [items]);
  const query = usePriorityCompare(ids, open && ids.length >= COMPARE_MIN);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[calc(100vw-1rem)] max-w-5xl overflow-y-auto p-4 sm:p-5">
        <DialogHeader>
          <DialogTitle>Compare projects ({items.length})</DialogTitle>
          <DialogDescription>
            The 13 dimension scores (0–5) with their points, and the score out of 100. All figures are served by the
            API; the highest value in each row is marked.
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <div className="space-y-3" aria-busy="true" aria-label="Loading comparison">
            <Skeleton className="h-64 w-full" />
            <Skeleton className="h-48 w-full" />
          </div>
        ) : query.isError ? (
          <p role="alert" className="text-xs text-danger">
            {compareErrorText(query.error)}
          </p>
        ) : (
          <CompareBody projects={orderLike(query.data.projects, items)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/** API_CONTRACT_P21 §5 error codes, in words. */
function compareErrorText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'COMPARE_PROJECT_UNAVAILABLE' || error.isForbidden) {
      return 'One of the selected projects is no longer available to you. Remove it and try again.';
    }
    if (error.code === 'COMPARE_COUNT') return `Select ${String(COMPARE_MIN)} to ${String(COMPARE_MAX)} projects to compare.`;
    if (error.code === 'COMPARE_DUPLICATE') return 'A project was selected twice. Clear the selection and try again.';
  }
  return 'The comparison could not be loaded. Close and try again.';
}

/** Keep the selection order (display only). */
function orderLike(projects: PriorityCompareProject[], items: CompareItem[]): PriorityCompareProject[] {
  const pos = new Map(items.map((it, i) => [it.id, i]));
  return [...projects].sort((a, b) => (pos.get(a.project_id) ?? 99) - (pos.get(b.project_id) ?? 99));
}

interface DimRow {
  key: string;
  label: string;
  pillar: string;
  cells: (DimensionScore | undefined)[];
}

function dimensionRows(projects: PriorityCompareProject[]): DimRow[] {
  const first = projects.find((p) => p.dimension_scores.length > 0);
  if (!first) return [];
  return sortByPillar(first.dimension_scores).map((d) => ({
    key: d.key,
    label: d.label,
    pillar: d.pillar,
    cells: projects.map((p) => p.dimension_scores.find((x) => x.key === d.key)),
  }));
}

/** Indices holding the row's highest served value (ties all marked; none when all null). */
function highest(values: (number | null | undefined)[]): Set<number> {
  let best: number | null = null;
  for (const v of values) if (v !== null && v !== undefined && (best === null || v > best)) best = v;
  const out = new Set<number>();
  if (best === null) return out;
  values.forEach((v, i) => {
    if (v === best) out.add(i);
  });
  return out;
}

function CompareBody({ projects }: { projects: PriorityCompareProject[] }): React.JSX.Element {
  const reduced = usePrefersReducedMotion();
  const [hidden, setHidden] = React.useState<ReadonlySet<string>>(new Set());
  const rows = dimensionRows(projects);
  const pillars = [...new Set(rows.map((r) => r.pillar))];
  const radarData = rows.map((r) => {
    const d: Record<string, string | number | null> = { dim: r.label };
    r.cells.forEach((c, i) => {
      const p = projects[i];
      if (p) d[p.project_id] = c?.score ?? null;
    });
    return d;
  });
  const scoreTop = highest(projects.map((p) => p.normalized_pct));

  return (
    <div className="flex flex-col gap-4" data-testid="compare-body">
      <ul className="flex flex-wrap gap-1.5" aria-label="Legend — choose a project to show or hide it on the chart">
        {projects.map((p, i) => {
          const off = hidden.has(p.project_id);
          return (
            <li key={p.project_id}>
              <button
                type="button"
                aria-pressed={!off}
                onClick={() =>
                  setHidden((prev) => {
                    const next = new Set(prev);
                    if (next.has(p.project_id)) next.delete(p.project_id);
                    else next.add(p.project_id);
                    return next;
                  })
                }
                className={cn(
                  'inline-flex items-center gap-1.5 rounded border px-2 py-1 text-2xs text-text',
                  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  off ? 'border-dashed border-border text-text-muted line-through' : 'border-border-strong',
                )}
              >
                <span className="size-2.5 shrink-0 rounded-full" style={{ background: seriesColor(i) }} aria-hidden="true" />
                <span className="font-semibold">{p.project_name}</span>
                <span className="text-text-muted">{p.hub}</span>
              </button>
            </li>
          );
        })}
      </ul>

      <figure className="h-72 w-full sm:h-80" aria-label="Radar of the 13 dimension scores (0–5) per project; the table below has the same figures">
        <ResponsiveContainer width="100%" height="100%">
          <RadarChart data={radarData} outerRadius="72%">
            <PolarGrid stroke="hsl(var(--color-border))" />
            <PolarAngleAxis dataKey="dim" tick={{ fill: 'hsl(var(--color-text-muted))', fontSize: 10 }} />
            <PolarRadiusAxis domain={[0, 5]} tickCount={6} tick={{ fontSize: 9 }} angle={90} />
            {projects.map((p, i) =>
              hidden.has(p.project_id) ? null : (
                <Radar
                  key={p.project_id}
                  name={p.project_name}
                  dataKey={p.project_id}
                  stroke={seriesColor(i)}
                  fill={seriesColor(i)}
                  fillOpacity={0.12}
                  strokeWidth={2}
                  isAnimationActive={!reduced}
                />
              ),
            )}
            <ChartTooltip
              contentStyle={{
                background: 'hsl(var(--color-surface))',
                border: '1.5px solid hsl(var(--color-border))',
                borderRadius: 12,
                fontSize: 12,
              }}
            />
          </RadarChart>
        </ResponsiveContainer>
      </figure>

      <div className="overflow-x-auto rounded border border-border" role="region" aria-label="Comparison table" tabIndex={0}>
        <table className="w-full min-w-[36rem] border-collapse text-xs" data-testid="compare-table">
          <caption className="sr-only">Dimension scores and points per project; the highest in each row is marked</caption>
          <thead className="bg-surface-sunken">
            <tr>
              <th scope="col" className="px-2 py-2 text-left text-2xs font-bold uppercase tracking-wider text-text-subtle">
                Dimension
              </th>
              {projects.map((p, i) => (
                <th key={p.project_id} scope="col" className="px-2 py-2 text-right text-xs font-semibold text-text">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: seriesColor(i) }} aria-hidden="true" />
                    {p.project_name}
                  </span>
                  {p.has_score ? null : <span className="block text-2xs font-normal text-text-muted">Not scored</span>}
                </th>
              ))}
            </tr>
          </thead>
          {pillars.map((pillar) => (
            <tbody key={pillar}>
              <tr className="bg-primary-subtle/40">
                <th
                  scope="colgroup"
                  colSpan={projects.length + 1}
                  className="px-2 py-1 text-left text-2xs font-bold uppercase tracking-wider text-text"
                >
                  {pillar}
                </th>
              </tr>
              {rows
                .filter((r) => r.pillar === pillar)
                .map((r) => {
                  const top = highest(r.cells.map((c) => c?.points ?? c?.score));
                  return (
                    <tr key={r.key} className="border-b border-border/60" data-testid="compare-row">
                      <th scope="row" className="px-2 py-1.5 text-left font-medium text-text">
                        {r.label}
                      </th>
                      {r.cells.map((c, i) => (
                        <CompareCell key={projects[i]?.project_id ?? i} cell={c} top={top.has(i)} />
                      ))}
                    </tr>
                  );
                })}
            </tbody>
          ))}
          <tfoot>
            <tr className="border-t-2 border-border-strong" data-testid="compare-total-row">
              <th scope="row" className="px-2 py-2 text-left font-semibold text-text">
                Score /100 and band
              </th>
              {projects.map((p, i) => (
                <td
                  key={p.project_id}
                  className={cn('px-2 py-2 text-right', scoreTop.has(i) && 'bg-primary-subtle font-bold')}
                >
                  <span className="inline-flex items-center justify-end gap-1.5">
                    {!p.has_score || p.normalized_pct === null ? (
                      <span className="text-2xs text-text-muted">Not scored</span>
                    ) : (
                      <>
                        <span className="tnum text-text" data-numeric="">
                          {formatOutOf100(p.normalized_pct)}
                        </span>
                        <BandChip band={p.suggested_band} />
                      </>
                    )}
                    {scoreTop.has(i) ? <span className="sr-only">(highest)</span> : null}
                  </span>
                </td>
              ))}
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

function BandChip({ band }: { band: ProjectPriority | null }): React.JSX.Element {
  if (band === null) return <span className="text-2xs text-text-muted">Unscored</span>;
  return <PriorityBandPill priority={band} />;
}

function CompareCell({ cell, top }: { cell: DimensionScore | undefined; top: boolean }): React.JSX.Element {
  if (!cell || cell.score === null) {
    return <td className="px-2 py-1.5 text-right text-text-subtle">–</td>;
  }
  return (
    <td className={cn('px-2 py-1.5 text-right', top && 'bg-primary-subtle font-bold')} data-highest={top || undefined}>
      <span className="tnum text-text" data-numeric="">
        {cell.score}
      </span>
      {cell.points !== null ? (
        <span className="tnum ml-1.5 text-2xs font-normal text-text-muted" data-numeric="">
          {formatPoints(cell.points, cell.max_points)}
        </span>
      ) : null}
      {top ? <span className="sr-only">(highest)</span> : null}
    </td>
  );
}
