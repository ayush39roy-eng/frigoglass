# ADR 0005: CP-SAT objective uses a priority-band ordinal weight as a documented gap-fill

## Status

Accepted (provisional — proceeding without formal client sign-off; revisit before P2 closes, and
again if the client specifies a real numeric value scheme for the portfolio objective)

## Context

`docs/DOMAIN_RULES.md` states the CP-SAT objective as "maximise weighted value of projects
completing by week 52" (P2-T06). It does **not** define what "weighted value" is numerically:

- The 13-dimension prioritization scoring formula in `docs/DOMAIN_RULES.md` produces a
  `normalised_pct` and a *band* (`P1 / P2 / P3 / P4`, plus `Q` for unscored/queued). A band is a
  category, not a scalar an optimizer's `Maximize()` can consume.
- The greedy SGS scheduler (P2-T01) only ever uses priority as a *sort key*
  (`P1 → P2 → P3 → P4 → Q`), never as a magnitude.
- `ProjectInput` (P2-T01's dataclass contract) carries only the band string
  (`project.priority`), not the underlying weighted score, and not any financial "value" figure.
  Financial fields (TCOGS, gross margin, selling price) are commercially sensitive, encrypted at
  rest, and were deliberately not plumbed into the pure scheduling dataclasses.

So there is no DOMAIN_RULES.md-sourced number to maximise. P2-T06 needs one to build the model.

## Decision

For v1, the CP-SAT objective's **primary term** is:

```
maximise  Σ  PRIORITY_OBJECTIVE_WEIGHT[project.priority] × within_year[project]
         over solvable (non-frozen, non-excluded, non-pre-resolved-LEFT_OUT) projects

PRIORITY_OBJECTIVE_WEIGHT = {"P1": 4, "P2": 3, "P3": 2, "P4": 1, "Q": 0}
```

i.e. maximise the priority-band-weighted count of projects that are both scheduled at all (not
`LEFT_OUT`) and complete within `WITHIN_YEAR_WEEK`. The ordinal weights mirror the greedy
scheduler's own `P1 → P2 → P3 → P4 → Q` sort precedence — a higher band is strictly more valuable,
by the same ordering DOMAIN_RULES.md already commits to for the greedy path.

A **coarse secondary (lexicographic tie-break) term** is added on top, scaled so it can never
override the primary ranking: among solutions tied on the primary term, prefer scheduling a
project (`present = True`) over leaving it `LEFT_OUT` for no reason. This is the CP-SAT module's own
addition (also not DOMAIN_RULES.md-sourced); without it CP-SAT is free to leave a perfectly
schedulable project `LEFT_OUT` because doing so scores identically under the primary term alone
(e.g. a `Q`-band project contributing weight 0 either way). A finer secondary term that also
minimised exact completion weeks was tried and rejected — it made the real 46-project solve time
out at 60s without proving optimality and produced non-deterministic results across runs.

Both the weight table and the tie-break term live in `backend/scheduling/cp_sat.py` with inline
comments pointing back to this ADR. `PRIORITY_OBJECTIVE_WEIGHT` is a module-level constant, not a
literal scattered through the model-building code, so a real scheme replaces exactly one binding.

## Consequences

- CP-SAT's project selection (which projects it chooses to schedule vs. leave `LEFT_OUT` when
  resources are contended) depends on these weights. P2-T07's greedy-vs-CP-SAT comparison harness
  will surface differences that trace to this choice; `workflow-auditor` classifies them against
  this ADR rather than investigating each as an anomaly.
- The greedy scheduler is unaffected — it has no numeric objective. This ADR is CP-SAT-only.
- If the client specifies a real value scheme (financial value, full weighted priority score, or a
  different band-to-weight mapping), this ADR is superseded by a new one, `PRIORITY_OBJECTIVE_WEIGHT`
  (and possibly `ProjectInput`, to carry the needed figure) is updated, and P2-T06's model plus any
  P2-T07/T09 comparison baselines are re-run. Scoped as a P2 remediation task, not a re-architecture.
- `docs/DOMAIN_RULES.md`'s objective line is left as written (it is not wrong, only underspecified);
  this ADR records the numeric interpretation P2-T06 proceeds under in the meantime.
