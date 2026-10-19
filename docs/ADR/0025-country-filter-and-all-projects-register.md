# ADR 0025: Country filter (All Hubs / Greece / India / Romania) and an all-projects register on the Dashboard

## Status

Accepted (2026-10-18). Part of P13. No scheduler change.

## Context

On 2026-10-18 Frigoglass shared their own earlier web app and the mock-up deck
(`RPD Web Application mock-up-Frigoglass -15-09.pptx`). They asked, relayed by the owner:

- "in the main dashboard … there are India, Romania and Greece options and All Hubs, so we also
  want like that";
- "on dashboard add a place that displays all the projects".

The mock-up's Dashboard header has four buttons: **All Hubs · Greece · India · Romania**. Its KPI
cards carry a chip per country with count and share. Its counts confirm the grouping is by the
hub's served `lab_region`, with the OEM hubs counted in Greece (client correction 2026-10-13):
Greece 30 = R&D-Greece 6 + OEM-HCK 12 + OEM-Seltek 9 + OEM-SEITEK 3; India 182 = PD-India 180 +
R&D-India 2; Romania 24.

The mock-up also has an "All active registered projects" table near the bottom of the Dashboard. It
has a country summary chip per country (Comm. / Ind. / Dev. / Que), a search box, filters (hub,
department, category, type, status, engineer, plant, step), and the columns #, Hub, Cat, Type,
Status, Project name, Plant, Req. dept, Leader, End date, Current step, Priority and Actions.

Our P12 global hub filter (ADR 0020) narrows by one hub only.

## Decision

1. **A second filter level: country.** The global filter state becomes `{ region, hubId }`, where
   `region ∈ {Greece, India, Romania} | null`. "Country" means the hub's `lab_region` served by
   `GET /hubs`. Choosing a country clears the hub. Choosing a hub clears the country. "All Hubs"
   clears both.
2. **The server filters.** Every endpoint that takes the ADR 0020 `hub_id` also takes
   `region: LabRegion`. The predicate is: RBAC scope AND (`hub_id` if given) AND (project's hub is
   in `region` if given). It never widens scope (I23 extended to region). Totals, shares and counts
   stay server-side (I9, I19).
3. **Controls.**
   - The Dashboard header shows the mock-up's segmented buttons: All Hubs / Greece / India /
     Romania.
   - The app-header select lists "All hubs", then the three countries, then the hubs.
   - Every filtered page shows a chip, for example "Country: India" or "Hub: PD-India", with a
     clear button.
4. **Country chips on the KPI cards.** A new `GET /dashboard/region-summary` returns per-country
   counts by status and by pipeline composition (spillover / newly registered), with server-side
   shares. The Dashboard renders these as the mock-up's chips under the pipeline and status cards.
   The browser never sums rows to make a country figure.
5. **All-projects register.** The Dashboard gains a full-width "All registered projects" section,
   reachable from a header button. It upgrades the existing `ProjectBreakdown` to the mock-up's
   table.
   - **Filters, all server-side:** search, hub, category, type, status, leader, current step.
   - **Columns:** #, Hub, Cat, Type, Status, Project, Leader, End week (active run), Current step,
     Priority, and Actions (Open; Edit only where Registration write is permitted).
   - **Plant and Requesting department** are not modelled (see OQ #34). They are shown only once
     the data exists. They are never invented.
   - **Delete** is not offered from the Dashboard. Deletion stays where it is governed today.

## Consequences

- Query keys gain `region` beside `hubId`.
- One shared hook `useHubFilterParams()` returns `{ hub_id?, region? }`, so surfaces stop building
  the parameter themselves.
- Lab capacity stays regional (ADR 0020 §4). With a country selected, the hub rows show that
  country's hubs and `areas[]` shows the containing area (Greece/Romania → Europe, India → India).
