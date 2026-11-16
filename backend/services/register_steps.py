"""Per-project step exclusion and "current step" for the Projects register
popup (P35-T05; ADR 0049 as ruled at P35-T03, R35-1..R35-12, I33–I36;
owner request 2026-11-17 for `current_step_code`;
docs/API_CONTRACT_REGISTER_POPUP.md).

Three things live here, all over one project's 14 live
`ProjectWorkflowStep` rows:

- **Applicability (R35-2).** Which steps may be excluded, from the template
  copy, never from `eff` (the split can revive a zeroed step):

      inForce(p,k)    ⟺ figure_k(p) > 0 ∧ (k ≠ lab ∨ p.cert)
                         ∧ ∃ s of kind k: effort_weight_weeks(s) > 0
      applicable(p,s) ⟺ ¬(kind(s) = lab ∧ ¬p.cert)
                         ∧ (effort_weight_weeks(s) > 0   if inForce(p, kind(s))
                            plan_weeks(s) > 0            otherwise)

- **Exclusion edits (R35-2/4/6/10).** Validated, then only `excluded` is
  written (R35-4), the effort re-derived over S′ (R35-3/R35-6), one
  `project.step_excluded` / `project.step_included` audit row per changed
  step with the stage status at the time and that kind's `eff` before /
  after for every step whose `eff` changed. Refusals: 409
  `PROJECT_FROZEN`, `PROJECT_CLOSED`, `STEP_NOT_APPLICABLE`, `STEP_DONE`;
  422 `UNKNOWN_STEP`.

- **Current step (owner, 2026-11-17).** Picking step C sets progress the way
  a weekly check-in at `CURRENT_WEEK` would (`services.workspace.
  merge_stage_update`, the check-in's server-filled weeks): every
  not-skipped step before C in workflow order (`sequence_order`) becomes
  Done, C becomes In Progress (an In Progress or on-hold (`Blocked`) C is
  kept as it is), every not-skipped step after C becomes Not Started.
  Skipped steps (excluded, 0-length, lab without certification testing,
  split to 0) are never written (R35-4 / I34). C itself must not be skipped
  (422 `STEP_NOT_APPLICABLE`); a frozen project is 409 `PROJECT_FROZEN`. One
  `project.current_step_set` audit row with the before / after current step
  and the before / after progress of every changed stage. Applied after the
  exclusions of the same patch.

- **Guards (R35-5)** on the final state of a Save: a figure in force whose
  every weighted step is excluded → 409 `EFFORT_NEEDS_A_STEP`; no step with
  `eff > 0` → 409 `NO_STEPS_LEFT`.

Nothing here commits; the caller owns the transaction (the register batch
holds the R35-10 project row lock). No financial field is read or written.
"""

from __future__ import annotations

import uuid
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException, field_error
from models.audit import AuditLogEntry
from models.enums import ProjectStatus, WorkflowStepKind, WorkflowStepStatus
from models.project import Project
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from scheduling.effort_split import EffortSplitRejected
from services.project_effort import (
    TRIGGER_STAGE_STATUS,
    TRIGGER_STEP_EXCLUSION,
    derive_for,
    effort_weights,
    exclusion_guard_error,
    rederive_project_effort,
    split_rejected_error,
)
from services.step_pin_clear import clear_pin_if_started
from services.workspace import (
    merge_stage_update,
    row_effective_weeks,
    row_is_skipped,
    row_own_effort_kinds,
)

AUDIT_STEP_EXCLUDED = "project.step_excluded"
AUDIT_STEP_INCLUDED = "project.step_included"
AUDIT_CURRENT_STEP_SET = "project.current_step_set"
#: `reason` on the exclusion audit rows (a workflow change clears flags with
#: reason `workflow_change`, `services.project_steps`, R35-11).
REASON_REGISTER_EDIT = "register_edit"

#: The served "skipped" stage status of the register-steps read.
STATUS_SKIPPED = "Skipped"

_CLOSED_STATUSES = frozenset({ProjectStatus.CANCELLED, ProjectStatus.COMMERCIALIZED})
_EFFORT_KINDS = ("design", "lab")


# --- Loading --------------------------------------------------------------------------


