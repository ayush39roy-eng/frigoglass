"""Nightly Postgres backup-to-MinIO (P6-T06), scheduled by Celery beat on
the EXISTING general-purpose `worker` Celery app (`workers/worker_app.py`'s
`beat_schedule` — see that module for why this reuses `worker` rather than
`solver-worker` or a second scheduler process).

Per `docs/PROJECT_AND_STACK.md` §6's own "Backup strategy" note: "Nightly
`pg_dump` to MinIO (separate bucket, lifecycle-policy retained)... Backup
verification (restore drill) is a P6/P7 task, not scoped in detail here."
This module builds the backup half of that; the restore half is
`deploy/backup/restore_from_minio.sh` (a deliberately manual operator
script, not a Celery task — restoring over a live database is a
destructive, human-approved action, never something a background job should
be able to trigger on a schedule or accidental `.delay()` call).

**Never logs**: the database password (read only into a subprocess `env=`
dict, never into a log line or a command-line ARGUMENT — `PGPASSWORD` is an
env var precisely so it never appears in `ps`/subprocess-argv-based
inspection either), the dump's actual row contents (a `pg_dump` binary
stream is written straight to a temp file and uploaded — this process never
parses or logs its contents), or `pg_dump`'s raw stderr (which is not
guaranteed to be PII/secret-free in every Postgres version/error path — this
task only logs the return code and a short generic message on failure, per
the same "log identifiers/status, never raw payload" standard already
established in `workers/schedule_tasks.py`/`workers/export_tasks.py`, see
`docs/MEMORY.md`'s P6-T06 entry for the audit of those).
"""

from __future__ import annotations

import logging
import os
import subprocess
import tempfile
import time
from datetime import UTC, datetime

from celery import Task

from core.minio_config import ensure_backups_bucket, get_minio_client
from workers.worker_app import worker_app

logger = logging.getLogger(__name__)

#: Object-key prefix inside `MinioSettings.backups_bucket`, mirroring
#: `workers/export_tasks.py`'s `exports/{export_job_id}.{extension}`
#: convention (a namespaced prefix, not a flat bucket root) — see
#: `deploy/backup/restore_from_minio.sh`, which lists this same prefix to
#: find the latest backup.
BACKUP_OBJECT_PREFIX = "postgres"

#: pg_dump's own custom format (`-Fc`): compressed, and restorable
#: selectively / in parallel via `pg_restore` — chosen over plain-SQL
#: (`-Fp`) specifically so `deploy/backup/restore_from_minio.sh` can use
#: `pg_restore --clean --if-exists` (safe re-run semantics) rather than
#: needing a hand-rolled "DROP everything first" SQL preamble.
_PG_DUMP_FORMAT = "c"


def _require_env(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set for nightly_pg_dump_backup to run")
    return value


@worker_app.task(name="workers.backup_tasks.nightly_pg_dump_backup", bind=True)
def nightly_pg_dump_backup(task: Task) -> dict[str, object]:
    """Runs `pg_dump -Fc` against this deployment's Postgres (same
    `POSTGRES_*`/`POSTGRES_PASSWORD` env vars `backend/docker-entrypoint.sh`
    already assembles `RPD_DATABASE_URL` from — reused directly here rather
    than parsing that URL back apart) and uploads the resulting dump file to
    `MinioSettings.backups_bucket` under a UTC-timestamped object key.

    Returns a small JSON-serialisable summary (bucket, object key, size,
    duration) — the same "return a status dict, never raise silently" shape
    as `workers/export_tasks.py::generate_export` /
    `workers/schedule_tasks.py::run_cp_sat_schedule`.
    """

    started_at = time.monotonic()
    timestamp = datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")
    object_key = f"{BACKUP_OBJECT_PREFIX}/rpd-{timestamp}.dump"

    host = os.environ.get("POSTGRES_HOST", "postgres")
    port = os.environ.get("POSTGRES_PORT", "5432")
    user = _require_env("POSTGRES_USER")
    database = _require_env("POSTGRES_DB")
    password = _require_env("POSTGRES_PASSWORD")

    logger.info(
        "nightly_pg_dump_backup: starting",
        extra={"object_key": object_key, "task_id": task.request.id},
    )

    with tempfile.NamedTemporaryFile(suffix=".dump", delete=True) as tmp:
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
            [
                "pg_dump",
                "-h",
                host,
                "-p",
                port,
                "-U",
                user,
                "-d",
                database,
                "-F",
                _PG_DUMP_FORMAT,
                "-f",
                tmp.name,
            ],
            env={**os.environ, "PGPASSWORD": password},
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
        )
        if result.returncode != 0:
            # Deliberately not logging result.stderr verbatim — see module
            # docstring. The length is a harmless debugging breadcrumb
            # (roughly "how much detail was there") without echoing content.
            logger.error(
                "nightly_pg_dump_backup: pg_dump failed",
                extra={
                    "returncode": result.returncode,
                    "stderr_length": len(result.stderr or ""),
                },
            )
            raise RuntimeError(f"pg_dump exited with code {result.returncode}")

        size_bytes = os.path.getsize(tmp.name)

        client = get_minio_client()
        bucket = ensure_backups_bucket(client)
        client.fput_object(bucket, object_key, tmp.name)

    duration_seconds = time.monotonic() - started_at
    logger.info(
        "nightly_pg_dump_backup: completed",
        extra={
            "bucket": bucket,
            "object_key": object_key,
            "size_bytes": size_bytes,
            "duration_seconds": round(duration_seconds, 2),
        },
    )
    return {
        "status": "completed",
        "bucket": bucket,
        "object_key": object_key,
        "size_bytes": size_bytes,
    }
