"""Restore-drill entry point for P6-T06's nightly pg_dump-to-MinIO backups
(`workers/backup_tasks.py`). Downloads a backup object and `pg_restore`s it
into a target Postgres.

**Deliberately a plain script (`python -m workers.restore_backup`), NOT a
Celery task.** Restoring over a database is a destructive, human-approved
operator action — it must never be reachable via `.delay()`, a schedule, or
any API call. See `deploy/backup/restore_from_minio.sh` for the operator-
facing wrapper that runs this inside a throwaway container built from the
same image `api`/`worker`/`solver-worker` already use.

Never logs the resolved Postgres password (read from `POSTGRES_PASSWORD`,
passed to `pg_restore` only via the `PGPASSWORD` subprocess environment, per
the same standard as `workers/backup_tasks.py`) or `pg_restore`'s raw
stderr (which, like `pg_dump`'s, is not guaranteed to be secret-free in
every error path) — only status/identifiers/counts.
"""

from __future__ import annotations

import logging
import os
import subprocess
import sys
import tempfile

from minio import Minio

from core.minio_config import ensure_backups_bucket, get_minio_client
from workers.backup_tasks import BACKUP_OBJECT_PREFIX

logger = logging.getLogger(__name__)


def _resolve_object_key(client: Minio, bucket: str, requested: str) -> str:
    """`requested == "latest"` (the default): finds the most-recently
    uploaded object under `BACKUP_OBJECT_PREFIX`, since object keys are
    UTC-timestamped (`workers/backup_tasks.py`) but not lexicographically
    guaranteed sortable across a DST/leap-second edge case — comparing
    `last_modified` (MinIO/S3's own object metadata) is the actually-correct
    "latest" definition, not a string-sort assumption.
    """

    if requested != "latest":
        return requested

    objects = list(client.list_objects(bucket, prefix=f"{BACKUP_OBJECT_PREFIX}/", recursive=True))
    if not objects:
        raise RuntimeError(
            f"No backup objects found under '{BACKUP_OBJECT_PREFIX}/' in bucket '{bucket}'"
        )
    latest = max(objects, key=lambda obj: obj.last_modified)
    return str(latest.object_name)


def main() -> int:
    requested_key = os.environ.get("RESTORE_OBJECT_KEY", "latest")
    host = os.environ.get("POSTGRES_HOST", "postgres")
    port = os.environ.get("POSTGRES_PORT", "5432")
    user = os.environ.get("POSTGRES_USER", "rpd")
    database = os.environ.get("POSTGRES_DB", "rpd")
    password = os.environ["POSTGRES_PASSWORD"]

    client = get_minio_client()
    bucket = ensure_backups_bucket(client)
    object_key = _resolve_object_key(client, bucket, requested_key)

    logger.info(
        "restore_backup: downloading",
        extra={"bucket": bucket, "object_key": object_key},
    )

    with tempfile.NamedTemporaryFile(suffix=".dump") as tmp:
        client.fget_object(bucket, object_key, tmp.name)
        logger.info(
            "restore_backup: downloaded",
            extra={"size_bytes": os.path.getsize(tmp.name)},
        )

        # `--clean --if-exists`: drop each object before recreating it, so
        # this is safe to run against a target that already has SOME
        # version of the schema (not just a bare-empty database) —
        # `--no-owner` because the target's Postgres role running this
        # restore (the deployment's own `POSTGRES_USER`) does not
        # necessarily match whatever role name owned the objects at dump
        # time.
        result = subprocess.run(  # noqa: S603 - fixed argv, no shell, no user input
            [
                "pg_restore",
                "--clean",
                "--if-exists",
                "--no-owner",
                "-h",
                host,
                "-p",
                port,
                "-U",
                user,
                "-d",
                database,
                tmp.name,
            ],
            env={**os.environ, "PGPASSWORD": password},
            capture_output=True,
            text=True,
            timeout=1800,
            check=False,
        )
        if result.returncode != 0:
            logger.error(
                "restore_backup: pg_restore failed",
                extra={
                    "returncode": result.returncode,
                    "stderr_length": len(result.stderr or ""),
                },
            )
            return 1

    logger.info(
        "restore_backup: completed",
        extra={
            "bucket": bucket,
            "object_key": object_key,
            "target_host": host,
            "target_db": database,
        },
    )
    return 0


if __name__ == "__main__":
    from core.logging_config import configure_logging

    configure_logging("restore-drill", force=True)
    sys.exit(main())
