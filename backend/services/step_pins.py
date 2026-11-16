"""Manual step pins: the batch write and the served editability (P40-T03b).

ADR 0054 "Ruling (P40-T02)" R40-1, R40-2, R40-11; docs/DOMAIN_RULES.md
"Manual step weeks". The scheduler side (placement, flags) lives in
`backend/scheduling/` (algorithm-engineer); nothing here schedules.

**Batch save** (`save_step_pins`), all-or-nothing, in this order:

1. 422 `DUPLICATE_STEP` (the same project + step twice) and 422
   `PIN_INVALID` (a partial pair, or end < start) — shape only, before any
   lock.
2. The project rows `FOR UPDATE` in `project_id` order (the R33-10 lock the
   stage PATCH, the check-in and the template apply take), then the scoped
   lookup: a project out of the caller's hub scope, or nonexistent, is 404
   `PROJECT_NOT_FOUND` (existence is never revealed); a step that is not a
   live step of the project's workflow is 422 `UNKNOWN_STEP`.
3. Under the lock, for every item whose pair differs from the stored one
   (an equal pair is a no-op and is never refused):
   - set: 422 `PIN_OUT_OF_RANGE` unless `CW <= ms <= me <= 52` (CW = the
     request's `plan_clock` week); then 409 `PROJECT_FROZEN`,
     `PROJECT_CLOSED` (Cancelled / Commercialized), `STEP_STARTED` (stored
     stage not Not Started), `STEP_SKIPPED` (R35-1 `eff = 0`), first failing
     condition per item;
   - clear: 409 `PROJECT_FROZEN` only.
   All 422s of a phase are reported together; 422 range errors win over
   409s. A refusal writes nothing (the request's session ends without a
   commit, which also releases the locks). The top-level `code` is the
   first failing item's code; `detail.errors` lists every failing item.
4. Write the pairs, one `project.step_pinned` / `project.step_pin_cleared`
   audit row per changed pair (`cause = "manual"`), `schedule_stale` on the
   changed projects, then ONE greedy run through the priority move's
   lifecycle (`trigger_reason = "step_pin"`), `not_needed` when no
   schedulable project changed.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    ProjectStatus,
    RoleName,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.hub import Hub
from models.project import Project, workflow_id_for_hub
from models.schedule import ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from scheduling.workflow import fte_span, is_valid_fte
from schemas.step_pin import (
    PinBlockReason,
    StepPinChange,
    StepPinError,
    StepPinErrorCode,
    StepPinItem,
)
from services.hub_scope import hub_scope_filter, is_hub_in_scope
from services.priority_move import (
    AutoRecalcOutcome,
    decide_auto_recalc_batch,
    dispatch_auto_recalc_batch,
)
from services.schedule_stale import mark_projects_stale
from services.step_pin_clear import CAUSE_MANUAL, add_pin_audit
from services.template_apply import lock_projects
from services.workspace import row_is_skipped, row_own_effort_kinds

#: `ScheduleRun.trigger_reason` of the run a pin save starts (R40-11).
TRIGGER_REASON = "step_pin"

#: R40-2: the roles that may write pins (and unfreeze, R40-10).
PIN_ROLES: frozenset[RoleName] = frozenset({RoleName.ADMIN, RoleName.SUPER_ADMIN})

#: R40-1: the stored / written cap (WITHIN_YEAR_WEEK, not HORIZON_WEEKS).
PIN_MAX_WEEK = dc.WITHIN_YEAR_WEEK

_CLOSED = frozenset({ProjectStatus.CANCELLED, ProjectStatus.COMMERCIALIZED})

_MESSAGES: Mapping[StepPinErrorCode, str] = {
    "DUPLICATE_STEP": "This step appears more than once in the batch.",
    "PIN_INVALID": "Give both a start and an end week (end not before start), or neither.",
    "PIN_OUT_OF_RANGE": "",  # filled per request: names the allowed weeks
    "PROJECT_NOT_FOUND": "Project not found.",
    "UNKNOWN_STEP": "This step is not a step of the project's workflow.",
    "PROJECT_FROZEN": "This project is frozen. Its step weeks cannot be changed.",
    "PROJECT_CLOSED": "This project is Cancelled or Commercialized.",
    "STEP_STARTED": "This step has started. Only a Not Started step can be pinned.",
    "STEP_SKIPPED": "This step is skipped (0 weeks) for this project.",
}


def can_write_pins(principal: Principal) -> bool:
    """R40-2: the Admin and Super Admin **roles** (not a project grant)."""

    return bool(principal.roles & PIN_ROLES)


def pin_length(start: int | None, end: int | None) -> int | None:
    if start is None or end is None:
        return None
    return end - start + 1


def set_block_reason(
    project: Project, row: ProjectWorkflowStep, *, skipped: bool
) -> PinBlockReason | None:
    """R40-2: why a pin may not be **set** on this step (first failing
    condition), or None. Role and scope are the caller's (see
    `pin_block_reason`)."""

    if project.frozen:
        return "PROJECT_FROZEN"
    if project.status in _CLOSED:
        return "PROJECT_CLOSED"
    if row.status != WorkflowStepStatus.NOT_STARTED:
        return "STEP_STARTED"
    if skipped:
        return "STEP_SKIPPED"
    return None


def pin_block_reason(
    principal: Principal, project: Project, row: ProjectWorkflowStep | None, *, skipped: bool
) -> PinBlockReason | None:
    """The served `pin_block_reason`: `NOT_ALLOWED` when the caller may not
    write pins on this project (role or hub scope), else `set_block_reason`.
    `STEP_STARTED` when the project has no live row for the step."""

    if not can_write_pins(principal) or not is_hub_in_scope(principal, project.hub_id):
        return "NOT_ALLOWED"
    if row is None:
        return "STEP_STARTED" if not project.frozen else "PROJECT_FROZEN"
    return set_block_reason(project, row, skipped=skipped)


def current_length_weeks(
    *,
    row: ProjectWorkflowStep | None,
    run_step: ScheduleRunProjectStep | None,
    eff: int,
    kind: WorkflowStepKind,
    frozen: bool,
    leader_fte: float | None,
) -> int:
    """R40-2 "current length", served as `current_length_weeks`:

    - the live pin's length, if one is set;
    - else the active run row's window length (`end − start + 1`); a skipped
      run row is 0;
    - else `ceil(eff / fte)` for a design step of a non-frozen project with a
      valid leader FTE, otherwise `eff`.
    """

    if row is not None:
        length = pin_length(row.manual_start_week, row.manual_end_week)
        if length is not None:
            return length
    if run_step is not None:
        if run_step.skipped:
            return 0
        return run_step.end_week - run_step.start_week + 1
    if eff <= 0:
        return 0
    if (
        kind == WorkflowStepKind.DESIGN
        and not frozen
        and leader_fte is not None
        and is_valid_fte(leader_fte)
    ):
        return fte_span(eff, leader_fte)
    return eff


# --- the batch write ------------------------------------------------------------------


@dataclass
class StepPinSaveResult:
    changes: list[StepPinChange]
    unchanged_count: int
    projects_marked_stale: list[uuid.UUID]
    outcome: AutoRecalcOutcome
    current_week: int

    def response_headers(self) -> dict[str, str]:
        return self.outcome.response_headers()


def _error(
    index: int, item: StepPinItem, code: StepPinErrorCode, message: str | None = None
) -> StepPinError:
    return StepPinError(
        index=index,
        project_id=item.project_id,
        step_template_id=item.step_template_id,
        code=code,
        message=message or _MESSAGES[code],
    )


def _refuse(status_code: int, errors: list[StepPinError]) -> CodedHTTPException:
    code = errors[0].code
    return CodedHTTPException(
        status_code,
        code,
        {
            "code": code,
            "message": "Nothing was saved: fix the steps listed in errors.",
            "errors": [e.model_dump(mode="json") for e in errors],
        },
    )


async def save_step_pins(
    db: AsyncSession,
    items: Sequence[StepPinItem],
    principal: Principal,
    *,
    current_week: int,
) -> StepPinSaveResult:
    """See the module docstring. The caller has checked the role (403)."""

    # --- 1. shape, before any lock ------------------------------------------------------
    errors: list[StepPinError] = []
    seen: set[tuple[uuid.UUID, str]] = set()
    for index, item in enumerate(items):
        key = (item.project_id, item.step_template_id)
        if key in seen:
            errors.append(_error(index, item, "DUPLICATE_STEP"))
            continue
        seen.add(key)
        start, end = item.manual_start_week, item.manual_end_week
        if (start is None) != (end is None) or (
            start is not None and end is not None and end < start
        ):
            errors.append(_error(index, item, "PIN_INVALID"))
    if errors:
        raise _refuse(HTTP_422, errors)

    # --- 2. lock, scoped lookup, live rows ------------------------------------------------
    project_ids = sorted({item.project_id for item in items})
    await lock_projects(db, project_ids)
    stmt = (
        select(Project).where(Project.id.in_(project_ids)).execution_options(populate_existing=True)
    )
    scope = hub_scope_filter(principal, Project.hub_id)
    if scope is not None:
        stmt = stmt.where(scope)
    projects = {p.id: p for p in (await db.execute(stmt)).scalars()}
    missing = [
        _error(i, item, "PROJECT_NOT_FOUND")
        for i, item in enumerate(items)
        if item.project_id not in projects
    ]
    if missing:
        raise _refuse(status.HTTP_404_NOT_FOUND, missing)

    templates = {t.id: t for t in (await db.execute(select(WorkflowStepTemplate))).scalars()}
    live = (
        (
            await db.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id.in_(project_ids))
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    rows: dict[tuple[uuid.UUID, str], ProjectWorkflowStep] = {
        (r.project_id, r.step_template_id): r for r in live
    }
    rows_by_project: dict[uuid.UUID, list[ProjectWorkflowStep]] = {}
    for r in live:
        rows_by_project.setdefault(r.project_id, []).append(r)
    own_kinds = {pid: row_own_effort_kinds(prs, templates) for pid, prs in rows_by_project.items()}
    # The project's workflow decides which steps are "its" steps.
    oem_by_hub = {
        h_id: is_oem
        for h_id, is_oem in (
            await db.execute(
                select(Hub.id, Hub.is_oem).where(Hub.id.in_({p.hub_id for p in projects.values()}))
            )
        ).all()
    }
    unknown: list[StepPinError] = []
    for i, item in enumerate(items):
        project = projects[item.project_id]
        template = templates.get(item.step_template_id)
        workflow_id = workflow_id_for_hub(oem_by_hub.get(project.hub_id, False))
        if (
            template is None
            or template.workflow_id != workflow_id
            or (item.project_id, item.step_template_id) not in rows
        ):
            unknown.append(_error(i, item, "UNKNOWN_STEP"))
    if unknown:
        raise _refuse(HTTP_422, unknown)

    # --- 3. rules under the lock, changed items only ------------------------------------
    changed: list[tuple[int, StepPinItem, ProjectWorkflowStep]] = []
    unchanged_count = 0
    for i, item in enumerate(items):
        row = rows[(item.project_id, item.step_template_id)]
        if (row.manual_start_week, row.manual_end_week) == (
            item.manual_start_week,
            item.manual_end_week,
        ):
            unchanged_count += 1
            continue
        changed.append((i, item, row))

    range_errors: list[StepPinError] = []
    for i, item, _row in changed:
        start, end = item.manual_start_week, item.manual_end_week
        if start is None or end is None:
            continue
        if not (current_week <= start <= end <= PIN_MAX_WEEK):
            range_errors.append(
                _error(
                    i,
                    item,
                    "PIN_OUT_OF_RANGE",
                    f"Pick weeks between W{current_week} and W{PIN_MAX_WEEK}.",
                )
            )
    if range_errors:
        raise _refuse(HTTP_422, range_errors)

    conflicts: list[StepPinError] = []
    for i, item, row in changed:
        project = projects[item.project_id]
        if item.manual_start_week is None:
            if project.frozen:
                conflicts.append(_error(i, item, "PROJECT_FROZEN"))
            continue
        template = templates[item.step_template_id]
        skipped = row_is_skipped(
            row,
            template.kind,
            project.certification_testing_required,
            own_effort=template.kind.value in own_kinds.get(project.id, frozenset()),
        )
        reason = set_block_reason(project, row, skipped=skipped)
        if reason is not None:
            conflicts.append(_error(i, item, reason))  # type: ignore[arg-type]
    if conflicts:
        raise _refuse(status.HTTP_409_CONFLICT, conflicts)

    # --- 4. write, audit, stale, one run ------------------------------------------------
    out: list[StepPinChange] = []
    changed_projects: dict[uuid.UUID, Project] = {}
    for _i, item, row in changed:
        project = projects[item.project_id]
        before = (row.manual_start_week, row.manual_end_week)
        row.manual_start_week = item.manual_start_week
        row.manual_end_week = item.manual_end_week
        add_pin_audit(
            db,
            project=project,
            row=row,
            before=before,
            cause=CAUSE_MANUAL,
            actor_user_id=principal.user_id,
        )
        changed_projects[project.id] = project
        out.append(
            StepPinChange(
                project_id=project.id,
                step_template_id=row.step_template_id,
                action="cleared" if item.manual_start_week is None else "pinned",
                before_start_week=before[0],
                before_end_week=before[1],
                manual_start_week=row.manual_start_week,
                manual_end_week=row.manual_end_week,
            )
        )

    if not changed_projects:
        # Every item equals the stored pair: nothing written, no run. The
        # commit only ends the transaction (releases the row locks).
        await db.commit()
        return StepPinSaveResult(
            changes=[],
            unchanged_count=unchanged_count,
            projects_marked_stale=[],
            outcome=AutoRecalcOutcome(recalc_status="unchanged"),
            current_week=current_week,
        )

    await db.flush()
    stale_ids = sorted(changed_projects)
    await mark_projects_stale(db, stale_ids)
    needs_run = any(p.status not in NON_SCHEDULABLE_STATUSES for p in changed_projects.values())
    recalc, baseline_id = await decide_auto_recalc_batch(
        db, needs_run=needs_run, trigger_reason=TRIGGER_REASON
    )
    outcome = await dispatch_auto_recalc_batch(
        db,
        [changed_projects[pid] for pid in stale_ids],
        principal,
        recalc=recalc,
        baseline_id=baseline_id,
        trigger_reason=TRIGGER_REASON,
    )
    return StepPinSaveResult(
        changes=out,
        unchanged_count=unchanged_count,
        projects_marked_stale=stale_ids,
        outcome=outcome,
        current_week=current_week,
    )


__all__ = [
    "PIN_MAX_WEEK",
    "PIN_ROLES",
    "TRIGGER_REASON",
    "StepPinSaveResult",
    "can_write_pins",
    "current_length_weeks",
    "pin_block_reason",
    "pin_length",
    "save_step_pins",
    "set_block_reason",
]
