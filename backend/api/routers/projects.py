"""Project Registration surface — full CRUD on `Project`
(`docs/PROJECT_AND_STACK.md` §2), including the Draft hard-gate.

**RBAC (P3-T02)**: every endpoint below requires a real, validated OIDC
token (`api.deps.get_current_principal` — 401 if missing/invalid) and
action-level permission on the `PROJECT_REGISTRATION` surface
(`core.rbac.Surface.PROJECT_REGISTRATION`) per `docs/PROJECT_AND_STACK.md`
§5: reads need `READ`, mutations need `WRITE` (Portfolio Manager, Hub
Planner, Admin only — Engineer/Executive Viewer/Auditor get 403 on
everything here).

**Hub-scoped (P3-T03)**: every read/write below is additionally filtered to
the caller's own hub(s) via `services.hub_scope`, unless
`current_user.hub_scope_all` (Portfolio Manager/Admin — Executive Viewer is
READ-only elsewhere and has no access to this surface at all per the
matrix). A Hub Planner's list is silently filtered; a direct `GET
/projects/{id}` (or PATCH/submit) on an out-of-scope project 404s exactly
like a nonexistent one, never 200s with cross-hub data. Creating/moving a
project to a hub outside the caller's scope 403s (`services.hub_scope.
is_hub_in_scope`) — there is no existing row to scope-filter a lookup
against for a `POST`/for a `hub_id` reassignment, so that check is explicit.

**P9-T03 (docs/API_CONTRACT_P9.md §6).** The new fields are
`target_end_week`, `certification_testing_required` and
`estimated_*_weeks`; reads also carry `schedule_stale` and `workflow_id`.
A category that does not match the hub's workflow is a 422
`CATEGORY_WORKFLOW_MISMATCH` (`models.project.category_allowed_for_hub`).
Creating a project also creates its 14 live stage rows
(`services.project_steps`); a hub or category change re-syncs them and their
lead-time durations. Editing a scheduler input sets `schedule_stale`.
`Cancelled` is a valid status and, like On Hold, is excluded from
scheduling.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal, require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import ProjectCategory, ProjectPriority, ProjectStatus, ProjectType
from models.hub import Hub
from models.project import Project, category_allowed_for_hub
from schemas.project import (
    HardGateStatus,
    ProjectCreateRequest,
    ProjectListItem,
    ProjectRead,
    ProjectSubmitRequest,
    ProjectUpdateRequest,
)
from services.audit_helpers import project_audit_state
from services.hub_scope import hub_scope_filter, is_hub_in_scope
from services.project_access import authorize_project_action, effective_project_access
from services.project_hard_gates import missing_hard_gate_fields
from services.project_steps import WorkflowChangeWithProgress, sync_project_steps

router = APIRouter(prefix="/projects", tags=["projects"])

_read = require_permission(Surface.PROJECT_REGISTRATION, Action.READ)
_write = require_permission(Surface.PROJECT_REGISTRATION, Action.WRITE)

#: Project fields that are scheduler inputs. Changing any of them sets
#: `schedule_stale` (P9-T03), the same banner a progress edit raises. A
#: solve is never triggered (ADR 0006).
SCHEDULE_INPUT_FIELDS: frozenset[str] = frozenset(
    {
        "hub_id",
        "leader_engineer_id",
        "category",
        "priority",
        "status",
        "actual_start_week",
        "delay_weeks",
        "target_end_week",
        "certification_testing_required",
    }
)


def _category_mismatch(hub: Hub, category: ProjectCategory | None) -> CodedHTTPException | None:
    """DOMAIN_RULES "Lead times": OEM hubs use A-OEM/B-OEM/C-OEM, every other
    hub A+/A/B/C. Checked here to give a 422 before the DB trigger
    `trg_projects_category_matches_hub` would raise.
    """

    if category_allowed_for_hub(hub.is_oem, category):
        return None
    assert category is not None
    workflow = "OEM" if hub.is_oem else "PDD"
    return CodedHTTPException(
        HTTP_422,
        "CATEGORY_WORKFLOW_MISMATCH",
        f"Category {category.value!r} is not valid for hub {hub.name.value!r} "
        f"(workflow {workflow}).",
    )


async def _get_project_or_404(
    db: AsyncSession, project_id: uuid.UUID, principal: Principal
) -> Project:
    """2026-09-30 (ADR 0012, P10-T02): falls back to
    `services.project_access.effective_project_access` when the plain
    hub-scope lookup finds nothing — the same "a grant can surface a project
    hub scope alone would not" composition as the Workspace surface's
    identical fallback (`services.workspace.get_scoped_project_or_404`):
    accepts ANY resolved role (Viewer or above), not just Admin. The WRITE
    path (`update_project`, below) is where the real ADR 0012 §1 distinction
    is enforced — only a project-scoped Admin grant may write Registration,
    via its own `authorize_project_action(..., min_grant_role="admin")`
    call — so a Viewer/Editor grantee can reach a 403 there (a definite,
    specific "you may look but not touch" signal) instead of an
    existence-hiding 404, matching this task's required behaviour.
    """

    stmt = select(Project).where(Project.id == project_id)
    hub_filter = hub_scope_filter(principal, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    result = await db.execute(stmt)
    project = result.scalar_one_or_none()
    if project is not None:
        return project

    fallback = (
        await db.execute(select(Project).where(Project.id == project_id))
    ).scalar_one_or_none()
    if fallback is not None and await effective_project_access(db, principal, fallback) is not None:
        return fallback
    raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Project not found")


@router.get("", response_model=list[ProjectListItem])
async def list_projects(
    hub_id: uuid.UUID | None = None,
    category: ProjectCategory | None = None,
    status_: ProjectStatus | None = None,
    priority: ProjectPriority | None = None,
    type_: ProjectType | None = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[Project]:
    """List/filter projects. Requires READ on the Project Registration
    surface (401/403 enforced by `_read`, P3-T02) and is hub-scoped
    (P3-T03): a Hub Planner only ever sees their own hub(s)' projects here,
    server-side (`services.hub_scope.hub_scope_filter`), regardless of what
    `hub_id` the caller passes — an explicit out-of-scope `hub_id` query
    param simply yields an empty list (the AND of both filters), not a 403,
    matching this endpoint's existing "filter narrows silently" convention
    for its other query params.
    """

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")

    stmt = select(Project)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    if category is not None:
        stmt = stmt.where(Project.category == category)
    if status_ is not None:
        stmt = stmt.where(Project.status == status_)
    if priority is not None:
        stmt = stmt.where(Project.priority == priority)
    if type_ is not None:
        stmt = stmt.where(Project.type == type_)
    stmt = stmt.order_by(Project.name).limit(limit).offset(offset)

    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Project:
    return await _get_project_or_404(db, project_id, current_user)


@router.get("/{project_id}/hard-gate-status", response_model=HardGateStatus)
async def get_hard_gate_status(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> HardGateStatus:
    """Which required fields are still missing before this project can leave
    `Draft` (`services.project_hard_gates.missing_hard_gate_fields`). Read-only
    — does not mutate anything, so no audit row.
    """

    project = await _get_project_or_404(db, project_id, current_user)
    missing = missing_hard_gate_fields(project)
    return HardGateStatus(can_leave_draft=not missing, missing_fields=missing)


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Create a new project — always starts in `Draft`
    (`ProjectStatus.DRAFT`), regardless of how fully the body is filled in.
    """

    hub = (await db.execute(select(Hub).where(Hub.id == body.hub_id))).scalar_one_or_none()
    if hub is None:
        raise HTTPException(
            status_code=HTTP_422, detail="Unknown hub_id"
        )
    if not is_hub_in_scope(current_user, body.hub_id):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Cannot create a project for a hub outside your assigned hub scope.",
        )
    mismatch = _category_mismatch(hub, body.category)
    if mismatch is not None:
        raise mismatch

    data = body.model_dump()
    project = Project(**data, status=ProjectStatus.DRAFT)
    db.add(project)
    await db.flush()
    await sync_project_steps(db, project, hub.is_oem)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.create",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=None,
            after_state=project_audit_state(project),
        )
    )
    await db.commit()
    await db.refresh(project)
    return project


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: uuid.UUID,
    body: ProjectUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> Project:
    """Partial update. See `schemas.project.ProjectUpdateRequest`'s docstring:
    `frozen` is not settable here (use the Gantt freeze toggle), and `status`
    may not be used to leave `Draft` here (use `POST /{id}/submit`, which
    runs the hard-gate check).

    2026-09-30 (ADR 0012): every Registration charter field here is
    Admin-grain-only — an Editor-level `ProjectAccessGrant` may NEVER write
    here (its write set is exactly stage-progress PATCH, file upload and
    comment post, all on the Workspace surface, none of them this one).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    updates = body.model_dump(exclude_unset=True)

    if "status" in updates and project.status == ProjectStatus.DRAFT:
        new_status = updates["status"]
        if new_status != ProjectStatus.DRAFT:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=(
                    "Cannot change status away from Draft via PATCH — use "
                    f"POST /projects/{project_id}/submit, which runs the hard-gate check."
                ),
            )

    for key in ("name", "hub_id", "status", "delay_weeks", "carry_over",
                "certification_testing_required"):
        if key in updates and updates[key] is None:
            raise CodedHTTPException(
                HTTP_422, "NULL_NOT_ALLOWED", f"{key} may not be null"
            )

    current_hub = (await db.execute(select(Hub).where(Hub.id == project.hub_id))).scalar_one()
    target_hub = current_hub
    if "hub_id" in updates and updates["hub_id"] is not None:
        hub_result = await db.execute(select(Hub).where(Hub.id == updates["hub_id"]))
        hub = hub_result.scalar_one_or_none()
        if hub is None:
            raise HTTPException(
                status_code=HTTP_422, detail="Unknown hub_id"
            )
        # Moving a project to a different hub is itself a hub-scoped write —
        # a Hub Planner may not reassign a project (even one already in
        # their own scope) to a hub outside it.
        if not is_hub_in_scope(current_user, updates["hub_id"]):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot move a project to a hub outside your assigned hub scope.",
            )
        target_hub = hub

    target_category = updates["category"] if "category" in updates else project.category
    mismatch = _category_mismatch(target_hub, target_category)
    if mismatch is not None:
        raise mismatch

    before_state = project_audit_state(project)
    schedule_inputs_changed = any(
        getattr(project, name) != value
        for name, value in updates.items()
        if name in SCHEDULE_INPUT_FIELDS
    )
    for field_name, value in updates.items():
        setattr(project, field_name, value)
    if schedule_inputs_changed:
        project.schedule_stale = True
    await db.flush()
    if "hub_id" in updates or "category" in updates:
        try:
            await sync_project_steps(db, project, target_hub.is_oem)
        except WorkflowChangeWithProgress as exc:
            await db.rollback()
            raise CodedHTTPException(
                HTTP_422, "WORKFLOW_CHANGE_WITH_PROGRESS", str(exc)
            ) from exc
    after_state = project_audit_state(project)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.update",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(project)
    return project


@router.post("/{project_id}/submit", response_model=ProjectRead)
async def submit_project(
    project_id: uuid.UUID,
    body: ProjectSubmitRequest = ProjectSubmitRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Leave `Draft` status, per `docs/PROJECT_AND_STACK.md` §2's hard gate:
    "Hard gates enforce required fields before a project can leave draft
    status." 422s with the list of missing fields if any hard-gate field is
    still unset; otherwise transitions to `body.target_status` (default
    `In Queue`).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    if project.status != ProjectStatus.DRAFT:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Project is not in Draft status (currently {project.status.value!r})",
        )
    disallowed_targets = (
        ProjectStatus.DRAFT,
        ProjectStatus.COMMERCIALIZED,
        ProjectStatus.ON_HOLD,
        ProjectStatus.CANCELLED,
    )
    if body.target_status in disallowed_targets:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                f"target_status must be one of the four schedulable statuses "
                f"(In Buyoff/Under Industrialization/In Development/In Queue), "
                f"got {body.target_status.value!r}"
            ),
        )

    missing = missing_hard_gate_fields(project)
    if missing:
        raise HTTPException(
            status_code=HTTP_422,
            detail={
                "message": "Project cannot leave Draft status: required fields missing.",
                "missing_fields": missing,
            },
        )

    before_state = project_audit_state(project)
    project.status = body.target_status
    # Newly schedulable and not in the active run yet (P9-T03).
    project.schedule_stale = True
    await db.flush()
    after_state = project_audit_state(project)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.submit",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state=before_state,
            after_state=after_state,
        )
    )
    await db.commit()
    await db.refresh(project)
    return project
