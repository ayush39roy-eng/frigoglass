# ADR 0020: One global hub filter in the header narrows every portfolio surface

## Status

Accepted (2026-10-10). Part of P12. No scheduler change.

## Context

Frigoglass asked (relayed 2026-10-10): "a dropdown for all the hubs everywhere, on the dashboard or
other areas, in fact in the main top as well, to see the stats for a particular hub".

Until now only the Gantt and the Matrix had a page-local hub select, and the Dashboard aggregates
could not be narrowed at all. Row-level hub *scoping* (RBAC, P3-T03) already exists. That is about
what a user may see. This request is about what they *choose* to look at.

## Decision

1. **One hub select in the app header:** "All hubs" plus each hub in the caller's scope. "In scope"
   means all six hubs when `/me.hub_scope_all` is true. Otherwise it means `/me.hub_ids`. An
   Engineer, who has no hub scope, sees all six as narrowing choices. The choice is kept per viewer
   in the browser (a Zustand store persisted to `localStorage`, `rpd-hub-filter`). A stored hub that
   is no longer in scope resets to "All hubs".
2. **Every portfolio surface follows it:** Dashboard, Projects, Capacity, Prioritization, Timeline,
   Priority board, VIP projects and Weekly check-in. The Gantt's page-local select is removed and
   replaced by the global one. Registration, Workspace, settings, admin and audit pages ignore it.
   A visible "Hub: <name>" chip with a clear button sits in each filtered page header, so a
   filtered number is never mistaken for the portfolio total.
3. **The server does the filtering.** Every read endpoint behind those surfaces takes an optional
   `hub_id`. It is **ANDed with the RBAC scope filter and never widens it**. A `hub_id` outside the
   caller's scope returns empty rows and zero totals, not a 403, so it does not reveal whether the
   hub has data. Totals, percentages and counts are computed server-side for the filtered set (I9,
   I19). The browser never sums rows to get a hub figure.
4. **Capacity keeps lab capacity regional.** With a hub selected, the hub rows show only that hub,
   and `areas[]` shows only the area that contains it. Region-level lab figures stay region-wide,
   because chambers are shared across a region (ADR 0008, ADR 0016).

## Consequences

- Each query key gains the hub id, so switching hubs refetches rather than reusing another hub's
  cache.
- Dashboard numbers under a hub filter must reconcile with the Capacity and Gantt numbers for the
  same hub. The workflow-auditor checks this at the gate.
