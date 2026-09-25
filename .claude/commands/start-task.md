---
description: Start a task from docs/IMPLEMENTATION_PLAN.md by its task ID.
---

Takes a task ID (e.g., `P1-T03`) as an argument: `$ARGUMENTS`.

1. Read `docs/DOMAIN_RULES.md`, then `docs/MEMORY.md`, then `docs/IMPLEMENTATION_PLAN.md` — the
   Memory Protocol, in that order.
2. Locate the task by ID in `docs/IMPLEMENTATION_PLAN.md`. If it doesn't exist, stop and report.
3. Confirm every task listed in its `Depends on:` line has status `DONE`. If any dependency is not
   `DONE`, stop and report which one is blocking — do not start the task.
4. Set the task's status to `IN_PROGRESS` in `docs/IMPLEMENTATION_PLAN.md`.
5. Delegate the task to its owning agent (per the phase table's `Owner` column, or the task's own
   stated owner if it differs), giving it the task ID, its full description, and its acceptance
   criteria verbatim from `docs/IMPLEMENTATION_PLAN.md`.
6. Do not mark the task `DONE` yourself — that happens in `/close-task` after acceptance criteria
   are verified and a `docs/MEMORY.md` entry exists.
