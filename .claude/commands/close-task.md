---
description: Close a task from docs/IMPLEMENTATION_PLAN.md by its task ID, verifying acceptance criteria before marking it done.
---

Takes a task ID (e.g., `P1-T03`) as an argument: `$ARGUMENTS`.

1. Locate the task in `docs/IMPLEMENTATION_PLAN.md`. If its status is not `IN_PROGRESS` or
   `REVIEW`, stop and report — a task must have been started before it can be closed.
2. Verify every item in the task's acceptance criteria is actually met — read the relevant files/
   test output yourself, don't take the delegated agent's summary at face value.
3. Run the relevant test suite for the area touched (backend: `pytest` scoped to the touched path;
   frontend: `vitest` scoped to the touched path) if `make test` targets exist yet for that area.
   If test infrastructure doesn't exist yet (early P1), note that explicitly rather than skipping
   silently.
4. Confirm a `docs/MEMORY.md` entry exists for this task, appended by the agent that did the work,
   following the required entry template (Did / Files touched / Decisions / Deviations from plan /
   Broke or discovered / Gate result / Next).
5. If acceptance criteria are met and the entry exists: set the task's status to `DONE` in
   `docs/IMPLEMENTATION_PLAN.md`.
6. If acceptance criteria are not met, or the entry is missing: set status to `REVIEW`, and append
   your own `docs/MEMORY.md` entry stating specifically what's missing. Do not mark `DONE`.

Never mark a task `DONE` without a corresponding `docs/MEMORY.md` entry — this is a hard rule from
`CLAUDE.md`, not a discretionary check.
