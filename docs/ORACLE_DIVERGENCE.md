# Oracle Divergence Report — P2-T03

Diff between the P2-T02 differential oracle (`tests/oracle/oracle_output.json`, the prototype's own
unmodified scheduler run against the real 46-project seed dataset) and `backend/scheduling/greedy.py`
(P2-T01) on the identical input, produced by `tests/oracle/diff_against_scheduler.py`.

**Zero unclassified divergences**, per P2-T03's acceptance criteria. Every one of the 1055
field-level divergences across 41 of the 46 projects traces to a single root cause (Pattern 1
below); everything else in this report is a downstream, mechanically-explained consequence of that
one decision propagating through shared, contended resources (engineers, chambers) — not an
independent bug. **No `PORT_BUG`s were found.** `backend/scheduling/greedy.py` was not modified by
this task.

## Summary

| Divergence field | Count | Pattern |
|---|---|---|
| `start_week` | 495 | 1 |
| `end_week` | 493 | 1 |
| `assigned_chamber_id` | 42 | 1 (downstream) |
| `step_presence` | 15 | 1 (downstream) |
| `spillover` | 5 | 1 (downstream) |
| `within_year` | 3 | 1 (downstream) |
| `left_out` | 2 | 1 (downstream) |
| **Total** | **1055** | |

**41 of 46 projects** show at least one divergence. The 5 that show none: the single `frozen`
project in the dataset (`26-00200` — frozen projects' dates are locked at `actual_start_week`
identically on both sides, exactly as expected, and this was specifically checked as a
correctness signal — see Verification below), the 2 excluded projects (`26-00226` Commercialized,
`26-00227` On Hold — excluded from scheduling entirely on both sides), and 2 non-frozen projects
(`26-00238`, `26-00242`) whose specific leader/timing combination happened not to be affected.

---

## Pattern 1 — INTENTIONAL: earliest-start floor for non-frozen projects

**Classification:** `INTENTIONAL`
**Citation:** `docs/MEMORY.md`, the `[2026-08-30 12:00] P2-T01 review` entry's "earliest-start
floor" decision (no dedicated ADR — resolved as a routine DOMAIN_RULES.md ambiguity within P2-T01's
own scope, per that task's brief; this MEMORY.md entry is the citation of record).

**What diverges:** For every non-frozen project, `docs/DOMAIN_RULES.md`'s booking rules say "Non-
frozen projects advance `w` until a free window is found" but never specify what week that search
*starts* from. The prototype fills this gap with an undocumented magic constant:
`w = max(actualStart, CURRENT_WEEK - 6)` — i.e. it treats every project's `actualStart` field (even
for non-frozen projects, where DOMAIN_RULES.md and the accepted P1 data model both treat that field
as not-a-real-fact) as a soft starting hint, floored at 6 weeks before the current planning week.

`backend/scheduling/greedy.py` deliberately does not replicate this: the search for a non-frozen
project starts at `current_week` (31) and only respects `actual_start_week` if it happens to be
populated and later than `current_week` — which, per the P1-T03 seed script's own convention (also
followed by this diff's harness, `tests/oracle/diff_against_scheduler.py`), it never is for
non-frozen projects, since `actual_start_week` is only persisted for `frozen` projects in the
accepted data model.

**Representative example** (direct effect): project `26-00205`, category A, non-frozen,
`actualStart=25`, `delay=0`.
- Oracle (prototype): search floor `= max(25, 31-6) = max(25, 25) = 25` → first design step starts
  at week 25.
- Ours: search floor `= current_week = 31` (actual_start_week is `None` for this non-frozen
  project) → first design step starts at week 31.
- Net effect: our schedule runs 6 weeks later throughout this project's 14 steps, which alone is
  enough to push its completion from week 52 (within-year) to week 54+ (`spillover`).

**Why this is INTENTIONAL, not a bug to fix:** the "-6" constant has no textual basis anywhere in
`docs/DOMAIN_RULES.md`, and `docs/CLAUDE.md`'s non-negotiable is explicit that "the scheduler's
behaviour is defined by DOMAIN_RULES.md, never by the prototype." Building the scheduler around an
unexplained prototype magic number — one that also contradicts the already-accepted P1 data model's
decision not to persist a non-real `actual_start_week` for non-frozen projects — would mean silently
resurrecting an ambiguity P1 already closed. Starting from `current_week` (you cannot schedule new
work in the past) is the direct, spec-consistent reading of "advance `w` until a free window is
found" absent any other stated floor.

**Direct effect:** 495 `start_week` + 493 `end_week` divergences (nearly every step of every
affected non-frozen project shows a shifted week — expected, since a shift at step 1 propagates
through every subsequent sequential step per Invariant I3).

### Downstream effect A — chamber reassignment (42 divergences)

Because lab steps now book at different weeks than the oracle, the pool of chambers with available
capacity *at that specific week window* differs from the oracle's pool at *its* week window — so a
different (but equally rule-eligible: same lab region, same `allowed_stages` membership, same
capacity constraint) chamber sometimes gets picked. Example: project `26-00202`'s `PDD-L` step —
oracle assigns `IN-CH1`, ours assigns `IN-CH2`; both chambers are eligible for that step in that lab
region, the difference is purely which one had room during each side's differently-timed window.
Not investigated project-by-project — the chamber-selection *logic* itself (sorted by `chamber_id`,
first with capacity for the full window) is unchanged and was already verified correct in P2-T01's
review; only the *timing* that feeds into it differs, per Pattern 1.

