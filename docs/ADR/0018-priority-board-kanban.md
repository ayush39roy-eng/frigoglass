# ADR 0018: Priority board — a Kanban view whose drag is a priority move

## Status

Accepted (2026-10-10). Part of P12. Builds on ADR 0015. `backend/scheduling/` is not touched.

## Context

Frigoglass asked (relayed 2026-10-10): "a drag and drop type option called Kanban chart that allows
to change the priority P1, P2 … we can change the priority from P1 to P2, likewise to others".

ADR 0015 already made a priority change recalculate the timeline automatically
(`POST /projects/{id}/priority`), with a shared move control on the Gantt row and the Workspace
header. What is missing is a board that shows all projects by priority at once and lets a planner
move one by dragging it.

## Decision

1. **New surface "Priority board"** at `/priority-board`, in the sidebar's Plan group. It has five
   columns, one per `ProjectPriority`: P1, P2, P3, P4 and Q. Each card is one schedulable or
   pipeline project in the caller's scope, filtered by the global hub filter (ADR 0020).
2. **A drop is a priority move, and nothing else.** Dropping a card on another column calls
   `POST /projects/{id}/priority`. It then follows the same flow as the move control: SSE progress,
   then the "Timeline updated" panel. No new write path exists, so RBAC, the hard-gate 409, audit,
   deferral and greedy-only all carry over unchanged from ADR 0015.
3. **Order within a column is served, not stored.** Cards are sorted by weighted priority score
   (descending), then by name. A drop does not set a rank inside the column, because the scheduler
   has no intra-band manual rank (DOMAIN_RULES "Scheduling order"). OQ #28 asks whether the client
   wants one.
4. **Read permission:** the `matrix` surface (Prioritization). This is a new layout of the same
   facts, not a new capability, the same reasoning as the Projects page reusing `dashboard`.
   **Drag permission:** the same rule as the move control: Registration write, hub-scoped. A
   project with hard gates is pinned to P1, so its card shows a lock and cannot be dragged out of P1.
5. **Keyboard and screen-reader access:** every card also carries the existing move control, so a
   drag is never the only way to move a project.
6. **Served payload:** `GET /priority-board` (contract `docs/API_CONTRACT_P12.md` §2) returns the
   columns, already grouped and sorted, with each card's projected finish, within-year flag and
   health from the active run (I9, I13). The browser does not join or compute these.

## Consequences

- Dragging many cards quickly is safe. A move while a run is in flight returns `deferred`, and the
  board says so. It does not queue a second run (ADR 0015).
- A card's column only changes once the server has accepted the move. The drop is optimistic, but
  it rolls back on any error, including the 409.
