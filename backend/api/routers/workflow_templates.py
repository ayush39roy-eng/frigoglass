"""Workflow templates (P33-T09..T11; `docs/API_CONTRACT_P33.md` Parts B2, D
and E; ADR 0045, ADR 0046 (owner ruling OR-1..OR-6 > R33 > text), ADR 0047;
DOMAIN_RULES "Category templates, apply rules, categories table").

Every endpoint here needs `workflow_templates` WRITE (Admin, Super Admin;
contract Part A): the two previews are writes-in-preparation.

- `POST /workflow-templates/timeline-preview` (D): stateless; the saved
  template with the request's overrides, through
  `scheduling.template_timeline`.
- `POST /workflow-templates/apply-preview` (E2): the stage rule (R33-10) and
  OR-4 on the current data; no writes.
- `POST /workflow-templates/apply` (E3): one transaction (category rows
  locked and versions checked; the category's projects locked `FOR UPDATE`
  in id order; the rule evaluated under the lock; template, `template_changes`
  row, copies, stale flags, audit), then ONE greedy run with the priority
  move's lifecycle (`trigger_reason="template_apply"`). No `effort_weeks` is
  written and nothing is re-derived (R33-2), except the ADR 0070 revive: a
  length 0 -> N on a step with weight 0 sets the weight to N, and every
  received own-effort pair of it gets the copy and its project's effort
  re-derived (`services.template_apply` module docstring).
- `POST /workflow-templates/categories` (B2): add a category.
- `POST /workflow-templates/sync-effort-weights` (ADR 0070, Super Admin
  only): the one-time catch-up of revives saved before ADR 0070; dry run or
  apply; marks stale, never dispatches a run.

Lock order (owner 2026-11-24, run 307 "deadlock detected"): the apply and
the sync take the band-rank advisory lock FIRST (`lock_band_ranks`, 5 s ->
503 `BAND_RANK_BUSY`), before any category or project row lock, the same
first lock a schedule run's persistence takes (`wait_for_band_ranks`), so
the two serialise instead of deadlocking on project rows.

Rate limits are per API process (`services.rate_limit`): timeline preview
120/min, apply preview 30/min (not in the contract; it reads every project of
the categories), apply 6/min, add category 10/min per user. 429
`RATE_LIMITED` with `Retry-After`.

No financial field is read into a response, written or logged; project names
are served to the editors (as on the Matrix), engineer names never.
"""

from __future__ import annotations

import math
import uuid
from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_roles, require_workflow_templates_write
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.category import Category
from models.enums import NON_SCHEDULABLE_STATUSES, RoleName
from models.project import Project
from models.workflow import TemplateChange, WorkflowLeadTime
from scheduling.effort_split import EffortSplitRejected
from schemas.category import CategoryRead
from schemas.workflow_templates import (
    AppliedCounts,
    ApplyPreviewCategory,
    ApplyPreviewChoosableProject,
    ApplyPreviewCounts,
    ApplyPreviewNeverProject,
    ApplyPreviewOwnEffortProject,
    ApplyPreviewProject,
    ApplyPreviewResponse,
    ApplyPreviewStep,
    CategoryCreateRequest,
    CategoryCreateResponse,
    CurrentStage,
    EffortWeightSyncRequest,
    EffortWeightSyncResponse,
    NotApplied,
    TemplateApplyRequest,
    TemplateApplyResponse,
    TemplateChangeSet,
    TemplateVersion,
    TimelinePreviewRequest,
    TimelinePreviewResponse,
)
from services.band_rank import lock_band_ranks
from services.category_admin import add_category
from services.effort_weight_sync import sync_effort_weights
from services.hub_scope import hub_scope_filter
from services.priority_move import decide_auto_recalc_batch, dispatch_auto_recalc_batch
from services.project_effort import (
    TRIGGER_TEMPLATE_REVIVE,
    rederive_project_effort,
    split_rejected_error,
    template_kinds,
)
from services.rate_limit import TokenBucketLimiter
from services.schedule_stale import mark_projects_stale
from services.template_apply import (
    Evaluation,
    ProjectOutcome,
    change_summary,
    evaluate,
    step_names,
    write_copies,
)
from services.template_editor import (
    ResolvedEntry,
    category_timeline_payload,
    load_categories,
    resolve_entry,
)
from services.workflow_previews import template_timeline_for

