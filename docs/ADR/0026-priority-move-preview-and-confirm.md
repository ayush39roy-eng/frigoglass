# ADR 0026: Priority move — preview the knock-on changes, then confirm

## Status

Accepted (2026-10-19). Part of P14. Amends ADR 0015 and ADR 0018. `backend/scheduling/` is not
touched.

## Context

Frigoglass asked (relayed 2026-10-19): "in priority board … if we move a project from P4 to P1
then there should be a popup [showing] what changes will be done, like which projects will be
moved … and then we can do yes or no, and then it does the change". They also reported: "right
now the priority board function is not working".

**Root cause of "not working".** Under ADR 0015, a move saves the priority and queues a greedy run
on the Celery `solver` worker. On the owner's dev stack (uvicorn :8001), and on any deployment
without a worker, nothing ever executes that run.
- The live DB has one `priority_move` run that has been `queued` since 2026-10-18 09:29.
- The board shows "Recalculating…", the UI stops polling after 3 minutes, and the timeline never
  changes.
- For about 17 minutes after each move (the in-flight window), every later move answers
  `deferred`.

The design depends on a process that is easy to leave out.

## Decision

1. **Preview first.** A new endpoint, `POST /projects/{id}/priority/preview {priority}`, runs the
   greedy scheduler on the current inputs with only that project's priority replaced.
   - **Same scheduler as a real move.** It uses the same `backend/scheduling/greedy.py` and the
     same input snapshot builder as the worker.
   - **Runs in the API process.** It is pure Python on a thread pool with a hard time cap.
     CP-SAT is never run this way (non-negotiable).
   - **Writes nothing.** No priority, no run row, no audit entry.
   - **Returns:**
     - the moved project's finish before and after;
     - every other project in scope whose `projected_end_week`, `within_year`, `left_out` or
       `blocked` would change, using the run-to-run comparison of ADR 0015 §4. Projects pushed
       out of the year are listed first;
     - counts: delayed, earlier, newly spillover, newly within-year;
     - a `preview_token`, a hash of the input snapshot the preview was computed from.
   - **When nothing is computed:**
     - same priority → `unchanged`;
     - hard gate → 409 `HARD_GATE_FORCES_P1`;
     - non-schedulable status → `not_needed`, with an empty change list.
2. **Confirm = the move, done in-process.** `POST /projects/{id}/priority` accepts an optional
   `preview_token`. With a token:
   - It rebuilds the snapshot. If the hash differs (something changed since the preview), it
     returns 409 `PREVIEW_STALE` and the dialog re-previews.
   - Otherwise it writes the priority, the audit row and the stale flag. It then runs greedy
     in-process, persists the run (`trigger_reason="priority_move"`, immutable, I14) and activates
     it, all before responding.
   - The response carries the new `schedule_run_id`, `baseline_run_id` and the same change list.
     Greedy is deterministic, so what was previewed is exactly what is applied.

   The confirmed move no longer depends on a Celery worker.
3. **Concurrency.** The dispatch advisory lock (`run_dispatch.DISPATCH_LOCK_KEY`) is held across
   the in-process run and its activation.
   - A worker run that is genuinely queued or running → `deferred`, exactly as in ADR 0015 and
     ADR 0023.
   - Without a token (the PATCH path and old clients), ADR 0015 behaviour is unchanged.
4. **Abandoned runs.** A run still `queued` or `running` after the in-flight window
   (`task_time_limit + 120 s`) is marked `failed` with error `ABANDONED` the next time dispatch is
   decided. It never becomes active. The stuck 2026-10-18 row is cleaned up that way. The Workspace
   "Recalculate" and the check-in and step-timing triggers still use Celery (unchanged scope).
5. **UI.** Every move entry point opens the preview dialog first: a drop on the Priority board, the
   move control on the Gantt row, the Workspace header and the Registration form. The dialog shows
   the moved project's finish (before → after), the summary counts, and the list of affected
   projects (name, hub, priority, finish before → after, within-year change). **Yes** confirms and
   **No** cancels. On No, a board drop snaps back. Nothing is written until Yes.

## Consequences

- One greedy pass now runs inside a request. It must stay well under the request timeout at
  production scale (about 250 projects). The builder records the measured wall time in MEMORY. If
  it exceeds 10 s, this ADR is revisited.
- Hub-scoped users see a count of hidden affected rows, as in ADR 0015 §4.
- "Checking the scheduler" is a separate workflow-auditor re-derivation (P14-T03). This ADR does
  not change any scheduling rule.
