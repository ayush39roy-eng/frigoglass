import { NON_OEM_CATEGORIES, OEM_CATEGORIES, type ProjectCategory } from '@/types/enums';

import type { WhatIfHub } from '../../api/whatif-types';
import { OEM_HUBS } from '../scenario-schema';
import type {
  ImportLeadTime,
  ImportRosterEntry,
  ImportRow,
  ImportSimulateRequest,
  ImportStepEdit,
  ImportStepMeta,
  ImportWorkflow,
  ImportMode,
  PlanYearEndWeek,
} from './import-types';

/**
 * Review-step row editing and the `/simulate` body (P32-T06). These helpers only keep an
 * edited row self-consistent as an INPUT (its stage, category and step-week keys must belong
 * to its hub's workflow, contract B3 validation); every schedule figure still comes from the
 * server. Nothing here computes a week, a load or a count that is displayed as a result.
 */

/** OEM hubs run the OEM workflow (ADR 0042); every other hub runs PDD. */
export function workflowOfHub(hub: string): ImportWorkflow {
  return OEM_HUBS.includes(hub) ? 'OEM' : 'PDD';
}

/** OEM hubs share R&D-Greece's designers (ADR 0042); only orders the engineer picker. */
export function capacityHubOf(hub: string): string {
  return OEM_HUBS.includes(hub) ? 'R&D-Greece' : hub;
}

export function categoriesForWorkflow(wf: ImportWorkflow): readonly ProjectCategory[] {
  return wf === 'OEM' ? OEM_CATEGORIES : NON_OEM_CATEGORIES;
}

/** The workflow's steps in sequence order. */
export function stepsOfWorkflow(meta: readonly ImportStepMeta[], wf: ImportWorkflow): ImportStepMeta[] {
  return meta.filter((m) => m.workflow === wf).sort((a, b) => a.sequence_order - b.sequence_order);
}

/** "PDD-E" → "OEM-E" (same letter in the other workflow). */
export function remapStepId(stepId: string, wf: ImportWorkflow): string {
  const letter = stepId.split('-').at(-1) ?? stepId;
  return `${wf}-${letter}`;
}

function mapCategory(cat: ProjectCategory, wf: ImportWorkflow): ProjectCategory {
  const allowed = categoriesForWorkflow(wf);
  if (allowed.includes(cat)) return cat;
  const candidate = wf === 'OEM' ? `${cat === 'A+' ? 'A' : cat}-OEM` : cat.replace(/-OEM$/, '');
  return (allowed.find((c) => c === candidate) ?? allowed.at(-1) ?? cat) as ProjectCategory;
}

export interface RowEditContext {
  lead_times: readonly ImportLeadTime[];
  steps_meta: readonly ImportStepMeta[];
}

function weeksFromLeadTime(lt: ImportLeadTime, steps: readonly ImportStepMeta[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of steps) out[s.step_id] = lt.weeks[s.step_id] ?? 0;
  return out;
}

/**
 * A row after the planner changed its hub and/or category. The file's own lead-time row
 * for the new (workflow, category) is used when the file has one (ADR 0044 §6); otherwise
 * the row keeps its weeks, re-keyed to the new workflow's step ids.
 */
export function withHubOrCategory(
  row: ImportRow,
  patch: { hub?: WhatIfHub; category?: ProjectCategory },
  ctx: RowEditContext,
): ImportRow {
  const hub = patch.hub ?? row.hub;
  const oldWf = workflowOfHub(row.hub);
  const wf = workflowOfHub(hub);
  const category = mapCategory(patch.category ?? row.category, wf);
  const wfSteps = stepsOfWorkflow(ctx.steps_meta, wf);
  const next: ImportRow = { ...row, hub, category };
  if (wf !== oldWf && row.stage_step_id !== null) next.stage_step_id = remapStepId(row.stage_step_id, wf);
  const categoryChanged = category !== row.category;
  if (!categoryChanged && wf === oldWf) return next;
  const labels = categoryChanged ? [category] : [row.lead_time_label, category];
  const lt = labels
    .map((label) => ctx.lead_times.find((l) => l.workflow === wf && l.label === label))
    .find((l) => l !== undefined);
  if (lt) {
    next.lead_time_label = lt.label;
    next.step_weeks = weeksFromLeadTime(lt, wfSteps);
  } else if (wf !== oldWf) {
    const remapped: Record<string, number> = {};
    for (const [id, w] of Object.entries(row.step_weeks)) remapped[remapStepId(id, wf)] = w;
    next.step_weeks = remapped;
  }
  return next;
}

/** Roster for the engineer picker: the row's capacity hub first, then the others. */
export function rosterForRow(
  roster: readonly ImportRosterEntry[],
  hub: string,
): { own: ImportRosterEntry[]; others: ImportRosterEntry[] } {
  const cap = capacityHubOf(hub);
  const byName = (a: ImportRosterEntry, b: ImportRosterEntry) => a.name.localeCompare(b.name);
  return {
    own: roster.filter((e) => e.capacity_hub === cap).sort(byName),
    others: roster.filter((e) => e.capacity_hub !== cap).sort(byName),
  };
}

