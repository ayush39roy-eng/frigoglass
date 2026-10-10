# ADR 0021: Live project tracking through a weekly stage check-in

## Status

Accepted (2026-10-10). Part of P12. No scheduler change. It extends who may write stage progress:
Engineers, for their own stages only.

## Context

Frigoglass asked (relayed 2026-10-10): "Project tracking should be LIVE, meaning all engineers need
to fill it on a weekly basis, or the project itself should move through it."

Per-stage progress already exists (ADR 0006). Only Hub Planners and above could write it, on the
Project Workspace, one stage at a time, and nothing showed whether a project's progress was
current. Engineers had read-only access to their own assignments.

## Decision

1. **A weekly check-in surface** at `/check-in` (sidebar Execute group). It lists the stages
   *due* for the caller this week. A stage is due when it is not skipped, not `Done`, and
   either its status is `In Progress` / `Blocked` or its planned window in the active run
   contains `CURRENT_WEEK`. For each due stage the user sets status, % complete, hold reason
   (required when On Hold) and an optional note, and submits the whole week in one go.
2. **A check-in writes the same progress fields** as the Workspace stage PATCH, and the same
   consistency rules apply (DOMAIN_RULES "Per-stage progress fields"). The server fills
   `actual_start_week = CURRENT_WEEK` on the first move out of `Not Started`, and
   `actual_end_week = CURRENT_WEEK` on `Done`, so engineers never type week numbers. Each
   submitted stage also appends one immutable `stage_checkins` row: who, which week, what was
   reported, and the note. A stage confirmed unchanged still gets a row, because "no change" is
   a report.
3. **Who may check in.**
   - **Engineer:** only stages of projects they lead (`Project.leader_engineer_id`) or stages
     assigned to them (`ProjectWorkflowStep.assigned_engineer_id`). Their linked engineer is
     `Engineer.user_id`. This is a new, narrow write right. It is not general `project_workspace`
     write.
   - **Hub Planner** (own hub), **Portfolio Manager**, **Admin** and **Super Admin:** any due
     stage in scope, on someone's behalf.
   - **Editor-or-higher project grant (ADR 0012):** that project's due stages.
   - **Executive Viewer** and **Auditor:** read only.
4. **Tracking status per project**, served and never computed in the browser:

   | Status | Meaning |
   |---|---|
   | `live` | Every due stage has a check-in this week (`stage_checkins.week == CURRENT_WEEK`). |
   | `due` | Some due stage has no check-in this week, but did have one last week, or became due this week. |
   | `overdue` | Some due stage has had no check-in this week or last week, and has been due for at least two weeks. |
   | `idle` | The project has no due stage. |

   The status shows as a chip on the Gantt row, the Workspace header, the Projects cards, VIP
   cards and the check-in page.
5. **"Or the project itself should move through it".** When nobody has reported, the app shows
   *plan-based progress*: the share of a stage's planned window already elapsed at
   `CURRENT_WEEK`, labelled "per plan". This sits next to the reported % and is never written into
   the progress fields. Writing it would fabricate history that I11 then freezes. OQ #31 asks
   whether the client wants stages to auto-advance at week close instead.
6. **Rescheduling stays explicit for check-ins.** A check-in sets `schedule_stale`, as a
   Workspace edit does (ADR 0006). With dozens of engineers submitting on Monday, an
   auto-dispatch per submission would just produce a pile of `deferred` results. The check-in
   page shows planners "N projects changed since the last run" with the existing Recalculate
   action. OQ #30 asks whether a scheduled weekly recalc is wanted.
7. **GDPR (OQ #8).** Compliance is reported per project and per stage, never as a per-engineer
   league table. `stage_checkins.user_id` is kept for audit and shown only on the stage's own
   history.

## Consequences

- RBAC gains one row-level rule, the Engineer own-stage write. The security-auditor must test the
  negatives: another engineer's stage, an out-of-hub stage, and a Viewer grant.
- Due-ness is computed from the active run plus live status. A stage can become due because of a
  recalculation, and that is intended.
