# ADR 0002: FTE does not gate scheduling throughput in v1

## Status

Accepted (provisional — proceeding without formal client sign-off; revisit before P2 closes if the
client's answer to `docs/OPEN_QUESTIONS.md` #2 differs)

## Context

The prototype has a known defect: the Capacity Planning surface reports engineer capacity scaled by
FTE (0.5 FTE → 9.4 weeks available, 1.0 FTE → 18.9 weeks), but the scheduler itself treats every
engineer as fully available for whole weeks regardless of FTE. Capacity reporting and the actual
Gantt schedule therefore disagree in the prototype. This is documented in `docs/DOMAIN_RULES.md`
under "Known defects in the prototype" (#1) and raised as `docs/OPEN_QUESTIONS.md` #2.

The project owner (standing in for formal client sign-off at this stage, to avoid blocking P1 on a
scheduling question that only affects P2) has directed the team to proceed with the stated default
assumption and revisit later rather than block.

## Decision

For v1, the greedy SGS scheduler and the CP-SAT model (P2-T01, P2-T06) will **not** apply FTE
scaling to engineer availability. An engineer is treated as fully available for every week they are
not already booked, regardless of their FTE value. FTE remains a stored, reportable field on
`Engineer` (used by the Capacity Planning surface's display, per `docs/PROJECT_AND_STACK.md`) but
has no effect on the booking rules in `docs/DOMAIN_RULES.md`.

This matches current prototype behaviour. It is recorded as an `INTENTIONAL` (matched-to-current)
outcome in `docs/ORACLE_DIVERGENCE.md` during P2, not a `PORT_BUG` — the port should replicate this
behaviour deliberately, not accidentally.

## Consequences

- Capacity Planning's reported FTE-scaled capacity figures will not reconcile with the scheduler's
  actual booking behaviour — this divergence must be visually clear on the Capacity surface (e.g.,
  a note that scheduling does not currently account for partial FTE), not silently presented as if
  they agree.
- If the client's real answer (once obtained) requires FTE to gate throughput, this ADR is
  superseded by a new ADR, `docs/DOMAIN_RULES.md`'s booking rules are amended, and P2's scheduler
  and golden-file tests are revised accordingly. This is scoped as a P2 remediation task if/when it
  happens, not a full re-architecture — the FTE field already exists on `Engineer`.
- `docs/OPEN_QUESTIONS.md` #2 remains open for final client confirmation; this ADR unblocks P2 in
  the meantime rather than resolving the question permanently.
