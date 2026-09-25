# ADR 0001: Record architecture decisions with ADRs

## Status

Accepted

## Context

This project uses a multi-agent development workflow where the orchestrator delegates to
specialist subagents across seven phases (P0–P7). Decisions that override the locked tech stack
(`docs/PROJECT_AND_STACK.md` §2), decisions that intentionally diverge from the prototype's
observed behaviour (`docs/DOMAIN_RULES.md` "Known defects in the prototype"), and other
architecturally significant choices need a durable, dated record — separate from
`docs/MEMORY.md`, which is a chronological task log, not a decision register.

## Decision

We will use Architecture Decision Records (ADRs), one file per decision, numbered sequentially
(`docs/ADR/NNNN-title-in-kebab-case.md`), each containing at minimum: Status, Context, Decision,
Consequences.

An ADR is required, not optional, in these cases:

- Any substitution or addition to the locked tech stack in `docs/PROJECT_AND_STACK.md`.
- Any intentional divergence from the prototype's behaviour on one of the three known defects
  (FTE application, chamber efficiency/weeks_per_chamber enforcement, delay propagation) —
  see `docs/DOMAIN_RULES.md`.
- Any resolution of an item in `docs/OPEN_QUESTIONS.md` that changes a scheduling rule, invariant,
  or data model assumption.
- Any P2 divergence between our scheduler and the prototype oracle classified as `INTENTIONAL`
  in `docs/ORACLE_DIVERGENCE.md` (see P2-T03 in `docs/IMPLEMENTATION_PLAN.md`).

The `rpd-orchestrator` agent owns `docs/ADR/`. Specialist agents propose decisions; the
orchestrator records them.

## Consequences

- Every architecturally significant or domain-behaviour-significant choice has a traceable,
  reviewable record independent of chat history.
- `docs/MEMORY.md` entries that reference a decision link to the relevant ADR by filename rather
  than re-explaining the rationale inline.
- Future agents and human reviewers can answer "why does it work this way" without archaeology
  through commit history.
