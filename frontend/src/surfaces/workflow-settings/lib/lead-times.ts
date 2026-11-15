import type { ProjectCategory, WorkflowId, WorkflowStepKind } from '@/types/enums';

import type { TemplateChangeEntry, TemplateChangeSet } from '../api/types';

/**
 * The lead-time grid (workflow × category rows × 14 step columns) as the
 * client's own `Final RPD` sheet lays it out (`docs/CLIENT_FORMULAS.md` §1).
 *
 * The row totals are the workbook's own row formulas (`Σ` = SUM of the 14
 * cells; design / lab / elapsed = SUM over the steps of that kind) evaluated
 * over the cells ON SCREEN — including unsaved edits — so an editor sees the
 * effect of a change before saving. They are display sums of the table being
 * edited, not a schedule figure; the scheduler's per-project durations still
 * come from the server (ADR 0007).
 */

export interface LeadTimeCell {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  step_id: string;
  weeks: number;
}

export interface LeadTimeGridRow {
  category: ProjectCategory;
  /** step_id → weeks, one entry per step column (missing server rows read 0). */
  cells: Record<string, number>;
}

export interface LeadTimeTotals {
  total: number;
  design: number;
  lab: number;
  elapsed: number;
}

/**
 * P33-T14: `categoryOrder` is the workflow's served categories in rank order
 * (`GET /reference/categories`); each gets a row even with no lead-time rows.
 * A category only the lead times carry follows, in served order.
 */
export function buildLeadTimeGrid(
  leadTimes: readonly LeadTimeCell[],
  workflowId: WorkflowId,
  stepIds: readonly string[],
  categoryOrder: readonly ProjectCategory[],
): LeadTimeGridRow[] {
  const rows = new Map<ProjectCategory, Record<string, number>>();
  for (const cat of categoryOrder) {
    rows.set(cat, Object.fromEntries(stepIds.map((id) => [id, 0])));
  }
  for (const lt of leadTimes) {
    if (lt.workflow_id !== workflowId) continue;
    const row = rows.get(lt.category) ?? Object.fromEntries(stepIds.map((id) => [id, 0]));
    row[lt.step_id] = lt.weeks;
    rows.set(lt.category, row);
  }
  return [...rows.entries()].map(([category, cells]) => ({ category, cells }));
}

export function rowTotals(
  cells: Readonly<Record<string, number>>,
  kinds: Readonly<Record<string, WorkflowStepKind>>,
): LeadTimeTotals {
  const out: LeadTimeTotals = { total: 0, design: 0, lab: 0, elapsed: 0 };
  for (const [stepId, weeks] of Object.entries(cells)) {
    const w = Number.isFinite(weeks) ? weeks : 0;
    out.total += w;
    const kind = kinds[stepId];
    if (kind === 'design') out.design += w;
    else if (kind === 'lab') out.lab += w;
    else if (kind === 'elapsed') out.elapsed += w;
  }
  return out;
}

/** The cells that differ from the server's (one per edited cell). */
export function changedLeadTimes(
  original: readonly LeadTimeGridRow[],
  edited: readonly LeadTimeGridRow[],
  workflowId: WorkflowId,
): LeadTimeCell[] {
  const out: LeadTimeCell[] = [];
  const originalByCat = new Map(original.map((r) => [r.category, r.cells]));
  for (const row of edited) {
    const before = originalByCat.get(row.category) ?? {};
    for (const [step_id, weeks] of Object.entries(row.cells)) {
      if ((before[step_id] ?? 0) !== weeks) {
        out.push({ workflow_id: workflowId, category: row.category, step_id, weeks });
      }
    }
  }
  return out;
}

/**
 * P33-T17 (ADR 0045 §5): the edited cells as one E1 change set — one entry per
 * (workflow, category), `weeks` only, `base_version` = the category's served
 * `template_version` (409 `TEMPLATE_CHANGED` if someone saved meanwhile).
 */
export function leadTimeChangeSet(
  changes: readonly LeadTimeCell[],
  versions: Readonly<Record<string, number>>,
): TemplateChangeSet {
  const entries = new Map<string, TemplateChangeEntry>();
  for (const c of changes) {
    const key = `${c.workflow_id}|${c.category}`;
    let entry = entries.get(key);
    if (!entry) {
      entry = { workflow_id: c.workflow_id, category: c.category, base_version: versions[c.category] ?? 1, steps: [] };
      entries.set(key, entry);
    }
    entry.steps.push({ step_id: c.step_id, weeks: c.weeks });
  }
  return { changes: [...entries.values()] };
}