@dataclass
class StepContext:
    """One project's workflow templates (in workflow order), its live rows by
    step id, the template kinds and the category's R2 weights."""

    workflow_id: str
    templates: list[WorkflowStepTemplate]
    rows: dict[str, ProjectWorkflowStep]
    weights: dict[str, int]

    @property
    def kinds(self) -> dict[str, str]:
        return {t.id: t.kind.value for t in self.templates}

    def ordered_rows(self) -> list[ProjectWorkflowStep]:
        return [self.rows[t.id] for t in self.templates if t.id in self.rows]


async def load_step_context(
    db: AsyncSession, project: Project, *, workflow_id: str
) -> StepContext:
    """Three queries: the workflow's templates, the project's live rows, the
    category's weights."""

    templates = list(
        (
            await db.execute(
                select(WorkflowStepTemplate)
                .where(WorkflowStepTemplate.workflow_id == workflow_id)
                .order_by(WorkflowStepTemplate.sequence_order)
            )
        ).scalars()
    )
    rows = {
        r.step_template_id: r
        for r in (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == project.id)
            )
        ).scalars()
    }
    return StepContext(
        workflow_id=workflow_id,
        templates=templates,
        rows=rows,
        weights=await effort_weights(db, workflow_id, project.category),
    )


# --- Pure predicates ------------------------------------------------------------------


def _figure_positive(value: object) -> bool:
    if value is None:
        return False
    return Decimal(str(value)) > 0


def in_force_kinds(project: Project, ctx: StepContext) -> frozenset[str]:
    """R35-2 `inForce(p, k)` for k ∈ {design, lab}."""

    out: set[str] = set()
    kinds = ctx.kinds
    for kind, figure in (
        ("design", project.design_effort_weeks),
        ("lab", project.lab_effort_weeks),
    ):
        if not _figure_positive(figure):
            continue
        if kind == "lab" and not project.certification_testing_required:
            continue
        if any(kinds.get(sid) == kind and w > 0 for sid, w in ctx.weights.items()):
            out.add(kind)
    return frozenset(out)


def is_applicable(
    row: ProjectWorkflowStep, kind: str, *, cert: bool, in_force: frozenset[str],
    weights: Mapping[str, int],
) -> bool:
    """R35-2 `applicable(p, s)`: from the template copy and the R2 weights,
    ignoring the step's own exclusion."""

    if kind == "lab" and not cert:
        return False
    if kind in in_force:
        return weights.get(row.step_template_id, 0) > 0
    return row.plan_weeks > 0


def _eff_map(project: Project, ctx: StepContext) -> dict[str, int]:
    """R35-1 `eff` of every live row (the one service predicate)."""

    own = row_own_effort_kinds(ctx.rows.values(), ctx.kinds)
    out: dict[str, int] = {}
    for t in ctx.templates:
        row = ctx.rows.get(t.id)
        if row is None:
            continue
        out[t.id] = row_effective_weeks(
            row, t.kind, project.certification_testing_required, own_effort=t.kind.value in own
        )
    return out


def _skipped_map(project: Project, ctx: StepContext) -> dict[str, bool]:
    own = row_own_effort_kinds(ctx.rows.values(), ctx.kinds)
    return {
        t.id: row_is_skipped(
            ctx.rows[t.id], t.kind, project.certification_testing_required,
            own_effort=t.kind.value in own,
        )
        for t in ctx.templates
        if t.id in ctx.rows
    }


def live_current_step_id(project: Project, ctx: StepContext) -> str | None:
    """The first live row, in workflow order, that is neither skipped nor
    Done (the card rule of `services.project_cards`, on the live rows)."""

    skipped = _skipped_map(project, ctx)
    for t in ctx.templates:
        row = ctx.rows.get(t.id)
        if row is not None and not skipped[t.id] and row.status != WorkflowStepStatus.DONE:
            return t.id
    return None


async def project_eff_map(db: AsyncSession, project: Project, workflow_id: str) -> dict[str, int]:
    """R35-1 `eff` by step id of a stored project (for the Save response's
    per-step changes, R35-7)."""

    return _eff_map(project, await load_step_context(db, project, workflow_id=workflow_id))


# --- Edits ----------------------------------------------------------------------------


@dataclass
class StepEdits:
    """The step part of one register patch."""

    #: `(step_code, step_excluded)` in request order.
    exclusions: list[tuple[str, bool]] = field(default_factory=list)
    #: None = not sent.
    current_step_code: str | None = None

    @property
    def empty(self) -> bool:
        return not self.exclusions and self.current_step_code is None


