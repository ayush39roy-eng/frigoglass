"""Off-host mirror of the nightly MinIO backup bucket (P7-T06).

Context (`docs/HANDOVER/BACKUP_RESTORE.md` §4, flagged by `backend-builder`
while writing that document for P7-T03, tracked as `docs/IMPLEMENTATION_PLAN.md`
P7-T06): the nightly `pg_dump`-to-MinIO backup (`workers/backup_tasks.py`)
lands in the `rpd-backups` bucket on the SAME host as the primary Postgres
database — a single point of failure. If that host's disk fails entirely,
both the live database and every retained backup are lost together.

This module adds a SECOND, independently-scheduled Celery beat task that
copies every object in the local `rpd-backups` bucket to a second,
off-host S3-compatible target — equivalent in effect to running
`mc mirror <local-backups-bucket> <off-host-target>` on a schedule, but
implemented with the `minio` Python SDK already used everywhere else in
this codebase (`core/minio_config.py`) rather than shelling out to a
separate `mc` binary this image does not ship. Same semantics as `mc
mirror`'s default (one-way, source-to-destination, skip objects that
already exist at the destination with a matching size) — this is NOT a
two-way sync and NEVER deletes anything at either end.

**The destination is Frigoglass's own infrastructure decision, not hardcoded
here** (`docs/IMPLEMENTATION_PLAN.md` P7-T06's own acceptance criteria).
See `core/backup_mirror_config.py::BackupMirrorSettings` — until an operator
sets all four `RPD_BACKUP_MIRROR_*` values (endpoint/bucket/access key/
secret key), `mirror_backups_offhost` deliberately no-ops (`status:
"skipped"`) rather than failing the nightly beat schedule. This is a
DIFFERENT posture from `workers/backup_tasks.py`'s own nightly pg_dump task,
which fails loudly if its (always-required) Postgres/MinIO env vars are
missing — that asymmetry is intentional, not an inconsistency: the primary
backup is mandatory infrastructure this app ships complete; the off-host
mirror's target does not exist yet as a decided destination.

**Never logs**: either credential pair (both are only ever passed to the
`Minio` client constructor, never a log line), or any object's content
(only object keys/sizes/counts, same "log identifiers/status, never raw
payload" standard as `workers/backup_tasks.py`/`workers/restore_backup.py`
— a backup bucket's object CONTENT is `pg_dump` output of the same
database whose columns include TCOGS/gross margin/selling price/customer
name; this task never opens/parses a downloaded object, only streams it
through a temp file exactly like `workers/restore_backup.py` already does).
"""

from __future__ import annotations

import logging
import tempfile

from celery import Task
from minio import Minio
from minio.error import S3Error

from core.backup_mirror_config import get_backup_mirror_client, get_backup_mirror_settings
from core.minio_config import ensure_backups_bucket, ensure_bucket, get_minio_client
from workers.worker_app import worker_app

logger = logging.getLogger(__name__)


def _destination_object_exists_with_matching_size(
    dest_client: Minio, dest_bucket: str, object_key: str, expected_size: int
) -> bool:
    """`mc mirror`'s own default comparison is "skip if the destination
    object already exists with the same size" (it also considers mtime,
    which we deliberately do not replicate here — a `pg_dump` object is
    immutable once uploaded, per `workers/backup_tasks.py`'s own
    timestamped, never-overwritten object-key convention, so a size match
    is already a reliable "this is the same object" signal for this
    specific, append-only bucket shape).
    """

    try:
        stat = dest_client.stat_object(dest_bucket, object_key)
    except S3Error as exc:
        if exc.code == "NoSuchKey":
            return False
        raise
    return stat.size == expected_size


@worker_app.task(name="workers.backup_mirror_tasks.mirror_backups_offhost", bind=True)
def mirror_backups_offhost(task: Task) -> dict[str, object]:
    """Copies every object in the local `rpd-backups` bucket
    (`MinioSettings.backups_bucket`) to the configured off-host target
    (`BackupMirrorSettings`), skipping objects that already exist there
    with a matching size.

    Returns a status dict — never raises silently — matching
    `workers/backup_tasks.py::nightly_pg_dump_backup`'s "return a
    JSON-serialisable summary, not None" shape. Three possible `status`
    values: `"skipped"` (destination not configured — see module
    docstring), `"completed"` (ran; see `mirrored_count`/`skipped_count`),
    or an exception is raised (a copy genuinely failed after being
    attempted — Celery records this as a task FAILURE, same convention as
    `nightly_pg_dump_backup`'s `pg_dump`-failure path).
    """

    settings = get_backup_mirror_settings()
    if not settings.is_configured:
        logger.info(
            "mirror_backups_offhost: skipped, destination not configured",
            extra={"task_id": task.request.id},
        )
        return {"status": "skipped", "reason": "not_configured"}

    source_client = get_minio_client()
    source_bucket = ensure_backups_bucket(source_client)

    dest_client = get_backup_mirror_client()
    assert dest_client is not None  # guaranteed by settings.is_configured above
    dest_bucket = settings.bucket
    ensure_bucket(dest_client, dest_bucket)

    logger.info(
        "mirror_backups_offhost: starting",
        extra={
            "source_bucket": source_bucket,
            "dest_endpoint": settings.endpoint,
            "dest_bucket": dest_bucket,
            "task_id": task.request.id,
        },
    )

    mirrored_count = 0
    skipped_count = 0
    failed_object_keys: list[str] = []

    for obj in source_client.list_objects(source_bucket, recursive=True):
        object_key = obj.object_name
        try:
            if _destination_object_exists_with_matching_size(
                dest_client, dest_bucket, object_key, obj.size
            ):
                skipped_count += 1
                continue

            with tempfile.NamedTemporaryFile(suffix=".dump", delete=True) as tmp:
                source_client.fget_object(source_bucket, object_key, tmp.name)
                dest_client.fput_object(dest_bucket, object_key, tmp.name)
            mirrored_count += 1
        except Exception:  # noqa: BLE001 - collected below, re-raised after the full pass
            logger.error(
                "mirror_backups_offhost: failed to mirror one object",
                extra={"object_key": object_key},
            )
            failed_object_keys.append(object_key)

    logger.info(
        "mirror_backups_offhost: completed",
        extra={
            "mirrored_count": mirrored_count,
            "skipped_count": skipped_count,
            "failed_count": len(failed_object_keys),
        },
    )

    if failed_object_keys:
        # Best-effort: every OTHER object was still attempted (the loop
        # above never stops early on one failure) — but the task as a whole
        # must still surface as a FAILURE so `docker compose logs
        # worker`/beat monitoring (docs/HANDOVER/BACKUP_RESTORE.md §6-style
        # verification) actually notices a partial mirror, rather than a
        # `status: "completed"` payload silently hiding it.
        raise RuntimeError(
            f"mirror_backups_offhost: {len(failed_object_keys)} object(s) failed to mirror "
            f"(mirrored {mirrored_count}, skipped {skipped_count})"
        )

    return {
        "status": "completed",
        "source_bucket": source_bucket,
        "dest_bucket": dest_bucket,
        "mirrored_count": mirrored_count,
        "skipped_count": skipped_count,
    }
