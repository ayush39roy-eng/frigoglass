"""`ExportJob` — the async ("large export, via MinIO") half of P5-T04's
cross-cutting Downloads feature (`docs/PROJECT_AND_STACK.md` §2/§6). See
`api/routers/exports.py`'s module docstring for the full sync-vs-async
design; see `workers/export_tasks.py` for the `worker` (Celery, general
background jobs — distinct from `solver-worker`) task that actually
generates the file and writes it to MinIO.

**Mirrors `models.schedule.ScheduleRun`'s "one row per background job, status
column driven by a Celery task" shape deliberately** — same "why a DB row at
all, not just a Celery `AsyncResult`" reasoning applies: a `celery_task_id`
alone is opaque to a client without also talking to the Celery result
backend directly (an internal implementation detail this app never exposes),
and a durable row survives worker/broker restarts, gives every export a
"Versions & History"-adjacent audit trail (`AuditLogEntry`, written on
dispatch by `api/routers/exports.py`), and lets `GET /exports/jobs/{id}`
answer "is it done yet, and where" with a single indexed lookup.

**No financial data, ever, on this row** — `filters` is a JSONB dict of the
*query filter parameter values* a caller supplied (e.g. `hub_id`, `category`,
`currency`, `status_`), always plain strings/None, never a copy of any row
this job's output file will contain. This mirrors `models.scenario.
ScenarioApplyChange.before_state`/`after_state`'s "never a raw dump" rule
in spirit — the export's actual *contents* (which may include TCOGS,
selling price, gross margin, customer name — CLAUDE.md's four named
encrypted/never-logged fields) live only in the generated file in MinIO,
never in this row, never in a log line (`workers/export_tasks.py` logs job
ids and row *counts* only, per that module's own docstring).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Any

from sqlalchemy import DateTime, Enum, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import ExportFormat, ExportJobStatus, ExportSurface

if TYPE_CHECKING:
    from models.user import User


class ExportJob(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "export_jobs"

    surface: Mapped[ExportSurface] = mapped_column(
        Enum(
            ExportSurface,
            name="export_surface",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    format: Mapped[ExportFormat] = mapped_column(
        Enum(
            ExportFormat,
            name="export_format",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    status: Mapped[ExportJobStatus] = mapped_column(
        Enum(
            ExportJobStatus,
            name="export_job_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
        default=ExportJobStatus.QUEUED,
    )

    requested_by_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )

    #: Plain query-filter parameter echoes only — see module docstring's
    #: "No financial data, ever" section.
    filters: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)

    celery_task_id: Mapped[str | None] = mapped_column(String(255), nullable=True)

    #: Populated once the file has been written to MinIO
    #: (`workers/export_tasks.py`) — the object key within
    #: `core.minio_config.MinioSettings.exports_bucket`, e.g.
    #: `exports/{export_job.id}.xlsx`. `GET /exports/jobs/{id}/download`
    #: (`api/routers/exports.py`) proxies this object back to the caller
    #: rather than issuing a presigned MinIO URL — see that router's module
    #: docstring for why (the on-premise deployment topology does not
    #: guarantee MinIO is reachable from outside the Docker network the way
    #: `api` is, fronted by Nginx/Traefik per `docs/PROJECT_AND_STACK.md` §6).
    object_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    row_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)

    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    requested_by: Mapped[User | None] = relationship()

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<ExportJob {self.surface}:{self.format} {self.status}>"
