import type { WhatIfOutcome } from '../../api/whatif-types';
import type { ImportSimulateResponse } from './import-types';
import { breakdownFor, YEAR_ALL, YEAR_NOT_PLACED } from './year-filter';

/**
 * Compare-tab helpers (P32-R05 C2). Every figure is a served field of a saved response; the
 * only arithmetic is the DIFFERENCE of two served figures for the delta column, and the
 * outcome changes are a match of served rows by `ref` (expanded copies by their own ref).
 */

export interface CompareKpi {
  key: string;
  label: string;
  value: (r: ImportSimulateResponse) => number | null;
  /** True when more is better (colours the delta). */
  higherIsBetter: boolean | null;
}

/** "Not placed" (C1: left_out + blocked + data_error) is the served `not_placed` block total. */
export function notPlacedOf(r: ImportSimulateResponse): number | null {
  return breakdownFor(r, YEAR_NOT_PLACED)?.total ?? null;
}

/** The served `all` block (the Executive tab's "All" figures), or null when not served. */
function allOf(r: ImportSimulateResponse) {
  return breakdownFor(r, YEAR_ALL);
}

/**
 * The Compare rows, in the Executive tab's wording and from the SAME served fields as its
 * "All" tiles (orchestrator live check 2026-11-05: "Projects scheduled" is the served
 * `by_year.all.total`, not `kpis.projects_total`, which also counts the not-scheduled plan
 * projects; those keep their own "Not scheduled" row). Without breakdowns the served KPI
 * figure is used, as the Executive fallback does.
 */
export const COMPARE_KPIS: CompareKpi[] = [
  {
    key: 'projects_scheduled',
    label: 'Projects scheduled',
    value: (r) => allOf(r)?.total ?? r.kpis.projects_total,
    higherIsBetter: null,
  },
  {
    key: 'within_plan_year',
    label: 'Finish in the plan year',
    value: (r) => allOf(r)?.outcomes.within_year ?? r.kpis.within_plan_year,
    higherIsBetter: true,
  },
  {
    key: 'spillover',
    label: 'Spill over',
    value: (r) => allOf(r)?.outcomes.spillover ?? r.kpis.spillover,
    higherIsBetter: false,
  },
  {
    key: 'not_placed',
    label: 'Not placed',
    value: (r) => notPlacedOf(r) ?? r.kpis.left_out,
    higherIsBetter: false,
  },
  {
    key: 'file_projects',
    label: 'From the file',
    value: (r) => allOf(r)?.file ?? r.kpis.file_projects,
    higherIsBetter: null,
  },
  {
    key: 'plan_projects',
    label: 'From the plan',
    value: (r) => allOf(r)?.plan ?? r.kpis.plan_projects,
    higherIsBetter: null,
  },
  { key: 'excluded', label: 'Not scheduled', value: (r) => r.kpis.excluded, higherIsBetter: null },
  { key: 'left_out', label: 'Left out', value: (r) => r.kpis.left_out, higherIsBetter: false },
  { key: 'blocked', label: 'Blocked', value: (r) => r.kpis.blocked, higherIsBetter: false },
  { key: 'data_error', label: 'Data errors', value: (r) => r.kpis.data_error, higherIsBetter: false },
  { key: 'newly_slipping', label: 'Newly slipping', value: (r) => r.kpis.newly_slipping, higherIsBetter: false },
];

/** The served value of `b` minus the served value of `a` (null when either is missing). */
export function delta(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : b - a;
}

export function formatDelta(d: number): string {
  if (d === 0) return '±0';
  return d > 0 ? `+${String(d)}` : `−${String(Math.abs(d))}`;
}

export interface OutcomeChange {
  ref: string;
  name: string;
  hub: string;
  a: { outcome: WhatIfOutcome; finish_week: number | null } | null;
  b: { outcome: WhatIfOutcome; finish_week: number | null } | null;
}

/**
 * Projects whose served outcome differs between scenario A and B, matched by `ref`; a
 * project in only one of them is listed with `null` on the other side. Order: A's project
 * order, then B-only projects in B's order.
 */
export function outcomeChanges(a: ImportSimulateResponse, b: ImportSimulateResponse): OutcomeChange[] {
  const byRefB = new Map(b.projects.map((p) => [p.ref, p]));
  const seen = new Set<string>();
  const out: OutcomeChange[] = [];
  for (const pa of a.projects) {
    seen.add(pa.ref);
    const pb = byRefB.get(pa.ref);
    if (pb && pb.outcome === pa.outcome) continue;
    out.push({
      ref: pa.ref,
      name: pa.name,
      hub: pa.hub,
      a: { outcome: pa.outcome, finish_week: pa.finish_week },
      b: pb ? { outcome: pb.outcome, finish_week: pb.finish_week } : null,
    });
  }
  for (const pb of b.projects) {
    if (seen.has(pb.ref)) continue;
    out.push({ ref: pb.ref, name: pb.name, hub: pb.hub, a: null, b: { outcome: pb.outcome, finish_week: pb.finish_week } });
  }
  return out;
}

export interface CapacityCell {
  booked_pct: number | null;
  status: string;
}

export interface CapacityCompareRow {
  key: string;
  hub: string;
  windowKey: string;
  windowLabel: string;
  cells: (CapacityCell | null)[];
}

/**
 * Design capacity booked % per hub and window, one cell per scenario (served figures;
 * a hub / window a scenario does not serve is null). Rows: hubs in first-seen order, then
 * windows in first-seen order.
 */
export function capacityCompare(responses: readonly ImportSimulateResponse[]): CapacityCompareRow[] {
  const hubs: string[] = [];
  const windows = new Map<string, string>();
  for (const r of responses) {
    for (const w of r.capacity.windows) if (!windows.has(w.key)) windows.set(w.key, w.label);
    for (const h of r.capacity.hubs) if (!hubs.includes(h.hub)) hubs.push(h.hub);
  }
  const rows: CapacityCompareRow[] = [];
  for (const hub of hubs) {
    for (const [windowKey, windowLabel] of windows) {
      rows.push({
        key: `${hub}|${windowKey}`,
        hub,
        windowKey,
        windowLabel,
        cells: responses.map((r) => {
          const f = r.capacity.hubs.find((h) => h.hub === hub)?.windows.find((w) => w.key === windowKey);
          return f ? { booked_pct: f.booked_pct, status: f.status } : null;
        }),
      });
    }
  }
  return rows;
}