def _conflict(code: str, loc: str, message: str) -> CodedHTTPException:
    return CodedHTTPException(status.HTTP_409_CONFLICT, code, [field_error(loc, message)])


def _unknown_step(loc: str, code: str) -> CodedHTTPException:
    return CodedHTTPException(
        HTTP_422, "UNKNOWN_STEP", [field_error(loc, f"Unknown step {code!r} for this project.")]
    )


def _stage_state(row: ProjectWorkflowStep) -> dict[str, Any]:
    """The check-in / Workspace audit shape (the hold reason by length only)."""

    return {
        "step_id": row.step_template_id,
        "status": row.status.value,
        "percent_complete": row.percent_complete,
        "actual_start_week": row.actual_start_week,
        "actual_end_week": row.actual_end_week,
        "remaining_weeks_override": row.remaining_weeks_override,
        "blocked_reason_length": len(row.blocked_reason) if row.blocked_reason else 0,
    }


async def _rederive(
    db: AsyncSession, project: Project, ctx: StepContext, *, trigger: str,
    actor_user_id: uuid.UUID | None,
) -> None:
    try:
        await rederive_project_effort(
            db,
            project,
            trigger=trigger,
            actor_user_id=actor_user_id,
            kinds=ctx.kinds,
            rows=ctx.ordered_rows(),
        )
    except EffortSplitRejected as exc:
        # R7 over S′: excluding concentrates the figure on fewer steps.
        raise split_rejected_error(exc, ctx.kinds) from exc


async def apply_step_exclusions(
    db: AsyncSession,
    project: Project,
    ctx: StepContext,
    exclusions: Sequence[tuple[str, bool]],
    *,
    actor_user_id: uuid.UUID | None,
) -> bool:
    """Validate and write the exclusion edits of one patch (module docstring).
    Returns True when some flag changed. Every check runs before the first
    write; the effort is then re-derived over S′ in the same transaction."""

    in_force = in_force_kinds(project, ctx)
    kinds = ctx.kinds
    changes: list[tuple[ProjectWorkflowStep, bool]] = []
    for code, wanted in exclusions:
        row = ctx.rows.get(code)
        if row is None or code not in kinds:
            raise _unknown_step("step_exclusions", code)
        if bool(row.excluded) == wanted:
            continue  # R35-2: "include" on a non-excluded step is a no-op
        if project.frozen:
            raise _conflict(
                "PROJECT_FROZEN", "step_exclusions",
                "This project is frozen. Unfreeze it on the Gantt to change its steps.",
            )
        if project.status in _CLOSED_STATUSES:
            raise _conflict(
                "PROJECT_CLOSED", "step_exclusions",
                f"A {project.status.value} project's steps cannot be changed.",
            )
        if wanted:
            if not is_applicable(
                row, kinds[code], cert=project.certification_testing_required,
                in_force=in_force, weights=ctx.weights,
            ):
                raise _conflict(
                    "STEP_NOT_APPLICABLE", "step_exclusions",
                    f"Step {code} does not apply to this project, so it cannot be excluded.",
                )
            if row.status == WorkflowStepStatus.DONE:
                raise _conflict(
                    "STEP_DONE", "step_exclusions", f"Step {code} is Done and cannot be excluded."
                )
        changes.append((row, wanted))
    if not changes:
        return False

    eff_before = _eff_map(project, ctx)
    for row, wanted in changes:
        row.excluded = wanted
    project.schedule_stale = True
    await db.flush()
    await _rederive(
        db, project, ctx, trigger=TRIGGER_STEP_EXCLUSION, actor_user_id=actor_user_id
    )
    eff_after = _eff_map(project, ctx)
    for row, wanted in changes:
        kind = kinds[row.step_template_id]
        changed = {
            sid: [eff_before[sid], eff_after[sid]]
            for sid in sorted(eff_after)
            if kinds.get(sid) == kind and eff_before.get(sid) != eff_after[sid]
        }
        db.add(
            AuditLogEntry(
                actor_user_id=actor_user_id,
                action=AUDIT_STEP_EXCLUDED if wanted else AUDIT_STEP_INCLUDED,
                entity_type="Project",
                entity_id=str(project.id),
                hub_id=project.hub_id,
                before_state={
                    "project_id": str(project.id),
                    "step_id": row.step_template_id,
                    "step_row_id": str(row.id),
                    "step_excluded": not wanted,
                    "stage_status": row.status.value,
                    "eff": {sid: v[0] for sid, v in changed.items()},
                },
                after_state={
                    "project_id": str(project.id),
                    "step_id": row.step_template_id,
                    "step_row_id": str(row.id),
                    "step_excluded": wanted,
                    "stage_status": row.status.value,
                    "kind": kind,
                    "eff": {sid: v[1] for sid, v in changed.items()},
                    "reason": REASON_REGISTER_EDIT,
                },
            )
        )
    return True


