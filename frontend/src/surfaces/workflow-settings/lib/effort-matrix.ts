import type { ProjectCategory, WorkflowId, WorkflowStepKind } from '@/types/enums';

import type { TemplateChangeEntry, TemplateChangeSet, WorkflowSetting } from '../api/types';
import {
  changeEntry,
  currentValue,
  signedWeeks,
  WEEKS_MAX,
  WEEKS_MIN,
  type CategoryDrafts,
  type SavedCell,
  type StepDraft,
} from './template-drafts';

/**
 * P52-T01: "Effort & Timeline Planning" — the client's old app page as one
 * Excel-style matrix per workflow (categories × steps). Pure helpers only; the
 * drafts are the template-drafts shape of P33 (a value the user asks for, kept
 * only while it differs from the saved template), so the same apply (E2 → E3)
 * saves them. Every start week, timeline total and B-equivalent ratio still
 * comes from the server; the row totals here are display sums over the
 * template being edited (labelled as template totals).
 */

/** The client's Resource names for our step kinds (ADR 0007): Other = `elapsed`. */
export const RESOURCE_LABEL: Record<WorkflowStepKind, string> = {
  design: 'Design',
  lab: 'Lab',
  elapsed: 'Other',
};

/** Resource options in the client's order. */
export const RESOURCE_OPTIONS: readonly WorkflowStepKind[] = ['design', 'lab', 'elapsed'];

/** Drafts per category of one workflow. */
export type WorkflowDrafts = Readonly<Record<string, CategoryDrafts>>;

/** Whether a typed cell is a template length (a whole number of weeks, 0..104). Empty = 0. */
export function parseWeeks(text: string): number | null {
  const t = text.trim();
  if (t === '') return 0;
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= WEEKS_MIN && n <= WEEKS_MAX ? n : null;
}

/** Set one step's length draft; a value equal to the saved one drops out. */
export function setWeeks(
  drafts: CategoryDrafts,
  saved: Readonly<Record<string, SavedCell>>,
  stepId: string,
  weeks: number,
): CategoryDrafts {
  const savedWeeks = saved[stepId]?.weeks ?? 0;
  const step: StepDraft = { ...drafts[stepId] };
  if (weeks === savedWeeks) delete step.weeks;
  else step.weeks = weeks;
  const out: Record<string, StepDraft> = { ...drafts };
  if (step.weeks === undefined && step.gap_weeks === undefined) delete out[stepId];
  else out[stepId] = step;
  return out;
}

/** The length in force for one cell (draft, else saved). */
export function cellWeeks(drafts: CategoryDrafts | undefined, saved: Readonly<Record<string, SavedCell>>, stepId: string): number {
  return currentValue(drafts ?? {}, saved, stepId, 'weeks');
}

export interface MatrixTotals {
  /** Σ weeks over every step of the row (the client's TOTAL (W)). */
  total: number;
  /** Σ weeks over design-kind steps ("D: n w"). */
  design: number;
  /** Σ weeks over lab-kind steps ("L: n w"). */
  lab: number;
}

/** The row's template totals, by the kinds in force (drafted kinds included). */
export function matrixTotals(
  stepIds: readonly string[],
  weeksOf: (stepId: string) => number,
  kindOf: (stepId: string) => WorkflowStepKind,
): MatrixTotals {
  const out: MatrixTotals = { total: 0, design: 0, lab: 0 };
  for (const id of stepIds) {
    const w = weeksOf(id);
    out.total += w;
    const kind = kindOf(id);
    if (kind === 'design') out.design += w;
    else if (kind === 'lab') out.lab += w;
  }
  return out;
}

/**
 * Heat colour of a cell like the client's sheet: green for few weeks, through
 * amber, to red for the most weeks in this grid. 0 (skipped) is uncoloured.
 * Display only.
 */
export function heatStyle(weeks: number, max: number): { backgroundColor: string } | undefined {
  if (!(weeks > 0) || !(max > 0)) return undefined;
  const t = Math.min(1, weeks / max);
  const hue = Math.round(120 - 120 * t);
  return { backgroundColor: `hsl(${String(hue)} 72% 46% / 0.26)` };
}

/** Every drafted category of every workflow as one E1 change set. */
export function matrixChangeSet(
  drafts: Readonly<Partial<Record<WorkflowId, WorkflowDrafts>>>,
  versions: Readonly<Record<string, number>>,
): TemplateChangeSet {
  const changes: TemplateChangeEntry[] = [];
  for (const [workflowId, byCategory] of Object.entries(drafts) as [WorkflowId, WorkflowDrafts][]) {
    for (const category of Object.keys(byCategory).sort()) {
      const entry = changeEntry(workflowId, category as ProjectCategory, versions[category] ?? 1, byCategory[category] ?? {});
      if (entry) changes.push(entry);
    }
  }
  return { changes };
}

/** "A · PDD-E length 6w → 7w" / "A · PDD-H gap 0w → −2w" lines for the apply dialog. */
export function matrixSummary(
  drafts: Readonly<Partial<Record<WorkflowId, WorkflowDrafts>>>,
  savedOf: (workflowId: WorkflowId, category: string) => Readonly<Record<string, SavedCell>>,
): string[] {
  const lines: string[] = [];
  for (const [workflowId, byCategory] of Object.entries(drafts) as [WorkflowId, WorkflowDrafts][]) {
    for (const category of Object.keys(byCategory).sort()) {
      const catDrafts = byCategory[category] ?? {};
      const saved = savedOf(workflowId, category);
      for (const stepId of Object.keys(catDrafts).sort()) {
        const d = catDrafts[stepId] ?? {};
        const s = saved[stepId] ?? { weeks: 0, gap_weeks: 0 };
        if (d.weeks !== undefined) lines.push(`${category} · ${stepId} length ${String(s.weeks)}w → ${String(d.weeks)}w`);
        if (d.gap_weeks !== undefined) {
          lines.push(`${category} · ${stepId} gap ${signedWeeks(s.gap_weeks)}w → ${signedWeeks(d.gap_weeks)}w`);
        }
      }
    }
  }
  return lines;
}

/** Number of drafted steps (length and/or gap) across the categories of one workflow. */
export function draftedStepCount(drafts: WorkflowDrafts | undefined): number {
  let n = 0;
  for (const cat of Object.values(drafts ?? {})) n += Object.keys(cat).length;
  return n;
}

/** Every lab-kind step of each workflow, PDD first, in sequence order (chambers book only these, I4). */
export function labKindSteps(workflows: readonly WorkflowSetting[]): { workflowId: WorkflowId; stepId: string; name: string }[] {
  const rank = (id: WorkflowId) => (id === 'PDD' ? 0 : 1);
  return [...workflows]
    .sort((a, b) => rank(a.id) - rank(b.id))
    .flatMap((w) =>
      [...w.steps]
        .sort((a, b) => a.sequence_order - b.sequence_order)
        .filter((s) => s.kind === 'lab')
        .map((s) => ({ workflowId: w.id, stepId: s.step_id, name: s.name })),
    );
}