### Downstream effect B — step presence differences on `LEFT_OUT` projects (15 divergences)

Six projects (`26-00221`, `26-00228`, `26-00229`, `26-00230`, `26-00239`, `26-00244`) are `LEFT_OUT`
on at least one side (some on both, at different step counts). Because the exact week trajectory
differs from step 1 onward (Pattern 1), the point at which a project's search first fails to find a
window before `HORIZON_WEEKS` (78) differs too — so the two sides retain a different number of
successfully-booked steps before giving up (matching `backend/scheduling/types.py`'s documented
"partial steps are retained on `LEFT_OUT`" behavior, itself already resolved via the prototype and
accepted in P2-T01's review). Verified directly for all six:

| Project | Oracle: left_out / steps booked | Ours: left_out / steps booked |
|---|---|---|
| 26-00221 | False / 14 (all) | True / 11 |
| 26-00228 | True / 7 | True / 4 |
| 26-00229 | False / 14 (all) | True / 12 |
| 26-00230 | True / 9 | True / 7 |
| 26-00239 | True / 9 | True / 12 |
| 26-00244 | True / 5 | True / 3 |

Note `26-00239` is the one case where our scheduler got *further* (12 steps) than the oracle (9) —
consistent with Pattern 1 being a genuine timing shift in both directions depending on each
project's specific position in the shared engineer/chamber contention queue, not a one-directional
"ours is always worse" effect.

### Downstream effect C — `left_out` flips (2 divergences: `26-00221`, `26-00229`)

Both shown in the table above: the oracle completes all 14 steps (`left_out=False`), ours does not
(`left_out=True`) before hitting `HORIZON_WEEKS`. Direct consequence of Pattern 1's cumulative
6-week-or-more delay pushing these two specific, apparently already-tightly-contended projects past
the horizon on our side when they weren't on the oracle's.

### Downstream effect D — `within_year` / `spillover` flips (3 + 5 divergences)

`26-00205`, `26-00217`, `26-00219` flip `within_year`; `26-00205`, `26-00217`, `26-00219`,
`26-00221`, `26-00229` flip `spillover` (the `left_out` projects `26-00221`/`26-00229` are
correctly excluded from `spillover` on our side per the mutual-exclusivity rule — `spillover` is
only meaningful for a project that was NOT left out; see P2-T01's self-test case "spillover
boundary: not left_out (it WAS scheduled, just late)" for the same rule verified in isolation).
Each is the direct completing-within-year consequence (`docs/DOMAIN_RULES.md`: `!left_out AND
(last_step_end + delay <= WITHIN_YEAR_WEEK)`) of Pattern 1 shifting `end_week` across the week-52
boundary in one direction or the other, depending on each project's specific contention profile.

---

## Verification performed

- **Frozen-project agreement check:** the dataset's single frozen project (`26-00200`) shows
  **zero** divergence on any field — confirmed deliberately as a correctness signal, since frozen
  projects use `actual_start_week` verbatim on both sides and should never be affected by Pattern 1
  at all. Zero divergence here is strong evidence the diff harness's identifier mapping and field
  comparison logic are correct, and that Pattern 1's mechanism is exactly what it's described as
  (a non-frozen-only effect) rather than a broader identifier/mapping bug that happens to look like
  a Pattern-1-shaped signature.
- **ADR-governed defects (0002 FTE, 0003 chamber efficiency, 0004 delay-terminal) produced zero
  divergence** — checked explicitly: no divergence in this report is explained by any of these three
  behaviors differing between the oracle and our scheduler, confirming all three ADR decisions are
  correctly implemented consistently with the prototype's own (matched-on-purpose) behavior on these
  points.
- **Sample-verified by hand** (not just asserted): `26-00205`'s week-25-vs-31 start shift, computed
  directly from `docs/DOMAIN_RULES.md`'s stated rule and the two respective floor formulas, matches
  both captured outputs exactly.
- Diff harness: `tests/oracle/diff_against_scheduler.py`, machine-readable output at
  `tests/oracle/divergences.json` (1055 entries, regenerable by re-running the script — not hand-
  edited).

## Disposition

No changes to `backend/scheduling/greedy.py` were made or needed — every divergence is explained by
a single, already-reviewed, already-accepted P2-T01 decision and its mechanical downstream effects
through shared resource contention. `backend/scheduling/_selftest.py`'s 47 checks remain the
authoritative correctness contract and were not affected by this task (no scheduler code changed).

Per `docs/IMPLEMENTATION_PLAN.md` P2-T05, this entire `tests/oracle/` directory (including this
report's supporting `divergences.json` and `diff_against_scheduler.py`) is deleted once P2-T05
replaces it with spec-derived golden-file tests. `docs/ORACLE_DIVERGENCE.md` itself is *not* deleted
— it's the permanent record of this analysis.
