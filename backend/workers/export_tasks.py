"""The Celery task that actually generates a CSV/XLSX export file and writes
it to MinIO — the "large export, via MinIO" async half of P5-T04's Downloads
feature, dispatched onto the general-purpose `worker` process
(`workers/worker_app.py`, distinct from `solver-worker` — see that module's
docstring for why). `api/routers/exports.py`'s `?async_export=true` path is
the only caller of `.delay(...)` on this task; the synchronous default path
never touches this module or MinIO at all (`services/export_builder.py`'s
per-surface builder functions are the single shared implementation both
paths call — see that module's docstring).

**Lifecycle** (mirrors `workers/schedule_tasks.py`'s `ScheduleRun` lifecycle
shape, deliberately — same "one DB row per background job, status column
driven by this task" pattern, see `models/export.py`'s docstring):

    QUEUED --(this task starts)--> RUNNING --(upload succeeds)--> COMPLETED
                                          \\--(any exception)-----> FAILED

**Async DB access from a sync Celery task — same fresh-engine-per-invocation
pattern as `workers/schedule_tasks.py`, same reason, deliberately
duplicated rather than shared**: `asyncpg` connections are bound to the
`asyncio` event loop they were created on, and `asyncio.run(...)` (this
task's entry point, below) creates a brand-new loop per call — reusing
`api.db`'s module-level singleton engine across separate worker invocations
breaks exactly the way that module's own docstring describes. `_database_url`
/ `_open_session_factory` below are a near-verbatim copy of
`workers/schedule_tasks.py`'s own versions of the same two functions — kept
as a deliberate small duplication (not refactored into a shared
`workers/db_utils.py`) for the same reason `workers/schedule_tasks.py`
itself gives for not importing `api.db`: this task module should not gain a
dependency on `solver-worker`'s own task module, or vice versa, just to
share four lines: the two Celery apps/processes (`worker` vs
`solver-worker`) are deliberately isolated from each other
(`workers/worker_app.py`'s docstring) and importing across that boundary
for a trivial helper would be a real, if narrow, coupling regression.

**No progress pub/sub for exports (a deliberate, narrower scope than
`workers/schedule_tasks.py`'s SSE-backed CP-SAT progress)**: export
generation at this app's actual scale (~236 projects portfolio-wide, per
CLAUDE.md — at most a few thousand flattened Gantt step-rows) is expected to
complete in low single-digit seconds, not the up-to-a-minute-plus CP-SAT
solves `workers/progress.py`'s SSE relay was built for. `api/routers/
exports.py`'s brief explicitly allows "a simpler 'poll a status endpoint for
the download URL'" instead of a progress stream for exports, and this task
takes that option: `GET /exports/jobs/{id}` is a plain DB-row poll (`models.
export.ExportJob.status`), no Redis pub/sub channel is published to at all.
Flagged here as a considered scope decision, not an oversight, for a
reviewer or a future task to reopen if a real large-portfolio export turns
out to be slow enough that a bare poll feels wrong in practice.

**No log line in this module ever contains an exported row's actual field
values** (CLAUDE.md: "Financial columns ... never log their values") — only
`export_job_id`, `surface`, `format`, and integer row *counts* are logged.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from celery import Task
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from core.minio_config import ensure_bucket, get_minio_client, get_minio_settings
from core.principal import Principal
from models.enums import ExportFormat, ExportJobStatus, RoleName
from models.export import ExportJob
from services.export_builder import ExportFilters, build_export_sheets, csv_bytes, xlsx_bytes
from workers.worker_app import worker_app

logger = logging.getLogger(__name__)

TASK_NAME = "workers.generate_export"

_XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _database_url() -> str:
    """Same `RPD_DATABASE_URL` convention / deliberate non-import of
    `api.db` as `workers/schedule_tasks.py::_database_url` — see that
    module's docstring and this module's own "Async DB access" section
    above for why.
    """

    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/api/db.py / backend/workers/schedule_tasks.py for the same convention."
        )
    return url


@asynccontextmanager
async def _open_session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """A fresh `AsyncEngine` + `async_sessionmaker`, scoped to (and disposed
    at the end of) THIS `async with` block — see module docstring.
    """

    engine: AsyncEngine = create_async_engine(_database_url())
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def _principal_from_payload(data: dict[str, Any]) -> Principal:
    """The exact inverse of `api/routers/exports.py::_principal_to_task_payload`
    — reconstructs the dispatching caller's `Principal` from the plain
    JSON-safe dict passed as this task's `principal` argument, so
    `services.export_builder.build_export_sheets` (and therefore every
    surface's RBAC-gated/hub-scoped read endpoint it calls) sees the exact
    same authorization context the original HTTP request had. Never reads
    a token or re-authenticates — the caller was already authenticated and
    authorized (`Depends(require_permission(...))`) at dispatch time in
    `api/routers/exports.py`, which is the ONLY place this payload is
    constructed.
    """

    return Principal(
        user_id=uuid.UUID(data["user_id"]),
        email=data["email"],
        full_name=data["full_name"],
        oidc_subject=data["oidc_subject"],
        roles=frozenset(RoleName(r) for r in data["roles"]),
        hub_scope_all=data["hub_scope_all"],
        hub_ids=frozenset(uuid.UUID(h) for h in data["hub_ids"]),
    )


@worker_app.task(bind=True, name=TASK_NAME)
def generate_export(
    self: Task,
    export_job_id: str,
    *,
    principal: dict[str, Any],
    surface: str,
    format: str,
    filters: ExportFilters,
) -> dict[str, Any]:
    """Celery entry point (sync). `export_job_id` must already reference an
    existing `ExportJob` row in `QUEUED` status (created by
    `api/routers/exports.py` before dispatch, mirroring `POST
    /schedule-runs/cp-sat-dispatch`'s "create the row first, then enqueue"
    order).
    """

    return asyncio.run(
        _generate_export_async(
            self,
            export_job_id=export_job_id,
            principal=principal,
            surface=surface,
            format=format,
            filters=filters,
        )
    )


async def _generate_export_async(
    task: Task,
    *,
    export_job_id: str,
    principal: dict[str, Any],
    surface: str,
    format: str,
    filters: ExportFilters,
) -> dict[str, Any]:
    job_uuid = uuid.UUID(export_job_id)

    try:
        # Same "wrap the WHOLE function body, not just the risky-looking
        # part" reasoning as `workers/schedule_tasks.py` — see that module's
        # docstring for the real deployment misconfiguration that motivated
        # widening this in the first place.
        async with _open_session_factory() as session_factory, session_factory() as db:
            job = await db.get(ExportJob, job_uuid)
            if job is None:
                raise RuntimeError(
                    f"ExportJob {export_job_id} not found — deleted before the task started?"
                )

            job.status = ExportJobStatus.RUNNING
            job.started_at = datetime.now(UTC)
            job.celery_task_id = task.request.id
            db.add(job)
            await db.commit()
            logger.info("ExportJob %s (%s/%s): generation started", export_job_id, surface, format)

            principal_obj = _principal_from_payload(principal)
            sheets = await build_export_sheets(db, principal_obj, surface=surface, filters=filters)

            if format == ExportFormat.CSV.value:
                sheet_name = next(iter(sheets))
                headers, rows = sheets[sheet_name]
                content = csv_bytes(headers, rows)
                content_type = "text/csv"
                extension = "csv"
                row_count = len(rows)
            else:
                content = xlsx_bytes(sheets)
                content_type = _XLSX_CONTENT_TYPE
                extension = "xlsx"
                row_count = sum(len(rows) for _, rows in sheets.values())

            object_key = f"exports/{export_job_id}.{extension}"
            client = get_minio_client()
            minio_settings = get_minio_settings()
            ensure_bucket(client, minio_settings.exports_bucket)
            client.put_object(
                minio_settings.exports_bucket,
                object_key,
                io.BytesIO(content),
                length=len(content),
                content_type=content_type,
            )

            job.status = ExportJobStatus.COMPLETED
            job.object_key = object_key
            job.row_count = row_count
            job.completed_at = datetime.now(UTC)
            db.add(job)
            await db.commit()
            logger.info(
                "ExportJob %s (%s/%s): completed, %d row(s)",
                export_job_id,
                surface,
                format,
                row_count,
            )
            return {
                "status": "completed",
                "export_job_id": export_job_id,
                "row_count": row_count,
                "object_key": object_key,
            }
    except Exception as exc:  # noqa: BLE001 - deliberately broad, see workers/schedule_tasks.py
        try:
            async with (
                _open_session_factory() as cleanup_session_factory,
                cleanup_session_factory() as cleanup_db,
            ):
                failed_job = await cleanup_db.get(ExportJob, job_uuid)
                if failed_job is not None and failed_job.status in (
                    ExportJobStatus.QUEUED,
                    ExportJobStatus.RUNNING,
                ):
                    failed_job.status = ExportJobStatus.FAILED
                    failed_job.error_message = str(exc)[:2000]
                    failed_job.completed_at = datetime.now(UTC)
                    cleanup_db.add(failed_job)
                    await cleanup_db.commit()
        except Exception:
            logger.exception(
                "ExportJob %s: failed to mark row FAILED after task error", export_job_id
            )
        logger.exception("ExportJob %s (%s/%s): generation failed", export_job_id, surface, format)
        raise
