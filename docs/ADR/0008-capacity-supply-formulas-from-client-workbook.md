# ADR 0008: Capacity supply is computed with the client's working-calendar and chamber-downtime formulas

## Status

Accepted (2026-09-27). Partially supersedes ADR 0003 (chamber `efficiency` and `weeks_per_chamber`
were reporting-only display fields; `weeks_per_chamber` is retired and `efficiency`/platforms now
feed a defined supply formula). Does **not** change ADR 0002 — FTE still does not gate week-level
booking in the scheduler. Evidence: `docs/CLIENT_FORMULAS.md` §2.

## Context

The RPD Capacity surface has shown a supply figure of `Σ fte × remaining_weeks` for engineers and
`Σ max_concurrent × remaining_weeks × efficiency` for chambers — P3-T07's own documented judgement
call, because DOMAIN_RULES.md defined only the load side (I6/I7). The client workbook now defines
supply exactly, per hub and per chamber, and it is the number their management already reads.

## Decision

Per hub, a **work calendar** (`weekdays_per_week`, and days per year of national holidays, medical
leave, casual leave, annual leave) gives

```
working_weeks_per_engineer = 52 − Σ(days / weekdays_per_week)
yearly_design_capacity     = working_weeks_per_engineer × Σ engineer.fte          (hub)
remaining_fraction         = (52 − CURRENT_WEEK) / 52
remaining_design_capacity  = ((52 − CURRENT_WEEK) − Σ(deduction_weeks) × remaining_fraction) × Σ fte
```

Per chamber, **downtime** fields (`maintenance_weeks`, `breakdown_weeks`, `calibration_weeks`) plus
the region's holiday weeks give

```
working_weeks_per_chamber  = 52 − holiday_weeks − maintenance − breakdown − calibration
efficient_lab_weeks        = working_weeks_per_chamber × efficiency × platforms
yearly_lab_capacity        = Σ efficient_lab_weeks                                 (lab region)
remaining_lab_capacity     = yearly_lab_capacity × remaining_fraction
```

Load stays what I6/I7 say (sums over the active `ScheduleRun`), now in the client's units: design
load = Σ design-kind durations, lab load = Σ lab-kind durations (× 1.0, ADR 0007). The surface shows
`gap = load − capacity` and `completion_pct = capacity / load` exactly as the workbook does, for both
the full year and the remaining year.

Normalisations of the workbook's internal inconsistencies (`docs/CLIENT_FORMULAS.md` §2.4), all
raised in `docs/OPEN_QUESTIONS.md` #16:
- one `CURRENT_WEEK` for every hub, and each hub uses its **own** remaining fraction;
- every deduction in a hub divides by that hub's `weekdays_per_week` (no 5-vs-6 mixing);
- lab load always sums lab weeks (never design weeks).

Seed values are the workbook's (India 6 weekdays, 13/7/7/20 days; Greece 5, 12/0/0/25; Romania 5,
13/7/0/20; chamber platforms/efficiency/breakdown per chamber).

## Consequences

- New `HubWorkCalendar` table (one row per hub) and three downtime columns on `Chamber`;
  `Chamber.weeks_per_chamber` dropped. Both editable on Capacity Planning (Hub Planner, own hub)
  and Workflow Settings (Super Admin), audit-logged.
- The capacity API returns the intermediate figures (working weeks per engineer, per-chamber
  efficient weeks) so the surface can show the client the same breakdown their sheet does, and so
  `workflow-auditor` can reconcile to two decimals (new invariant I17).
- Scheduling is unchanged: an engineer is still bookable for whole weeks regardless of FTE
  (ADR 0002), and a chamber's booking gate is still `max_concurrent` = platforms. If the client
  later asks for FTE or downtime to gate booking, that is a new ADR against ADR 0002.
