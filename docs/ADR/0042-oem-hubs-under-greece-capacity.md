# ADR 0042: OEM-HCK and OEM-Seltek are capacity children of R&D-Greece

## Status

Accepted (2026-10-22). Part of P29 (P29-T01 backend, P29-T02 scheduler, P29-T03 frontend).
Amends `docs/DOMAIN_RULES.md` "Capacity supply" (ADR 0008), "Booked % and areas" (ADR 0016) and
the hubs table. Builds on ADR 0025 (OEM hubs already count as Greece for the country filter) and
the 2026-10-13 client correction (OEM lab work runs in Greece's chambers). Supersedes ADR 0035 §4
for Theoni only. Changes scheduling input (engineer pool), so the workflow-auditor gates P29.

## Context

Client ruling relayed by the owner on 2026-10-22: "both the OEM are under Greece; the total
capacity of Greece is for these three, and the load on Greece includes the OEM projects — that is
why they said the data is wrong."

Evidence in the client's own files agrees:
- `Final RPD` rows 9–16 and the old app's `For Gannt- time activity wise` sheet: OEM steps A, B,
  G and H are "R&D Resource" work; C and F are Marketing; D, E and I–N are "done by OEM".
- The formula workbook's `RPD Capacity` roster has no OEM engineers and no OEM capacity row, yet
  its pivot carries 60 (OEM-HCK) + 118 (OEM-Seitek) design weeks of OEM load.
- The old app (`production_seed.json`) kept its 24 OEM projects in hub R&D-Greece and gave
  Dimopoulou the `OEM` chip.
- Every OEM row's leader is Theoni or blank. In the app today, 17 OEM projects have no leader and
  are left out of every schedule run; the Capacity page shows OEM-HCK 10 / 44.17 wk (Theoni, a
  provisional 1.0 FTE engineer) and OEM-Seltek 0 / 0.

## Decision

1. **Capacity hub.** `hubs.capacity_hub_id` (nullable self-reference). OEM-HCK and OEM-Seltek point
   to R&D-Greece; every other hub is its own capacity hub (null). The capacity hub is the hub whose
   engineers do the design work and whose work calendar and supply count. OEM-HCK and OEM-Seltek
   remain hubs for registration, plant, filters, RBAC scoping, the Dashboard Hub × Type table and
   the country filter (ADR 0025); their own work-calendar rows are retired from the seed.
2. **Supply** (ADR 0008 formulas unchanged): design capacity is computed per capacity hub, over the
   engineers whose `hub_id` is that hub, with `counts_in_capacity = true` (point 5). Child hubs
   carry no engineers.
3. **Load** (I6 unchanged in definition): a capacity hub's design load is Σ design-kind step
   durations of every project whose hub resolves to it. Lab load is unchanged (OEM lab region is
   already Greece).
4. **Capacity surfaces** (Capacity page, Capacity Planning, Dashboard capacity cards,
   `GET /capacity/hub-load`, `GET /priorities/capacity-fill`, the engineer heatmap): rows are the
   four capacity hubs. The Greece row serves a `members` breakdown (R&D-Greece own, OEM-HCK,
   OEM-Seltek: project count and design load each) for display. `booked_pct`, status, gap and
   `completion_pct` exist for the aggregate only; no OEM row is served. Selecting an OEM hub in the
   global hub filter on a capacity surface shows the Greece row with that member highlighted.
   The P1 capacity fill (ADR 0036) walks the capacity hub's project set (own + members).
5. **Engineers.** `engineers.counts_in_capacity` boolean, default true. False for the four leaders
   who are on no client roster: Theoni, Dipak, Antonis, Sailesh (`docs/OPEN_QUESTIONS.md` #52).
   True for Elena Micu and Marian, whom the client's older app lists as PD-Romania engineers.
   Supply sums only counted engineers; the scheduler still books non-counted engineers because
   they lead projects. Theoni's `hub_id` becomes R&D-Greece (an engineer's hub is always a capacity
   hub). The Capacity Planning roster shows a "not in capacity roster" marker on non-counted rows.
6. **Eligibility.** Dimopoulou, Lioumis and Kanarios get `A-OEM`, `B-OEM`, `C-OEM` added to
   `allowed_categories`. `ProjectInput.capacity_hub` (defaulting to the hub) carries the capacity
   hub to the scheduler. Booking is unchanged: the greedy and CP-SAT walks book the project's
   assigned leader and choose no engineer. Wherever an engineer is chosen (the seed's
   provisional-leader picker, the what-if planner's leader pick and supply), candidates and supply
   are the capacity hub's engineers, and what-if supply sums only `counts_in_capacity` engineers.
   Workflow selection is unchanged: a project on an OEM hub runs the OEM workflow.
   *(Clarified 2026-10-22 after P29-T02: the scheduler has no engineer pool; a leader outside the
   project's capacity hub, e.g. Dipak on PD-India projects, is reported by the validator's
   `cross_capacity_hub_leaders` diagnostic, not rejected.)*
7. **Leaderless OEM projects.** The seed assigns each OEM project with a blank workbook leader a
   provisional leader: the eligible Greek roster engineer with the least Σ design effort of
   schedulable projects already assigned (ties alphabetical), recorded as provisional. Theoni keeps
   the projects the workbook names. The client is asked who should lead them (question list).
8. **RBAC.** Hub scoping is unchanged at row level. The Greece capacity row (aggregate figures,
   like the area figures of ADR 0016) is visible to a caller scoped to R&D-Greece, OEM-HCK or
   OEM-Seltek; the `members` breakdown shows only the members in the caller's scope.
9. **Not decided here.** Renaming OEM-Seltek to the client's spelling OEM-Seitek, and replacing
   lead-time durations with the client's per-project man-weeks, are handled by the data
   reconciliation (`docs/DATA_RECONCILIATION_2026.md`, ADR 0041).

## Consequences

- The Capacity page shows four rows. Greece's full-year design line becomes capacity 124.88 wk
  against its own load plus 60 + 118 wk of OEM load (client per-project figures: 243 wk, 195 %
  booked). With the current lead-time durations the figure differs; P29-T01 reports it after the
  reseed.
- 17 OEM projects that were left out are scheduled, so Dashboard within-year counts, the Gantt and
  the board change. This is a solver-input change: workflow-auditor must re-derive.
- R&D-India, PD-India and PD-Romania supply drops by the non-counted leaders' FTE (Dipak 1.0,
  Antonis + Sailesh 2.0); their booked % rises accordingly.
- ADR 0025 country totals are unchanged. Hub filters and the Hub × Type table keep six hubs.
