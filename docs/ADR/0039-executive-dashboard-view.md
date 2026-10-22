# ADR 0039 — Executive ("helicopter") view on the Dashboard

Date: 2026-10-22. Status: Accepted. Phase: P28.

## Context

The client proposed (Teams, 2026-10-22) a three-level dashboard structure — Level 1 "Executive
View (Helicopter)" (Executive Summary, Portfolio Health, Business Impact, Risks & Escalations,
Strategic Roadmap), Level 2 Management, Level 3 Detailed Engineering — and sent an ASCII mock-up
of the helicopter level (KPI summary; portfolio %; roadmap quarters; executive alerts; testing &
validation; resource utilization per team) plus a Power BI "Quality Dashboard" as a visual
reference (KPI tiles on top, compact pie/donut charts below). The owner asked for a single
compact one-page Executive view on the Dashboard for CEO / CMO / top management, with pie charts
for the project pipeline and the status overview.

## Decision

1. **Frontend-only recomposition.** The Executive view is a second presentation of the Dashboard
   surface built entirely from fields the backend already serves. No new endpoint, no browser
   arithmetic beyond what the detailed Dashboard already does (I9/I19): counts and `*_share_pct`
   fields are shown verbatim; the only client-side proportion is the one the existing
   `DeliveryGaugeCard` already computes from served counts.
2. **Entry.** A segmented toggle in the Dashboard header: **Executive | Detailed**, reflected in
   the URL as `/?view=executive`, persisted per user (`localStorage` key `rpd-dashboard-view`).
   Precedence: URL param → stored choice → role default. **Role default:** a caller whose served
   roles are exactly `["Executive Viewer"]` lands on Executive; everyone else lands on Detailed.
   The global hub and country filters apply to both views unchanged (ADR 0020/0025).
3. **Composition (one compact page, in order):**
   - **Executive summary** — KPI tile strip from `GET /dashboard/completing-within-year` (+
     pipeline total and VIP count): scheduled, completing within year, spillover, left out,
     blocked, VIP.
   - **Portfolio health** — compact donut charts of the served figures: *Project pipeline*
     (`spillover / new / unregistered` + served shares) and *Status overview* (the five card
     statuses + "other", served counts and shares), plus the delivery gauge.
   - **Delivery by priority** — compact stacked bars from the served `priority_delivery` bands.
   - **Risks & escalations** — a served-rows list, no new judgement: blocked projects (run
     outcome `blocked`), overdue check-ins (`tracking_status = 'overdue'` on
     `GET /dashboard/projects` rows), and VIP projects not completing within year. Capped list,
     each row linking to the project.
   - **Hubs at a glance** — per-hub design booked % and per-region lab booked % from
     `GET /capacity/hub-load`, status-tinted, figures verbatim.
4. **`/capacity/hub-load` on the Dashboard.** P23-T03 removed the Dashboard's hub-load request.
   That holds for the **Detailed** view; the **Executive** view fetches it lazily (only while
   that view is shown). The P23-T03 test is narrowed accordingly — this is an owner-sanctioned
   supersession, not a regression.
5. **Mock-up items with no served data are NOT invented.** CAPEX utilization, product roadmap
   quarters, executive alerts as a curated list, testing success rate / field-trial counts, and
   hiring status appear in the client's mock-up but have no source in the system. They are
   omitted and asked as OQ #63. The client's Levels 2 and 3 are today's Dashboard/Capacity/
   Matrix/Gantt surfaces; no separate build.

## Consequences

- The Executive view inherits hub scoping, so a hub-scoped executive sees scoped figures.
- Charts stay Recharts, lazy-loaded like the detailed view's panels; dark mode via tokens; axe
  clean; reduced motion respected.
- If the client later supplies CAPEX / roadmap / alerts data (OQ #63), those become new served
  fields first, then tiles here.
