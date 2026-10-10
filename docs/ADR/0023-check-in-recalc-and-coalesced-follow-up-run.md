# ADR 0023: Check-ins recalculate; a deferred auto-recalc gets one coalesced follow-up run

## Status

Accepted (2026-10-10). Part of P12. It amends three earlier ADRs:
- ADR 0021 §6: a check-in now recalculates.
- ADR 0015: `deferred` now ends in a run.
- ADR 0019: `deferred` gets the same follow-up as ADR 0015.

There is no scheduler change.

## Context

The project owner answered OQ #29–#31 on 2026-10-10:
- "for gantt drag calculate straight away";
- "for live tracking recalculate and do whatever you think is best".

ADR 0021 kept a check-in as "mark stale" because of the flood problem. On a Monday, many engineers
submit within minutes. Under ADR 0015's rules, every submission after the first returns `deferred`,
the project stays stale, and no run picks it up until someone presses Recalculate. Priority moves
and Gantt drags already had the same gap: drag three bars quickly and only the first one gets a run.

## Decision

1. **A check-in recalculates.** `POST /check-ins` dispatches a greedy run
   (`trigger_reason="check_in"`, `activate=True`) through `services/run_dispatch.py`, the same path
   and lifecycle as a priority move:
   - `queued`: a run was dispatched;
   - `deferred`: a run was already in flight;
   - `not_needed`: no project in the batch is schedulable.
   One batch produces at most one run. A batch of stages that are all confirmed unchanged still
   counts as a report, but it produces `not_needed` when no progress field changed.
2. **One coalesced follow-up run.** When any auto-trigger answers `deferred` (`priority_move`,
   `step_timing` or `check_in`), it records a durable *follow-up request* in Postgres, under the
   same advisory lock. When the in-flight run finishes, whether it succeeded, failed or was swept,
   the worker clears the request inside that lock and, if one was set, dispatches **exactly one**
   greedy run (`trigger_reason="follow_up"`, `activate=True`). That run reads current inputs, so it
   includes every change saved in the meantime.
3. **The bound.** At any moment there is at most one run in flight and one follow-up pending. Any
   number of `deferred` answers inside that window collapse into the one follow-up. This keeps
   P11-T05's "cannot flood the solver" property: a burst of N requests costs at most two runs.
4. **The explicit Workspace Recalculate is unchanged** (ADR 0006). It still answers 409 when a run
   is in flight, and it does not register a follow-up. Plain Workspace stage edits still only mark
   the project stale. Auto-recalc covers only the three direct-manipulation or reporting actions
   above.
5. **No automatic stage advance** (OQ #31, decided by the owner's "whatever you think is best").
   Nobody's stage is ever marked started or Done on their behalf:
   - a Done stage is frozen history (I11), and writing one without a report would fabricate it;
   - the plan already moves by itself, because each run re-places every not-started stage from
     `CURRENT_WEEK` onward;
   - missing reports show as Due or Overdue, and "per plan" progress is displayed next to the
     reported %.
6. **Reminders are in-app** (OQ #33): a due-count badge on the Weekly check-in tab, plus the
   tracking chips. Email waits for Frigoglass IT's SMTP relay.

## Consequences

- `deferred` UI copy changes from "press Recalculate later" to "saved; the timeline updates
  automatically after the current recalculation". The UI watches for the next active run and
  refreshes when it arrives.
- The follow-up request is one durable flag, not a queue. Losing a worker mid-run is covered by the
  existing `schedule_run_sweeper`, which must also honour the flag.
- The workflow-auditor gains a check:
  - fire several auto-triggers during one run;
  - assert exactly one follow-up run;
  - assert that its inputs contain every change.