router = APIRouter(prefix="/workflow-templates", tags=["workflow-templates"])

TIMELINE_PREVIEW_RATE_LIMIT = TokenBucketLimiter(capacity=120, refill_per_second=2.0)
APPLY_PREVIEW_RATE_LIMIT = TokenBucketLimiter(capacity=30, refill_per_second=0.5)
APPLY_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=0.1)
ADD_CATEGORY_RATE_LIMIT = TokenBucketLimiter(capacity=10, refill_per_second=1 / 6)
SYNC_EFFORT_WEIGHTS_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=0.1)

#: ADR 0070 / ADR 0058: the one-time effort-weight sync is Super Admin only.
_super_admin_only = require_roles(RoleName.SUPER_ADMIN)

#: `ScheduleRun.trigger_reason` of the apply's run (contract Part H).
TEMPLATE_APPLY_TRIGGER_REASON = "template_apply"


def _rate_limit(limiter: TokenBucketLimiter, key: str, principal: Principal, what: str) -> None:
    allowed, retry_after = limiter.allow(f"{key}:{principal.user_id}")
    if not allowed:
        raise CodedHTTPException(
            status.HTTP_429_TOO_MANY_REQUESTS,
            "RATE_LIMITED",
            f"Too many {what}. Please wait a moment and try again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )


# --- D: timeline preview -----------------------------------------------------------


@router.post("/timeline-preview", response_model=TimelinePreviewResponse)
async def timeline_preview(
    body: TimelinePreviewRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(require_workflow_templates_write),
) -> TimelinePreviewResponse:
    """Contract D: one C2 category object with the overrides, plus
    `changed_step_ids`. Stateless; no audit row (nothing changes)."""

    _rate_limit(TIMELINE_PREVIEW_RATE_LIMIT, "timeline-preview", current_user, "previews")
    entry = await resolve_entry(
        db,
        workflow_id=body.workflow_id,
        category_code=body.category,
        steps=body.steps,
        loc=("body",),
        categories=await load_categories(db, [body.category]),
        require_change=False,
    )
    timeline = template_timeline_for(entry.wf, entry.cells, entry.overrides)
    payload = category_timeline_payload(entry.wf, entry.category, timeline)
    return TimelinePreviewResponse(
        **payload.model_dump(), changed_step_ids=[d.step_id for d in entry.changed]
    )


# --- E1: change set ----------------------------------------------------------------


async def _resolve_change_set(
    db: AsyncSession, body: TemplateChangeSet, *, lock: bool
) -> list[ResolvedEntry]:
    """Validate the change set (contract E1) and check every `base_version`.
    With `lock`, the category rows are locked first (contract E3 step 1)."""

    categories = await load_categories(db, [c.category for c in body.changes], lock=lock)
    entries = [
        await resolve_entry(
            db,
            workflow_id=c.workflow_id,
            category_code=c.category,
            steps=c.steps,
            loc=("body", "changes", i),
            categories=categories,
            require_change=True,
        )
        for i, c in enumerate(body.changes)
    ]
    stale = [
        e
        for e, c in zip(entries, body.changes, strict=True)
        if e.category.template_version != c.base_version
    ]
    if stale:
        raise CodedHTTPException(
            status.HTTP_409_CONFLICT,
            "TEMPLATE_CHANGED",
            {
                "message": "Someone saved this category meanwhile. Reload.",
                "versions": [_version(e).model_dump() for e in entries],
            },
        )
    return entries


def _version(entry: ResolvedEntry) -> TemplateVersion:
    return TemplateVersion(
        workflow_id=entry.category.workflow_id,
        category=entry.category.code,
        template_version=entry.category.template_version,
    )


def _steps_out(outcome: ProjectOutcome) -> list[ApplyPreviewStep]:
    return [
        ApplyPreviewStep(
            step_id=s.step_id,
            eff_before=s.eff_before,
            eff_after=s.eff_after,
            gap_before=s.gap_before,
            gap_after=s.gap_after,
            # P62 (contract §4.2): null on a non-lab step (a stored hold
            # there is not read, R62-3), as `GET /workflow-settings` serves it.
            hold_before=s.hold_before if s.kind == "lab" else None,
            hold_after=s.hold_after if s.kind == "lab" else None,
            flags=s.flags,
        )
        for s in outcome.steps
    ]


async def _preview_payload(
    db: AsyncSession, entries: list[ResolvedEntry], evaluation: Evaluation
) -> ApplyPreviewResponse:
    names = await step_names(
        db,
        (o.current_stage[0] for o in evaluation.outcomes if o.current_stage is not None),
    )
    automatic = [
        ApplyPreviewProject(
            project_id=o.project.id,
            name=o.project.name,
            hub=o.project.hub.name,
            status=o.project.status,
            steps=_steps_out(o),
        )
        for o in evaluation.in_list("automatic")
    ]
    choosable = [
        ApplyPreviewChoosableProject(
            project_id=o.project.id,
            name=o.project.name,
            hub=o.project.hub.name,
            status=o.project.status,
            current_stage=(
                CurrentStage(
                    step_id=o.current_stage[0],
                    name=names.get(o.current_stage[0], o.current_stage[0]),
                    status=o.current_stage[1],
                )
                if o.current_stage is not None
                else None
            ),
            steps=_steps_out(o),
        )
        for o in evaluation.in_list("choosable")
    ]
    own_effort = [
        ApplyPreviewOwnEffortProject(
            project_id=o.project.id,
            name=o.project.name,
            hub=o.project.hub.name,
            status=o.project.status,
            step_ids=[s.step_id for s in o.own_effort_steps],
            kinds=sorted({s.kind for s in o.own_effort_steps}),
            reason="own_effort_length_not_applied",
        )
        for o in evaluation.in_list("own_effort")
    ]
    never = [
        ApplyPreviewNeverProject(
            project_id=o.project.id,
            name=o.project.name,
            hub=o.project.hub.name,
            reason=reason,
            step_ids=step_ids,
        )
        for o, reason, step_ids in evaluation.never()
    ]
    categories = [
        ApplyPreviewCategory(
            workflow_id=e.category.workflow_id,
            category=e.category.code,
            timeline=category_timeline_payload(
                e.wf, e.category, template_timeline_for(e.wf, e.cells, e.overrides)
            ),
        )
        for e in entries
    ]
    return ApplyPreviewResponse(
        categories=categories,
        counts=ApplyPreviewCounts(
            automatic=len(automatic),
            choosable=len(choosable),
            own_effort=len(own_effort),
            never=len(never),
        ),
        automatic=automatic,
        choosable=choosable,
        own_effort=own_effort,
        never=never,
    )


# --- E2: apply preview -------------------------------------------------------------------


@router.post("/apply-preview", response_model=ApplyPreviewResponse)
async def apply_preview(
    body: TemplateChangeSet,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(require_workflow_templates_write),
) -> ApplyPreviewResponse:
    """Contract E2. No writes, no lock, no audit row."""

    _rate_limit(APPLY_PREVIEW_RATE_LIMIT, "apply-preview", current_user, "apply previews")
    entries = await _resolve_change_set(db, body, lock=False)
    evaluation = await evaluate(db, entries, current_user, lock=False)
    return await _preview_payload(db, entries, evaluation)


# --- E3: apply ------------------------------------------------------------------------------


async def _check_selected_ids_exist(
    db: AsyncSession, principal: Principal, ids: set[uuid.UUID]
) -> None:
    """422 `BAD_PROJECT` unless every selected id is a project in the
    caller's hub scope (an out-of-scope id reads exactly like a missing one).
    Existence only: whether it is still choosable is decided under the lock."""

    stmt = select(Project.id).where(Project.id.in_(sorted(ids)))
    scope = hub_scope_filter(principal, Project.hub_id)
    if scope is not None:
        stmt = stmt.where(scope)
    found = set((await db.execute(stmt)).scalars())
    missing = sorted(ids - found)
    if missing:
        raise CodedHTTPException(
            HTTP_422,
            "BAD_PROJECT",
            f"{len(missing)} selected project(s) do not exist: "
            + ", ".join(str(m) for m in missing[:5]),
        )


async def _write_template(db: AsyncSession, entry: ResolvedEntry, revived: dict[str, int]) -> None:
    """Contract E3 step 4: the template's `weeks` / `gap_weeks` /
    `lab_hold_weeks` (P62) of the changed steps and `template_version + 1`.
    `effort_weight_weeks` is written only for a revived step (ADR 0070:
    0 -> N, `revived`); every other weight is left alone. The category row
    is locked by the caller."""

    for d in entry.changed:
        values: dict[str, int | None] = {}
        if d.length_changed:
            values["weeks"] = d.weeks_after
        if d.gap_changed:
            values["gap_weeks"] = d.gap_after
        if d.hold_changed:
            # P62 (R62-8): the room weeks (None = Full), in the same UPDATE as
            # the length so the I65 CHECK sees the final row.
            values["lab_hold_weeks"] = d.hold_after
        if d.step_id in revived:
            values["effort_weight_weeks"] = revived[d.step_id]
        await db.execute(
            update(WorkflowLeadTime)
            .where(
                WorkflowLeadTime.workflow_id == entry.category.workflow_id,
                WorkflowLeadTime.category == entry.category.code,
                WorkflowLeadTime.step_id == d.step_id,
            )
            .values(**values)
            # Keep template rows already in the session in step (they were
            # read by the validation).
            .execution_options(synchronize_session="evaluate")
        )
    entry.category.template_version += 1


@router.post("/apply", response_model=TemplateApplyResponse)
async def apply_template(
    body: TemplateApplyRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(require_workflow_templates_write),
) -> TemplateApplyResponse:
    """Contract E3 (module docstring). 409 `TEMPLATE_CHANGED`, 422
    `BAD_PROJECT` for a selected id that does not exist in the caller's
    scope; an id that is no longer choosable is reported in `not_applied`."""

    _rate_limit(APPLY_RATE_LIMIT, "template-apply", current_user, "template applies")
    selected_ids = set(body.selection.project_ids)
    if selected_ids:
        await _check_selected_ids_exist(db, current_user, selected_ids)

    # 0. The band-rank lock FIRST (owner 2026-11-24, run 307 deadlock): a
    # schedule run's persistence takes it before its first write, so the
    # apply's project row locks never interleave with a persisting run.
    # Bounded: 503 BAND_RANK_BUSY after 5 s, nothing written.
    await lock_band_ranks(db)

    # 1. category rows locked, versions checked; 2–3. the category's projects
    # locked in id order, the stage rule and ownEffort evaluated under it.
    entries = await _resolve_change_set(db, body, lock=True)
    evaluation = await evaluate(db, entries, current_user, lock=True)

    mode = body.selection.mode
    receivers: list[tuple[ProjectOutcome, str]] = []
    for o in evaluation.outcomes:
        if o.list_name == "automatic":
            receivers.append((o, "automatic"))
        elif o.list_name == "choosable" and (
            mode == "all_not_reached" or (mode == "selected" and o.project.id in selected_ids)
        ):
            receivers.append((o, "selected"))
    received = {o.project.id for o, _ in receivers}
    by_id = {o.project.id: o for o in evaluation.outcomes}
    not_applied: list[NotApplied] = []
    for pid in sorted(selected_ids):
        if pid in received:
            continue
        found = by_id.get(pid)
        reached = (
            found is not None and found.closed_reason is None and bool(found.reached_step_ids)
        )
        not_applied.append(
            NotApplied(project_id=pid, reason="reached_stage" if reached else "not_choosable")
        )

    # 4. the template and its versions; 5. the template_changes row.
    change_id = uuid.uuid4()
    summaries: list[dict[str, Any]] = []
    for e in entries:
        revived = evaluation.revived.get(e.category.code, {})
        await _write_template(db, e, revived)
        summaries.append(change_summary(e, e.category.template_version, revived))
    db.add(
        TemplateChange(
            id=change_id,
            actor_user_id=current_user.user_id,
            reason=body.reason,
            changes=summaries,
            selection={"mode": mode, "project_ids": [str(p) for p in sorted(selected_ids)]},
        )
    )
    await db.flush()

    # 6. the copies (OR-4; no effort_weeks, no progress field); 8. one
    # project.template_applied row per changed project.
    changed: list[tuple[Project, str]] = []
    rederived: list[uuid.UUID] = []
    kinds = await template_kinds(db) if any(o.needs_rederive for o, _ in receivers) else {}
    for o, how in receivers:
        before, after = write_copies(o, change_id)
        if not after and not o.needs_rederive:  # pragma: no cover - a receiver writes
            continue
        changed.append((o.project, how))
        # P62 (contract §4.3): `lab_hold_weeks: [before, after]` per step
        # whose room-weeks copy changed.
        hold_changes = {
            sid: [before[sid].get("plan_lab_hold_weeks"), a["plan_lab_hold_weeks"]]
            for sid, a in sorted(after.items())
            if "plan_lab_hold_weeks" in a
        }
        after_state: dict[str, Any] = {
            "template_change_id": str(change_id),
            "workflow_id": o.entry.category.workflow_id,
            "category": o.entry.category.code,
            "received_as": how,
            "steps": after,
            "effort_rederived": o.needs_rederive,
        }
        if hold_changes:
            after_state["lab_hold_weeks"] = hold_changes
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="project.template_applied",
                entity_type="Project",
                entity_id=str(o.project.id),
                hub_id=o.project.hub_id,
                before_state={"steps": before},
                after_state=after_state,
            )
        )
        if o.needs_rederive:
            # ADR 0070: the revived weight reaches this project; the same R6
            # re-derivation as the project PATCH (audit
            # `project.effort_rederived`), after the template weights and the
            # copies above are in the session. P62 (R62-8): or a room-weeks
            # flip on an own-lab-figure project (trigger `lab_hold_change`,
            # no `started_share` refusal).
            await db.flush()
            try:
                await rederive_project_effort(
                    db,
                    o.project,
                    trigger=o.rederive_trigger or TRIGGER_TEMPLATE_REVIVE,
                    actor_user_id=current_user.user_id,
                    kinds=kinds,
                    rows=sorted(o.rows.values(), key=lambda r: r.sequence_order),
                )
            except EffortSplitRejected as exc:  # pragma: no cover - predicted in evaluate
                await db.rollback()
                raise split_rejected_error(exc, kinds) from exc
            rederived.append(o.project.id)
    await db.flush()
    # 7. stale on the changed projects.
    await mark_projects_stale(db, [p.id for p, _ in changed])

    own_effort = evaluation.in_list("own_effort")
    schedulable_changed = [p for p, _ in changed if p.status not in NON_SCHEDULABLE_STATUSES]
    # P62 (contract §4.3, ADR 0069): an apply that changes only room weeks
    # marks stale and dispatches nothing (`not_needed`).
    hold_only = all(e.hold_only for e in entries)
    if hold_only:
        schedulable_changed = []
    recalc, baseline_id = await decide_auto_recalc_batch(
        db, needs_run=bool(schedulable_changed), trigger_reason=TEMPLATE_APPLY_TRIGGER_REASON,
        defer=body.defer_recalc,
    )
    # 8. the summary row: every affected project id, with reasons.
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="workflow_template.applied",
            entity_type="TemplateChange",
            entity_id=str(change_id),
            hub_id=None,
            before_state=None,
            after_state={
                "template_change_id": str(change_id),
                "changes": summaries,
                "selection_mode": mode,
                "automatic": [str(p.id) for p, how in changed if how == "automatic"],
                "selected": [str(p.id) for p, how in changed if how == "selected"],
                "own_effort": [str(o.project.id) for o in own_effort],
                # ADR 0070: revived weights and the projects re-derived.
                "effort_weights_revived": {
                    code: dict(sorted(steps.items()))
                    for code, steps in sorted(evaluation.revived.items())
                },
                "effort_rederived": [str(pid) for pid in rederived],
                "never": [
                    {"project_id": str(o.project.id), "reason": reason, "step_ids": step_ids}
                    for o, reason, step_ids in evaluation.never()
                ],
                "not_applied": [
                    {"project_id": str(n.project_id), "reason": n.reason} for n in not_applied
                ],
                # Free text, possibly personal: only its length (as comments).
                "reason_length": len(body.reason) if body.reason else 0,
                "recalc_status": recalc,
            },
        )
    )
    # 9. commit; 10. one greedy run (or deferred + one coalesced follow-up,
    # or not_needed).
    outcome = await dispatch_auto_recalc_batch(
        db,
        schedulable_changed,
        current_user,
        recalc=recalc,
        baseline_id=baseline_id,
        trigger_reason=TEMPLATE_APPLY_TRIGGER_REASON,
    )
    return TemplateApplyResponse(
        template_change_id=change_id,
        versions=[_version(e) for e in entries],
        applied=AppliedCounts(
            automatic=sum(1 for _, how in changed if how == "automatic"),
            selected=sum(1 for _, how in changed if how == "selected"),
            own_effort_not_applied=len(own_effort),
        ),
        not_applied=not_applied,
        recalc_status=outcome.recalc_status,
        schedule_run_id=outcome.schedule_run_id,
        task_id=outcome.task_id,
    )


