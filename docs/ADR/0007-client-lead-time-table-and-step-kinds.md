# ADR 0007: The client's per-category lead-time table replaces category multipliers; steps are design, lab or elapsed; OEM projects get their own workflow

## Status

Accepted (2026-09-27). Supersedes the "Category multipliers" section of `docs/DOMAIN_RULES.md` and
the `base_weeks` column of the workflow template. Evidence: `docs/CLIENT_FORMULAS.md` §1
(`reference/Formula-2025-26 Global RPD Project Pipeline.xlsx`, sheet `Final RPD`).

## Context

The prototype (and therefore DOMAIN_RULES.md until today) derived every step duration as
`max(1, round(base_weeks × multiplier))` with `A+ 1.0 / A 0.8 / B 0.5 / C 0.25`. Frigoglass has now
supplied the workbook their planners actually use. It contains an explicit **lead-time table**: one
integer week count per (category, step), with zeros where a category skips a step entirely (a B
project has no Feasibility Study, no Business-case approval and no CAPEX approval). No multiplier
reproduces that table — e.g. PDD-B is 8 weeks for A+, 4 for A and 0 for B/C.

The same sheet's row formulas also say which steps consume which resource. Design time sums steps
A, B, D, E, I, J, K, M; lab time sums F and H; steps C, G, L, N are in the total lead time but in
neither — they are approvals, a plant pilot and commercial launch: calendar time that no engineer or
chamber is booked for. The prototype treated F, H, J, L as chamber-booked and everything else as
engineer-booked; six of the fourteen step names also differ from the client's.

Finally the workbook has a second, OEM-specific workflow (OEM-A … OEM-N) with categories
A-OEM / B-OEM / C-OEM and its own lead times ("only for Frigoglass resources — steps are done by
OEM"). The app currently forces OEM-hub projects through the PDD template with A+/A/B/C.

## Decision

1. **Durations come from a configurable lead-time table**, seeded verbatim from the workbook:
   `duration_weeks = lead_time[workflow][category][step]`. The `max(1, …)` floor is gone: a
   0-week entry means *the step does not apply to that category* and it is recorded as `skipped`
   (no calendar time, no capacity, `start = end = predecessor end`). The table is editable by
   Super Admin on the Workflow Settings surface; every change is audit-logged and marks every
   schedulable project `schedule_stale` (a settings change never auto-solves — same rule as
   progress edits, ADR 0006).
2. **Three step kinds.** `design` books the project leader; `lab` books a chamber; `elapsed`
   books nothing but occupies calendar weeks on the project's critical path. PDD kinds:
   design = A, B, D, E, I, J, K, M; lab = F, H; elapsed = C, G, L, N. The B/C rows' design
   formulas omit A and J; we treat that as a workbook inconsistency (OPEN_QUESTIONS #13) and keep
   A and J as design for every category.
3. **Step names and codes follow the client** (`docs/CLIENT_FORMULAS.md` §1.1). Step IDs
   (`PDD-A` … `PDD-N`) are unchanged, so no historical `ScheduleRun` row is invalidated.
4. **A second workflow, `OEM`**, with steps OEM-A … OEM-N, is assigned to every project whose hub is
   OEM (`OEM-HCK`, `OEM-Seltek`). `ProjectCategory` gains `A-OEM`, `B-OEM`, `C-OEM`; OEM-hub
   projects must use one of those, non-OEM projects one of `A+/A/B/C`. The workbook gives no
   design/lab split for OEM steps; kinds are assigned by analogous name (OPEN_QUESTIONS #14):
   design = A, B, D, G, I, J, K, M; lab = E, H; elapsed = C, F, L, N. Scheduling-order category
   rank becomes `A+ → A → B → C → A-OEM → B-OEM → C-OEM`.
5. **Lab steps apply only when the project requires certification testing.** New
   `Project.certification_testing_required` (default `true`); when `false`, F and H are `skipped`
   exactly like a 0-week entry. This is how the client's own lab-load pivot works
   (`docs/CLIENT_FORMULAS.md` §2.3).
6. **Lab consumption is 1 platform-week per project-week**, not the prototype's 0.5. The client's
   lab load is the plain sum of lab lead-times and their supply is platform-weeks (ADR 0008); a 0.5
   factor would make load and capacity incomparable. `Chamber.max_concurrent` is the platform count.

## Consequences

- `docs/DOMAIN_RULES.md` "Workflow template", "Category multipliers" (now "Lead times"), booking
  rules, scheduling order and invariants I5/I6/I7 are rewritten in the same change.
- `backend/domain_constants.py` loses `CATEGORY_MULTIPLIERS`/`duration_weeks()`; the seed tables
  carry the lead times. The P2 golden files that encode multiplier-derived durations are
  regenerated from the new contract by `algorithm-engineer` and re-adjudicated by
  `workflow-auditor` — the prototype oracle was retired at P2 close and is **not** consulted.
- Every existing `ScheduleRun` was produced under the old durations. They remain readable history
  (I14) and are simply superseded by the first run after this change.
- Capacity Planning's engineer `allowed_categories` already includes `OEM`; it now also has to
  accept the three OEM categories explicitly.
- What the client must still confirm is listed in `docs/OPEN_QUESTIONS.md` #12–#15. Any answer that
  differs from the assumptions above is a data change (lead-time table, kind column), not a code
  change.
