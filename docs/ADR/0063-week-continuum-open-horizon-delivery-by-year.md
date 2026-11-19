# ADR 0063 — One week line across years, P1–P3 scheduled to completion, delivery by year

**Date:** 2026-11-19 · **Status:** Accepted with amendments (workflow-auditor ruling R53-1..R53-9, invariants I57–I63; full text in `docs/MEMORY.md` "[2026-11-19] R53 — workflow-auditor ruling" and its addendum) · **Supersedes:** P37-F01 (opening 2027 by re-basing) · **Amends:** ADR 0024/0062 (display), 0052 (plan clock), 0056 (queued P3), 0061 (plan window bounds)

## Context

Owner, 2026-11-19: "Scheduling should be for P1, P2 and P3, whatever the timeline is coming, even if it
is going till 2029. But we should be able to tell what we can deliver by 2027, or 2028 and so on."
And: "Don't make a hard cap of 2030; they will keep using it after 2030 also, so it should be
generic." Standing rule: never lose or overwrite client data. From 4 Jan 2027 the app would freeze
(plan year closed). Measurement: horizon length does not change greedy / Monte Carlo / import run time;
CP-SAT model size is horizon-independent.

## Decision

1. **Week continuum (R53-1).** Weeks are absolute from 2026 W1 forever (2027 W1 = 53, 2028 W1 = 105).
   CURRENT_WEEK is the absolute ISO week (Europe/Athens; ISO W53 folds into the year's W52); the plan
   year is the year of that week. No stored row is re-based. The closed-year state, `PLAN_YEAR_CLOSED`
   and `RPD_PLAN_YEAR` are retired; 2027 opens by itself. Weekly rollover (P37-T05) is built here.
2. **P1–P3 to completion (R53-2).** Queued P3 now counts toward its year (amends ADR 0056); band order
   unchanged, so P3 never delays P1/P2. Search limit = current week + N×52, N an Admin setting 1–10,
   default 5, stored per run — never a fixed year. Unplaced at the limit → LEFT_OUT "Cannot be
   scheduled within N years — check resources". A Commercialized project counts only in the year of its
   actual end (no end → 2026).
3. **Delivered by year (R53-3).** One server function: by end of plan year (= Dashboard within-year),
   then each later year from the data, then "not placed within N years"; P1/P2/P3, total, cumulative;
   years after plan year + 1 marked indicative.
4. **Plan import (R53-4)** bounds generalised to the same search limit; year presets from data.
5. **CP-SAT (R53-5)** keeps its window (plan-year end + 26) and is followed by a greedy tail to the
   search limit; Monte Carlo uses the search limit.
6. **Display (R53-6):** generic week labels from a served base year; Timeline axis to the run's last
   finish week under a data-driven year row.
7. **Data (R53-7):** one additive migration `p53a` (N setting, `rules_epoch`, `priority_at_run`, two
   relaxed CHECKs) with a no-UPDATE/DELETE checksum test; old runs read as history ("computed under the
   earlier rules"); one new greedy run on deploy, which adds a run and overwrites nothing.
8. **Warnings (R53-9):** `far_finish` and `leader_overloaded`, display only, never a scheduler input;
   leader names only where engineer utilisation is already shown (OQ #8).

## Invariants

I57–I63 (one week line, open horizon, delivery table = Dashboard, CP-SAT + greedy tail, delivered
year, stored runs are history, warnings never change placement); I39–I41, I50–I53, I56 amended.
