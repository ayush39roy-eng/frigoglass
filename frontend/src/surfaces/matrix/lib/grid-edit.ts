/**
 * P34-T02 (D34-1): the scoring grid's inline edit session.
 *
 * A draft holds one project's full proposed values (every active dimension of
 * the row, 0..5 or null, and the full hard-gate list). Only projects whose
 * draft differs from their base are kept. The base is the served row, or in
 * scenario mode the row with its staged scenario edit applied.
 *
 * Save is ONE `POST /scenarios/apply` with every changed project (one version);
 * in scenario mode the same drafts are staged into the scenario store instead.
 * Nothing here computes a score, a band or points: the server recomputes them
 * after the apply and the grid re-reads them (I9).
 */

import type { HardGateReason } from '@/types/enums';

import type {
  DimensionKey,
  DimensionScoreMap,
  DimensionScoreValue,
  PriorityMatrixRow,
  PriorityScoreUpdateRequest,
  ScenarioApplyRequest,
} from '../api/types';
import { liveRequestValuesFromRow } from '../components/score-edit-schema';
import { toScoreChangeBody } from './score-base';

export type GridDraft = PriorityScoreUpdateRequest;
export type GridDrafts = Readonly<Record<string, GridDraft>>;

/** One 0..5 score, or null ("not scored": clears it, as the old dialog allowed). */
export function parseScoreInput(raw: string): DimensionScoreValue | undefined {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^[0-5]$/.test(t)) return undefined;
  return Number(t);
}

function sameGates(a: readonly HardGateReason[], b: readonly HardGateReason[]): boolean {
  return a.length === b.length && a.every((g) => b.includes(g));
}

/** True when `draft` differs from `base` on any key or on the gates. */
export function draftDiffers(base: GridDraft, draft: GridDraft): boolean {
  const keys = new Set([...Object.keys(base.scores), ...Object.keys(draft.scores)]);
  for (const key of keys) {
    if ((base.scores[key] ?? null) !== (draft.scores[key] ?? null)) return true;
  }
  return !sameGates(base.hard_gates, draft.hard_gates);
}

/** The values the grid shows for `row` in edit mode: its draft, else its base. */
export function valuesFor(drafts: GridDrafts, baseRow: PriorityMatrixRow): GridDraft {
  return drafts[baseRow.project_id] ?? liveRequestValuesFromRow(baseRow);
}

function withDraft(drafts: GridDrafts, baseRow: PriorityMatrixRow, next: GridDraft): GridDrafts {
  const out: Record<string, GridDraft> = { ...drafts };
  if (draftDiffers(liveRequestValuesFromRow(baseRow), next)) out[baseRow.project_id] = next;
  else delete out[baseRow.project_id];
  return out;
}

export function setDraftScore(
  drafts: GridDrafts,
  baseRow: PriorityMatrixRow,
  key: DimensionKey,
  value: DimensionScoreValue,
): GridDrafts {
  const current = valuesFor(drafts, baseRow);
  return withDraft(drafts, baseRow, { ...current, scores: { ...current.scores, [key]: value } });
}

export function setDraftGate(
  drafts: GridDrafts,
  baseRow: PriorityMatrixRow,
  gate: HardGateReason,
  on: boolean,
): GridDrafts {
  const current = valuesFor(drafts, baseRow);
  const gates = current.hard_gates.filter((g) => g !== gate);
  return withDraft(drafts, baseRow, { ...current, hard_gates: on ? [...gates, gate] : gates });
}

/** Ids of projects whose draft still differs from the CURRENT base (a re-read
 *  may have caught up with a draft), in `baseRows` order. */
export function changedProjectIds(drafts: GridDrafts, baseRows: readonly PriorityMatrixRow[]): string[] {
  const out: string[] = [];
  for (const row of baseRows) {
    const draft = drafts[row.project_id];
    if (draft && draftDiffers(liveRequestValuesFromRow(row), draft)) out.push(row.project_id);
  }
  return out;
}

/** Per-cell "changed" marker in edit mode. */
export function scoreChanged(drafts: GridDrafts, baseRow: PriorityMatrixRow, key: DimensionKey): boolean {
  const draft = drafts[baseRow.project_id];
  if (!draft) return false;
  const base = baseRow.dimension_scores.find((d) => d.key === key)?.score ?? null;
  return (draft.scores[key] ?? null) !== base;
}

export function gateChanged(drafts: GridDrafts, baseRow: PriorityMatrixRow, gate: HardGateReason): boolean {
  const draft = drafts[baseRow.project_id];
  if (!draft) return false;
  return draft.hard_gates.includes(gate) !== baseRow.hard_gates.includes(gate);
}

/**
 * D34-1: one apply body for every changed project — the full scores map (each
 * ACTIVE key of the served row, so nothing inactive is sent) and the full gate
 * list, per the `ScenarioPriorityScoreChange` contract.
 */
export function buildGridApplyBody(
  drafts: GridDrafts,
  liveRows: readonly PriorityMatrixRow[],
  notes: string,
  /** P47 (ADR 0059): each project's values when its first cell was edited.
   *  When given, a row sends only the dimensions the user changed (omitted
   *  keys keep their stored value, so a dimension someone else changed
   *  meanwhile is never overwritten) and carries its `base`. */
  reads?: Readonly<Record<string, GridDraft>>,
): ScenarioApplyRequest {
  const priority_scores = changedProjectIds(drafts, liveRows).map((id) => {
    const row = liveRows.find((r) => r.project_id === id) as PriorityMatrixRow;
    const draft = drafts[id] as GridDraft;
    const scores: DimensionScoreMap = {};
    if (reads) {
      const read = reads[id] ?? liveRequestValuesFromRow(row);
      for (const d of row.dimension_scores) {
        const next = draft.scores[d.key] ?? null;
        if (next !== (read.scores[d.key] ?? null)) scores[d.key] = next;
      }
      // P47-R03 (QA-2): `hard_gates` only when the row's gates changed.
      return { project_id: id, ...toScoreChangeBody({ scores, hard_gates: [...draft.hard_gates] }, read) };
    }
    for (const d of row.dimension_scores) scores[d.key] = draft.scores[d.key] ?? null;
    return { project_id: id, scores, hard_gates: [...draft.hard_gates] };
  });
  const trimmed = notes.trim();
  return { notes: trimmed === '' ? null : trimmed, priority_scores };
}

/**
 * P47 (ADR 0059 C2, "Use theirs"): the drafts with the stored values put back
 * for each conflicting dimension / gate list (my other edits stay), and the
 * read snapshot moved to the stored values so the next save starts from them.
 */
export function applyTheirScores(
  drafts: GridDrafts,
  reads: Readonly<Record<string, GridDraft>>,
  projectId: string,
  theirs: { scores: DimensionScoreMap; hard_gates: HardGateReason[] | null },
): { drafts: GridDrafts; reads: Readonly<Record<string, GridDraft>> } {
  const outDrafts: Record<string, GridDraft> = { ...drafts };
  const outReads: Record<string, GridDraft> = { ...reads };
  const put = (v: GridDraft | undefined): GridDraft | undefined =>
    v && {
      scores: { ...v.scores, ...theirs.scores },
      hard_gates: theirs.hard_gates ? [...theirs.hard_gates] : v.hard_gates,
    };
  const draft = put(drafts[projectId]);
  const read = put(reads[projectId]);
  if (draft) outDrafts[projectId] = draft;
  if (read) outReads[projectId] = read;
  if (draft && read && !draftDiffers(read, draft)) delete outDrafts[projectId];
  return { drafts: outDrafts, reads: outReads };
}
