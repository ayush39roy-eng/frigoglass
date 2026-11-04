# ADR 0043: Parallel steps — a per-project step overlap set from the Gantt

## Status

Accepted (2026-11-04). Part of P32. Owner request relayed 2026-11-04: "some of the 14 steps can be
parallel … the broken charts for each step are movable so they can increase and decrease the time,
make 2 parallel by overlapping … then everything is recomputed." Amends ADR 0009 (precedence) and
ADR 0019 (step timing). Scheduler input change.

## Context

ADR 0019 lets a planner drag a step bar (sets `start_not_before_week`, a floor) and resize it (sets
`duration_override_weeks`). A floor can only move a step LATER: precedence still forces
`start >= predecessors' end + 1`, so dragging a step onto its predecessor does nothing. The client
plans some steps in parallel (for example certification testing alongside TF-1, CAPEX approval
alongside design detailing) and needs the drag to say so, per project, without editing the global
precedence DAG on Workflow Settings (ADR 0009), which would change every project.

## Decision

1. **New per-project step input `overlap_weeks`** (`project_workflow_steps.overlap_weeks`, int
   0..104, null = 0). It says: this step may start up to `overlap_weeks` weeks before the work it
   waits for has ended. It is a planner input, never written by a run, like the two ADR 0019 fields.

2. **Semantics (exact).** For a non-frozen project, step `s`, predecessors `P(s)` (template DAG),
   `o(s)` = its `overlap_weeks` (0 when absent or null; always 0 in a frozen project):
   - *Release* `G(q)` of a step `q`, the week by which everything `q`'s successors wait for is done:
     - skipped `q`: `G(q) = max(G(p) for p in P(q))` (or `frontier - 1` with no predecessors) — this
       is also where a skipped step is emitted (`start = end = G(q)`), unchanged;
     - `o(q) = 0`: `G(q) = end(q)` (unchanged);
     - `o(q) > 0`: `G(q) = max(end(q), max(G(p) for p in P(q)))` — a step that overlapped its
       predecessors passes their end on, so successors still wait for ALL upstream work.
   - *Start gate* of `s`: `gate(s) = max(G(q) for q in P(s)) + 1 - o(s)` (`frontier - o(s)` with no
     predecessors, then floored by `frontier` as today).
   - *Start anchor* of `s`: `SG(s)` = the nearest non-skipped predecessors (walking through skipped
     steps). When `o(s) > 0`, `start(s) >= max(start(r) for r in SG(s))` — a step never starts
     before the step it runs in parallel with has started. (With `o(s) = 0` this is implied.)
   - Not Started placement: the search floor is
     `max(CURRENT_WEEK, gate(s), start anchor, start_not_before_week)`; capacity then applies as
     today (a design step still needs its leader free, a lab step a chamber).
   - In Progress / Blocked tail: wherever today's rule uses `pred_end + 1`, it uses `gate(s)`
     (and the start anchor), so a step the planner ran in parallel and then started keeps running in
     parallel.
   - The unconstrained finish, CP-SAT and the invariant validator use the same definitions.
   - **With every `o = 0`, every formula reduces to today's**, so every golden file and every stored
     run is unchanged (I8, I14).

3. **Two design steps of one project still cannot overlap** (ADR 0009 note): both book the same
   leader and I1 forbids it, so an overlap between two design steps lets the second one start as
   soon as the leader is free — that is, straight after the first. Real parallelism is lab ∥ design,
   elapsed ∥ anything, and design ∥ lab. The Gantt says so while dragging.

4. **Project completion** is `max(end)` over non-skipped steps (already so in greedy); with overlaps
   the last step in `sequence_order` is not necessarily the last to end, and every surface uses the
   served `end_week` / `projected_end_week`, never "the last step's end".

5. **Gantt gesture.** Dragging a Not Started step bar so that it starts at week `w`:
   - `w >= gate(s)` with `o = 0` (no overlap): as today, `start_not_before_week = w` and
     `overlap_weeks = null`;
   - `w < max(G(q)) + 1` (it overlaps the work it waits for): `overlap_weeks = max(G(q)) + 1 - w`
     and `start_not_before_week = w`. The drag label says "Runs in parallel with <step> (N weeks
     overlap)".
   - "Reset timing" clears all three fields. One PATCH carries the fields; the server recalculates
     exactly like a drag today (greedy, `trigger_reason="step_timing"`).
   - Rules of ADR 0019 §4 are unchanged: Done steps, skipped steps, frozen and non-schedulable
     projects are never editable. A non-null `overlap_weeks` on an In Progress / Blocked step is
     409 `STEP_STARTED` (clearing it is allowed). The first step of a workflow (no predecessors)
     rejects a non-null, non-zero `overlap_weeks` with 422 `VALIDATION_ERROR`.

6. **New invariant I27**: every non-skipped, non-frozen Not Started step starts at or after
   `max(gate(s), start anchor)`, and every step with `o(s) = 0` satisfies I3 exactly as before. I3 is
   restated through `G` (identical when every `o = 0`).

## Consequences

- One more field in the solver input hash; stored runs keep their snapshot (I14).
- The what-if engine (ADR 0031) and the plan import (ADR 0044) take the same field through
  `StepTimingInput`, so a what-if Gantt drag behaves exactly like the live one.
- The Workflow Settings precedence editor (ADR 0009) remains the tool for changing every project.

## Alternatives rejected

- *Let the floor override precedence.* A floor is absolute: after a recalculation moves the
  predecessor, the step would sit at a stale week, possibly before its predecessor starts.
- *Per-project precedence DAG edits.* Far heavier UI and data model for the same gesture.
