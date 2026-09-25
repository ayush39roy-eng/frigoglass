"""The Celery application object for the `solver-worker` process, per
CLAUDE.md's non-negotiable: "CP-SAT dispatch always goes through a Celery
task in `solver-worker`, never inline in a FastAPI request handler."

Run a worker (from `backend/`, with this project's `.venv` active and
`RPD_REDIS_URL` / `RPD_DATABASE_URL` / `RPD_FIELD_ENCRYPTION_KEY` set — same
env-var convention as `api/main.py` / `alembic/env.py`):

    celery -A workers.celery_app worker --loglevel=info

`api/routers/schedule_runs.py` (the FastAPI process) imports
`workers.schedule_tasks.run_cp_sat_schedule` only to call `.delay(...)` on
it — it never imports or calls `scheduling.cp_sat.run_cp_sat` directly, and
this module itself has zero FastAPI/web-framework imports, keeping the
"never inline in FastAPI" boundary structural (an accidental future import
of `fastapi` into this package would be a visible, out-of-place diff, not a
silent violation).

**Cancellation semantics this config enables** — see
`api/routers/schedule_runs.py`'s cancel endpoint and
`workers/schedule_tasks.py`'s module docstring for the full picture:
`task_acks_late=False` (the default, set explicitly below so the choice is
visible rather than implicit) means a task is removed from the Redis queue
the instant a worker picks it up, *before* it starts executing. This is
deliberate: with `task_acks_late=True`, a `revoke(terminate=True)`-killed
worker process would cause Celery/Redis to redeliver the SAME task to
another worker on restart (acks-late's whole point is "redeliver on worker
crash") — which would silently re-run an already-explicitly-cancelled CP-SAT
solve. Early ack means a terminated task is simply gone.
"""

from __future__ import annotations

from celery import Celery

from core.celery_config import get_celery_settings, get_redis_settings
from core.celery_logging import install_celery_logging, install_task_duration_logging

# P6-T06: structured (JSON) stdout logging for this process, wired via
# Celery's own `setup_logging` signal — connected at IMPORT time (before
# `_build_celery_app()` runs) so the app-construction log lines Celery itself
# emits are also JSON, not just log lines from task code. See
# `core/celery_logging.py`'s module docstring for the full rationale,
# including why this is log-based rather than a `/metrics` HTTP endpoint on
# this process.
install_celery_logging("solver-worker")


def _build_celery_app() -> Celery:
    redis_settings = get_redis_settings()
    celery_settings = get_celery_settings()

    app = Celery(
        "rpd_solver_worker",
        broker=redis_settings.redis_url,
        backend=redis_settings.redis_url,
        include=["workers.schedule_tasks"],
    )
    app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        timezone="UTC",
        enable_utc=True,
        # Lets `AsyncResult.state` report "STARTED" (not just PENDING ->
        # SUCCESS/FAILURE) once a worker begins executing — used by this
        # task's own live verification and by anything inspecting Celery's
        # own state as a secondary source of truth alongside the
        # `ScheduleRun.status` DB column.
        task_track_started=True,
        # See module docstring: paired with the cancellation design, not an
        # unrelated default.
        task_acks_late=False,
        task_time_limit=celery_settings.task_time_limit_seconds,
        # One task in flight per worker process at a time — a CP-SAT solve
        # is CPU/memory-heavy and single-threaded by this project's own
        # determinism default (`scheduling.cp_sat.DEFAULT` `num_search_workers
        # =1`); prefetching a second task onto an already-busy worker process
        # would only delay it, not parallelise it.
        worker_prefetch_multiplier=1,
        # P6-T01: Celery's OUT-OF-THE-BOX default queue name is the literal
        # string "celery" regardless of the `Celery(main, ...)` app name
        # above — `app.main` only affects auto-derived task names, not
        # routing. Without an explicit `task_default_queue` here, THIS app's
        # tasks (`workers.schedule_tasks.run_cp_sat_schedule`) and
        # `workers/worker_app.py`'s tasks (`workers.export_tasks.*`) would
        # both be published to that same literal "celery" queue by default —
        # quietly undoing the resource-isolation this module's own docstring
        # promises ("solver-worker ... isolated for resource limits") the
        # moment both apps share one Redis broker (`docs/PROJECT_AND_STACK.md`
        # §6's single-Redis-container topology). Naming this app's queue
        # "solver" (paired with `worker_app.py`'s "worker") is what makes
        # `docker-compose.yml`'s `solver-worker` service's
        # `--queues=solver` genuinely receive only CP-SAT dispatches, not a
        # cosmetic flag with no effect. See `docker-compose.yml`'s
        # `solver-worker`/`worker` service definitions.
        task_default_queue="solver",
    )
    return app


celery_app = _build_celery_app()

# P6-T06: one structured `task_completed` log line per finished task
# (`duration_seconds`, no task arguments — see `core/celery_logging.py`).
install_task_duration_logging(celery_app, queue="solver")
