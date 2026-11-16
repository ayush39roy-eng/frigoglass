# ADR 0056 — What each priority band means for scheduling

- **Status:** Accepted with amendments (2026-11-17, P42-T01 ruling R42-1..R42-12, see the end).
  workflow-auditor's ruling at P42-T01. The ruling overrides this text where they differ.
- **Amends:** DOMAIN_RULES "Scheduling order" (key 3) and "Booking rules" (the excluded set), and the
  within-year KPIs. It also affects I25 (remaining demand) and the I37b membership in ADR 0050.
- **Phase:** P42.

## Context

Owner, 2026-11-17: "we have different priority: P1 — must do in this year, P2 — good to have in
this year, P3 — in queue, P4 — miscellaneous. P1 and P2 in scheduling, P3 (in queue) remains in
queue, P4 no scheduling."

The owner answered three questions the same day:

1. **Started P3 projects keep scheduling.** These are P3 projects In Buyoff, Under
   Industrialization or In Development. On the dev data that is all 116 P3 projects.
2. **"P3 remains in queue" means scheduled only with spare capacity.** A P3 project still
   `In Queue` is planned after all P1/P2 work with whatever capacity is left. It **never counts
   toward this year's target**.
3. **P1 and P2 differ by label only.** Scheduling is unchanged: P1 is planned first, then P2.

Today every band P1–P4 and `Q` is scheduled. Only the status decides exclusion: Commercialized,
On Hold, Cancelled and Draft are left out.

Dev data, 2026-11-17:

| Priority | Statuses that schedule today |
|---|---|
| P1 | 26 |
| P2 | 7 |
| P3 | 116: 85 In Development, 31 Under Industrialization, 0 In Queue |
| P4 | 72, all In Queue |
| Q | 0 rows |

## Decision (proposed)

**D1 — Band labels.** The band labels are served and shown wherever a priority is shown: the
board column header, the priority pill tooltip and the priority select.

| Band | Label |
|---|---|
| P1 | Must do this year |
| P2 | Good to have this year |
| P3 | In queue |
| P4 | Miscellaneous |

The codes stay P1–P4. The score bands (≥70 / ≥55 / ≥40) and the P1 capacity fill are unchanged.

**D2 — P4 (and Q) is never scheduled.**
- A project whose priority is P4 or `Q` is excluded from scheduling, exactly like an excluded
  status: no rows, no capacity, and not in remaining demand (I25).
- Its result is a new reason, `not_scheduled_priority`, rather than `LEFT_OUT`, and it does not
  count as within year.
- This applies to greedy, CP-SAT (`prepare_run`), What-if, scenarios and plan import.
- VIP does not override it.
- *Open for the ruling:* does a **frozen** P4 project, with dates locked and work in progress,
  still book its capacity? Proposed: no. The owner said P4 is not scheduled, and a planner who
  wants it planned moves it to P3 or higher.
- `Q` has no rows. It is treated as P4.

**D3 — P3 "queued" counts nothing toward the year.**
- P3 in a started status (In Buyoff, Under Industrialization, In Development) is unchanged.
- P3 in `In Queue` is still scheduled. Serial order already places it after every P1/P2 project,
  so this is the "spare capacity" behaviour.
- Its result is flagged `queued` (`counts_toward_year = false`). Every within-year count, % and
  target leaves it out, and the surfaces show it as "Queued — fits by W.." instead of
  within-year or spillover.
- *Open for the ruling:* should CP-SAT's objective weight these projects at zero, so they cannot
  push a P1/P2 project later?

**D4 — Band rank (ADR 0050).**
- P4 projects keep their `band_rank`, so the board keeps an order a planner can promote from.
  The I37b membership ("ranked iff schedulable status with a priority") is unchanged.
- The scheduler ignores P4 ranks, because those projects are not scheduled. No migration.

**D5 — Priority moves.**
- **Into P4:** the preview and confirm work as today. The preview shows the project leaving the
  plan.
- **Out of P4:** the project enters the plan last in its new band.
- The moves recalculate as today (ADR 0015 / 0026).

**D6 — Rollout.** No schema change is expected. After deploy the existing `schedule_stale` path
triggers one greedy recalculation. On the dev data the 72 P4 projects leave the plan and free
their engineers and chambers, so P1–P3 dates may move earlier. This is intended, not a regression.

## Consequences

- The within-year KPIs now count only P1, P2 and started P3 work. Dashboard and Executive numbers
  change on the day of the rollout.
- Remaining demand drops by the P4 projects' load.
- What-if: an override to P4 removes the project from the scenario.

## Ruling (P42-T01)

The workflow-auditor's verdict on 2026-11-17 is **ACCEPT WITH AMENDMENTS**. The full text is in `docs/MEMORY.md`,
"[2026-11-17] P42-T01 — workflow-auditor ruling on ADR 0056", R42-1..R42-12. Where this ADR differs from the
ruling, the ruling wins. The main differences:

- **Frozen P4 (R42-2).** A frozen P4 or Q project books its locked capacity but counts nothing toward the year.
  This reverses the D2 proposal and is the new assumption for OQ #107.
- **"Spare capacity only" (R42-5).**
  - It needs a new sort key 1a, `counts_toward_year` descending, placed between frozen and VIP.
  - In CP-SAT, queued projects are placed after the solve, on the capacity left over. They are not weighted at
    zero.
- **Schema (R42-10).** A schema change is needed: `p42a` adds the outcome columns `counts_toward_year` and
  `not_scheduled_priority`.
- **D6 on dev data (R42-10).** P1–P3 dates do not move because of P4 leaving: P4 was already last in the
  scheduling order.
- **New invariants (R42-9).** I49–I53.
