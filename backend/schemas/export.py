"""Pydantic response models for the async ("large export, via MinIO") half
of P5-T04's Downloads feature (`api/routers/exports.py`). The synchronous
path returns a `StreamingResponse` (raw CSV/XLSX bytes) with no JSON body at
all — mirroring `api/routers/schedule_runs.py::stream_schedule_run_progress`
(SSE), the one other file-streaming endpoint already in this codebase, which
also has no `response_model` for the same reason (there is no JSON shape to
describe; the response body itself IS the deliverable).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel

from models.enums import ExportFormat, ExportJobStatus, ExportSurface


class ExportJobAccepted(BaseModel):
    """`202 Accepted` response body when `?async_export=true` is used —
    returned instead of streaming the file inline, per `docs/PROJECT_AND_
    STACK.md`'s "queued -> running -> done" async-job shape.
    """

    job_id: uuid.UUID
    status: ExportJobStatus


class ExportJobStatusResponse(BaseModel):
    """`GET /exports/jobs/{job_id}` — poll this until `status="completed"`
    (or `"failed"`, see `error_message`), then call
    `GET /exports/jobs/{job_id}/download`.
    """

    job_id: uuid.UUID
    surface: ExportSurface
    format: ExportFormat
    status: ExportJobStatus
    row_count: int | None
    error_message: str | None
    created_at: datetime
    completed_at: datetime | None
