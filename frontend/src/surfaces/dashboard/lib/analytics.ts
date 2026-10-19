/**
 * Layout helpers for `GET /dashboard/analytics` (P13-T10, API_CONTRACT_P13 §5).
 *
 * Grouping and labelling only. Every count, share and percentage shown comes
 * verbatim from one served field (I9); nothing here adds, divides or rounds a
 * figure.
 */

import { formatDecimal } from '@/lib/format';
import { HUB_NAMES, PROJECT_TYPE_LABELS, type ProjectType } from '@/types/enums';

import type {
  AnalyticsTypeKey,
  CompletingByHubRow,
  CompletingByTypeRow,
  CompletingHubTypeCell,
} from '../api/types';

/** Label for a served type bucket key ("CO" → "Cost Optimization"). */
export function typeLabel(key: AnalyticsTypeKey | string | null): string {
  if (key === null || key === 'Unmapped') return 'Unmapped';
  return PROJECT_TYPE_LABELS[key as ProjectType] ?? key;
}

/** Short axis code for a type key ("Unmapped" → "—"). */
export function typeCode(key: AnalyticsTypeKey | string | null): string {
  return key === null || key === 'Unmapped' ? '—' : key;
}

/** A served 2-dp percentage, printed as served ("37.71%"). */
export function formatServedPct(pct: number): string {
  return `${formatDecimal(pct)}%`;
}

function cellTypeKey(type: AnalyticsTypeKey | null): string {
  return type ?? 'Unmapped';
}

export interface CompletingPivot {
  hubs: string[];
  types: string[];
  /** The served cell, or null when the server sent no row for (hub, type). */
  cell: (hub: string, type: string) => CompletingHubTypeCell | null;
  /** The served per-type row (the Total row), or null. */
  total: (type: string) => CompletingByTypeRow | null;
  /** The served per-hub row (the Total column), or null. */
  hubTotal: (hub: string) => CompletingByHubRow | null;
}

/**
 * Pivot the served flat cross-tab (plus the served per-hub totals) into rows (hubs) × columns (types).
 * Hubs follow the canonical hub order; types follow the served
 * `completing_by_type` order, then any type only seen in a cell.
 */
export function pivotCompleting(
  cells: readonly CompletingHubTypeCell[],
  byType: readonly CompletingByTypeRow[],
  byHub: readonly CompletingByHubRow[] = [],
): CompletingPivot {
  const cellMap = new Map<string, CompletingHubTypeCell>();
  const hubSet = new Set<string>();
  for (const c of cells) {
    hubSet.add(c.hub);
    cellMap.set(`${c.hub}::${cellTypeKey(c.type)}`, c);
  }
  for (const r of byHub) hubSet.add(r.key);
  const types: string[] = byType.map((r) => r.key);
  for (const c of cells) {
    const key = cellTypeKey(c.type);
    if (!types.includes(key)) types.push(key);
  }
  const order = (hub: string): number => {
    const i = (HUB_NAMES as readonly string[]).indexOf(hub);
    return i === -1 ? HUB_NAMES.length : i;
  };
  const hubs = [...hubSet].sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const totals = new Map(byType.map((r) => [r.key as string, r]));
  const hubTotals = new Map(byHub.map((r) => [r.key as string, r]));
  return {
    hubs,
    types,
    cell: (hub, type) => cellMap.get(`${hub}::${type}`) ?? null,
    total: (type) => totals.get(type) ?? null,
    hubTotal: (hub) => hubTotals.get(hub) ?? null,
  };
}
