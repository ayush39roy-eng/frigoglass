import { isMappedStatus } from './import-rows';
import type { ImportMode, ImportPlanProject, ImportRow } from './import-types';

/**
 * P41 (ADR 0055 D2, contract E2): the project picker's list. A scenario is the set of
 * ticked projects: file rows (their `include`) and, in merge mode, the served
 * `plan_projects` (an unticked one is sent as `exclude_plan_project_ids`). This only decides
 * what is SENT; every figure of the scenario is the server's.
 */

export type PickSource = 'file' | 'plan';

export interface PickItem {
  /** `file:<row key>` or `plan:<project id>` (a row key and a project id never collide). */
  id: string;
  source: PickSource;
  ref: string;
  name: string;
  hub: string;
  category: string;
  priority: string;
  status: string;
  /** Why the tick is locked (an On Hold / Cancelled row is never mapped), else null. */
  locked: string | null;
  /** A short served-data note ("replaces …", "replaced by a file row"). */
  note: string | null;
}

export const fileId = (key: string): string => `file:${key}`;
export const planId = (id: string): string => `plan:${id}`;

export function pickItems(rows: readonly ImportRow[], planProjects: readonly ImportPlanProject[], mode: ImportMode): PickItem[] {
  const items: PickItem[] = rows.map((r) => ({
    id: fileId(r.key),
    source: 'file',
    ref: r.key,
    name: r.name,
    hub: r.hub,
    category: r.category,
    priority: r.priority,
    status: r.status,
    locked: isMappedStatus(r.status) ? null : `${r.status}: not scheduled`,
    note: r.matched_project_name ? `replaces ${r.matched_project_name}` : null,
  }));
  if (mode !== 'merge') return items;
  const matched = new Set(rows.filter((r) => r.matched_project_id !== null).map((r) => r.matched_project_id as string));
  for (const p of planProjects) {
    items.push({
      id: planId(p.id),
      source: 'plan',
      ref: p.id,
      name: p.name,
      hub: p.hub,
      category: p.category,
      priority: p.priority,
      status: p.status,
      locked: null,
      note: matched.has(p.id) ? 'also a file row' : null,
    });
  }
  return items;
}

/** The ticks the picker opens with: included file rows, plan projects not excluded. */
export function initialTicks(rows: readonly ImportRow[], planProjects: readonly ImportPlanProject[], excludedPlanIds: readonly string[]): Set<string> {
  const excluded = new Set(excludedPlanIds);
  const out = new Set<string>();
  for (const r of rows) if (r.include && isMappedStatus(r.status)) out.add(fileId(r.key));
  for (const p of planProjects) if (!excluded.has(p.id)) out.add(planId(p.id));
  return out;
}

/** The ticks as the store's inputs: included row keys and the unticked plan project ids. */
export function picksToRequest(
  items: readonly PickItem[],
  ticks: ReadonlySet<string>,
): { includedKeys: Set<string>; excludedPlanIds: string[] } {
  const includedKeys = new Set<string>();
  const excludedPlanIds: string[] = [];
  for (const it of items) {
    if (it.source === 'file') {
      if (ticks.has(it.id)) includedKeys.add(it.ref);
    } else if (!ticks.has(it.id)) excludedPlanIds.push(it.ref);
  }
  return { includedKeys, excludedPlanIds: excludedPlanIds.sort() };
}

export interface PickFilters {
  query: string;
  category: string;
  hub: string;
  priority: string;
  source: string;
}

export const NO_PICK_FILTERS: PickFilters = { query: '', category: '', hub: '', priority: '', source: '' };

export function filterPicks(items: readonly PickItem[], f: PickFilters): PickItem[] {
  const q = f.query.trim().toLowerCase();
  return items.filter(
    (it) =>
      (f.category === '' || it.category === f.category) &&
      (f.hub === '' || it.hub === f.hub) &&
      (f.priority === '' || it.priority === f.priority) &&
      (f.source === '' || it.source === f.source) &&
      (q === '' || [it.name, it.hub, it.category, it.priority, it.status].some((v) => v.toLowerCase().includes(q))),
  );
}

/** Distinct values of a dimension, sorted, for the filter dropdowns. */
export function pickValues(items: readonly PickItem[], dim: 'category' | 'hub' | 'priority'): string[] {
  return [...new Set(items.map((it) => it[dim]))].sort((a, b) => a.localeCompare(b));
}
