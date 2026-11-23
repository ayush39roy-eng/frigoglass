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
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal, principal_can, require_permission
from api.errors import HTTP_422, CodedHTTPException, field_error
from api.query_params import (
    MAX_FILTER_VALUES,
    CategoryListQuery,
    HubIdListQuery,
    PriorityListQuery,
    StatusListQuery,
    TypeListQuery,
)
from api.super_admin import ensure_super_admin
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.engineer import Engineer
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)
from models.hub import Hub
from models.project import Project, category_allowed_for_hub, workflow_id_for_hub
from models.types import FINANCIAL_FIELD_NAMES
from scheduling.effort_split import EffortSplitRejected
from schemas.project import (
    BandRankMoveRequest,
    BandRankPreviewRequest,
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
    RegisterEditEffChange,
    RegisterEditError,
    RegisterEditPatch,
    RegisterEditsRequest,
    RegisterEditsResponse,
    RegisterStepRead,
    RegisterStepsRead,
)
from services.active_run import get_active_run
from services.audit_helpers import project_audit_state
from services.band_rank import (
    BandSizes,
    band_sizes,
    lock_band_ranks,
    plan_batch_band_ranks,
    reconcile_band_rank,
    with_band_size,
)
from services.categories import CategoryCatalog, check_category_code, load_catalog
from services.category_type_filter import any_of, category_type_filter
from services.edit_conflict import (
    AuditRef,
    FieldConflict,
    edit_conflict_error,
    find_conflicts,
    path_changed,
    raise_edit_conflict,
)
from services.engineer_status import (
    CAUSE_PROJECT_UPDATE,
    CAUSE_REGISTER_EDIT,
    CAUSE_REGISTRATION,
    CLOSED_STATUSES,
    check_leader_write,
    lock_engineers,
    record_leader_change,
)
from services.hub_scope import global_hub_filter, hub_scope_filter, is_hub_in_scope
from services.plan_clock import PlanClock, get_plan_clock
from services.plan_clock import now as plan_clock_now
from services.priority_applicability import priority_applicable, priority_filter_predicate
from services.priority_move import (
    AutoRecalcOutcome,
    add_priority_move_audit,
    apply_priority_change,
    decide_auto_recalc_batch,
    dispatch_auto_recalc_batch,
    ensure_priority_move_allowed,
)
from services.priority_preview import (
    confirm_band_rank_move,
    confirm_priority_move,
    preview_band_rank_move,
    preview_priority_move,
)
from services.project_access import authorize_project_action, effective_project_access
from services.project_cards import build_project_cards
from services.project_effort import (
    TRIGGER_CREATE,
    TRIGGER_FIGURE,
    TRIGGER_PROJECT_FIELDS,
    TRIGGER_WORKFLOW_CHANGE,
    exclusion_guard_error,
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
from services.register_steps import (
    StepEdits,
    apply_step_edits,
    build_step_views,
    live_current_step_id,
    load_step_context,
    project_eff_map,
)
from services.scoring_tags import apply_tag_prefill
from services.template_copy import CopyChanges, merge_copy_changes, share_lock_categories
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


def _category_mismatch(
    hub: Hub, category: str | None, catalog: CategoryCatalog
) -> CodedHTTPException | None:
    """DOMAIN_RULES "Lead times" / ADR 0047 §5: the category must belong to the
    hub's workflow (`categories.workflow_id`; OEM hubs use the OEM workflow's
    categories, every other hub the PDD workflow's). Checked here to give a
    422 before the DB trigger `trg_projects_category_matches_hub` would raise.
    """

    if category_allowed_for_hub(hub.is_oem, category, catalog.workflow_by_code):
        return None
    assert category is not None
    workflow = "OEM" if hub.is_oem else "PDD"
    return CodedHTTPException(
        HTTP_422,
        "CATEGORY_WORKFLOW_MISMATCH",
        f"Category {category!r} is not valid for hub {hub.name.value!r} "
        f"(workflow {workflow}).",
    )


def _actual_end_before_start(
    project: Project, updates: dict[str, Any]
) -> CodedHTTPException | None:
    """P35 (D35-3): with the PATCH applied, `actual_end_week` may not be
    before `actual_start_week`. Either side null passes (an end without a
    start is allowed, as is clearing either)."""

    start = updates["actual_start_week"] if "actual_start_week" in updates else (
        project.actual_start_week
    )
    end = updates["actual_end_week"] if "actual_end_week" in updates else project.actual_end_week
    if start is None or end is None or end >= start:
        return None
    field = "actual_end_week" if "actual_end_week" in updates else "actual_start_week"
    return CodedHTTPException(
        HTTP_422,
        "ACTUAL_END_BEFORE_START",
        [field_error(field, f"Actual end week {end} is before actual start week {start}.")],
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


async def _authorize_registration_write(
    db: AsyncSession, project: Project, principal: Principal
) -> None:
    await authorize_project_action(
        db, principal, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )


def project_read_for(
    project: Project, principal: Principal, sizes: BandSizes
) -> ProjectRead:
    """`ProjectRead` of a written project. P47-R01 (security M-2): the four
    financial fields are decrypted only for a caller with Project
    Registration READ, as on the Workspace; anyone else (e.g. an Engineer
    with an Admin project grant) gets `null` and the values are never read.
    P54 (ADR 0064 R1): `band_size` from `sizes` (`services.band_rank.band_sizes`)."""

    if principal_can(principal, Surface.PROJECT_REGISTRATION, Action.READ):
        return with_band_size(ProjectRead.model_validate(project), sizes)
    data: dict[str, Any] = {
        name: getattr(project, name)
        for name in ProjectRead.model_fields
        if name not in FINANCIAL_FIELD_NAMES
        and name not in ("band_size", "hub_rank", "hub_band_size")
    }
    return with_band_size(
        ProjectRead.model_validate({**data, **dict.fromkeys(FINANCIAL_FIELD_NAMES)}), sizes
    )


def refuse_hidden_financials(
    principal: Principal, sent: set[str], base: Mapping[str, Any]
) -> None:
    """P47-R01 (security M-2): a caller who cannot read the financial fields
    may not send them, in the edit or in its `base` (422
    `FINANCIAL_FIELDS_HIDDEN`, nothing written), so neither the write nor the
    409-vs-200 of a `base` can probe a value it may not see."""

    if principal_can(principal, Surface.PROJECT_REGISTRATION, Action.READ):
        return
    named = sorted((sent | set(base)) & FINANCIAL_FIELD_NAMES)
    if named:
        raise CodedHTTPException(
            HTTP_422,
            "FINANCIAL_FIELDS_HIDDEN",
            [
                field_error(name, "You cannot see or edit this financial field.")
                for name in named
            ],
        )


async def _lock_bands_and_reload(
    db: AsyncSession, project: Project, principal: Principal
) -> Project:
    """P36-R01 (security M-1 / L-2): the caller has already looked the
    project up and authorised the write with plain SELECTs (no lock taken, so
    an unauthorised caller never waits on or holds the band-rank lock), and
    applied its rate limit. Now take the band-rank lock (R36-8: the first
    lock of the write, bounded by `lock_timeout`, 503 `BAND_RANK_BUSY`),
    re-read the project under it, and re-check hub scope + permission on the
    re-read row (its hub may have changed while this request waited)."""

    await lock_band_ranks(db)
    await db.refresh(project)
    reloaded = await _get_project_or_404(db, project.id, principal)
    await _authorize_registration_write(db, reloaded, principal)
    return reloaded


async def _lock_project_row_for_base(
    db: AsyncSession, project: Project, updates: Mapping[str, Any], principal: Principal
) -> Project:
    """P47 (ADR 0059 C1): the single PATCH with a `base` locks its row
    `FOR UPDATE` and re-reads it, in the register batch's lock order (band
    rank lock if any, taken by the caller -> categories `FOR SHARE` ->
    leader engineers `FOR SHARE` -> the project row), so the comparison and
    the write see the same stored values. Scope and permission are re-checked
    on the re-read row. A PATCH without `base` is unchanged."""

    if updates.keys() & EFFORT_SPLIT_INPUT_FIELDS:
        await share_lock_categories(db, [project.category, updates.get("category")])
    leader_ids: set[uuid.UUID] = set()
    if updates.get("leader_engineer_id") is not None:
        leader_ids.add(updates["leader_engineer_id"])
    if (
        "status" in updates
        and project.status in CLOSED_STATUSES
        and project.leader_engineer_id is not None
    ):
        leader_ids.add(project.leader_engineer_id)
    await lock_engineers(db, leader_ids, share=True)
    await db.execute(
        select(Project)
        .where(Project.id == project.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    reloaded = await _get_project_or_404(db, project.id, principal)
    await _authorize_registration_write(db, reloaded, principal)
    return reloaded


def _step_exclusion_base(value: Any) -> dict[str, Any]:
    """`base.step_exclusions` as `{step_code: excluded}`; the request's own
    list shape (`[{step_code, step_excluded}]`) is accepted too."""

    if isinstance(value, Mapping):
        return {str(k): v for k, v in value.items()}
    if isinstance(value, list):
        return {
            str(x["step_code"]): x.get("step_excluded")
            for x in value
            if isinstance(x, Mapping) and "step_code" in x
        }
    return {}


def _excluded_step_changed(step_code: str) -> Any:
    """P47: a `project.step_excluded` / `project.step_included` audit row of
    `step_code` that changed the flag."""

    def matches(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> bool:
        if not isinstance(after, Mapping) or after.get("step_id") != step_code:
            return False
        if "step_excluded" not in after:
            return False
        old = before.get("step_excluded") if isinstance(before, Mapping) else None
        return bool(old != after["step_excluded"])

    return matches


async def project_conflicts(
    db: AsyncSession,
    project: Project,
    base: Mapping[str, Any] | None,
    updates: Mapping[str, Any],
    *,
    step_edits: StepEdits | None = None,
) -> list[FieldConflict]:
    """P47 (ADR 0059 C1): the project fields of `updates` (and the register
    popup's `step_exclusions` / `current_step_code`) whose stored value is
    no longer `base`. Call under the project row lock, before any write.
    `step_exclusions` compare per step (`step_exclusions.<code>`, the stored
    `excluded` flag); `current_step_code` compares with the live current step
    (`services.register_steps.live_current_step_id`)."""

    if not base:
        return []
    pid = str(project.id)
    requested: dict[str, Any] = dict(updates)
    flat_base: dict[str, Any] = {k: v for k, v in base.items() if k != "step_exclusions"}
    step_current: dict[str, Any] = {}
    wants_steps = step_edits is not None and (
        ("step_exclusions" in base and step_edits.exclusions)
        or ("current_step_code" in base and step_edits.current_step_code is not None)
    )
    if wants_steps:
        assert step_edits is not None
        ctx = await load_step_context(db, project, workflow_id=await _workflow_id(db, project))
        if "step_exclusions" in base:
            for code, excluded in _step_exclusion_base(base["step_exclusions"]).items():
                flat_base[f"step_exclusions.{code}"] = excluded
            for code, excluded in step_edits.exclusions:
                key = f"step_exclusions.{code}"
                requested[key] = excluded
                row = ctx.rows.get(code)
                step_current[key] = row.excluded if row is not None else None
        if step_edits.current_step_code is not None:
            requested["current_step_code"] = step_edits.current_step_code
            step_current["current_step_code"] = live_current_step_id(project, ctx)

    def current(name: str) -> Any:
        if name in step_current:
            return step_current[name]
        return getattr(project, name, None)

    def refs(name: str) -> Sequence[AuditRef]:
        if name.startswith("step_exclusions."):
            code = name.split(".", 1)[1]
            return (AuditRef("Project", pid, _excluded_step_changed(code)),)
        return (AuditRef("Project", pid, path_changed(name)),)

    return find_conflicts(
        entity="project",
        entity_id=pid,
        label=project.name,
        base=flat_base,
        requested={k: v for k, v in requested.items() if k in flat_base},
        current=current,
        refs=refs,
        hub_id=project.hub_id,
    )


async def check_project_base(
    db: AsyncSession,
    principal: Principal,
    project: Project,
    base: Mapping[str, Any] | None,
    updates: Mapping[str, Any],
) -> None:
    """`project_conflicts`, then the 409 `EDIT_CONFLICT` if any."""

    await raise_edit_conflict(db, principal, await project_conflicts(db, project, base, updates))


@router.get("", response_model=list[ProjectListItem])
async def list_projects(
    hub_id: HubIdListQuery = None,
    category: CategoryListQuery = None,
    status_: StatusListQuery = None,
    priority: PriorityListQuery = None,
    type_: TypeListQuery = None,
    legacy_type: Annotated[
        list[ProjectType] | None,
        Query(
            alias="type_",
            description=(
                "Pre-P31 spelling of `type`, still accepted (repeatable). "
                "Its values are ORed with `type`."
            ),
            max_length=MAX_FILTER_VALUES,
        ),
    ] = None,
    q: Annotated[str | None, Query(max_length=Q_MAX_LENGTH)] = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> list[ProjectListItem]:
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

    P31 (`docs/API_CONTRACT_P31.md`): `category` and `type` are repeatable
    (OR within a param, AND across, absent = all). The pre-P31 wire name
    `type_` is still accepted and joins the `type` list.
    """

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")

    stmt = select(Project)
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # ADR 0051: `hub_id`, `status_`, `priority` are lists (OR within, AND
    # across), ANDed with the scope above, so they only ever narrow.
    chosen_hubs = global_hub_filter(Project.hub_id, hub_id)
    if chosen_hubs is not None:
        stmt = stmt.where(chosen_hubs)
    selection = category_type_filter(category, [*(type_ or []), *(legacy_type or [])])
    if selection is not None:
        stmt = stmt.where(selection)
    status_filter = any_of(Project.status, status_)
    if status_filter is not None:
        stmt = stmt.where(status_filter)
    # ADR 0067: the effective band, so P4 never matches a Commercialized /
    # Cancelled project; `not_applicable` selects exactly those.
    priority_filter = priority_filter_predicate(priority)
    if priority_filter is not None:
        stmt = stmt.where(priority_filter)
    search = project_search_filter(q)
    if search is not None:
        stmt = stmt.where(search)
    stmt = stmt.order_by(Project.name).limit(limit).offset(offset)

    result = await db.execute(stmt)
    # P54 (ADR 0064 R1): read-only `band_rank` / `band_size`; one grouped
    # count for the whole page (full band, all hubs), never per row.
    sizes = await band_sizes(db)
    return [
        with_band_size(ProjectListItem.model_validate(p), sizes)
        for p in result.scalars().all()
    ]


@router.get("/{project_id}", response_model=ProjectRead)
async def get_project(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ProjectRead:
    project = await _get_project_or_404(db, project_id, current_user)
    # P54 (ADR 0064 R1): the registration form's "Rank in P1: n of m".
    return with_band_size(ProjectRead.model_validate(project), await band_sizes(db))


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


#: P53 (R53-8): a target end may lie at most 520 weeks past the calendar week.
TARGET_END_MAX_AHEAD = 520



async def _ensure_external_code_free(
    db: AsyncSession, code: str | None, exclude_id: uuid.UUID | None
) -> None:
    """409 `DUPLICATE_EXTERNAL_CODE` when another project already holds the
    (non-blank) code — instead of the UNIQUE constraint's 500. Unscoped on
    purpose: the constraint is global."""
    if code is None:
        return
    stmt = select(Project.id).where(Project.external_code == code)
    if exclude_id is not None:
        stmt = stmt.where(Project.id != exclude_id)
    if (await db.execute(stmt.limit(1))).scalar_one_or_none() is not None:
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "DUPLICATE_EXTERNAL_CODE",
            "Another project already uses this project code.",
        )

def _check_target_end(value: object, week: int) -> None:
    """R53-8: `1 <= target_end_week <= current_week + 520` (replaces the fixed
    520). 422 `TARGET_END_OUT_OF_RANGE`."""

    if isinstance(value, int) and value > week + TARGET_END_MAX_AHEAD:
        raise CodedHTTPException(
            HTTP_422,
            "TARGET_END_OUT_OF_RANGE",
            [
                field_error(
                    "target_end_week",
                    f"The target end must be within {TARGET_END_MAX_AHEAD} weeks of the "
                    f"current week (at most {week + TARGET_END_MAX_AHEAD}).",
                )
            ],
        )


@router.post("", response_model=ProjectRead, status_code=status.HTTP_201_CREATED)
async def create_project(
    body: ProjectCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
    clock: PlanClock = Depends(get_plan_clock),
) -> ProjectRead:
    """Register a project (ADR 0034): it is created `In Queue`, never Draft.

    Order: RBAC (`_write`, 401/403) → unknown hub 422 → hub outside the
    caller's scope 403 → missing hard-gate fields 422
    `HARD_GATE_FIELDS_MISSING` (P56: the list is empty, so only `name` and
    `hub_id`, schema-required, are ever missing) → category vs
    hub workflow 422 `CATEGORY_WORKFLOW_MISMATCH` → unknown leader 422
    `UNKNOWN_LEADER`. The new project is not in the active run, so it is
    marked `schedule_stale` (no solve is triggered, ADR 0006). One
    `project.create` audit row, financial fields redacted.
    """

    # P33-T07 (contract B3): an unknown category is the 422 the enum gave,
    # before anything else (it used to fail body validation).
    catalog = await check_category_code(db, body.category, loc=("body", "category"))
    _check_target_end(body.target_end_week, clock.week)
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
    mismatch = _category_mismatch(hub, body.category, catalog)
    if mismatch is not None:
        raise mismatch
    # P56: the leader is optional; a given one must exist.
    leader = (
        await db.get(Engineer, body.leader_engineer_id)
        if body.leader_engineer_id is not None
        else None
    )
    if body.leader_engineer_id is not None and leader is None:
        raise CodedHTTPException(
            HTTP_422,
            "UNKNOWN_LEADER",
            [field_error("leader_engineer_id", "Unknown leader_engineer_id")],
        )

    await _ensure_external_code_free(db, body.external_code, None)
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
    # ADR 0050 / R36-8: registration enters the priority band last. The
    # band-rank lock is the first lock of the transaction.
    await lock_band_ranks(db)
    # P38 (I42, R38-5): the leader row `FOR SHARE`, then 422 `LEADER_INACTIVE`
    # for an inactive engineer.
    await check_leader_write(db, None, {"leader_engineer_id": body.leader_engineer_id})
    project = Project(
        **data, id=uuid.uuid4(), status=ProjectStatus.IN_QUEUE, schedule_stale=True
    )
    db.add(project)
    await reconcile_band_rank(
        db, project, status_before=ProjectStatus.DRAFT, priority_before=None
    )
    # P33-T10 ruling: wait for an in-flight template apply of this category
    # (FOR SHARE vs its FOR NO KEY UPDATE), then copy the new template (OR-5).
    await share_lock_categories(db, [project.category])
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
    await db.flush()
    # P38 (R38-6): the first leader starts a tenure the history can close.
    await record_leader_change(
        db,
        project_id=project.id,
        old_leader_id=None,
        new_leader_id=project.leader_engineer_id,
        cause=CAUSE_REGISTRATION,
        actor_user_id=current_user.user_id,
        clock=clock,
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
    # P54 (ADR 0064 R1): read-only `band_rank` / `band_size`.
    return with_band_size(ProjectRead.model_validate(project), await band_sizes(db))


@router.patch("/{project_id}", response_model=ProjectRead)
async def update_project(
    project_id: uuid.UUID,
    body: ProjectUpdateRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
    clock: PlanClock = Depends(get_plan_clock),
) -> ProjectRead:
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

    # P33-T07 (contract B3): an unknown category is the 422 the enum gave,
    # before anything else (it used to fail body validation).
    await check_category_code(db, body.category, loc=("body", "category"))
    project = await _get_project_or_404(db, project_id, current_user)
    await _authorize_registration_write(db, project, current_user)
    refuse_hidden_financials(current_user, body.model_fields_set - {"base"}, body.base)
    if body.model_fields_set & {"status", "priority"}:
        # ADR 0050 / R36-8: a status or priority change may move the band
        # rank; the band-rank lock is the first lock of the write, taken only
        # after lookup + authorisation (P36-R01), and the project is re-read
        # and re-authorised under it.
        project = await _lock_bands_and_reload(db, project, current_user)
    updates = body.model_dump(exclude_unset=True, exclude={"base"})
    if body.base:
        # P47 (ADR 0059 C1): lock the row the way the register batch does,
        # then compare `base` before anything is written. P47-R01 (M-1):
        # every authorisation check of the write runs before the comparison.
        project = await _lock_project_row_for_base(db, project, updates, current_user)
        ensure_may_cancel(project, updates.get("status"), current_user)
        if updates.get("hub_id") is not None and not is_hub_in_scope(
            current_user, updates["hub_id"]
        ):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Cannot move a project to a hub outside your assigned hub scope.",
            )
        await check_project_base(db, current_user, project, body.base, updates)
    staged = await stage_project_update(db, project, updates, current_user, clock=clock)
    if staged.priority_moves:
        # Commits everything above together with the move.
        move = await apply_priority_change(db, project, staged.new_priority, current_user)
        response.headers.update(move.response_headers())
    else:
        await db.commit()
    await db.refresh(project)
    return project_read_for(project, current_user, await band_sizes(db))


def ensure_may_cancel(
    project: Project, new_status: ProjectStatus | None, principal: Principal
) -> None:
    """ADR 0058 D1.1: setting a project's status to Cancelled is Super Admin
    only (403 `SUPER_ADMIN_ONLY`), on every API write path. Leaving Cancelled
    is an ordinary edit, and re-sending Cancelled for a project that already
    is Cancelled changes nothing, so neither is restricted."""

    if new_status == ProjectStatus.CANCELLED and project.status != ProjectStatus.CANCELLED:
        ensure_super_admin(principal)


@dataclass(frozen=True)
class StagedProjectUpdate:
    """What `stage_project_update` staged (nothing committed)."""

    priority_moves: bool
    new_priority: ProjectPriority | None
    #: A scheduler input (`SCHEDULE_INPUT_FIELDS`) changed value.
    schedule_inputs_changed: bool
    #: The project's status before the update (a status change into a
    #: non-schedulable one still changes the plan).
    status_before: ProjectStatus


async def stage_project_update(
    db: AsyncSession,
    project: Project,
    updates: dict[str, Any],
    current_user: Principal,
    *,
    band_rank_plan: Mapping[uuid.UUID, int | None] | None = None,
    step_edits: StepEdits | None = None,
    clock: PlanClock | None = None,
    leader_cause: str = CAUSE_PROJECT_UPDATE,
    apply_priority: bool = False,
) -> StagedProjectUpdate:
    """The single PATCH's validation and writes, shared with the register's
    batch (`POST /projects/register-edits`, P35). The caller has already
    resolved the project through the scoped lookup and authorised the
    write. Every check raises (CodedHTTPException / HTTPException) BEFORE
    anything is written; then the fields are set, `schedule_stale` raised
    for a scheduler input, the steps re-synced and the effort re-derived
    (ADR 0041 R6), tags pre-filled, and the `project.update` audit row
    staged. Nothing is committed. A `priority` change is NOT applied here:
    the caller applies `new_priority` as a priority move (ADR 0015).

    ADR 0050 / R36-8: a status change runs the band-rank lifecycle
    (`services.band_rank.reconcile_band_rank`); the P35 batch instead passes
    `band_rank_plan` (`plan_batch_band_ranks`, each band renumbered once) and
    the planned rank is set with the status. The caller holds the band-rank
    lock.

    P35-T05 / register popup: `step_edits` (the batch's `step_exclusions` and
    `current_step_code`) are applied after the project fields, exclusions
    first (`services.register_steps.apply_step_edits`); the R35-5 guards then
    run on the final state, also for a figure / category / certification /
    hub edit on a project with an excluded step. Those checks run after the
    writes: the batch rolls back on any error, the single PATCH never
    commits.

    P38 (ADR 0053, I42 / R38-4 / R38-6): a written leader must exist and be
    active, and a reopen (out of Commercialized / Cancelled) needs an active
    leader or an explicit one in the same write (422 `LEADER_INACTIVE`); the
    leader row is locked `FOR SHARE` (R38-5). Every leader change writes one
    `project_leader_history` row (`leader_cause`), at `clock`'s week.

    P59-B: `apply_priority=True` (the register batch only, with
    `band_rank_plan` planned on the new priority) sets a changed priority on
    the row together with its status and planned rank (the membership CHECK
    is immediate) and counts it as a scheduler input; the caller then writes
    the `project.priority_move` audit row once the batch's recalc is
    decided."""

    status_before = project.status
    if "external_code" in updates:
        await _ensure_external_code_free(db, updates["external_code"], project.id)
    if "target_end_week" in updates:
        _check_target_end(updates["target_end_week"], (clock or plan_clock_now()).week)
    # ADR 0058 D1.1: only a Super Admin sets a project to Cancelled.
    ensure_may_cancel(project, updates.get("status"), current_user)
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
                    f"POST /projects/{project.id}/submit, which runs the hard-gate check."
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
    target_status = updates.get("status", project.status)
    if new_priority is None and not priority_applicable(target_status):
        # ADR 0067: a client that shows "Not applicable" may send null for a
        # Commercialized / Cancelled project; the stored priority is kept
        # (never cleared), so null is the unchanged round-trip.
        new_priority = project.priority
    priority_moves = new_priority != project.priority
    if priority_moves:
        if new_priority is None and target_status not in NON_SCHEDULABLE_STATUSES:
            # Clearing a set priority is not offered (P56 made it optional at
            # registration only; a priority-less project is left out of the
            # run, `services.schedule_readiness`, so this is a product rule,
            # no longer a run-safety guard).
            raise CodedHTTPException(
                HTTP_422,
                "NULL_NOT_ALLOWED",
                "priority may not be null while the project's status is schedulable",
            )
        # ADR 0067: 409 PRIORITY_NOT_APPLICABLE for a Commercialized /
        # Cancelled target status (an unchanged priority never gets here).
        await ensure_priority_move_allowed(
            db, project, new_priority, target_status=target_status
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

    actual_end_error = _actual_end_before_start(project, updates)
    if actual_end_error is not None:
        raise actual_end_error

    # P38 (I42, R38-4): before anything is written.
    await check_leader_write(db, project, updates)

    target_category = updates["category"] if "category" in updates else project.category
    mismatch = _category_mismatch(target_hub, target_category, await load_catalog(db))
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
            derivation = await validate_effort_split(
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
        if step_edits is None or step_edits.empty:
            # R35-5 (a) before anything is written, on the stored exclusions:
            # a figure in force needs one weighted step that is not excluded.
            guard = exclusion_guard_error(derivation)
            if guard is not None:
                raise guard
    before_state = project_audit_state(project)
    tags_before = list(project.scoring_tags or [])
    figures_changed = any(
        name in updates and getattr(project, name) != updates[name] for name in _EFFORT_FIGURES
    )
    workflow_changes = target_hub.is_oem != current_hub.is_oem
    # P33-T08 (OR-5, R33-10): a category change re-copies the template onto
    # the not-reached steps (a workflow change re-copies every re-pointed one).
    category_changes = "category" in updates and updates["category"] != project.category
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
    leader_before = project.leader_engineer_id
    if (
        "leader_engineer_id" in updates
        and updates["leader_engineer_id"] != project.leader_engineer_id
    ):
        # ADR 0042 §7 (P29): a person chose the leader, so it is no longer the
        # seed's / migration's provisional pick.
        project.leader_is_provisional = False
    if category_changes or workflow_changes or effort_inputs_changed:
        # P33-T10 ruling: wait for an in-flight template apply of the target
        # category before a re-copy reads it (OR-5: category change, or a
        # figure cleared). Taken before this write locks the project row (the
        # single PATCH holds none yet; the register batch takes it before its
        # row locks).
        await share_lock_categories(db, [target_category])
    for field_name, value in updates.items():
        setattr(project, field_name, value)
    # P53 (R53-2b, I61): moving to Commercialized with no actual end week
    # stamps the calendar week (new writes only; still editable; an explicit
    # `actual_end_week` in the same write wins). Its delivered year is then
    # the year of that week.
    if (
        updates.get("status") == ProjectStatus.COMMERCIALIZED
        and status_before != ProjectStatus.COMMERCIALIZED
        and project.actual_end_week is None
        and "actual_end_week" not in updates
    ):
        project.actual_end_week = (clock or plan_clock_now()).week
    if apply_priority and priority_moves:
        project.priority = new_priority
        schedule_inputs_changed = True
    if schedule_inputs_changed:
        project.schedule_stale = True
    if band_rank_plan is not None:
        if project.id in band_rank_plan:
            project.band_rank = band_rank_plan[project.id]
    elif "status" in updates:
        # ADR 0050 / R36-8: un-hold / reactivation enters the band last, a
        # non-schedulable status clears the rank and renumbers the band; a
        # schedulable -> schedulable change keeps it (R36-3). Before the
        # flush: the membership CHECK is immediate. The caller holds the
        # band-rank lock. The priority (if any) is reconciled by the move.
        await reconcile_band_rank(
            db, project, status_before=status_before, priority_before=project.priority
        )
    await db.flush()
    if project.leader_engineer_id != leader_before:
        # P38 (R38-6): every leader change, on every path.
        await record_leader_change(
            db,
            project_id=project.id,
            old_leader_id=leader_before,
            new_leader_id=project.leader_engineer_id,
            cause=leader_cause,
            actor_user_id=current_user.user_id,
            clock=clock if clock is not None else plan_clock_now(),
        )
    template_copy: list[CopyChanges] = []
    if "hub_id" in updates or "category" in updates:
        try:
            template_copy.append(
                await sync_project_steps(
                    db,
                    project,
                    target_hub.is_oem,
                    recopy_template=category_changes,
                    actor_user_id=current_user.user_id,
                )
            )
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
        rederived = await rederive_project_effort(
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
        # OR-5: a kind that lost its own figure follows the template again.
        if rederived is not None and rederived.template_copy:
            template_copy.append(rederived.template_copy)
    steps_changed = False
    if (step_edits is not None and not step_edits.empty) or effort_inputs_changed:
        # P35-T05: exclusions, then the current step, then the R35-5 guards
        # on the final state (audited in their own rows).
        steps_changed = await apply_step_edits(
            db,
            project,
            step_edits or StepEdits(),
            workflow_id=workflow_id_for_hub(target_hub.is_oem),
            actor_user_id=current_user.user_id,
            check_guards=effort_inputs_changed,
            plan_week=(clock if clock is not None else plan_clock_now()).week,
        )
    if "scoring_tags" in updates:
        # ADR 0038: only a not-set -> set tag pre-fills its score (same
        # transaction); `scoring_tags` is not a scheduler input, so it never
        # sets `schedule_stale`.
        await apply_tag_prefill(
            db, project, before=tags_before, after=project.scoring_tags, principal=current_user
        )
    after_state = project_audit_state(project)
    # Contract P33 E4: the per-step template copy before / after.
    copy_changes = merge_copy_changes(*template_copy)
    if copy_changes:
        before_state["template_copy"] = {
            sid: {name: v[0] for name, v in fields.items()} for sid, fields in copy_changes.items()
        }
        after_state["template_copy"] = {
            sid: {name: v[1] for name, v in fields.items()} for sid, fields in copy_changes.items()
        }
    if priority_moves:
        # The move is applied below, in the same commit; the snapshot shows
        # the project as it will be stored.
        after_state["priority"] = new_priority.value if new_priority is not None else None

    if updates or (not priority_moves and (step_edits is None or step_edits.empty)):
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
    return StagedProjectUpdate(
        priority_moves=priority_moves,
        new_priority=new_priority,
        schedule_inputs_changed=schedule_inputs_changed or steps_changed,
        status_before=status_before,
    )


#: P35: per user, a burst of 10 register saves, then one every 6 seconds
#: (the check-in batch's limit). Per API process (`services.rate_limit`).
REGISTER_EDITS_RATE_LIMIT = TokenBucketLimiter(capacity=10, refill_per_second=1 / 6)
#: `ScheduleRun.trigger_reason` of the register batch's run.
REGISTER_EDIT_TRIGGER_REASON = "register_edit"
#: Register popup patch fields that are not `Project` columns (applied by
#: `services.register_steps` after the project fields). Both are scheduler
#: inputs: a change counts for the recalculation decision.
_STEP_EDIT_FIELDS: frozenset[str] = frozenset({"step_exclusions", "current_step_code"})


def _register_step_edits(edit: RegisterEditPatch) -> StepEdits:
    return StepEdits(
        exclusions=[(x.step_code, x.step_excluded) for x in edit.step_exclusions or []],
        current_step_code=edit.current_step_code,
    )


#: P59-B: register patch keys whose `Project` column has another name.
_REGISTER_COLUMN_OF: dict[str, str] = {"project_type": "type"}


def _register_updates(edit: RegisterEditPatch) -> dict[str, Any]:
    """The patch's sent project fields keyed by `Project` column (as the
    PATCH's `updates`): `project_type` -> `type`."""

    data = edit.model_dump(exclude_unset=True, exclude={"project_id", "base", *_STEP_EDIT_FIELDS})
    return {_REGISTER_COLUMN_OF.get(k, k): v for k, v in data.items()}


def _register_base(edit: RegisterEditPatch) -> dict[str, Any]:
    """`edit.base` keyed like `_register_updates`."""

    return {_REGISTER_COLUMN_OF.get(k, k): v for k, v in edit.base.items()}


def _register_error(project_id: uuid.UUID, exc: HTTPException) -> RegisterEditError:
    """A single-PATCH failure as one batch error: its code, and its message
    (a coded detail list is joined; never any field value beyond the week
    numbers / codes the PATCH itself reports)."""

    code = getattr(exc, "code", None)
    if code is None:
        code = (
            "STATUS_DRAFT_SUBMIT_ONLY"
            if exc.status_code == status.HTTP_400_BAD_REQUEST
            else f"HTTP_{exc.status_code}"
        )
    detail = exc.detail
    if isinstance(detail, list):
        message = "; ".join(str(d.get("msg", d)) if isinstance(d, dict) else str(d) for d in detail)
    elif isinstance(detail, dict):
        message = str(detail.get("message", detail.get("msg", code)))
    else:
        message = str(detail)
    return RegisterEditError(project_id=project_id, code=code, message=message)


def _batch_error(status_code: int, code: str, message: str, errors: list[RegisterEditError]) -> (
    CodedHTTPException
):
    return CodedHTTPException(
        status_code,
        code,
        {"code": code, "message": message, "errors": [e.model_dump(mode="json") for e in errors]},
    )


async def _authorize_register_batch(
    db: AsyncSession, edits: Sequence[RegisterEditPatch], principal: Principal
) -> dict[uuid.UUID, Project]:
    """The single PATCH's scoped lookup + Admin-grain write authorisation for
    every project of a register batch. Any failure is a 403
    `REGISTER_EDITS_FORBIDDEN` listing those ids as `FORBIDDEN_PROJECT` (out
    of scope and nonexistent read the same); the transaction is rolled back."""

    projects: dict[uuid.UUID, Project] = {}
    forbidden: list[RegisterEditError] = []
    for edit in edits:
        try:
            project = await _get_project_or_404(db, edit.project_id, principal)
            await _authorize_registration_write(db, project, principal)
            if (
                "hub_id" in edit.model_fields_set
                and edit.hub_id is not None
                and edit.hub_id != project.hub_id
                and not (
                    is_hub_in_scope(principal, project.hub_id)
                    and is_hub_in_scope(principal, edit.hub_id)
                )
            ):
                # Register popup: a hub move needs write scope on the old AND
                # the new hub (a project grant alone does not move a project
                # between hubs). Same answer as any other refusal here, so an
                # unknown or foreign hub is never revealed.
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN)
        except HTTPException:
            forbidden.append(
                RegisterEditError(
                    project_id=edit.project_id,
                    code="FORBIDDEN_PROJECT",
                    message="You cannot edit this project.",
                )
            )
            continue
        projects[edit.project_id] = project
    if forbidden:
        await db.rollback()
        raise _batch_error(
            status.HTTP_403_FORBIDDEN, "REGISTER_EDITS_FORBIDDEN",
            "Nothing was saved: you cannot edit the projects listed in errors.", forbidden,
        )
    return projects


@router.post("/register-edits", response_model=RegisterEditsResponse)
async def save_register_edits(
    body: RegisterEditsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
    clock: PlanClock = Depends(get_plan_clock),
) -> RegisterEditsResponse:
    """P35 (OQ #83: recalculate on Save): the Projects register's Edit-mode
    Save. One transaction, all-or-nothing:

    1. Rate limit (429 `RATE_LIMITED`); a project twice in one batch is a
       422 `REGISTER_EDITS_INVALID` (`DUPLICATE_PROJECT`).
    2. Every named project goes through the single PATCH's scoped lookup
       and write authorisation (`_get_project_or_404` +
       `authorize_project_action`, Admin-grain) with plain SELECTs. Any
       failure is a 403 `REGISTER_EDITS_FORBIDDEN` listing those ids as
       `FORBIDDEN_PROJECT` (out of scope and nonexistent read the same).
       Only then (P36-R01) the band-rank lock (503 `BAND_RANK_BUSY` on
       `lock_timeout`), every row locked `FOR UPDATE` in id order and
       re-read, and the authorisation re-checked on the re-read rows.
    3. Each patch runs `stage_project_update`, the single PATCH's own
       validation and writes (incl. `ACTUAL_END_BEFORE_START`, ADR 0041 R7
       split check, R6 re-derivation, `schedule_stale`, one `project.update`
       audit row per project). Every row is validated; any failure rolls the
       whole batch back and answers 422 `REGISTER_EDITS_INVALID` with
       `detail.errors = [{project_id, code, message}]`.
    4. ONE greedy recalculation for the batch through the priority move's
       lifecycle (`decide_auto_recalc_batch` / `dispatch_auto_recalc_batch`,
       `trigger_reason="register_edit"`): `not_needed` unless a scheduler
       input changed on a project schedulable before or after its edit,
       `deferred` (coalesced follow-up) when a run is in flight, else
       `queued`. Never solves in-process.

    P59-B (bulk edit): `priority`, `category` and `type` follow the PATCH.
    A changed priority is a priority move (band end, one
    `project.priority_move` audit row per project, the one recalc above);
    `PRIORITY_NOT_APPLICABLE` / `HARD_GATE_FORCES_P1` come back per project
    in the 422 `REGISTER_EDITS_INVALID` errors.
    """

    allowed, retry_after = REGISTER_EDITS_RATE_LIMIT.allow(
        f"register-edits:{current_user.user_id}"
    )
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            "Too many register saves. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )

    seen: set[uuid.UUID] = set()
    duplicates: list[RegisterEditError] = []
    for edit in body.edits:
        if edit.project_id in seen:
            duplicates.append(
                RegisterEditError(
                    project_id=edit.project_id,
                    code="DUPLICATE_PROJECT",
                    message="This project appears more than once in the batch.",
                )
            )
        seen.add(edit.project_id)
    if duplicates:
        raise _batch_error(
            HTTP_422, "REGISTER_EDITS_INVALID",
            "Nothing was saved: fix the projects listed in errors.", duplicates,
        )
    # P59-B: an unknown category is the PATCH's enum-shaped 422 (contract
    # B3), at the row's body location, before any lock.
    for index, edit in enumerate(body.edits):
        if "category" in edit.model_fields_set:
            await check_category_code(
                db, edit.category, loc=("body", "edits", index, "category")
            )

    edits = sorted(body.edits, key=lambda e: e.project_id)
    # P36-R01 (security M-1): scoped lookup + write authorisation with plain
    # SELECTs first, so a batch naming a project the caller may not edit is
    # refused without ever taking (or waiting on) the band-rank lock.
    readable = await _authorize_register_batch(db, edits, current_user)
    # ADR 0058 D1.1: a batch that cancels a project is refused as a whole
    # (403 `SUPER_ADMIN_ONLY`) before any lock, not as a per-row 422.
    for edit in edits:
        if "status" in edit.model_fields_set:
            ensure_may_cancel(readable[edit.project_id], edit.status, current_user)
    # ADR 0050 / R36-8: the band-rank lock is the first lock, before the row
    # locks below, so this batch and a re-rank / priority move serialise
    # without deadlock.
    await lock_band_ranks(db)
    # P33-T10 ruling (OR-5): a figure cleared re-copies the template; the
    # categories' FOR SHARE is taken before the row locks (an apply locks
    # categories, then projects).
    effort_edit_ids = [
        e.project_id
        for e in edits
        if e.model_fields_set & (EFFORT_SPLIT_INPUT_FIELDS | _STEP_EDIT_FIELDS)
    ]
    if effort_edit_ids:
        await share_lock_categories(
            db,
            [
                *(
                    await db.execute(
                        select(Project.category).where(Project.id.in_(effort_edit_ids))
                    )
                ).scalars(),
                # P59-B: a category change re-copies the TARGET category.
                *(e.category for e in edits if "category" in e.model_fields_set),
            ],
        )
    # P38 (R38-5): the engineer rows a leader write names (a written leader,
    # or the stored leader of a project whose status is edited, which may be
    # a reopen) are locked `FOR SHARE` before the project rows, so this batch
    # and a deactivation lock in the same order.
    leader_ids = {
        e.leader_engineer_id
        for e in edits
        if "leader_engineer_id" in e.model_fields_set and e.leader_engineer_id is not None
    }
    status_edit_ids = [e.project_id for e in edits if "status" in e.model_fields_set]
    if status_edit_ids:
        leader_ids.update(
            lid
            for lid in (
                await db.execute(
                    select(Project.leader_engineer_id).where(
                        Project.id.in_(status_edit_ids),
                        Project.status.in_(list(CLOSED_STATUSES)),
                    )
                )
            ).scalars()
            if lid is not None
        )
    await lock_engineers(db, leader_ids, share=True)
    await db.execute(
        select(Project)
        .where(Project.id.in_([e.project_id for e in edits]))
        .order_by(Project.id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    # Re-checked on the locked, re-read rows (P36-R01 / L-2: a hub may have
    # changed while the batch waited for the lock).
    projects = await _authorize_register_batch(db, edits, current_user)

    # P47 (ADR 0059 C1): every row's `base` is compared under the row locks
    # before anything is written; any conflict refuses the whole batch (409
    # `EDIT_CONFLICT` listing every conflicting field), so nothing is
    # stored, audited, marked stale or dispatched.
    conflicts: list[FieldConflict] = []
    for edit in edits:
        if edit.base:
            conflicts.extend(
                await project_conflicts(
                    db,
                    projects[edit.project_id],
                    _register_base(edit),
                    _register_updates(edit),
                    step_edits=_register_step_edits(edit),
                )
            )
    if conflicts:
        error = await edit_conflict_error(db, current_user, conflicts)
        await db.rollback()
        raise error

    # P59-B: the stored priority / rank of every row before anything moves
    # (the `project.priority_move` audit row's before state).
    priority_before = {pid: (p.priority, p.band_rank) for pid, p in projects.items()}
    # ADR 0050 / R36-8: one band-rank plan for the whole batch (leavers
    # removed, enterers appended last, each band renumbered once), read
    # before any status or priority is written, on the TARGET status and
    # priority (P59-B: a priority move enters its new band last, several in
    # their current rank, then name, order). A row whose staging fails
    # (e.g. `PRIORITY_NOT_APPLICABLE`) rolls the whole batch back below.
    band_rank_plan = await plan_batch_band_ranks(
        db,
        [
            (
                projects[e.project_id],
                e.status
                if "status" in e.model_fields_set and e.status is not None
                else projects[e.project_id].status,
                e.priority
                if "priority" in e.model_fields_set and e.priority is not None
                else projects[e.project_id].priority,
            )
            for e in edits
            if (
                ("status" in e.model_fields_set and e.status is not None)
                or ("priority" in e.model_fields_set and e.priority is not None)
            )
            and e.status != ProjectStatus.DRAFT
            and projects[e.project_id].status != ProjectStatus.DRAFT
        ],
    )
    errors: list[RegisterEditError] = []
    staged: dict[uuid.UUID, StagedProjectUpdate] = {}
    eff_changes: list[RegisterEditEffChange] = []
    known_hubs: dict[uuid.UUID, bool] = {}
    for edit in edits:
        project = projects[edit.project_id]
        updates = _register_updates(edit)
        step_edits = _register_step_edits(edit)
        tracks_eff = bool(
            edit.model_fields_set & (SCHEDULE_INPUT_FIELDS | _STEP_EDIT_FIELDS)
        )
        try:
            if updates.get("hub_id") is not None:
                hub_id = updates["hub_id"]
                if hub_id not in known_hubs:
                    known_hubs[hub_id] = (
                        await db.execute(select(Hub.id).where(Hub.id == hub_id))
                    ).scalar_one_or_none() is not None
                if not known_hubs[hub_id]:
                    raise CodedHTTPException(
                        HTTP_422, "UNKNOWN_HUB", [field_error("hub_id", "Unknown hub.")]
                    )
            eff_before = (
                await project_eff_map(db, project, await _workflow_id(db, project))
                if tracks_eff
                else {}
            )
            staged[project.id] = await stage_project_update(
                db,
                project,
                updates,
                current_user,
                band_rank_plan=band_rank_plan,
                step_edits=step_edits,
                clock=clock,
                leader_cause=CAUSE_REGISTER_EDIT,
                apply_priority=True,
            )
            if tracks_eff:
                eff_after = await project_eff_map(db, project, await _workflow_id(db, project))
                eff_changes.extend(
                    RegisterEditEffChange(
                        project_id=project.id,
                        step_code=step_id,
                        eff_before=eff_before[step_id],
                        eff_after=after,
                        revived=eff_before[step_id] == 0 and after > 0,
                        skipped_now=eff_before[step_id] > 0 and after == 0,
                    )
                    for step_id, after in eff_after.items()
                    if step_id in eff_before and eff_before[step_id] != after
                )
        except HTTPException as exc:
            # The whole batch is rolled back below, so a row that failed after
            # some of its writes (the step edits and the R35-5 guards are
            # checked on the written state) leaves nothing behind.
            errors.append(_register_error(project.id, exc))
    if errors:
        await db.rollback()
        raise _batch_error(
            HTTP_422, "REGISTER_EDITS_INVALID",
            "Nothing was saved: fix the projects listed in errors.", errors,
        )

    changed = [
        projects[pid] for pid, result in staged.items() if result.schedule_inputs_changed
    ]
    needs_run = any(
        staged[p.id].status_before not in NON_SCHEDULABLE_STATUSES
        or p.status not in NON_SCHEDULABLE_STATUSES
        for p in changed
    )
    recalc, baseline_id = await decide_auto_recalc_batch(
        db, needs_run=needs_run, trigger_reason=REGISTER_EDIT_TRIGGER_REASON
    )
    for pid, result in staged.items():
        if result.priority_moves:
            # P59-B: one `project.priority_move` row per moved project, the
            # single move's shape, with the batch's recalc decision.
            before, rank_before = priority_before[pid]
            add_priority_move_audit(
                db, projects[pid], before, result.new_priority, current_user,
                recalc=recalc, baseline_id=baseline_id, band_rank_before=rank_before,
            )
    outcome = await dispatch_auto_recalc_batch(
        db, changed, current_user,
        recalc=recalc, baseline_id=baseline_id, trigger_reason=REGISTER_EDIT_TRIGGER_REASON,
    )
    return RegisterEditsResponse(
        project_ids=[e.project_id for e in edits],
        projects_marked_stale=[p.id for p in changed],
        recalc_status=outcome.recalc_status,
        schedule_run_id=outcome.schedule_run_id,
        baseline_run_id=outcome.baseline_run_id,
        task_id=outcome.task_id,
        eff_changes=eff_changes,
    )


async def _workflow_id(db: AsyncSession, project: Project) -> str:
    return workflow_id_for_hub(
        (await db.execute(select(Hub.is_oem).where(Hub.id == project.hub_id))).scalar_one()
    )


@router.get("/{project_id}/register-steps", response_model=RegisterStepsRead)
async def get_register_steps(
    project_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> RegisterStepsRead:
    """The register Edit popup's step chips (P35-T05 / P35-T06,
    docs/API_CONTRACT_REGISTER_POPUP.md §3). Same permission and hub scope
    as `GET /projects/{id}` (404 out of scope). Read-only, so no audit row.
    A constant number of statements: the project, its workflow's templates,
    its live rows, the category weights and one `build_project_cards` pass
    (which gives `current_step_code` and `end_week` exactly as the register
    list serves them)."""

    project = await _get_project_or_404(db, project_id, current_user)
    ctx = await load_step_context(db, project, workflow_id=await _workflow_id(db, project))
    card = (
        await build_project_cards(
            db, [project], await get_active_run(db), current_week=clock.week
        )
    )[project.id]
    current = card.current_stage.step_id if card.current_stage is not None else None
    return RegisterStepsRead(
        project_id=project.id,
        current_step_code=current,
        end_week=card.projected_end_week,
        design_weeks_calculated=card.design_weeks_calculated,
        lab_weeks_calculated=card.lab_weeks_calculated,
        steps=[
            RegisterStepRead(
                step_code=v.step_code,
                step_name=v.step_name,
                kind=v.kind,
                status=v.status,
                step_excluded=v.step_excluded,
                applicable=v.applicable,
                excludable=v.excludable,
                is_current=v.is_current,
            )
            for v in build_step_views(project, ctx, current_step_code=current)
        ],
    )


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
    await _authorize_registration_write(db, project, current_user)
    if body.preview_token is not None:
        # P14 (ADR 0026 §2): confirm a preview, applied in-process.
        _rate_limited(
            PRIORITY_CONFIRM_RATE_LIMIT,
            f"priority-confirm:{current_user.user_id}",
            "Too many timeline confirmations. Please wait a moment and try again.",
        )
    # ADR 0050 / R36-8: the band-rank lock is the first lock of the move (it
    # re-ranks two bands), taken after lookup, authorisation and the rate
    # limit (P36-R01); the project is re-read and re-authorised under it.
    project = await _lock_bands_and_reload(db, project, current_user)
    if body.base:
        # P47 (ADR 0059 C1): every priority writer holds the band-rank lock,
        # so the re-read priority cannot change before this move commits.
        await check_project_base(db, current_user, project, body.base, {"priority": body.priority})
    if body.preview_token is not None:
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


def _rate_limited(limiter: TokenBucketLimiter, key: str, message: str) -> None:
    allowed, retry_after = limiter.allow(key)
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            message,
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )


@router.post("/{project_id}/band-rank/preview", response_model=PriorityPreviewResponse)
async def preview_project_band_rank(
    project_id: uuid.UUID,
    body: BandRankPreviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> PriorityPreviewResponse:
    """P36 (ADR 0050 §4, docs/API_CONTRACT_P36.md §2): what re-ranking the
    project inside its priority band would change, from the priority
    preview's in-process greedy pair. Writes nothing.

    Permission is the priority move's (404 out of scope, 403 without
    Registration WRITE or an Admin-level grant); the anchor must be ranked in
    the same band and in the caller's hub scope (else 422 `NOT_SAME_BAND`).
    `to_rank` (1..n in the full band) is the alternative to an anchor: 422
    `ANCHOR_AND_RANK` with one, 422 `BAD_RANK` out of range.
    422 `BOTH_ANCHORS`, 409 `NOT_RANKABLE`, 429 `RATE_LIMITED` (the priority
    preview's bucket), 503 `PREVIEW_TIMEOUT`. `result = "unchanged"` when the
    placement keeps the order."""

    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    _rate_limited(
        PRIORITY_PREVIEW_RATE_LIMIT,
        f"priority-preview:{current_user.user_id}",
        "Too many timeline previews. Please wait a moment and try again.",
    )
    return await preview_band_rank_move(
        db, project, current_user,
        before=body.before_project_id, after=body.after_project_id, to_rank=body.to_rank,
        hub_rank=body.hub_rank,
    )


@router.post("/{project_id}/band-rank", response_model=PriorityMoveResponse)
async def move_project_band_rank(
    project_id: uuid.UUID,
    body: BandRankMoveRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> PriorityMoveResponse:
    """P36 (ADR 0050 §4, contract §3): confirm a re-rank preview. The band is
    renumbered with the project at its new place and the greedy run applied
    in-process (`applied`), or `deferred` when a worker run is in flight.
    409 `PREVIEW_STALE` on a stale token (nothing written). Audit
    `project.band_rank_move`. Same permission and errors as the preview; the
    `X-Schedule-*` headers report the recalc as on the PATCH."""

    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    _rate_limited(
        PRIORITY_CONFIRM_RATE_LIMIT,
        f"priority-confirm:{current_user.user_id}",
        "Too many timeline confirmations. Please wait a moment and try again.",
    )
    # R36-8: the band-rank lock is the first lock of the write; the project
    # is re-read under it (a concurrent move may have re-ranked it) and its
    # hub scope / permission re-checked (P36-R01, security L-2).
    project = await _lock_bands_and_reload(db, project, current_user)
    result = await confirm_band_rank_move(
        db, project, current_user,
        before=body.before_project_id, after=body.after_project_id,
        preview_token=body.preview_token, to_rank=body.to_rank, hub_rank=body.hub_rank,
    )
    response.headers.update(
        AutoRecalcOutcome(
            recalc_status=result.recalc_status,
            schedule_run_id=result.schedule_run_id,
            baseline_run_id=result.baseline_run_id,
        ).response_headers()
    )
    return result


@router.post("/{project_id}/submit", response_model=ProjectRead)
async def submit_project(
    project_id: uuid.UUID,
    body: ProjectSubmitRequest = ProjectSubmitRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> ProjectRead:
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
    await _authorize_registration_write(db, project, current_user)
    # ADR 0050 / R36-8: the band-rank lock is the first lock (leaving Draft
    # enters a band), taken after lookup + authorisation (P36-R01).
    project = await _lock_bands_and_reload(db, project, current_user)
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
    status_before = project.status
    project.status = body.target_status
    # Newly schedulable and not in the active run yet (P9-T03).
    project.schedule_stale = True
    # ADR 0050 / R36-8: leaving Draft enters the priority band last.
    await reconcile_band_rank(
        db, project, status_before=status_before, priority_before=project.priority
    )
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
    # P54 (ADR 0064 R1): read-only `band_rank` / `band_size`.
    return with_band_size(ProjectRead.model_validate(project), await band_sizes(db))