# --- ADR 0070: one-time effort-weight sync ------------------------------------------------------


@router.post("/sync-effort-weights", response_model=EffortWeightSyncResponse)
async def sync_effort_weights_endpoint(
    body: EffortWeightSyncRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_super_admin_only),
) -> EffortWeightSyncResponse:
    """ADR 0070 catch-up (owner 2026-11-24, "Split the figure"): every
    template row with `weeks > 0` and `effort_weight_weeks = 0` gets weight
    = weeks, and every not-closed, not-frozen project of those categories
    with its own effort for the step's kind and the step not reached gets the
    copy and a re-derived split (`services.effort_weight_sync`).

    `dry_run: true` reads only (no lock, no write, no audit). `dry_run:
    false` takes the band-rank lock first (503 `BAND_RANK_BUSY`), writes the
    weights, copies and effort, audit rows and `schedule_stale` in one
    transaction, and never dispatches a run (recalculation is manual,
    ADR 0069). Idempotent: once applied there is nothing left to sync."""

    _rate_limit(
        SYNC_EFFORT_WEIGHTS_RATE_LIMIT, "sync-effort-weights", current_user, "effort-weight syncs"
    )
    if not body.dry_run:
        await lock_band_ranks(db)
    try:
        result = await sync_effort_weights(
            db, dry_run=body.dry_run, actor_user_id=current_user.user_id
        )
    except EffortSplitRejected as exc:  # pragma: no cover - predicted per project
        await db.rollback()
        raise split_rejected_error(exc) from exc
    if body.dry_run:
        await db.rollback()
    else:
        await db.commit()
    return result


