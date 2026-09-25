"""`solver-worker` process package (P3-T06) — the Celery app + task(s) that
make CLAUDE.md's non-negotiable real: "CP-SAT dispatch always goes through a
Celery task in solver-worker, never inline in a FastAPI request handler."

Deliberately its own top-level package (not under `backend/api/`, which is
FastAPI-only, and not under `backend/scheduling/`, which is
algorithm-engineer's pure-function package and must not be edited here). See
`workers/celery_app.py`'s module docstring for how to run a worker process
and `workers/schedule_tasks.py` / `workers/progress.py` for the task itself
and the Redis pub/sub progress contract P3-T05 depends on.
"""

from __future__ import annotations
