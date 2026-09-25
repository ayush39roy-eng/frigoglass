"""Downloads — CSV/XLSX export of every surface's current view
(`docs/PROJECT_AND_STACK.md` §2's cross-cutting "Downloads" feature, P5-T04).

**Two paths, one shared implementation**: every endpoint below defaults to a
SYNCHRONOUS, streamed-inline response (`StreamingResponse`, no MinIO, no
Celery) — appropriate for this app's actual scale (~236 projects
portfolio-wide, per CLAUDE.md; even an unfiltered, unscoped Gantt export
flattens to at most a few thousand rows, sub-second to generate). Passing
`?async_export=true` instead creates a durable `models.export.ExportJob` row
and dispatches `workers.export_tasks.generate_export` onto the
general-purpose `worker` Celery process (`workers/worker_app.py`, per
`docs/PROJECT_AND_STACK.md` §6 — distinct from `solver-worker`), which
writes the finished file to MinIO; the caller polls `GET
/exports/jobs/{job_id}` for `status`, then `GET
/exports/jobs/{job_id}/download` once `completed`. BOTH paths call the exact
same `services.export_builder.build_export_sheets(...)` — see that module's
docstring for why this single-implementation design is what actually
guarantees an export can never show a caller data their role/hub scope
wouldn't already let them see via the ordinary read endpoint (RBAC + hub
scoping is `require_permission(...)` below plus whatever the reused read
endpoint already enforces internally, never re-derived here).

**Export-only — no import path** (P5-T05, orchestrator scope-lock, `docs/
IMPLEMENTATION_PLAN.md`): nothing in this file accepts an uploaded
CSV/XLSX to write back into the database. Revisit only if `docs/
OPEN_QUESTIONS.md` #7 is answered by the real client establishing a
round-trip contract.

**RBAC — one dependency per surface, reusing `core.rbac.Surface`/`Action`
exactly as that surface's own router does** (not a new, separately-derived
permission concept for "can this role export X" — an export is a read, and
is gated identically to that surface's normal `GET`, per CLAUDE.md's "an
export is a read operation and must never leak data a user's role/hub scope
wouldn't let them see via the API"): `dashboard`/`capacity`/`matrix`/
`gantt`/`project-registration`/`capacity-planning` each require `READ` on
their matching `core.rbac.Surface` member.

**`GET /exports/jobs/{job_id}` and `.../download` are OWNER-scoped, not
surface-RBAC-scoped**: once dispatched, a job's stored `filters` carry no
information about which surface-level permission produced them beyond the
`surface` column itself (re-deriving "does this caller currently hold READ
on that surface" at poll/download time would also be actively wrong — a
caller whose role was changed, or who is polling on behalf of a scheduled
follow-up, should still be able to fetch a job THEY dispatched with
authorization that was valid at dispatch time). Authorization here is
instead simply "this is your own job" (`ExportJob.requested_by_user_id ==
current_user.user_id`) OR the caller is Admin (ops visibility into any job)
— any other caller gets 404 (not 403), matching this codebase's established
"hub-scope mismatch reads as not-found" convention (`api/routers/
projects.py` et al.) rather than confirming the job's existence to an
unauthorized caller.

**No presigned MinIO URL — a deliberate proxy-download design, not a
missing feature**: `GET /exports/jobs/{job_id}/download` streams the object
from MinIO through THIS FastAPI process rather than redirecting the browser
to a MinIO presigned URL, because the on-premise deployment topology
(`docs/PROJECT_AND_STACK.md` §6) puts `minio` on the same internal Docker
network as `api`/`worker`, fronted by Nginx/Traefik for browser-facing
traffic — nothing guarantees `minio:9000` (the endpoint `core.minio_config`
talks to) is reachable, or even meaningfully addressable, from a browser
outside that network. Revisit only alongside a real P6-T01 reverse-proxy
route for MinIO if direct browser-to-MinIO downloads are ever wanted.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from typing import Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Response, status
from fastapi.responses import StreamingResponse
from minio.error import S3Error
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal, require_permission
from core.minio_config import get_minio_client, get_minio_settings
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import ExportFormat, ExportJobStatus, ExportSurface, RoleName
from models.export import ExportJob
from schemas.export import ExportJobAccepted, ExportJobStatusResponse
from services.export_builder import ExportFilters, build_export_sheets, csv_bytes, xlsx_bytes

router = APIRouter(prefix="/exports", tags=["exports"])

_XLSX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"

_read_dashboard = require_permission(Surface.DASHBOARD, Action.READ)
_read_capacity = require_permission(Surface.CAPACITY, Action.READ)
_read_matrix = require_permission(Surface.MATRIX, Action.READ)
_read_gantt = require_permission(Surface.GANTT, Action.READ)
_read_registration = require_permission(Surface.PROJECT_REGISTRATION, Action.READ)
_read_capacity_planning = require_permission(Surface.CAPACITY_PLANNING, Action.READ)


def _principal_to_task_payload(principal: Principal) -> dict[str, Any]:
    """The exact inverse of `workers.export_tasks._principal_from_payload` —
    see that function's docstring. Every value here is JSON-safe (Celery's
    task serializer is JSON-only, per `workers/worker_app.py`).
    """

    return {
        "user_id": str(principal.user_id),
        "email": principal.email,
        "full_name": principal.full_name,
        "oidc_subject": principal.oidc_subject,
        "roles": sorted(r.value for r in principal.roles),
        "hub_scope_all": principal.hub_scope_all,
        "hub_ids": sorted(str(h) for h in principal.hub_ids),
    }


async def _dispatch_async_job(
    db: AsyncSession,
    principal: Principal,
    *,
    surface: ExportSurface,
    export_format: ExportFormat,
    filters: ExportFilters,
) -> ExportJobAccepted:
    from workers.export_tasks import generate_export

    job = ExportJob(
        surface=surface,
        format=export_format,
        requested_by_user_id=principal.user_id,
        filters=filters,
        status=ExportJobStatus.QUEUED,
    )
    db.add(job)
    await db.flush()

    async_result = generate_export.delay(
        str(job.id),
        principal=_principal_to_task_payload(principal),
        surface=surface.value,
        format=export_format.value,
        filters=filters,
    )
    job.celery_task_id = async_result.id
    db.add(job)

    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action="export.job_dispatch",
            entity_type="ExportJob",
            entity_id=str(job.id),
            hub_id=None,
            before_state=None,
            # `filters` only — plain query-filter parameter echoes, never row
            # data (see `models/export.py`'s docstring on why this is safe to
            # persist/audit unlike a Project/PriorityScore diff would be).
            after_state={
                "surface": surface.value,
                "format": export_format.value,
                "filters": filters,
                "status": job.status.value,
            },
        )
    )
    await db.commit()
    await db.refresh(job)
    return ExportJobAccepted(job_id=job.id, status=job.status)


async def _respond(
    db: AsyncSession,
    principal: Principal,
    *,
    response: Response,
    surface: ExportSurface,
    filters: ExportFilters,
    export_format: ExportFormat,
    async_export: bool,
    filename_stem: str,
    csv_sheet: str | None = None,
) -> StreamingResponse | ExportJobAccepted:
    if async_export:
        # 202, not 200 — mirrors `POST /schedule-runs/cp-sat-dispatch`'s own
        # "accepted, not yet done" status code for the same "created a row,
        # enqueued a background job" shape. Set on the shared `Response`
        # object (rather than a per-route decorator `status_code=`) because
        # each of these endpoints returns EITHER this JSON body (202) OR a
        # streamed file (200, `StreamingResponse` sets its own status), and a
        # decorator-level `status_code` would apply to both branches.
        response.status_code = status.HTTP_202_ACCEPTED
        return await _dispatch_async_job(
            db, principal, surface=surface, export_format=export_format, filters=filters
        )

    sheets = await build_export_sheets(db, principal, surface=surface.value, filters=filters)
    if export_format == ExportFormat.CSV:
        sheet_name = csv_sheet if csv_sheet in sheets else next(iter(sheets))
        headers, rows = sheets[sheet_name]
        content = csv_bytes(headers, rows)
        media_type = "text/csv"
        filename = f"{filename_stem}.csv"
    else:
        content = xlsx_bytes(sheets)
        media_type = _XLSX_CONTENT_TYPE
        filename = f"{filename_stem}.xlsx"

    return StreamingResponse(
        iter([content]),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/dashboard", response_model=None)
async def export_dashboard(
    response: Response,
    format: ExportFormat = ExportFormat.CSV,
    hub_id: uuid.UUID | None = None,
    category: str | None = None,
    status_: str | None = None,
    priority: str | None = None,
    async_export: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_dashboard),
) -> StreamingResponse | ExportJobAccepted:
    """The Dashboard's filterable analytics-breakdown table — see
    `services.export_builder.build_dashboard_sheets` for why this table
    specifically is "the current view" among Dashboard's several widgets.
    """

    filters: ExportFilters = {
        "hub_id": str(hub_id) if hub_id else None,
        "category": category,
        "status_": status_,
        "priority": priority,
    }
    return await _respond(
        db,
        current_user,
        response=response,
        surface=ExportSurface.DASHBOARD,
        filters=filters,
        export_format=format,
        async_export=async_export,
        filename_stem="dashboard-export",
    )


@router.get("/capacity", response_model=None)
async def export_capacity(
    response: Response,
    format: ExportFormat = ExportFormat.CSV,
    async_export: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_capacity),
) -> StreamingResponse | ExportJobAccepted:
    """Hub load vs. capacity — no filters (see `services.export_builder.
    build_capacity_sheets`)."""

    return await _respond(
        db,
        current_user,
        response=response,
        surface=ExportSurface.CAPACITY,
        filters={},
        export_format=format,
        async_export=async_export,
        filename_stem="capacity-export",
    )


@router.get("/matrix", response_model=None)
async def export_matrix(
    response: Response,
    format: ExportFormat = ExportFormat.CSV,
    currency: str | None = None,
    hub_id: uuid.UUID | None = None,
    category: str | None = None,
    async_export: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_matrix),
) -> StreamingResponse | ExportJobAccepted:
    """The 13-dimension scoring grid, including the encrypted financial
    columns for whichever rows/fields the caller's role and hub scope
    already entitle them to see via `GET /priorities` (see module
    docstring)."""

    filters: ExportFilters = {
        "currency": currency,
        "hub_id": str(hub_id) if hub_id else None,
        "category": category,
    }
    return await _respond(
        db,
        current_user,
        response=response,
        surface=ExportSurface.MATRIX,
        filters=filters,
        export_format=format,
        async_export=async_export,
        filename_stem="matrix-export",
    )


@router.get("/gantt", response_model=None)
async def export_gantt(
    response: Response,
    format: ExportFormat = ExportFormat.CSV,
    hub_id: uuid.UUID | None = None,
    project_id: uuid.UUID | None = None,
    async_export: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_gantt),
) -> StreamingResponse | ExportJobAccepted:
    """Flattened project x step rows. An Engineer caller only ever sees
    their own assignments and their own name (`services.hub_scope.
    is_engineer_self_scoped`, `docs/OPEN_QUESTIONS.md` #8) — inherited
    automatically from `GET /gantt` (see module docstring); nothing here
    widens that.
    """

    filters: ExportFilters = {
        "hub_id": str(hub_id) if hub_id else None,
        "project_id": str(project_id) if project_id else None,
    }
    return await _respond(
        db,
        current_user,
        response=response,
        surface=ExportSurface.GANTT,
        filters=filters,
        export_format=format,
        async_export=async_export,
        filename_stem="gantt-export",
    )


@router.get("/project-registration", response_model=None)
async def export_project_registration(
    response: Response,
    format: ExportFormat = ExportFormat.CSV,
    hub_id: uuid.UUID | None = None,
    category: str | None = None,
    status_: str | None = None,
    priority: str | None = None,
    type_: str | None = None,
    async_export: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_registration),
) -> StreamingResponse | ExportJobAccepted:
    """Includes the encrypted financial columns (`tcogs_eur`/
    `selling_price_eur`/`gross_margin_pct`/`customer_name`) exactly as `GET
    /projects` already serves them to an authorized caller — see module
    docstring."""

    filters: ExportFilters = {
        "hub_id": str(hub_id) if hub_id else None,
        "category": category,
        "status_": status_,
        "priority": priority,
        "type_": type_,
    }
    return await _respond(
        db,
        current_user,
        response=response,
        surface=ExportSurface.PROJECT_REGISTRATION,
        filters=filters,
        export_format=format,
        async_export=async_export,
        filename_stem="project-registration-export",
    )


@router.get("/capacity-planning", response_model=None)
async def export_capacity_planning(
    response: Response,
    format: ExportFormat = ExportFormat.CSV,
    hub_id: uuid.UUID | None = None,
    entity: Literal["engineers", "chambers"] = "engineers",
    async_export: bool = False,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_capacity_planning),
) -> StreamingResponse | ExportJobAccepted:
    """Two sheets (Engineers, Chambers) for XLSX; `entity` selects which one
    the CSV path exports (CSV is inherently single-table) — see
    `services.export_builder.build_capacity_planning_sheets`.
    """

    filters: ExportFilters = {"hub_id": str(hub_id) if hub_id else None}
    csv_sheet = "Engineers" if entity == "engineers" else "Chambers"
    return await _respond(
        db,
        current_user,
        response=response,
        surface=ExportSurface.CAPACITY_PLANNING,
        filters=filters,
        export_format=format,
        async_export=async_export,
        filename_stem=f"capacity-planning-{entity}-export",
        csv_sheet=csv_sheet,
    )


def _authorize_job_access(job: ExportJob | None, current_user: Principal) -> ExportJob:
    if job is None or (
        job.requested_by_user_id != current_user.user_id
        and RoleName.ADMIN not in current_user.roles
    ):
        # 404, not 403 — never confirms a job's existence to a caller who
        # didn't dispatch it and isn't Admin. See module docstring.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Export job not found")
    return job


@router.get("/jobs/{job_id}", response_model=ExportJobStatusResponse)
async def get_export_job_status(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> ExportJobStatusResponse:
    job = _authorize_job_access(await db.get(ExportJob, job_id), current_user)
    return ExportJobStatusResponse(
        job_id=job.id,
        surface=job.surface,
        format=job.format,
        status=job.status,
        row_count=job.row_count,
        error_message=job.error_message,
        created_at=job.created_at,
        completed_at=job.completed_at,
    )


@router.get("/jobs/{job_id}/download")
async def download_export_job(
    job_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> StreamingResponse:
    job = _authorize_job_access(await db.get(ExportJob, job_id), current_user)
    if job.status != ExportJobStatus.COMPLETED or not job.object_key:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Export job is not ready for download (status={job.status.value})",
        )

    client = get_minio_client()
    minio_settings = get_minio_settings()
    try:
        minio_response = client.get_object(minio_settings.exports_bucket, job.object_key)
    except S3Error as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to retrieve export from object storage",
        ) from exc

    def _iter_object_bytes() -> Iterator[bytes]:
        try:
            yield from minio_response.stream(32 * 1024)
        finally:
            minio_response.close()
            minio_response.release_conn()

    media_type = _XLSX_CONTENT_TYPE if job.format == ExportFormat.XLSX else "text/csv"
    extension = "xlsx" if job.format == ExportFormat.XLSX else "csv"
    filename = f"{job.surface.value}-export.{extension}"
    return StreamingResponse(
        _iter_object_bytes(),
        media_type=media_type,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