def _target_explicit(
    row: ProjectWorkflowStep, position: str, week: int
) -> dict[str, Any] | None:
    """The progress update a check-in at `week` would make for `row`, which
    is before / at / after the picked step. None = unchanged."""

    s = row.status
    if position == "before":
        if s == WorkflowStepStatus.DONE:
            return None
        return {
            "status": WorkflowStepStatus.DONE,
            "percent_complete": 100,
            "actual_start_week": row.actual_start_week if row.actual_start_week is not None
            else week,
            "actual_end_week": week,
            "blocked_reason": None,
        }
    if position == "at":
        if s in (WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED):
            return None
        if s == WorkflowStepStatus.NOT_STARTED:
            return {"status": WorkflowStepStatus.IN_PROGRESS, "actual_start_week": week}
        # Done → reopened: the actual start is kept, the end cleared; the
        # Done percent (100) would make it finish at once, so it restarts at 0.
        return {
            "status": WorkflowStepStatus.IN_PROGRESS,
            "percent_complete": 0,
            "actual_end_week": None,
            "remaining_weeks_override": None,
        }
    if s == WorkflowStepStatus.NOT_STARTED:
        return None
    return {
        "status": WorkflowStepStatus.NOT_STARTED,
        "percent_complete": 0,
        "actual_start_week": None,
        "actual_end_week": None,
        "remaining_weeks_override": None,
        "blocked_reason": None,
    }


async def apply_current_step(
    db: AsyncSession,
    project: Project,
    ctx: StepContext,
    code: str,
    *,
    actor_user_id: uuid.UUID | None,
    week: int,
) -> bool:
    """Set the project's progress so `code` is its current step (module
    docstring), recording weeks as a check-in at `week` would (default: the
    calendar plan week from `services.plan_clock`, read once per request by
    the route, P37). Returns True when some stage changed."""

    if code not in ctx.rows or code not in ctx.kinds:
        raise _unknown_step("current_step_code", code)
    skipped = _skipped_map(project, ctx)
    if skipped[code]:
        raise CodedHTTPException(
            HTTP_422,
            "STEP_NOT_APPLICABLE",
            [
                field_error(
                    "current_step_code",
                    f"Step {code} is skipped or excluded for this project, so it cannot be "
                    "the current step.",
                )
            ],
        )
    target_seq = ctx.rows[code].sequence_order
    planned: list[tuple[ProjectWorkflowStep, dict[str, Any]]] = []
    problems: list[str] = []
    for row in ctx.ordered_rows():
        if skipped[row.step_template_id]:
            continue  # R35-4 / I34: a skipped step's progress is never written
        position = (
            "before" if row.sequence_order < target_seq
            else "at" if row.sequence_order == target_seq
            else "after"
        )
        explicit = _target_explicit(row, position, week)
        if explicit is None:
            continue
        merged, errors = merge_stage_update(row, explicit)
        problems.extend(f"{row.step_template_id}: {name} {msg}" for name, msg in errors)
        planned.append((row, merged))
    if problems:
        raise CodedHTTPException(
            HTTP_422,
            "INCONSISTENT_PROGRESS",
            [field_error("current_step_code", "; ".join(problems))],
        )
    if not planned:
        return False
    if project.frozen:
        raise _conflict(
            "PROJECT_FROZEN", "current_step_code",
            "This project is frozen. Unfreeze it on the Gantt to record stage progress.",
        )

    before_code = live_current_step_id(project, ctx)
    before_states = [_stage_state(row) for row, _ in planned]
    started_flip = False
    for row, merged in planned:
        was_started = row.status != WorkflowStepStatus.NOT_STARTED
        stage_before = row.status
        for name, value in merged.items():
            setattr(row, name, value)
        # P40-R01 (ADR 0054 R40-4, I46 (c)(e)): a stage leaving Not Started
        # loses its pin, in this transaction, under the caller's R35-10
        # project row lock; one `project.step_pin_cleared` audit row per
        # cleared pin (cause `stage_started`). A no-op for rows that stay or
        # return to Not Started, so a later backward move cannot revive a pin.
        clear_pin_if_started(
            db, project, row, stage_before=stage_before, actor_user_id=actor_user_id
        )
        started_flip |= was_started != (row.status != WorkflowStepStatus.NOT_STARTED)
    project.schedule_stale = True
    await db.flush()
    if started_flip:
        # ADR 0041 R3/R6: the split's `started` input changed.
        await _rederive(
            db, project, ctx, trigger=TRIGGER_STAGE_STATUS, actor_user_id=actor_user_id
        )
    db.add(
        AuditLogEntry(
            actor_user_id=actor_user_id,
            action=AUDIT_CURRENT_STEP_SET,
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state={
                "project_id": str(project.id),
                "current_step_code": before_code,
                "stages": before_states,
            },
            after_state={
                "project_id": str(project.id),
                "current_step_code": live_current_step_id(project, ctx),
                "requested_step_code": code,
                "week": week,
                "stages": [_stage_state(row) for row, _ in planned],
            },
        )
    )
    return True


