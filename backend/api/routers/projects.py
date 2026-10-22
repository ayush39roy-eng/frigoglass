"""Project Registration surface — full CRUD on `Project`
(`docs/PROJECT_AND_STACK.md` §2), including the registration hard gate.

**P23-T02 (ADR 0034, docs/API_CONTRACT_P23.md).** Draft is retired from
registration: `POST /projects` checks the hard-gate fields up front (422
`HARD_GATE_FIELDS_MISSING`, no row written) and creates the project
`In Queue`, marked `schedule_stale`. `PATCH` rejects `status: "Draft"` (422
`DRAFT_RETIRED`). `POST /{id}/submit` stays for legacy Draft rows only.

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

**P11 (ADR 0015, docs/API_CONTRACT_P11.md §1–§2).** A priority change is a
*priority move*: `services.priority_move.apply_priority_change` writes it,
audits `project.priority_move`, sets `schedule_stale` and, when the project
is schedulable and no run is in flight, dispatches a greedy recalculation
through the Workspace recalc's Celery lifecycle. It is reached through the
new `POST /projects/{id}/priority` and through `PATCH /projects/{id}` when
the PATCH changes `priority`; the PATCH reports the outcome in the
`X-Schedule-Recalc` / `X-Schedule-Run-Id` / `X-Schedule-Baseline-Run-Id`
response headers. Hard gates pin P1 on both paths (409
`HARD_GATE_FORCES_P1`). Every other field edit still only sets
`schedule_stale` (ADR 0006).

**P14 (ADR 0026, docs/API_CONTRACT_P14.md §1).** `POST
/projects/{id}/priority/preview` runs greedy in-process and returns the
knock-on changes without writing anything; `POST /projects/{id}/priority`
with that `preview_token` applies the move and its run in-process
(`recalc_status: "applied"`). Both live in `services.priority_preview`.
"""

from __future__ import annotations

import math
import uuid
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal, require_permission
from api.errors import HTTP_422, CodedHTTPException, field_error
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)
from models.hub import Hub
from models.project import Project, category_allowed_for_hub
from scheduling.effort_split import EffortSplitRejected
from schemas.project import (
    HardGateStatus,
    PriorityMoveRequest,
    PriorityMoveResponse,
    PriorityPreviewRequest,
    PriorityPreviewResponse,
    ProjectCreateRequest,
    ProjectListItem,
    ProjectRead,
    ProjectSubmitRequest,
    ProjectUpdateRequest,
)
from services.audit_helpers import project_audit_state
from services.hub_scope import hub_scope_filter, is_hub_in_scope
from services.priority_move import apply_priority_change, ensure_priority_move_allowed
from services.priority_preview import confirm_priority_move, preview_priority_move
from services.project_access import authorize_project_action, effective_project_access
from services.project_effort import (
    TRIGGER_CREATE,
    TRIGGER_FIGURE,
    TRIGGER_PROJECT_FIELDS,
    TRIGGER_WORKFLOW_CHANGE,
    rederive_project_effort,
    split_rejected_error,
    template_kinds,
    validate_effort_split,
)
from services.project_hard_gates import (
    HARD_GATE_FIELDS,
    hard_gate_error,
    missing_hard_gate_field_names,
    missing_hard_gate_fields,
)
from services.project_steps import WorkflowChangeWithProgress, sync_project_steps
from services.rate_limit import TokenBucketLimiter
from services.scoring_tags import apply_tag_prefill
from services.text_search import Q_MAX_LENGTH, project_search_filter

router = APIRouter(prefix="/projects", tags=["projects"])

_HARD_GATE_NAMES: tuple[str, ...] = tuple(name for name, _label in HARD_GATE_FIELDS)

_read = require_permission(Surface.PROJECT_REGISTRATION, Action.READ)
_write = require_permission(Surface.PROJECT_REGISTRATION, Action.WRITE)

#: P14 contract §1: each preview is one in-process greedy pass. Per user: a
#: burst of 6, then one every 5 seconds. Per API process (see
#: `services.rate_limit` for the documented limitation). A confirm needs a
#: token from a preview, so this also bounds in-process confirms.
PRIORITY_PREVIEW_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=1 / 5)

