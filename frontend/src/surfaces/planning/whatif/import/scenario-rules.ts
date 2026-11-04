import { HUB_NAMES, PROJECT_CATEGORIES, PROJECT_PRIORITIES } from '@/types/enums';

import { isMappedStatus } from './import-rows';
import type { ImportMode, ImportRow } from './import-types';

/**
 * Scenario builder quick rules (P32-R05, docs/API_CONTRACT_P32.md C2). A rule set turns the
 * Review rows into a variant's INPUT rows: it only flips `include`. The variant is then
 * computed by the normal `/whatif/import/simulate`; nothing here is a schedule figure.
 *
 * - The starting set is the rows the planner would send today: included, mapped rows
 *   (an unticked or On Hold row stays out of every variant).
 * - Each dimension is "only these" or "all except these"; an empty value list is no rule.
 * - "At most N of category X" keeps the first N candidate rows of X by priority band
 *   (P1 → Q), then rank (unranked last), then file row; the rest are excluded. N counts
 *   file rows (a row whose "Num of Projects" expands still counts once).
 */

export type RuleDimension = 'category' | 'hub' | 'priority' | 'status' | 'source';
export const RULE_DIMENSIONS: readonly RuleDimension[] = ['category', 'hub', 'priority', 'status', 'source'];

export const DIMENSION_LABEL: Record<RuleDimension, string> = {
  category: 'Category',
  hub: 'Hub',
  priority: 'Priority',
  status: 'Status',
  source: 'Source',
};

/** A row's "source": matched to a plan project (replaces it) or a new project. */
export type RowSource = 'matched' | 'new';
export const SOURCE_LABEL: Record<RowSource, string> = { matched: 'Matched to plan', new: 'New in file' };

export interface DimensionRule {
  op: 'only' | 'except';
  values: string[];
}

export interface CategoryCap {
  category: string;
  max: number;
}

export interface ScenarioRules {
  filters: Record<RuleDimension, DimensionRule>;
  caps: CategoryCap[];
  mode: ImportMode;
}

export function emptyRules(mode: ImportMode): ScenarioRules {
  return {
    filters: {
      category: { op: 'only', values: [] },
      hub: { op: 'only', values: [] },
      priority: { op: 'only', values: [] },
      status: { op: 'only', values: [] },
      source: { op: 'only', values: [] },
    },
    caps: [],
    mode,
  };
}

export function rowValue(row: ImportRow, dim: RuleDimension): string {
  switch (dim) {
    case 'category':
      return row.category;
    case 'hub':
      return row.hub;
    case 'priority':
      return row.priority;
    case 'status':
      return row.status;
    case 'source':
      return row.matched_project_id === null ? 'new' : 'matched';
  }
}

/** Rows a variant can start from: what the planner would send today. */
export function isCandidate(row: ImportRow): boolean {
  return row.include && isMappedStatus(row.status);
}

function canonicalOrder(dim: RuleDimension): readonly string[] {
  if (dim === 'category') return PROJECT_CATEGORIES;
  if (dim === 'hub') return HUB_NAMES;
  if (dim === 'priority') return PROJECT_PRIORITIES;
  if (dim === 'source') return ['matched', 'new'];
  return [];
}

/** The values present among the candidate rows, in the app's canonical order. */
export function dimensionValues(rows: readonly ImportRow[], dim: RuleDimension): string[] {
  const present = new Set(rows.filter(isCandidate).map((r) => rowValue(r, dim)));
  const order = canonicalOrder(dim);
  const rank = (v: string) => {
    const i = order.indexOf(v);
    return i === -1 ? order.length : i;
  };
  return [...present].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

function passes(row: ImportRow, rules: ScenarioRules): boolean {
  return RULE_DIMENSIONS.every((dim) => {
    const rule = rules.filters[dim];
    if (rule.values.length === 0) return true;
    const hit = rule.values.includes(rowValue(row, dim));
    return rule.op === 'only' ? hit : !hit;
  });
}

const PRIORITY_RANK = new Map<string, number>(PROJECT_PRIORITIES.map((p, i) => [p, i]));

/** Priority band, then rank (unranked last), then file row. */
export function capOrder(a: ImportRow, b: ImportRow): number {
  const pa = PRIORITY_RANK.get(a.priority) ?? PROJECT_PRIORITIES.length;
  const pb = PRIORITY_RANK.get(b.priority) ?? PROJECT_PRIORITIES.length;
  if (pa !== pb) return pa - pb;
  const ra = a.rank ?? Number.POSITIVE_INFINITY;
  const rb = b.rank ?? Number.POSITIVE_INFINITY;
  if (ra !== rb) return ra - rb;
  return a.file_row - b.file_row;
}

/** The variant's rows: same rows, same order, `include` set by the rules. */
export function applyScenarioRules(rows: readonly ImportRow[], rules: ScenarioRules): ImportRow[] {
  const kept = new Set(rows.filter((r) => isCandidate(r) && passes(r, rules)).map((r) => r.key));
  for (const cap of rules.caps) {
    const max = Math.max(0, Math.floor(cap.max));
    const ofCat = rows.filter((r) => kept.has(r.key) && r.category === cap.category).sort(capOrder);
    for (const r of ofCat.slice(max)) kept.delete(r.key);
  }
  return rows.map((r) => {
    const include = kept.has(r.key);
    return include === r.include ? r : { ...r, include };
  });
}

function valueLabel(dim: RuleDimension, v: string): string {
  return dim === 'source' ? SOURCE_LABEL[v as RowSource] : v;
}

/** A one-line description of the rules ("Only A+, A · at most 5 A+ · this file only"). */
export function describeRules(rules: ScenarioRules): string {
  const parts: string[] = [];
  for (const dim of RULE_DIMENSIONS) {
    const rule = rules.filters[dim];
    if (rule.values.length === 0) continue;
    const vals = rule.values.map((v) => valueLabel(dim, v)).join(', ');
    parts.push(`${DIMENSION_LABEL[dim]} ${rule.op === 'only' ? 'only' : 'except'} ${vals}`);
  }
  for (const cap of rules.caps) parts.push(`at most ${String(cap.max)} ${cap.category}`);
  parts.push(rules.mode === 'merge' ? 'merged with the plan' : 'this file only');
  return parts.join(' · ');
}
