/**
 * P47-T03 (ADR 0059 C1): the `base` of a priority-score change
 * (`PUT /priorities/{id}`, a row of `POST /scenarios/apply`). Same shape as the
 * change: `scores` holds the value as read of each dimension the change sends,
 * `hard_gates` the gate list as read (the change always sends the full list,
 * so it is always checked). Nothing here scores or compares (I9).
 */

import {
  editConflicts,
  HIDDEN_VALUE,
  type ConflictChoice,
  type EditConflict,
  type EditSendOutcome,
} from '@/lib/api/edit-conflict';
import type { HardGateReason } from '@/types/enums';

import type {
  DimensionScoreMap,
  PriorityScoreBase,
  PriorityScoreChangeBody,
  PriorityScoreUpdateRequest,
} from '../api/types';

export type ScoreBase = PriorityScoreBase;

/**
 * P47-R03 (QA-2): the body of a score change and its `base`. `next` holds the
 * dimensions the user changed and the gate list the user wants; `read` MUST be
 * the SERVED stored values when the edit started (never a scenario's staged
 * copy, A4).
 * - `scores`: as given; `base.scores` = the read value of each.
 * - `hard_gates`: sent ONLY when it differs from the read list, together with
 *   `base.hard_gates` = the read list. Unchanged, it is left out of both, so
 *   the stored gates are untouched (another user's newer gates survive).
 */
export function toScoreChangeBody(next: PriorityScoreUpdateRequest, read: PriorityScoreUpdateRequest): PriorityScoreChangeBody & { base: ScoreBase } {
  const baseScores: DimensionScoreMap = {};
  for (const key of Object.keys(next.scores)) baseScores[key] = read.scores[key] ?? null;
  if (sameGates(next.hard_gates, read.hard_gates)) return { scores: { ...next.scores }, base: { scores: baseScores } };
  return {
    scores: { ...next.scores },
    hard_gates: [...next.hard_gates],
    base: { scores: baseScores, hard_gates: [...read.hard_gates] },
  };
}

/** `hard_gates`, or the dimension key a conflict names (`scores.<key>`, `<key>`). */
export function scoreConflictKey(field: string): string {
  if (field === 'hard_gates') return field;
  return field.replace(/^scores?[.:]/, '');
}

function gatesOf(value: unknown): HardGateReason[] | null {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'string') as HardGateReason[]) : null;
}

function scoreOf(value: unknown): number | null {
  return typeof value === 'number' ? value : null;
}

/** "Keep mine": the conflicting entries of `base` take the values stored now. */
export function keepMineScoreBase(base: ScoreBase, conflicts: readonly EditConflict[]): ScoreBase {
  const out: ScoreBase = { ...base, scores: { ...base.scores } };
  for (const c of conflicts) {
    if (c.current_value === HIDDEN_VALUE) continue;
    const key = scoreConflictKey(c.field);
    if (key === 'hard_gates') {
      const gates = gatesOf(c.current_value);
      if (gates) out.hard_gates = gates;
    } else if (key in out.scores) out.scores[key] = scoreOf(c.current_value);
  }
  return out;
}

/** "Use theirs": the stored values of the conflicting entries, to put back
 *  into an edit buffer (`scores` by key; `hard_gates` when it conflicted). */
export function theirScoreValues(conflicts: readonly EditConflict[]): {
  scores: DimensionScoreMap;
  hard_gates: HardGateReason[] | null;
} {
  const scores: DimensionScoreMap = {};
  let hardGates: HardGateReason[] | null = null;
  for (const c of conflicts) {
    const key = scoreConflictKey(c.field);
    if (key === 'hard_gates') hardGates = gatesOf(c.current_value);
    else scores[key] = scoreOf(c.current_value);
  }
  return { scores, hard_gates: hardGates };
}

/**
 * "Use theirs" on a single change: my value for each conflicting dimension,
 * and a conflicting gate list, are dropped from the body and from `base`
 * (left out, the stored values stay).
 */
export function withoutScoreConflicts(
  change: PriorityScoreChangeBody & { base: ScoreBase },
  conflicts: readonly EditConflict[],
): PriorityScoreChangeBody & { base: ScoreBase } {
  const theirs = theirScoreValues(conflicts);
  const scores: DimensionScoreMap = { ...change.scores };
  const baseScores: DimensionScoreMap = { ...change.base.scores };
  for (const key of Object.keys(theirs.scores)) {
    delete scores[key];
    delete baseScores[key];
  }
  const gatesConflict = conflicts.some((c) => scoreConflictKey(c.field) === 'hard_gates');
  if (gatesConflict || change.hard_gates === undefined) return { scores, base: { scores: baseScores } };
  return { scores, hard_gates: change.hard_gates, base: { ...change.base, scores: baseScores } };
}

function sameGates(a: readonly HardGateReason[], b: readonly HardGateReason[]): boolean {
  return a.length === b.length && a.every((g) => b.includes(g));
}

/**
 * One score change (`PUT /priorities/{id}`) with the ADR 0059 loop, the score
 * twin of `sendEditWithBase`: "Keep mine" resends with the stored values as
 * base; "Use theirs" drops the conflicting dimensions (and takes their gate
 * list), refetches, and sends what is left of mine, if anything.
 */
export async function sendScoreChange<T>(opts: {
  change: PriorityScoreUpdateRequest;
  /** The values when the edit started. */
  read: PriorityScoreUpdateRequest;
  send: (body: PriorityScoreChangeBody & { base: ScoreBase }) => Promise<T>;
  ask: (conflicts: EditConflict[]) => Promise<ConflictChoice>;
  onUseTheirs?: (conflicts: EditConflict[]) => void | Promise<void>;
}): Promise<EditSendOutcome<T>> {
  let body = toScoreChangeBody(opts.change, opts.read);
  const dropped: string[] = [];
  for (;;) {
    try {
      return { outcome: 'saved', data: await opts.send(body), dropped };
    } catch (err) {
      const conflicts = editConflicts(err);
      if (conflicts === null) throw err;
      const choice = await opts.ask(conflicts);
      if (choice === 'mine') {
        body = { ...body, base: keepMineScoreBase(body.base, conflicts) };
        continue;
      }
      if (choice !== 'theirs') return { outcome: 'dismissed', conflicts };
      body = withoutScoreConflicts(body, conflicts);
      dropped.push(...conflicts.map((c) => c.field));
      await opts.onUseTheirs?.(conflicts);
      if (Object.keys(body.scores).length === 0 && body.hard_gates === undefined) return { outcome: 'theirs', dropped };
    }
  }
}
