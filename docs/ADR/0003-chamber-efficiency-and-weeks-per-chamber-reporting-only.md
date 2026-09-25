# ADR 0003: Chamber `efficiency` and `weeks_per_chamber` are reporting-only in v1

## Status

Accepted (provisional — proceeding without formal client sign-off; revisit before P2 closes if the
client's answer to `docs/OPEN_QUESTIONS.md` #3 differs)

## Context

The prototype has a known defect: chamber fields `efficiency` and `weeks_per_chamber` are surfaced
in Capacity Planning's display but do not constrain lab-step booking — only `max` concurrent
projects gates booking (`docs/DOMAIN_RULES.md`, "Known defects in the prototype" #2;
`docs/OPEN_QUESTIONS.md` #3).

The project owner has directed the team to proceed with the stated default assumption (reporting-
only) and revisit later rather than block P1/P2 on this question.

## Decision

For v1, the booking rule for lab steps (`docs/DOMAIN_RULES.md` — Booking rules) uses only
`chamber.max` (concurrent project count) as the capacity constraint, with `0.5` consumption per
project-week. `efficiency` and `weeks_per_chamber` remain stored, reportable fields on `Chamber`
(used by Capacity Planning's display) but do not enter the CP-SAT or greedy scheduler's constraint
model.

This matches current prototype behaviour and is recorded as `INTENTIONAL` (matched-to-current) in
`docs/ORACLE_DIVERGENCE.md` during P2.

## Consequences

- Capacity Planning's `efficiency`/`weeks_per_chamber` figures are descriptive only; they must not
  be presented in the UI as if they already factor into the schedule.
- If the client's real answer requires these fields to constrain booking, this ADR is superseded,
  the booking rule in `docs/DOMAIN_RULES.md` is amended to incorporate an effective-capacity
  calculation from `efficiency`/`weeks_per_chamber`, and P2-T06's `AddCumulative` constraint is
  revised to use the derived effective capacity instead of raw `max`.
- `docs/OPEN_QUESTIONS.md` #3 remains open for final client confirmation.
