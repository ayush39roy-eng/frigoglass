# ADR 0069 — Manual recalculation mode (defer the auto-recalc while editing)

- **Status:** Accepted (2026-11-23, orchestrator, owner request: "when we edit in the project list and
  priority board at the same time, calculations run each time and things take too long; add a manual option
  to recalculate once we are done editing").
- **Amends:** ADR 0015 (priority move recalculates automatically), P35 register batch recalc, P36 band rank.

## Decision

- **Per-user switch "Auto-recalculate" (default On = today's behaviour).** Stored per user in the browser
  (no migration). When Off, every write request the UI sends carries `defer_recalc: true` (body field or
  query param, whichever fits each endpoint): register batch, PATCH /projects/{id}, priority move
  (+ preview/confirm), band-rank move, bulk moves, Workspace edits.
- **Server with `defer_recalc: true`:** saves and audits exactly as today, sets `schedule_stale` on the
  changed projects as today, but dispatches NO run; responds `recalc_status: "deferred"` (existing value).
  Priority-move previews still compute their impact preview (read-only) unless the client skips it.
- **Plan freshness (served, everyone):** `GET /schedule-runs/freshness` (or a field on an existing global
  read): `stale_project_count`, `last_run_at`, `last_run_version`, `run_in_flight`. Shown as a banner on all
  plan surfaces when `stale_project_count > 0`: "Plan not recalculated — N projects changed since <time> ·
  Recalculate now".
- **Recalculate now:** Admin / Super Admin. Dispatches ONE run the normal way (greedy, coalescing with an
  in-flight run per ADR 0023), which clears `schedule_stale` like any run. Hub Planners see the banner without
  the button.
- The weekly rollover and any non-deferred save still recalculate everything stale. Nothing is lost.