# --- B2: add category -------------------------------------------------------------------------


def _category_read(c: Category) -> CategoryRead:
    return CategoryRead(code=c.code, label=c.label, workflow_id=c.workflow_id, rank=c.rank)


@router.post(
    "/categories", response_model=CategoryCreateResponse, status_code=status.HTTP_201_CREATED
)
async def create_category(
    body: CategoryCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(require_workflow_templates_write),
) -> CategoryCreateResponse:
    """Contract B2 (`services.category_admin`). Nothing is marked stale and
    no run is dispatched."""

    _rate_limit(ADD_CATEGORY_RATE_LIMIT, "add-category", current_user, "new categories")
    added = await add_category(
        db,
        code=body.code,
        label=body.label,
        workflow_id=body.workflow_id,
        copy_from=body.copy_from,
        insert_after=body.insert_after,
        actor_user_id=current_user.user_id,
    )
    category = _category_read(added.category)
    ordered = [_category_read(c) for c in added.ordered]
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="category.created",
            entity_type="Category",
            entity_id=added.category.code,
            hub_id=None,
            before_state=None,
            after_state={
                "category": {
                    **category.model_dump(),
                    "template_version": added.category.template_version,
                    "copied_from_code": added.category.copied_from_code,
                },
                "template_rows": added.template_rows,
                "ranks": [c.code for c in ordered],
            },
        )
    )
    for ext in added.engineers:
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="engineer.allowed_categories_extended",
                entity_type="Engineer",
                entity_id=str(ext.engineer_id),
                hub_id=ext.hub_id,
                before_state={"allowed_categories": ext.before},
                after_state={
                    "allowed_categories": ext.after,
                    "category": added.category.code,
                },
            )
        )
    await db.commit()
    return CategoryCreateResponse(
        category=category,
        categories=ordered,
        template_rows=len(added.template_rows),
        engineers_extended=len(added.engineers),
    )
