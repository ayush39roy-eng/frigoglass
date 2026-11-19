# ADR 0064 — Change a project's rank inside its priority band from Project Registration

- **Status:** Accepted (2026-11-19, orchestrator, owner request).
- **Builds on:** ADR 0050 (band rank, P36) and the 2026-11-17 typed-rank input on the Priority board.
  No change to the scheduler, the rank rules or the endpoints' behaviour.

## Context

The owner wants the ranking to be changeable in Project Registration, the same way as on the
Priority board: the priority band (P1/P2/…) is set there, and the order inside the band follows the
rank. The rank already drives scheduling (ADR 0050 key 4), but it can only be changed on the board.

## Decision

- **R1 — Served.** The project read (`GET /projects/{id}`) and the register list rows serve
  `band_rank: int | null` and `band_size: int | null`, the number of ranked projects in that band.
  Both are read-only fields; `band_rank` is never accepted in a PATCH, create or register edit (422
  as today, `extra="forbid"`). The rank changes only through the existing ADR 0050 endpoints.
- **R2 — Projects register.** There is a "Rank" column, shown as `P1 · 3` (band and position), and
  sortable. Sorting by priority then rank gives the scheduling order. Users with the
  priority-move right see an editable rank cell, the same `BandRankInput` as the board: type a
  number and press Enter. It opens the shared priority-move preview side panel, and Confirm
  applies it and recalculates, exactly as on the board. The typed position is turned into the
  ADR 0050 relative anchor against the band's served order (`GET /priority-board`, all hubs the
  caller can see), using the board's own helper. An unranked project shows "—".
- **R3 — Registration form (edit an existing project).** Next to Priority, the form shows "Rank in
  P1: 3 of 42" with the same input and preview flow. A new project, or one whose priority is being
  changed in the unsaved form, shows "Ranked last in its band when saved" (ADR 0050 §5), and the
  input is disabled until it is saved.
- **R4 — The same rules as the board.** The same RBAC and hub scope, hard gates and 409s, P47
  `EDIT_CONFLICT` handling, and audit `project.band_rank_move`. While a preview or run is in
  progress the P49 reload hold applies.

## Consequences

- Backend: two read-only fields, a contract test, and no migration.
- Frontend: reuse `BandRankInput` and the board's anchor helper. Do not fork them.
- Gate: qa, workflow (the rank shown in the register equals the board and the scheduling order; a
  re-rank from the register gives the same run as from the board) and security (no new write path;
  `band_rank` cannot be sent in a PATCH).

## Gate amendment (2026-11-19)

- R2 as built: the typed position is sent as `{ to_rank }` through the shared `requestRankMove`, the
  same call the board has used since 2026-11-17, and the server resolves the position. The
  "relative anchor" wording above describes the older board behaviour. The result is the same.
