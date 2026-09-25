"""The Celery application object for the general-purpose `worker` process —
"background jobs: exports, notifications" per `docs/PROJECT_AND_STACK.md` §6
("worker (Celery — general background jobs: exports, notifications)"),
**deliberately a separate `Celery` app/process from `workers/celery_app.py`
("solver-worker" — CP-SAT and greedy scheduler runs, isolated for resource
limits)**.

Run a worker (from `backend/`, same env-var convention as
`workers/celery_app.py`):

    celery -A workers.worker_app worker --loglevel=info --queues=worker

**Why a second `Celery` app object rather than adding `workers.export_tasks`
to `workers/celery_app.py`'s existing `include=[...]` list**: the deployment
topology (`docs/PROJECT_AND_STACK.md` §6) names `worker` and `solver-worker`
as two SEPARATE Docker Compose services, specifically so a CP-SAT solve's
CPU/memory footprint is isolated from everything else ("solver-worker ...
isolated for resource limits", same section). Registering an export task
onto `solver-worker`'s own app object would let an export job compete for
the exact compute budget CP-SAT is isolated to have to itself — reusing
`workers/celery_app.py` here would quietly undo that isolation, not just be
an organisational nit. Both apps share the same Redis broker/backend
(`core.celery_config.RedisSettings` — see that module's own docstring on
"one Redis instance backs three distinct uses", now joined by a fourth: this
app's own task queue/results), which is fine because Celery routes tasks to
whichever worker process is actually listening on the relevant queue/app —
there is no cross-talk risk from sharing the broker.

P5-T04 scope: `include=["workers.export_tasks"]` only (CSV/XLSX export
generation). Notifications (`docs/PROJECT_AND_STACK.md` §2, P5-T06,
currently TODO per `docs/IMPLEMENTATION_PLAN.md`) will add their own task
module to this same app's `include` list when built — this app object, not
`workers/celery_app.py`, is the correct home for that future task per the
same resource-isolation reasoning above.
"""

from __future__ import annotations

from celery import Celery
from celery.schedules import crontab

from core.celery_config import get_redis_settings
from core.celery_logging import install_celery_logging, install_task_duration_logging

# P6-T06: see `workers/celery_app.py`'s identical call for the full
# rationale — connected at import time so this app's own construction log
# lines are JSON too, not just `workers.export_tasks`/`workers.backup_tasks`
# call sites.
install_celery_logging("worker")


def _build_worker_app() -> Celery:
    redis_settings = get_redis_settings()

    app = Celery(
        "rpd_worker",
        broker=redis_settings.redis_url,
        backend=redis_settings.redis_url,
        # P6-T06: `workers.backup_tasks` (nightly pg_dump-to-MinIO) added
        # to this app's own `include` list — reuses the EXISTING
        # general-purpose `worker` Celery app/queue/container rather than
        # inventing a second scheduler process, per this task's own
        # instruction ("a Celery beat schedule reusing the existing `worker`
        # Celery app... if that's a clean fit"). A nightly `pg_dump` is a
        # background job in the same spirit as exports/notifications (this
        # app's own docstring above), not a CP-SAT-scale compute job, so it
        # does not belong on `solver-worker`'s resource-isolated queue
        # either.
        #
        # P7-T06: `workers.backup_mirror_tasks` (off-host mirror of the
        # `rpd-backups` bucket, see that module's own docstring) added for
        # the exact same reasoning as `workers.backup_tasks` above — same
        # queue, same "not CP-SAT-scale" classification.
        include=["workers.export_tasks", "workers.backup_tasks", "workers.backup_mirror_tasks"],
    )
    app.conf.update(
        task_serializer="json",
        result_serializer="json",
        accept_content=["json"],
        timezone="UTC",
        enable_utc=True,
        # Same rationale as `workers/celery_app.py`'s identical setting,
        # re-derived rather than copied: a fast export-generation task
        # tracked as "STARTED" (not just PENDING -> SUCCESS/FAILURE) is
        # useful for the same live-verification/observability reasons.
        task_track_started=True,
        # P6-T01: pairs with this module's own docstring instruction to run
        # `--queues=worker` — without an explicit `task_default_queue` here,
        # Celery's literal default queue name ("celery", not derived from
        # `app.main`) is what `generate_export.delay(...)` would actually
        # publish to, which a worker started with `--queues=worker` would
        # never consume. See `workers/celery_app.py`'s identical fix
        # (`task_default_queue="solver"`) for the full rationale — both
        # apps share one Redis broker/`docs/PROJECT_AND_STACK.md` §6
        # topology, so explicit, distinct queue names are what actually
        # keeps `worker` and `solver-worker` isolated at the broker level,
        # not just two containers running the same default queue.
        task_default_queue="worker",
        # P6-T06: nightly Postgres backup-to-MinIO
        # (`workers/backup_tasks.py`), run by Celery beat
        # (`docker-compose.yml`'s `beat` service —
        # `celery -A workers.worker_app beat`) rather than a second/external
        # scheduler. 02:00 UTC — outside any plausible Frigoglass business
        # hours across all three hub countries (Greece/Romania: EET/EEST,
        # India: IST), a quiet-hours default an operator can override per
        # deployment by editing this schedule.
        beat_schedule={
            "nightly-postgres-backup": {
                "task": "workers.backup_tasks.nightly_pg_dump_backup",
                "schedule": crontab(hour=2, minute=0),
            },
            # P7-T06: off-host mirror of the `rpd-backups` bucket
            # (`workers/backup_mirror_tasks.py`). Scheduled a full hour
            # after the 02:00 UTC nightly pg_dump above — a real `pg_dump`
            # + upload of this portfolio's database size is expected to
            # finish in well under an hour, so by 03:00 the previous
            # night's dump object should already be sitting in the local
            # `rpd-backups` bucket ready to mirror. This is a
            # best-effort ordering, not a hard dependency: the mirror task
            # mirrors the WHOLE bucket (every retained object, not just
            # "last night's"), so if a particular night's pg_dump runs
            # unusually long and isn't finished by 03:00, that object is
            # simply picked up on the FOLLOWING night's mirror run instead
            # of being missed entirely — see `mirror_backups_offhost`'s own
            # docstring. Deliberately not chained/triggered directly off
            # the pg_dump task's own success (`.apply_async(link=...)`)
            # precisely so a pg_dump failure never blocks or skips the
            # mirror of previously-successful, still-unmirrored backups.
            "nightly-backup-offhost-mirror": {
                "task": "workers.backup_mirror_tasks.mirror_backups_offhost",
                "schedule": crontab(hour=3, minute=0),
            },
        },
    )
    return app


worker_app = _build_worker_app()

# P6-T06: one structured `task_completed` log line per finished task
# (`duration_seconds`, no task arguments — see `core/celery_logging.py`).
install_task_duration_logging(worker_app, queue="worker")