#: P14-R01 (S1): a confirm takes the global dispatch lock and builds a full
#: snapshot before its token is checked, so it is limited per user too, and
#: BEFORE the lock. Generous: a burst of 6, then one every 2 seconds.
PRIORITY_CONFIRM_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=1 / 2)

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
        # ADR 0041: the effort figures drive the step durations (R1).
        "design_effort_weeks",
        "lab_effort_weeks",
    }
)

#: ADR 0041 R6: a change to any of these re-derives the effort split.
EFFORT_SPLIT_INPUT_FIELDS: frozenset[str] = frozenset(
    {
        "design_effort_weeks",
        "lab_effort_weeks",
        "category",
        "certification_testing_required",
        "hub_id",
    }
)
_EFFORT_FIGURES = ("design_effort_weeks", "lab_effort_weeks")


def _figures_to_decimal(data: dict[str, Any]) -> None:
    """ADR 0041: a validated effort figure (a JSON number, at most 2 dp) is
    stored as its exact decimal (`Numeric(6, 2)`), never its binary value."""

    for name in _EFFORT_FIGURES:
        if data.get(name) is not None:
            data[name] = Decimal(str(data[name])).quantize(Decimal("0.01"))


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
    q: Annotated[str | None, Query(max_length=Q_MAX_LENGTH)] = None,
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

    P13-T17: `q` is a case-insensitive substring of name or `external_code`
    (at most 100 characters, wildcards literal, bound parameter —
    `services.text_search`), ANDed like the other filters.
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
    search = project_search_filter(q)
    if search is not None:
        stmt = stmt.where(search)
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
    """Register a project (ADR 0034): it is created `In Queue`, never Draft.

    Order: RBAC (`_write`, 401/403) → unknown hub 422 → hub outside the
    caller's scope 403 → missing hard-gate fields 422
    `HARD_GATE_FIELDS_MISSING` (per-field, nothing written) → category vs
    hub workflow 422 `CATEGORY_WORKFLOW_MISMATCH` → unknown leader 422
    `UNKNOWN_LEADER`. The new project is not in the active run, so it is
    marked `schedule_stale` (no solve is triggered, ADR 0006). One
    `project.create` audit row, financial fields redacted.
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
    data = body.model_dump()
    missing = missing_hard_gate_field_names(data)
    if missing:
        raise hard_gate_error(
            missing, "Project cannot be registered: required fields missing."
        )
    mismatch = _category_mismatch(hub, body.category)
    if mismatch is not None:
        raise mismatch
    leader = await db.get(Engineer, body.leader_engineer_id)
    if leader is None:
        raise CodedHTTPException(
            HTTP_422,
            "UNKNOWN_LEADER",
            [field_error("leader_engineer_id", "Unknown leader_engineer_id")],
        )

    _figures_to_decimal(data)
    kinds = await template_kinds(db)
    # ADR 0041 R7: a figure whose split exceeds 104 weeks on a step rejects
    # the registration before anything is stored.
    try:
        await validate_effort_split(
            db,
            hub_is_oem=hub.is_oem,
            category=body.category,
            design_effort_weeks=data.get("design_effort_weeks"),
            lab_effort_weeks=data.get("lab_effort_weeks"),
            certification_testing_required=body.certification_testing_required,
        )
    except EffortSplitRejected as exc:
        raise split_rejected_error(exc, kinds) from exc
    project = Project(**data, status=ProjectStatus.IN_QUEUE, schedule_stale=True)
    db.add(project)
    await db.flush()
    await sync_project_steps(db, project, hub.is_oem)
    # ADR 0041 R6: the effort split of a new project's figures (same
    # transaction).
    await rederive_project_effort(
        db, project, trigger=TRIGGER_CREATE, actor_user_id=current_user.user_id, kinds=kinds
    )
    # ADR 0038: every tag of a new project is a not-set -> set transition.
    await apply_tag_prefill(
        db, project, before=[], after=project.scoring_tags, principal=current_user
    )

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
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> Project:
    """Partial update. See `schemas.project.ProjectUpdateRequest`'s docstring:
    `frozen` is not settable here (use the Gantt freeze toggle), and `status`
    may not be used to leave `Draft` here (use `POST /{id}/submit`, which
    runs the hard-gate check). ADR 0034: `status: "Draft"` is never
    accepted (422 `DRAFT_RETIRED`), not even as a no-op on a legacy Draft
    row. `In Buyoff` is a schedulable status and stays settable.

    2026-09-30 (ADR 0012): every Registration charter field here is
    Admin-grain-only — an Editor-level `ProjectAccessGrant` may NEVER write
    here (its write set is exactly stage-progress PATCH, file upload and
    comment post, all on the Workspace surface, none of them this one).

    2026-10-09 (ADR 0015): a `priority` change is a priority move, applied
    last by `services.priority_move.apply_priority_change` after every other
    field, so the recalculation reads the final state. Its hard-gate check
    runs first, before anything is written. A priority-only PATCH is
    audited by the `project.priority_move` row alone; a PATCH that also
    changes other fields writes `project.update` for those as well. The
    response headers report the recalc outcome (contract §2).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    updates = body.model_dump(exclude_unset=True)

    if updates.get("status") == ProjectStatus.DRAFT:
        raise CodedHTTPException(
            HTTP_422,
            "DRAFT_RETIRED",
            [field_error("status", "Draft is no longer a project status (ADR 0034).")],
        )
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
                "certification_testing_required", "scoring_tags"):
        if key in updates and updates[key] is None:
            raise CodedHTTPException(
                HTTP_422, "NULL_NOT_ALLOWED", f"{key} may not be null"
            )

    # ADR 0015: the priority is applied last, as a priority move.
    new_priority: ProjectPriority | None = updates.pop("priority", project.priority)
    priority_moves = new_priority != project.priority
    if priority_moves:
        target_status = updates.get("status", project.status)
        if new_priority is None and target_status not in NON_SCHEDULABLE_STATUSES:
            # The scheduler needs a priority for every schedulable project;
            # clearing it would queue a run that can only fail.
            raise CodedHTTPException(
                HTTP_422,
                "NULL_NOT_ALLOWED",
                "priority may not be null while the project's status is schedulable",
            )
        await ensure_priority_move_allowed(db, project, new_priority)

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

    _figures_to_decimal(updates)
    effort_target = {
        name: updates[name] if name in updates else getattr(project, name)
        for name in (*_EFFORT_FIGURES, "certification_testing_required")
    }
    if any(name in updates for name in EFFORT_SPLIT_INPUT_FIELDS):
        # ADR 0041 R7 before anything is written: the split the PATCHed
        # project would get (frozen projects included: a figure stored while
        # frozen must apply on unfreeze).
        try:
            await validate_effort_split(
                db,
                hub_is_oem=target_hub.is_oem,
                category=target_category,
                design_effort_weeks=effort_target["design_effort_weeks"],
                lab_effort_weeks=effort_target["lab_effort_weeks"],
                certification_testing_required=bool(
                    effort_target["certification_testing_required"]
                ),
                project_id=project.id,
            )
        except EffortSplitRejected as exc:
            raise split_rejected_error(exc, await template_kinds(db)) from exc
    before_state = project_audit_state(project)
    tags_before = list(project.scoring_tags or [])
    figures_changed = any(
        name in updates and getattr(project, name) != updates[name] for name in _EFFORT_FIGURES
    )
    workflow_changes = target_hub.is_oem != current_hub.is_oem
    effort_inputs_changed = any(
        getattr(project, name) != value
        for name, value in updates.items()
        if name in EFFORT_SPLIT_INPUT_FIELDS
    )
    schedule_inputs_changed = any(
        getattr(project, name) != value
        for name, value in updates.items()
        if name in SCHEDULE_INPUT_FIELDS
    )
    if (
        "leader_engineer_id" in updates
        and updates["leader_engineer_id"] != project.leader_engineer_id
    ):
        # ADR 0042 §7 (P29): a person chose the leader, so it is no longer the
        # seed's / migration's provisional pick.
        project.leader_is_provisional = False
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
    if effort_inputs_changed:
        # ADR 0041 R6: figure edit, category / certification change or a hub
        # move (PDD <-> OEM re-points the steps). A no-op on a frozen
        # project (I10); R7 rejects the whole PATCH.
        # Validated above, so this cannot be rejected (R7).
        await rederive_project_effort(
            db,
            project,
            trigger=(
                TRIGGER_WORKFLOW_CHANGE
                if workflow_changes
                else TRIGGER_FIGURE
                if figures_changed
                else TRIGGER_PROJECT_FIELDS
            ),
            actor_user_id=current_user.user_id,
        )
    if "scoring_tags" in updates:
        # ADR 0038: only a not-set -> set tag pre-fills its score (same
        # transaction); `scoring_tags` is not a scheduler input, so it never
        # sets `schedule_stale`.
        await apply_tag_prefill(
            db, project, before=tags_before, after=project.scoring_tags, principal=current_user
        )
    after_state = project_audit_state(project)
    if priority_moves:
        # The move is applied below, in the same commit; the snapshot shows
        # the project as it will be stored.
        after_state["priority"] = new_priority.value if new_priority is not None else None

    if updates or not priority_moves:
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
    if priority_moves:
        # Commits everything above together with the move.
        move = await apply_priority_change(db, project, new_priority, current_user)
        response.headers.update(move.response_headers())
    else:
        await db.commit()
    await db.refresh(project)
    return project


