import type { ProjectCategory, WorkflowId, WorkflowStepKind } from '@/types/enums';

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

/** Category row order per workflow — DOMAIN_RULES "Lead times" table order. */
export const CATEGORY_ORDER: Record<WorkflowId, readonly ProjectCategory[]> = {
  PDD: ['A+', 'A', 'B', 'C'],
  OEM: ['A-OEM', 'B-OEM', 'C-OEM'],
};

export function buildLeadTimeGrid(
  leadTimes: readonly LeadTimeCell[],
  workflowId: WorkflowId,
  stepIds: readonly string[],
): LeadTimeGridRow[] {
  const rows = new Map<ProjectCategory, Record<string, number>>();
  for (const cat of CATEGORY_ORDER[workflowId]) {
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

/** The cells that differ from the server's, as `PUT /workflow-settings/lead-times`
 *  rows (partial update is allowed). */
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
