"""Structured logging + basic per-task duration metrics for the `worker` and
`solver-worker` Celery apps (P6-T06). Shared by `workers/celery_app.py` and
`workers/worker_app.py` so both processes get identical behaviour without
duplicating the signal-wiring code.

**Why not a `/metrics` HTTP endpoint on these two processes** (documented
judgment call, per this task's own "use judgment and document" instruction):
Celery's default worker pool is `prefork` — each task actually executes in a
forked CHILD process, not the parent process that owns Celery's own signal
dispatch. `prometheus_client`'s default `CollectorRegistry` is per-process;
metrics incremented in a forked child are invisible to the parent's registry,
so a naive `start_http_server()` in the parent would always read zero.
`prometheus_client` DOES support a "multiprocess mode" for exactly this
(`PROMETHEUS_MULTIPROCESS_DIR` + a shared `MultiProcessCollector`), but that
adds a shared-directory-of-`.db`-files mechanism, a `WSGI`/small HTTP server
to actually serve it, and per-container port/volume wiring — real, but
disproportionate to this task's stated minimal scope ("You are NOT expected
to stand up a full Prometheus+Grafana stack..."). Instead: every task
completion emits ONE structured JSON log line (`task_completed`) carrying
`task_name`, `queue`, `state`, and `duration_seconds` — an operator can
already alert/graph on this via log-based metrics tooling (e.g. Promtail +
Loki's LogQL `unwrap`, or a simple `mtail` program) without this app
inventing its own multiprocess Prometheus wiring. A full multiprocess
Prometheus setup for Celery is a reasonable P7/ops follow-up if the client
wants dashboards specifically on Celery throughput, not built here.

CP-SAT solve time specifically (`docs/PROJECT_AND_STACK.md`'s scheduling
engine) is additionally logged as its own structured field directly in
`workers/schedule_tasks.py` (`solve_wall_time_seconds`) — an aggregate
performance number, not tied to a named project/customer, per this task's
own guidance that this is a "reasonable, non-sensitive thing to expose".
"""

from __future__ import annotations

import logging
import time

from celery import Celery
from celery.signals import setup_logging, task_postrun, task_prerun

from core.logging_config import configure_logging

logger = logging.getLogger("celery.task_metrics")

#: Keyed by Celery task id. Prefork means each task body runs in its own
#: forked process (a fresh copy of this module-level dict) — `task_prerun`/
#: `task_postrun` for a given task id always fire in the SAME process, so a
#: plain dict (no cross-process sharing needed) is sufficient here.
_task_start_times: dict[str, float] = {}


def install_celery_logging(service_name: str) -> None:
    """Connects Celery's `setup_logging` signal to this app's own
    `configure_logging`. Once ANY receiver is connected to `setup_logging`,
    Celery skips its own default logging setup entirely (documented Celery
    behaviour) — this is what makes worker/solver-worker stdout JSON rather
    than Celery's own colourised plain-text default.
    """

    @setup_logging.connect(weak=False)
    def _configure(*args: object, **kwargs: object) -> None:
        configure_logging(service_name, force=True)


def install_task_duration_logging(app: Celery, *, queue: str) -> None:
    """Connects `task_prerun`/`task_postrun` to emit one structured
    `task_completed` log line per finished task, with `duration_seconds`.
    Never logs task ARGUMENTS (a CP-SAT dispatch's `schedule_run_id` is just
    a UUID and would be safe, but an export task's `filters` payload is not
    guaranteed to be — this module doesn't know per-task which arguments are
    safe, so it logs none of them, only identity/timing metadata).
    """

    # Celery's `task_prerun`/`task_postrun` signals are process-GLOBAL, not
    # scoped to a particular `Celery` app instance — `sender=None` receives
    # every task from every app in the process. In production this is a
    # non-issue (each container only ever imports ONE of
    # `workers.celery_app`/`workers.worker_app` — `solver-worker` never
    # imports `workers.worker_app` and vice versa, confirmed via
    # `grep -rn "from workers\." backend/` before writing this), but a
    # single process that DOES import both (this module's own test suite,
    # or any future tooling) would otherwise double-log every task once per
    # installed app. The explicit `task.app is app` check below makes this
    # correct regardless of what else happens to be imported in-process,
    # not just "correct because of how the containers happen to be split".
    @task_prerun.connect(sender=None, weak=False)
    def _prerun(task_id: str | None = None, task: object = None, **kwargs: object) -> None:
        if task_id is not None and getattr(task, "app", None) is app:
            _task_start_times[task_id] = time.monotonic()

    @task_postrun.connect(sender=None, weak=False)
    def _postrun(
        task_id: str | None = None,
        task: object = None,
        state: str | None = None,
        **kwargs: object,
    ) -> None:
        if getattr(task, "app", None) is not app:
            return
        started_at = _task_start_times.pop(task_id, None) if task_id is not None else None
        duration_seconds = time.monotonic() - started_at if started_at is not None else None
        logger.info(
            "task_completed",
            extra={
                "task_name": getattr(task, "name", None),
                "task_id": task_id,
                "queue": queue,
                "state": state,
                "duration_seconds": (
                    round(duration_seconds, 3) if duration_seconds is not None else None
                ),
            },
        )
