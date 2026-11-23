# ADR 0067 — Priority is "Not applicable" for Commercialized and Cancelled projects

- **Status:** Accepted (2026-11-22, orchestrator, owner request: "why commercialized and cancelled
  projects coming under P4. Commercialized and cancelled should not come under any. It may be
  'not applicable'").
- **Amends:** ADR 0056 (band meaning), ADR 0063 / I59 ("Other" row in delivery by year).

## Context

The hosted data has 86 Commercialized / Cancelled projects with a stored P4 (from the original
imports), plus Commercialized rows stored as P1 (1), P3 (11), Q (2) and one Cancelled P3. Every
surface that groups by priority shows them under that band (P4 mostly).

## Decision

- **Read-time rule, no data change.** `effective priority = NULL` when `status ∈ {Commercialized,
  Cancelled}`, else the stored priority. One helper on each side:
  backend `services/priority_applicability.py::effective_priority(status, priority)` (+ a SQL
  expression for aggregations); frontend `lib/priority-applicability.ts`.
- **Display.** Such a project shows **"Not applicable"** (short: "N/A") wherever a priority pill,
  cell, select or export column appears. It never appears in any P1/P2/P3/P4/Q column, count,
  chart, filter result or band total.
- **Grouping.** Every by-priority aggregation (Dashboard, Executive view, Capacity priority split,
  priority_delivery, delivery-by-year P1/P2/P3 split, exports, What-if results) puts them in a
  "Not applicable" bucket, or in "Other" where the surface already has one (delivery by year:
  Other = counting rows with priority N/A, P4 or none; I59 still P1+P2+P3+Other = Total).
  A priority filter set to P4 no longer matches them.
- **Stored value is kept.** The stored priority is not cleared and not editable while the status is
  Commercialized / Cancelled (the control shows "Not applicable", disabled). If the status goes
  back to a schedulable one, the stored priority applies again.
- **Scheduler unchanged.** Commercialized is already frozen/delivered and Cancelled is not
  scheduled; placement does not change. Only the band the outcome is counted under changes
  (e.g. a Commercialized P1 moves from P1 to Other in delivery by year).
- Plan import / What-if import: Commercialized / Cancelled rows already map no band (ADR 0061);
  served the same way.

## Consequences

- Headline per-band numbers move (P4 shrinks by ~86 on hosted; P1/P3 delivered counts lose their
  Commercialized rows). Totals do not change.
- No migration, no rewrite of hosted rows (standing rule 2026-11-18).
