# ADR 0068 — Hub rank inside a priority band (shown first; global rank derived)

- **Status:** Accepted (2026-11-23, orchestrator, owner request: "Frigoglass want hub-wise rank, they are
  more focused on it… show hub-wise rank mainly in priority board, project registration and everywhere rank
  is shown; global if required; with a filter show only hub-wise; without a filter show hub-wise and the
  global on hover; global derived from the hub priority").
- **Amends:** ADR 0050 (band rank), ADR 0064 (rank on registration).

## Decision

- **One stored order, two views.** The stored `band_rank` (global order inside a band, ADR 0050) stays the
  single source the scheduler reads. No migration, no scheduling change.
- **Hub rank (served, derived):** `hub_rank` = position of the project among the projects of the SAME hub
  in the same band, in `band_rank` order (1..`hub_band_size`). Null where `band_rank` is null (P4/Q not
  ranked, Commercialized/Cancelled N/A, non-schedulable).
- **Editing is by hub rank.** Setting a project's hub rank to k moves it in the global order to just
  before the hub peer that currently holds hub rank k (k = last+1 or beyond → just after the hub's last
  peer). Other hubs' relative order is untouched; the global rank follows from the hub order ("global
  derived from hub priority"). Same preview / recalc / audit path as the existing band-rank move.
- **Display rule (everywhere a rank is shown: Priority board, Projects register / Registration, form,
  workspace, exports):**
  - Primary: hub rank, e.g. `#3` with hub context ("#3 in PD-India · P1").
  - With a hub filter active: hub rank only.
  - Without a hub filter: hub rank, plus the global rank on hover (e.g. "Global: #16 of 40 in P1, all
    hubs") — optionally a small muted "G16" marker.
  - Priority board: drag-reorder inside a column works with a hub filter (positions are hub ranks).
  - Exports: "Hub rank" column, plus "Global rank".
