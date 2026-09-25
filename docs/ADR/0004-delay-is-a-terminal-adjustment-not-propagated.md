# ADR 0004: Delay is a terminal adjustment, not propagated into downstream steps, in v1

## Status

Accepted (provisional — proceeding without formal client sign-off; revisit before P2 closes if the
client's answer to `docs/OPEN_QUESTIONS.md` #5 differs)

## Context

The prototype has a known defect: delay is applied once at the end of a project's schedule
(`last_step_end + delay <= WITHIN_YEAR_WEEK`) to determine spillover, rather than being pushed into
each downstream step's start time (`docs/DOMAIN_RULES.md`, "Known defects in the prototype" #3;
`docs/OPEN_QUESTIONS.md` #5).

The project owner has directed the team to proceed with the stated default assumption (terminal
adjustment) and revisit later rather than block P2 on this question.

## Decision

For v1, delay is modelled as a terminal adjustment applied only to the completing-within-year check
(`!left_out AND (last_step_end + delay <= WITHIN_YEAR_WEEK)`), not propagated into intermediate
step start/end times. Invariant I3 (`step[n].start >= step[n-1].end + 1`) is asserted against the
*undelayed* planned schedule; the delay figure is a separate reported adjustment layered on top for
spillover determination and Gantt display (hatched bar + red connector, per the `dataviz-gantt`
skill), not baked into the per-step schedule itself.

This matches current prototype behaviour and is recorded as `INTENTIONAL` (matched-to-current) in
`docs/ORACLE_DIVERGENCE.md` during P2.

## Consequences

- A delayed project's downstream steps are not automatically pushed out in the stored schedule —
  only the final completion check reflects the delay. This must be communicated clearly in the
  Gantt (the delay connector shows magnitude at the end, not a full re-flowed timeline).
- If the client's real answer requires delay propagation, this ADR is superseded, the greedy
  scheduler and CP-SAT model are revised to add the delay to each downstream step's earliest-start
  computation (not just the final check), and Invariant I3 is re-scoped to apply to the
  delay-adjusted schedule. This is a more significant P2 change than ADR 0002/0003's reversals,
  since it affects every step's computed dates, not just one constraint.
- `docs/OPEN_QUESTIONS.md` #5 remains open for final client confirmation.
