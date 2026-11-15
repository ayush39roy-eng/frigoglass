# ADR 0050: Rank within a priority band

## Status

**Accepted with changes (2026-11-15, P36-T01).** The workflow-auditor's ruling R36-1..R36-10
(MEMORY "[2026-11-15] P36-T01") overrides §1–§7 where they differ. In particular: the backfill is
schedule-identical for every project, VIP and frozen included (R36-1); once ranked, status and
category no longer reorder a band (R36-3, OQ #86); the write takes exactly one of
`before_project_id` / `after_project_id` (both null = last) (R36-8); `confirm_priority_move`, the
preview input and the What-if override all go through one shared rank function (R36-5/6); a plan
import merge row that replaces a project in the same band keeps that project's rank (R36-7, OQ #87);
I30 becomes "equal on keys 1–5" in the same change as the new key, and I37 splits into a–d (R36-9);
CP-SAT honours the key through `prepare_run` only, its objective is unchanged (R36-4).
Originally: Proposed (2026-11-15, P36). Amends
DOMAIN_RULES "Scheduling order" (new key after priority) and the Priority board's card order
(ADR 0018, API_CONTRACT_P12 §2). Adds invariant I37.

## Context

Owner request 2026-11-15 (screenshot of the Priority board): the board moves a project between
priority columns, but there is no way to order projects *inside* a column — "in P1 only one of the
projects moves to 2nd position so it's the 2nd highest priority now in P1". Owner answers the same day:

- the position **drives scheduling** (not display only, not a tie-break);
- a re-rank goes through the **same preview popup and recalculation as a priority move** (ADR 0026);
- the board-wide filters (search, category, type, status, leader, hub/country) are enough; no
  per-column filter. Re-ranking must work while the board is filtered.

Today inside a band the scheduler orders by status, then category rank, then `project_id`, and the
board sorts cards by weighted score. Neither is something a planner can set.

## Decision

1. **Storage.** `projects.band_rank` — nullable integer ≥ 1, the project's position inside its
   committed `priority` band. Ranks are dense (1..n) among the ranked projects of a band after every
   write. `NULL` = unranked.
2. **Backfill (migration).** For each band, every schedulable project with that priority gets
   `band_rank` = its position when the band is sorted by status ordinal (a frozen copy of
   `SCHEDULABLE_STATUS_ORDER`), live `categories.rank`, then `project_id`; a member with no category
   goes last by id (count logged). The first run after the migration gives the same schedule for
   every project, VIP and frozen included (R36-1, verified by the auditor). Non-members (Draft,
   On Hold, Cancelled, Commercialized, `priority = NULL`) stay `NULL`.
3. **Scheduling order.** New key between priority and status:
   1. `frozen` desc  2. `is_vip` desc  3. priority  **4. `band_rank` asc, NULL last**  5. status
   6. category rank  7. `project_id`.
   VIP and frozen still jump the queue (ADR 0040); the rank orders projects *within* the VIP group and
   within the non-VIP group. Unranked projects keep today's order behind the ranked ones.
4. **Re-rank write.** `POST /projects/{id}/band-rank/preview` and `POST /projects/{id}/band-rank`
   with exactly one of `{"before_project_id"}` / `{"after_project_id"}` (both null = last), see
   `docs/API_CONTRACT_P36.md`. Relative placement, so a move made on a filtered board is
   well-defined: the project lands directly above the card it was dropped on, and every project the
   board did not show keeps its relative order. The band's ranks are renumbered 1..n in the same
   transaction (row lock on the band's projects). The project must be in a band and schedulable;
   `before_project_id` must be in the same band (422 `NOT_SAME_BAND`), not the project itself, and
   in the caller's hub scope. Preview / confirm reuse the priority-move preview machinery
   (`services.priority_preview`: in-process greedy pair on a snapshot, token, 409 on a stale token,
   then the same auto-recalc dispatch). RBAC = the priority move's (Registration write + hub scope;
   a hard-gated project may be re-ranked within P1). Audit `project.band_rank_move` with
   `{band, from_rank, to_rank, before_project_id, after_project_id}`.
5. **Priority move.** A project moved into another band gets `band_rank = max + 1` there (last);
   the band it left is renumbered. A status change to a non-schedulable status clears `band_rank`
   and renumbers. A project entering a band any other way (registration, PATCH, import) is last.
6. **Board order.** `GET /priority-board` cards are sorted by `band_rank` asc (NULL last), then
   status, category rank, `project_id` — exactly the scheduling order's keys 4–7, so the board shows
   the order the scheduler walks (VIP / frozen are not floated to the top on the board; the card
   carries its served `band_rank` and the VIP badge says it schedules first). Each card serves
   `band_rank`. Filters never change a card's served rank.
7. **What-if / scenarios / plan import.** `ProjectInput.band_rank: int | None` (default None). The
   What-if and scenario snapshots copy it; a What-if priority override to another band sets it to
   None (R36-5). Plan import (R36-7): a merge row that replaces a live project and keeps its band
   takes that project's rank; every other imported row is None, so it sorts behind the live ranked
   rows, and the file's PRIORITY rank only orders imported rows among themselves (OQ #87).
   `workflow_snapshot` records nothing new: `band_rank` is a project input like `priority`.

## Invariant

Per R36-9 (I30 now compares projects equal on keys 1–3a and 4):

- **I37a** (every run): keys 1–3a never decrease along `scheduling_order` (NULL rank last).
- **I37b** (live state): each band's ranks are exactly 1..n, and a rank is set iff the project is
  schedulable with a priority.
- **I37c**: after a re-rank the project sits next to its anchor and everyone else's relative order
  is unchanged.
- **I37d**: a preview's input equals the input rebuilt from the database after confirm.

## Consequences

- The board's order changes from score order to scheduling order on the day of the migration
  (the schedule itself does not change). Score stays on the card.
- Once ranked, status and category no longer reorder a band: a project reaching In Buyoff keeps
  its place (R36-3, OQ #86).
- CP-SAT takes the order through `prepare_run`; its objective ignores the rank, as it ignores
  status and category, so it may finish a lower-ranked project in the year ahead of a higher one
  (R36-4). Re-rank recalcs are greedy.
- What-if added projects (rank None) sort behind every live project in their band (R36-5).
- DB: `UNIQUE (priority, band_rank)` deferred to commit (NULLs distinct — never add
  `NULLS NOT DISTINCT`), `CHECK (band_rank >= 1)`, and a membership CHECK (P36-T05 ruling).
- Cross-column drops append to the end of the target band; to put it higher the user drags again.
- A Hub Planner's re-rank is relative to cards they can see, but the band is global, so the move
  passes over other hubs' projects in between. That matches the priority move's reach (a P1 promotion
  already affects other hubs through shared chambers).

## Addendum (2026-11-15, P36-T05 security L-1)

`band_rank` is served as the position in the **full** band, so a hub-scoped user can infer how many
other-hub projects sit between theirs. Accepted, same class as the P14 `hidden_count`; the write is
anchor-relative, so nothing depends on the gap.