def final_state_guard(project: Project, ctx: StepContext) -> CodedHTTPException | None:
    """R35-5 on the project's final state (only reachable with an excluded
    step): (a) `EFFORT_NEEDS_A_STEP`, (b) `NO_STEPS_LEFT`."""

    if not any(r.excluded for r in ctx.rows.values()):
        return None
    error = exclusion_guard_error(
        derive_for(project, ctx.ordered_rows(), ctx.kinds, ctx.weights)
    )
    if error is not None:
        return error
    if not any(v > 0 for v in _eff_map(project, ctx).values()):
        return _conflict(
            "NO_STEPS_LEFT", "step_exclusions",
            "The project must keep at least one step that takes time.",
        )
    return None


async def apply_step_edits(
    db: AsyncSession,
    project: Project,
    edits: StepEdits,
    *,
    workflow_id: str,
    actor_user_id: uuid.UUID | None,
    check_guards: bool,
    plan_week: int | None = None,
) -> bool:
    """The register patch's step part, after its project fields are written:
    exclusions, then the current step, then the R35-5 guards on the final
    state (also when only a figure / category / certification edit could
    trip them, `check_guards`). Returns True when a scheduler input changed.
    Raises a CodedHTTPException; the caller rolls back."""

    if edits.empty and not check_guards:
        return False
    ctx = await load_step_context(db, project, workflow_id=workflow_id)
    changed = False
    if edits.exclusions:
        changed |= await apply_step_exclusions(
            db, project, ctx, edits.exclusions, actor_user_id=actor_user_id
        )
    if edits.current_step_code is not None:
        if plan_week is None:  # the route must read the plan clock (P37)
            raise RuntimeError("apply_step_edits: current_step_code needs plan_week")
        changed |= await apply_current_step(
            db, project, ctx, edits.current_step_code,
            actor_user_id=actor_user_id, week=plan_week,
        )
    error = final_state_guard(project, ctx)
    if error is not None:
        raise error
    return changed


# --- The popup read -------------------------------------------------------------------


@dataclass(frozen=True)
class RegisterStepView:
    step_code: str
    step_name: str
    kind: WorkflowStepKind
    status: str
    step_excluded: bool
    applicable: bool
    excludable: bool
    is_current: bool


def build_step_views(
    project: Project, ctx: StepContext, *, current_step_code: str | None
) -> list[RegisterStepView]:
    """The popup's 14 chips in workflow order (contract §3)."""

    in_force = in_force_kinds(project, ctx)
    skipped = _skipped_map(project, ctx)
    editable = not project.frozen and project.status not in _CLOSED_STATUSES
    views: list[RegisterStepView] = []
    for t in ctx.templates:
        row = ctx.rows.get(t.id)
        if row is None:  # pragma: no cover - every project carries its 14 rows
            continue
        applicable = is_applicable(
            row, t.kind.value, cert=project.certification_testing_required,
            in_force=in_force, weights=ctx.weights,
        )
        views.append(
            RegisterStepView(
                step_code=t.id,
                step_name=t.name,
                kind=t.kind,
                status=STATUS_SKIPPED if skipped[t.id] else row.status.value,
                step_excluded=bool(row.excluded),
                applicable=applicable,
                excludable=editable and applicable and row.status != WorkflowStepStatus.DONE,
                is_current=t.id == current_step_code,
            )
        )
    return views
