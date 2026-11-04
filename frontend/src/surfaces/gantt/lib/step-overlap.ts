/**
 * Parallel steps — pure overlap helpers (ADR 0043, docs/API_CONTRACT_P32.md A2/A4).
 *
 * These only interpret the gesture: they turn a drop week into the two planner inputs the server
 * stores (`start_not_before_week`, `overlap_weeks`). They read the served schedule (planned weeks,
 * skipped, template predecessors, stored overlaps) and never produce a displayed schedule number;
 * the recalculated plan always comes back from the API (I9).
 */

export interface OverlapStep {
  stepId: string;
  startWeek: number | null;
  endWeek: number | null;
  skipped: boolean;
  predecessorIds: readonly string[];
  overlapWeeks: number | null;
  name?: string;
  kind?: string;
}

function indexSteps(steps: readonly OverlapStep[]): Map<string, OverlapStep> {
  const byId = new Map<string, OverlapStep>();
  for (const s of steps) byId.set(s.stepId, s);
  return byId;
}

function overlapOf(step: OverlapStep): number {
  return step.overlapWeeks != null && step.overlapWeeks > 0 ? step.overlapWeeks : 0;
}

/**
 * G(q) per A2. Predecessors absent from `steps` are ignored. Cycles (never served — the template is
 * a DAG) are cut so the helper cannot loop.
 */
function releaseOf(
  byId: Map<string, OverlapStep>,
  stepId: string,
  frontier: number,
  memo: Map<string, number>,
  visiting: Set<string>,
): number {
  const cached = memo.get(stepId);
  if (cached !== undefined) return cached;
  const q = byId.get(stepId);
  if (!q || visiting.has(stepId)) return frontier - 1;
  visiting.add(stepId);
  const predMax = (): number => {
    let m = Number.NEGATIVE_INFINITY;
    for (const p of q.predecessorIds) {
      if (!byId.has(p)) continue;
      m = Math.max(m, releaseOf(byId, p, frontier, memo, visiting));
    }
    return m === Number.NEGATIVE_INFINITY ? frontier - 1 : m;
  };
  let g: number;
  if (q.skipped) {
    g = predMax();
  } else {
    // A non-skipped step without a served end has not been placed — treat as "no constraint".
    const end = q.endWeek ?? frontier - 1;
    g = overlapOf(q) === 0 ? end : Math.max(end, predMax());
  }
  visiting.delete(stepId);
  memo.set(stepId, g);
  return g;
}

/** release(s) = max G(q) over the step's predecessors; `frontier - 1` when it has none. */
export function releaseWeek(
  steps: readonly OverlapStep[],
  stepId: string,
  frontier: number,
): number {
  const byId = indexSteps(steps);
  const s = byId.get(stepId);
  if (!s) return frontier - 1;
  const memo = new Map<string, number>();
  let m = Number.NEGATIVE_INFINITY;
  for (const p of s.predecessorIds) {
    if (!byId.has(p)) continue;
    m = Math.max(m, releaseOf(byId, p, frontier, memo, new Set()));
  }
  return m === Number.NEGATIVE_INFINITY ? frontier - 1 : m;
}

/** SG(s): nearest non-skipped predecessors, walking through skipped steps. */
function nearestNonSkipped(byId: Map<string, OverlapStep>, s: OverlapStep): OverlapStep[] {
  const out = new Map<string, OverlapStep>();
  const seen = new Set<string>();
  const stack = [...s.predecessorIds];
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    const p = byId.get(id);
    if (!p) continue;
    if (p.skipped) stack.push(...p.predecessorIds);
    else out.set(p.stepId, p);
  }
  return [...out.values()];
}

/**
 * The start anchor: the latest start among the nearest non-skipped predecessors (a step never
 * starts before the step it runs in parallel with has started). Null when there is none with a
 * served start week.
 */
export function nearestStartAnchor(
  steps: readonly OverlapStep[],
  stepId: string,
): { week: number; stepIds: string[] } | null {
  const byId = indexSteps(steps);
  const s = byId.get(stepId);
  if (!s) return null;
  const anchors = nearestNonSkipped(byId, s).filter((r) => r.startWeek != null);
  if (anchors.length === 0) return null;
  const week = Math.max(...anchors.map((r) => r.startWeek as number));
  const stepIds = anchors
    .filter((r) => r.startWeek === week)
    .map((r) => r.stepId)
    .sort();
  return { week, stepIds };
}

/**
 * Interpret a bar dropped at `dropWeek` (ADR 0043 §5, A4):
 * - clamp to the start anchor (and to `frontier`);
 * - at or after `release + 1` → `{start_not_before_week: w, overlap_weeks: null}`;
 * - before it → `overlap_weeks = release + 1 - w`, and `parallelWith` lists the non-skipped
 *   nearest predecessors whose served window the bar now overlaps (for the drag label).
 */
export function overlapForDrop(
  steps: readonly OverlapStep[],
  stepId: string,
  dropWeek: number,
  frontier: number,
): {
  startNotBeforeWeek: number;
  overlapWeeks: number | null;
  clampedWeek: number;
  parallelWith: OverlapStep[];
} {
  const byId = indexSteps(steps);
  const s = byId.get(stepId);
  const release = releaseWeek(steps, stepId, frontier);
  const hasPreds = s != null && s.predecessorIds.some((p) => byId.has(p));
  const anchor = nearestStartAnchor(steps, stepId);
  let w = Math.max(Math.round(dropWeek), frontier);
  if (hasPreds && anchor) w = Math.max(w, anchor.week);
  if (!hasPreds || w >= release + 1) {
    return { startNotBeforeWeek: w, overlapWeeks: null, clampedWeek: w, parallelWith: [] };
  }
  const overlap = Math.min(release + 1 - w, 104);
  const parallelWith = s
    ? nearestNonSkipped(byId, s)
        .filter((r) => (r.endWeek ?? Number.NEGATIVE_INFINITY) >= w)
        .sort((a, b) => (b.endWeek ?? 0) - (a.endWeek ?? 0) || a.stepId.localeCompare(b.stepId))
    : [];
  return { startNotBeforeWeek: w, overlapWeeks: overlap, clampedWeek: w, parallelWith };
}