@router.post("/{project_id}/priority", response_model=PriorityMoveResponse)
async def move_project_priority(
    project_id: uuid.UUID,
    body: PriorityMoveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> PriorityMoveResponse:
    """ADR 0015 priority move (docs/API_CONTRACT_P11.md §1). Always 200;
    `recalc_status` says what happened. 409 `HARD_GATE_FORCES_P1` when the
    project has hard gates and the target is not P1.

    Permission is exactly the PATCH's: the hub-scoped lookup (404 out of
    scope) and Registration WRITE or an Admin-level project grant (403
    otherwise). The recalculation is a consequence of the write, not a
    separate permission.
    """

    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    if body.preview_token is not None:
        # P14 (ADR 0026 §2): confirm a preview, applied in-process.
        allowed, retry_after = PRIORITY_CONFIRM_RATE_LIMIT.allow(
            f"priority-confirm:{current_user.user_id}"
        )
        if not allowed:
            raise CodedHTTPException(
                status.HTTP_429_TOO_MANY_REQUESTS,
                "RATE_LIMITED",
                "Too many timeline confirmations. Please wait a moment and try again.",
                headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
            )
        return await confirm_priority_move(
            db, project, body.priority, current_user, body.preview_token
        )
    move = await apply_priority_change(db, project, body.priority, current_user)
    assert move.priority_after is not None  # the request schema forbids null
    return PriorityMoveResponse(
        project_id=move.project_id,
        priority_before=move.priority_before,
        priority_after=move.priority_after,
        recalc_status=move.recalc_status,
        schedule_run_id=move.schedule_run_id,
        baseline_run_id=move.baseline_run_id,
        task_id=move.task_id,
    )


@router.post("/{project_id}/priority/preview", response_model=PriorityPreviewResponse)
async def preview_project_priority(
    project_id: uuid.UUID,
    body: PriorityPreviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> PriorityPreviewResponse:
    """P14 (ADR 0026 §1, docs/API_CONTRACT_P14.md §1): what a priority move
    would change, computed by an in-process greedy pass. Writes nothing.

    Permission is identical to `POST /projects/{id}/priority` (404 out of
    scope, 403 without Registration WRITE or an Admin-level grant). 409
    `HARD_GATE_FORCES_P1`, 429 `RATE_LIMITED`, 503 `PREVIEW_TIMEOUT`.
    Changed projects outside the caller's scope are only counted
    (`hidden_count`).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    allowed, retry_after = PRIORITY_PREVIEW_RATE_LIMIT.allow(
        f"priority-preview:{current_user.user_id}"
    )
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many timeline previews. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )
    return await preview_priority_move(db, project, body.priority, current_user)


@router.post("/{project_id}/submit", response_model=ProjectRead)
async def submit_project(
    project_id: uuid.UUID,
    body: ProjectSubmitRequest = ProjectSubmitRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> Project:
    """Legacy only (ADR 0034): nothing creates Draft any more, but a historic
    Draft row still leaves it here, per `docs/PROJECT_AND_STACK.md` §2's
    hard gate. 422 `HARD_GATE_FIELDS_MISSING` (the same shape as
    `POST /projects`) if any hard-gate field is still unset; otherwise
    transitions to `body.target_status` (default `In Queue`).
    """

    project = await _get_project_or_404(db, project_id, current_user)
    # P12-R01: the lookup admits an out-of-scope project on any grant, so the
    # role-level `_write` alone is not enough; the project must be in the
    # caller's hub scope or carry an Admin-level grant.
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
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

    missing = missing_hard_gate_field_names(
        {name: getattr(project, name) for name in _HARD_GATE_NAMES}
    )
    if missing:
        raise hard_gate_error(
            missing, "Project cannot leave Draft status: required fields missing."
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
