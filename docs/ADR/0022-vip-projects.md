# ADR 0022: VIP projects — the critical 10–15 per hub per year

## Status

Accepted (2026-10-10). Part of P12. No scheduler change. VIP does not affect scheduling order.

## Context

Frigoglass asked (relayed 2026-10-10): "VIP Projects: critical projects per hub per year, top 10–15
projects, should be an additional tab on the left side."

## Decision

1. **New surface "VIP projects"** at `/vip`, in the sidebar's Plan group, directly under
   Dashboard. Read permission reuses `dashboard` (same reasoning as the Projects page). The page
   honours the global hub filter (ADR 0020).
2. **A year selector:** the plan year (weeks 1–52) and the next year (weeks 53–78 of the horizon).
   A project belongs to a year when its schedule in the active run has any step week inside that
   year's range. A pipeline project not yet in the run belongs to the plan year.
3. **The VIP list for each hub and year** holds at most `limit` projects (default 15, allowed
   10–15) and is built in this order:
   1. **Pinned projects first.** A planner can pin a project as VIP (`projects.is_vip`). Pinned
      projects are ordered by the automatic ranking below.
   2. **Then automatic fill** up to `limit`, from the remaining in-year projects, ranked by:
      - priority (P1 → P4, then Q);
      - weighted priority score (descending);
      - name.
   If more than `limit` projects are pinned for a hub, all of them are shown and the hub is
   flagged `over_limit`. A pin is never silently dropped.
4. **The pin is a project flag, not per year.** Pinning requires Registration write, hub-scoped
   (the same rule as a priority move). Audit action: `project.vip_pin` / `project.vip_unpin`. A
   pin does **not** recalculate the schedule and does not change the scheduling order. A planner
   who wants a VIP scheduled first moves its priority (ADR 0015 / 0018).
5. **Each VIP card shows:**
   - priority;
   - score;
   - projected finish against expected;
   - the within-year chip;
   - health (I13);
   - roll-up progress (I12);
   - the current stage;
   - tracking status (ADR 0021);
   - a `pinned` or `auto` marker.
   Every value is served from the active run. Nothing is computed in the browser.

## Consequences

- "Critical" has a working definition (pins plus priority/score) until the client gives their own.
  OQ #32 asks whether the list should be curated only (no automatic fill) and who may pin.
- A VIP badge also appears on that project's Gantt row and Projects card.
