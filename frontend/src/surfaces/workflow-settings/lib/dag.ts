/**
 * Client-side mirror of the server's precedence-graph validation (P9 contract
 * §3, ADR 0009): a cycle, a self-reference, a reference to a step outside the
 * workflow, or an empty predecessor set on any step but the first is rejected.
 * The SERVER is the authority — this exists so the editor can refuse to submit
 * an obviously invalid graph and explain why, using the same codes.
 *
 * Also the two read-only derivations the Steps tab shows: "runs in parallel
 * with" (steps that are neither ancestors nor descendants) and the
 * longest-path level used to lay out the inline DAG diagram. Neither is a
 * scheduling computation; both are properties of the graph being edited.
 */

export interface DagStep {
  step_id: string;
  sequence_order: number;
  predecessor_ids: readonly string[];
}

export type DagErrorCode = 'CYCLE' | 'SELF_REFERENCE' | 'BAD_PREDECESSOR' | 'EMPTY_PREDECESSORS';

export interface DagError {
  code: DagErrorCode;
  step_id: string;
  detail: string;
}

function bySequence<T extends DagStep>(steps: readonly T[]): T[] {
  return [...steps].sort((a, b) => a.sequence_order - b.sequence_order);
}

/** DFS cycle detection. Returns the cycle as a list of step ids, or null. */
export function findCycle(steps: readonly DagStep[]): string[] | null {
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  const state = new Map<string, 'visiting' | 'done'>();
  const stack: string[] = [];

  const visit = (id: string): string[] | null => {
    const st = state.get(id);
    if (st === 'done') return null;
    if (st === 'visiting') {
      const start = stack.indexOf(id);
      return [...stack.slice(start), id];
    }
    state.set(id, 'visiting');
    stack.push(id);
    const step = byId.get(id);
    for (const pred of step?.predecessor_ids ?? []) {
      if (!byId.has(pred)) continue;
      const found = visit(pred);
      if (found) return found;
    }
    stack.pop();
    state.set(id, 'done');
    return null;
  };

  for (const s of bySequence(steps)) {
    const found = visit(s.step_id);
    if (found) return found;
  }
  return null;
}

export function validateDag(steps: readonly DagStep[]): DagError[] {
  const errors: DagError[] = [];
  const ids = new Set(steps.map((s) => s.step_id));
  const ordered = bySequence(steps);
  const first = ordered[0];

  for (const s of ordered) {
    for (const pred of s.predecessor_ids) {
      if (pred === s.step_id) {
        errors.push({ code: 'SELF_REFERENCE', step_id: s.step_id, detail: `${s.step_id} cannot depend on itself.` });
      } else if (!ids.has(pred)) {
        errors.push({
          code: 'BAD_PREDECESSOR',
          step_id: s.step_id,
          detail: `${s.step_id} references ${pred}, which is not a step of this workflow.`,
        });
      }
    }
    if (s !== first && s.predecessor_ids.length === 0) {
      errors.push({
        code: 'EMPTY_PREDECESSORS',
        step_id: s.step_id,
        detail: `${s.step_id} must start after at least one other step (only the first step has none).`,
      });
    }
  }

  const cycle = findCycle(steps);
  if (cycle) {
    errors.push({
      code: 'CYCLE',
      step_id: cycle[0] ?? '',
      detail: `Cycle: ${cycle.join(' → ')}.`,
    });
  }
  return errors;
}

/** Every transitive predecessor of `id`. */
export function ancestors(steps: readonly DagStep[], id: string): Set<string> {
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  const out = new Set<string>();
  const walk = (cur: string) => {
    for (const pred of byId.get(cur)?.predecessor_ids ?? []) {
      if (out.has(pred) || pred === id) continue;
      out.add(pred);
      walk(pred);
    }
  };
  walk(id);
  return out;
}

/** Every transitive successor of `id`. */
export function descendants(steps: readonly DagStep[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (cur: string) => {
    for (const s of steps) {
      if (s.predecessor_ids.includes(cur) && !out.has(s.step_id) && s.step_id !== id) {
        out.add(s.step_id);
        walk(s.step_id);
      }
    }
  };
  walk(id);
  return out;
}

/**
 * Steps that can be in flight at the same time as `id`: neither before it nor
 * after it in the graph. Under the strict chain this is empty for every step —
 * the affordance the client asked for is to make it non-empty on purpose.
 * Only meaningful for an acyclic graph.
 */
export function parallelPeers(steps: readonly DagStep[], id: string): string[] {
  const anc = ancestors(steps, id);
  const desc = descendants(steps, id);
  return bySequence(steps)
    .filter((s) => s.step_id !== id && !anc.has(s.step_id) && !desc.has(s.step_id))
    .map((s) => s.step_id);
}

/**
 * Longest-path depth of each step (roots = 0) for the diagram's x-axis. Falls
 * back to `sequence_order − 1` while the graph is cyclic so the editor still
 * draws something.
 */
export function topologicalLevels(steps: readonly DagStep[]): Map<string, number> {
  const levels = new Map<string, number>();
  if (findCycle(steps)) {
    for (const s of steps) levels.set(s.step_id, Math.max(0, s.sequence_order - 1));
    return levels;
  }
  const byId = new Map(steps.map((s) => [s.step_id, s]));
  const depth = (id: string): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    const preds = (byId.get(id)?.predecessor_ids ?? []).filter((p) => byId.has(p));
    const d = preds.length === 0 ? 0 : 1 + Math.max(...preds.map(depth));
    levels.set(id, d);
    return d;
  };
  for (const s of steps) depth(s.step_id);
  return levels;
}
