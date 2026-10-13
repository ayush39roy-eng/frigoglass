# ADR 0024 — Real 2026 pipeline data, current week 42, 52-week display horizon

**Date:** 2026-10-13 · **Status:** Accepted · **Source:** client request via project owner

## Context

Frigoglass wants the demo video to show their real portfolio instead of the prototype's
46 synthetic projects. They supplied `24-25-26 Global RPD Project Pipeline.xlsx` and asked for
the following:

- show the 2026 projects only, about 250 of them;
- the current week is 42;
- they had seen a "72/78-week" horizon somewhere; they want a 52-week year only, with anything
  not done by W52 shown as spillover;
- about half of the portfolio completes within the year (within-year share around 51%, up from
  the 24% they saw);
- capacity booked at about 60% for R&D-India and about 100% for every other hub.

## Decision

1. **Dataset.** The default seed is the 253 rows of sheet `2024-25-26 Projects` whose
   `Project Request` date is in 2026.
   - It is extracted by `backend/seed/extract_client_2026.py` into
     `backend/seed/client_2026_seed_data.json`. The workbook itself is not committed.
   - The prototype dataset can still be selected for the tests and e2e that depend on it.
2. **Inputs the Excel lacks are derived deterministically and documented** in the extractor:
   - engineers come from the Excel's project leaders, plus named capacity engineers where needed;
   - per-step progress comes from Project Status and Development Step;
   - priority bands come from Marketing Priority;
   - prioritization dimensions are derived as well.
   The demo targets are met by tuning these seed inputs. No formula is changed. Every figure is
   what the scheduler and the capacity formulas compute from the seeded inputs.
3. **`CURRENT_WEEK = 42`.** The default is 42 and `RPD_CURRENT_WEEK` overrides it. Both test
   suites pin it to 31, so the golden files and existing tests stay valid.
4. **52-week display horizon.**
   - Every surface shows only W1–W52. Gantt bars are clipped at W52 with a spillover marker.
   - User-entered week inputs are bounded to 1–52.
   - `HORIZON_WEEKS = 78` stays as the scheduler's internal search limit, so spillover and
     `LEFT_OUT` are still told apart.
   - A `LEFT_OUT` project is presented as spillover past W52.

5. **OEM hubs are Europe.** OEM-HCK and OEM-Seltek now have lab region Greece. OEM lab steps
   book Greece chambers and count in the Europe area. Migration `p13a_oem_lab_region` corrects
   existing databases. The OEM hubs keep India's work calendar for now.

## Consequences

- The demo figures are real scheduler output for real projects, but they depend on derived
  inputs: engineer FTE and step progress. These must be replaced by the client's actual roster
  and the weekly check-ins once the app is live.
- The seed's engineers and FTE are tuned for the demo:
  - each Excel leader leads at most 4 open projects, and the rest go to named capacity engineers;
  - the chamber efficiencies are scaled to land the booked % targets;
  - a blank certification flag is treated as false.
  All of this is demo-only, and the real roster replaces it.
- 34 projects can't be placed by W78 and are shown as spillover. Most of them are India certification work on 3 platforms.
- `CURRENT_WEEK` is still one global value. Moving it to a value derived from the calendar is a
  future decision.