// --- Gantt edits ---------------------------------------------------------------------------

/**
 * Owner rule (2026-11-04): On Hold rows are not mapped, nor are Cancelled / Commercialized
 * (or Draft) ones. They arrive with `include=false`, cannot be included while their status
 * is one of these, and never appear in the results.
 */
export const NOT_MAPPED_STATUSES: ReadonlySet<string> = new Set(['On Hold', 'Cancelled', 'Commercialized', 'Draft']);

export function isMappedStatus(status: string): boolean {
  return !NOT_MAPPED_STATUSES.has(status);
}

/** A status change: to a not-mapped status excludes the row; back to a mapped one includes it again. */
export function withStatus(row: ImportRow, status: string): ImportRow {
  const was = isMappedStatus(row.status);
  const now = isMappedStatus(status);
  return { ...row, status, include: now ? (was ? row.include : true) : false };
}

/** Parse issue codes that mean the row has no usable engineer (highlighted on Review). */
export const ENGINEER_ISSUE_CODES: ReadonlySet<string> = new Set(['ENGINEER_MISSING', 'ENGINEER_UNKNOWN']);

export type EditMap = Record<string, ImportStepEdit>;

export function editKey(projectRef: string, stepId: string): string {
  return `${projectRef}|${stepId}`;
}

/** True when an edit sets nothing (it is then dropped from the map). */
export function isEmptyEdit(
  e: Pick<ImportStepEdit, 'duration_weeks' | 'start_not_before_week' | 'overlap_weeks'>,
): boolean {
  return e.duration_weeks === null && e.start_not_before_week === null && e.overlap_weeks === null;
}

/**
 * How many projects a file row becomes in the run (owner rule 2026-11-04, P32-R03): the
 * "Num of Projects" column is a project count, blank/1 → 1, n ≥ 2 → n when `expand` is on.
 * Mirrors the server's expansion (`services/whatif_import.py`); used to map refs and for the
 * Review chip / fallback tile only, never as a schedule figure.
 */
export function copiesOfRow(row: Pick<ImportRow, 'num_projects'>, expand: boolean): number {
  return expand && row.num_projects !== null && row.num_projects >= 2 ? row.num_projects : 1;
}

/**
 * Does `ref` (a result project ref) belong to file row `row` under the current expansion?
 * One copy → the ref is the row key; n copies → `<key>-<k>` with 1 ≤ k ≤ n (server keys).
 * A ref from the other expansion setting does not match, so toggling prunes its edits.
 */
export function refOfRow(ref: string, row: Pick<ImportRow, 'key' | 'num_projects'>, expand: boolean): boolean {
  const n = copiesOfRow(row, expand);
  if (n === 1) return ref === row.key;
  const prefix = `${row.key}-`;
  if (!ref.startsWith(prefix)) return false;
  const tail = ref.slice(prefix.length);
  if (!/^[1-9]\d*$/.test(tail)) return false;
  return Number(tail) <= n;
}

/**
 * Display-only fallback for the Review "Projects to schedule" tile when the parse does not
 * serve `counts.projects_after_expansion`: Σ copies over included, mapped rows.
 */
export function projectsToSchedule(rows: readonly ImportRow[], expand: boolean): number {
  return rows.reduce((acc, r) => (r.include && isMappedStatus(r.status) ? acc + copiesOfRow(r, expand) : acc), 0);
}

/**
 * The edits worth sending: an edit is dropped when its project is not in the run any more
 * (an excluded row, a plan project in "This file only" mode, a plan project a matched row
 * replaces). Kept edits are sent as they are, sorted for a stable body.
 */
export function editsForRequest(
  edits: EditMap,
  rows: readonly ImportRow[],
  options: { mode: ImportMode; expandMulti: boolean },
): ImportStepEdit[] {
  const replaced = new Set(
    rows.filter((r) => r.include && r.matched_project_id !== null).map((r) => r.matched_project_id as string),
  );
  return Object.values(edits)
    .filter((e) => {
      if (isEmptyEdit(e)) return false;
      const row = rows.find((r) => refOfRow(e.project_ref, r, options.expandMulti));
      if (row) return row.include;
      // A row key that no longer exists, or a copy of the other expansion setting.
      if (/^row-\d/.test(e.project_ref)) return false;
      if (options.mode === 'file_only') return false;
      return !replaced.has(e.project_ref);
    })
    .sort((a, b) => a.project_ref.localeCompare(b.project_ref) || a.step_id.localeCompare(b.step_id));
}

export interface ImportOptions {
  mode: ImportMode;
  planYearEndWeek: PlanYearEndWeek;
  expandMulti: boolean;
}

export function buildSimulateRequest(
  rows: readonly ImportRow[],
  options: ImportOptions,
  edits: EditMap,
): ImportSimulateRequest {
  return {
    mode: options.mode,
    plan_year_end_week: options.planYearEndWeek,
    expand_multi: options.expandMulti,
    rows: rows.map((r) => ({
      ...r,
      leader: r.leader.kind === 'new' ? { kind: 'new', name: r.leader.name.trim() } : r.leader,
    })),
    edits: editsForRequest(edits, rows, options),
  };
}
