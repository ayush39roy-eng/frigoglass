# Source brief — Project Prioritisation & Dynamic Planning (RPD Portfolio)

This is the fact base for the video. Every figure is taken from `docs/DOMAIN_RULES.md`, the ADRs, or
the live demo data seen in the 2026-10-02 screen recording (`new.mov`). Demo figures are marked
*(demo)*.

## §1 The problem

- Frigoglass plans its annual R&D and Product Development portfolio in a spreadsheet. The RPD
  application replaces it.
- About 236 active projects, 6 hubs: R&D-Greece, R&D-India, PD-India, PD-Romania, OEM-HCK and
  OEM-Seltek. R&D and production hubs are in Greece, India and Romania.
- Every project runs 14 workflow steps. The planning horizon is 78 weeks. Within-year cut-off is
  week 52. The current planning week is W31.
- The question leadership asks is: which projects will finish inside the calendar year? The answer
  depends on capacity, not just on priority. That is what the spreadsheet could not answer.

## §2 Prioritisation scoring — 13 dimensions, 5 pillars

| Pillar | Dimensions | Weight each |
|---|---|---|
| Strategic Alignment | Strategic Project, New Customer, New Options | 25 |
| Regulatory & Quality | Regulatory Compliance, Quality Improvements | 25 |
| Financial Return | RM Savings, Total RM Savings, Gross Margins, Profitability | 25 |
| Market & Volume | Annual Volume, 3-Year Volume, New Models | 15 |
| Investment & Feasibility | CAPEX Investment (inverted: lower CAPEX scores higher) | 10 |

- Each dimension is scored 1–5 against a written rubric. 1 = Negligible / N/A, 2 = Weak case,
  3 = Moderate / Average, 4 = Strong case, 5 = Exceptional / Must-do.
- Example anchors: Regulatory Compliance 1 = None, 5 = Mandatory < 6 months. Gross Margins 1 = < 1%,
  5 = > 15%. CAPEX 1 = > €500K, 5 = < €10K.
- Total weight = 280. Weighted score = Σ(score × weight). Maximum = 280 × 5 = 1,400.
- Normalised % = round(weighted / 1,400 × 100).

## §3 Bands and hard gates

- Bands: ≥ 70% → P1. ≥ 55% → P2. ≥ 40% → P3. Below that → P4. Unscored or queued work → Q.
- Hard gates override the band and force P1:
  1. Regulatory deadline within 6 months
  2. Customer certification at risk (Coke / Pepsi)
  3. Active safety non-compliance
- *(demo)* FV-500 V2 F-1 refresh: weighted 755 → 54% → computed P3. Its committed priority is
  P2.
- *(demo)* 2026 Energy Target — Coke protocol S-800: weighted 965 → 69%, which is just under P1.
  A hard gate applies, so it is forced to P1.
- *(demo)* 46 projects scored, 0 unscored, 3 forced to P1 by hard gates.
- The computed band and the committed priority are separate. Editing a score changes only the
  computed band. Applying priorities portfolio-wide is a separate, versioned action.
- Scenario mode allows what-if score edits. Version history keeps every applied version.
- Display currency can be EUR, USD or INR, converted on the server. Base is EUR, with USD 1.08 and
  INR 97, configurable.

## §4 Scheduling order (who gets capacity first)

The scheduler sorts all projects by:

1. Frozen projects first (dates locked)
2. Priority: P1 → P2 → P3 → P4 → Q
3. Status: In Buyoff → Under Industrialization → In Development → In Queue
4. Category: A+ → A → B → C → A-OEM → B-OEM → C-OEM

- Excluded from scheduling: Commercialized, On Hold, Cancelled, Draft.

## §5 Booking — durations, step kinds, resources

- Durations come from the client's own lead-time table (workbook "Final RPD" sheet). There is no
  multiplier.
- Total weeks by category: PDD A+ 44, A 38, B 18, C 8. OEM A-OEM 21, B-OEM 14, C-OEM 4.
- A step with 0 weeks is skipped. It uses no time and no capacity.
- There are three step kinds:
  - **Design**: books the project leader (an engineer) for every week of the step.
  - **Lab**: books a test chamber in the project's lab region. The chamber must allow that step,
    and its concurrent projects must stay below max concurrent.
  - **Elapsed**: books nothing but takes calendar time, for example Business Case Approval, CAPEX
    Approval, Pilot or Commercialization.
- Precedence: each step waits for its predecessors. The default is a strict chain A → N. A Super
  Admin can configure parallel steps. Two design steps never overlap because both book the same
  leader.
- The scheduler walks forward week by week to the earliest window where the resource is free. If
  there is no window inside 78 weeks, the project is LEFT OUT.
- Lab regions: Greece (R&D-Greece), Romania (PD-Romania), and India (R&D-India, PD-India, OEM-HCK,
  OEM-Seltek).

## §6 Outcomes

- **Within year**: not left out, and last step end + delay ≤ week 52.
- **Spillover**: scheduled, but finishes after week 52.
- **Left out**: no feasible window in the 78-week horizon.
- **Blocked**: held at a Blocked stage until it clears.
- *(demo)* 45 scheduled: 11 within year (24%), 24 spillover (53%), 10 left out (22%), 0 blocked.
- *(demo)* Delivery by priority: P1 80% (4 of 5), P2 43% (3 of 7), P3 50% (4 of 8), P4 0% (0 of
  10), Q 0% (0 of 16).
- *(demo)* Capacity: design load 398 / 535.16 engineer-weeks (74%). Lab load 141 / 373.66
  chamber-weeks (38%).
- Capacity supply follows the client's formula: working weeks per engineer = 52 − leave and
  holidays. Yearly design capacity = working weeks × Σ FTE. Chamber capacity = working weeks ×
  efficiency × platforms.
- Expected vs projected: *expected* is the target or the unconstrained finish (unlimited
  resources). *Projected* is what the capacity-constrained run says. Slip = projected − expected.

## §7 Dynamic planning — progress, staleness, recalculation

- Each of the 14 stages records status (Not Started / In Progress / Blocked / Done), % complete,
  actual start and end weeks, an optional remaining-weeks override, and a blocked reason.
- Remaining = ceil(duration × (1 − % complete)), unless overridden.
- On the next run:
  - **Done** stages are fixed history and are never moved.
  - **In Progress** stages keep their actual start and only the remaining tail is scheduled.
  - **Blocked** stages hold the project, and their successors, until the block clears.
  - **Not Started** stages are scheduled normally.
- Capacity is only counted from the current week forward.
- A progress edit never re-solves on its own. It marks the project *schedule stale*. A planner
  clicks "Recalculate schedule", which creates a new, immutable schedule run version. Old versions
  are never changed, so "what did the plan look like before?" can always be answered.
- Lead-time or precedence edits by a Super Admin also mark every project stale. They are
  audit-logged and never auto-solve.
- The health badge is derived, never typed in: Left Out, Blocked, Off Track (projected finish after
  week 52), At Risk (a stage overrunning), or On Track.
- Project progress % is weighted by stage duration, not a simple average of 14 numbers.
- Every change (scores, progress, roles, agent questions) goes into an append-only audit log.
- Same inputs always give the same schedule (determinism). The run is reproducible.

## §8 The loop

Score → band → apply priorities → schedule against capacity → outcomes → track progress → stale →
recalculate → new version. Repeat every planning cycle.
