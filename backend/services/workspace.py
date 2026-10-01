"""Project Workspace read model and rules (P9-T03; docs/API_CONTRACT_P9.md §7;
DOMAIN_RULES "Per-stage progress capture"; ADR 0006).

Where each figure comes from:

- **Health badge (I13):** only the active run's stored outcome and step rows
  for the project, via `health_badge`. Nothing is re-scheduled here.
- **Planned weeks, chamber, overrun:** the active run's `ScheduleRunProjectStep`.
- **Actuals, status, percent, override, blocked reason:** the live
  `ProjectWorkflowStep` (the planner's inputs).
- **progress_pct (I12, ruling 3):** always the one duration-weighted formula
  (`services.progress.project_progress_pct`, the single call site for the
  scheduler's shared function) over the stored percents, frozen projects
  included, with skipped steps weighted 0. A progress edit therefore shows
  up at once and always equals the scheduler's figure for the same inputs.
- **Remaining weeks:** `scheduling.workflow.derive_remaining`, the
  scheduler's own function. It is called, not re-implemented.

**Row scoping (P3-T03 pattern).** `get_scoped_project_or_404` applies the hub
filter for hub-scoped callers and the "own assignments" filter for an
Engineer (`services.hub_scope.is_engineer_self_scoped`). An Engineer's own
assignments are the projects they lead, plus the projects where the active
run assigns them a step. Out of scope and nonexistent both give 404.

**OQ#8 (docs/OPEN_QUESTIONS.md #8).** `_name_if_self` /
`_engineer_name_if_self` implement the P3-T09 rule for every person name
this surface returns: the name is returned only when it is the caller's own.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.deps import principal_can
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import WorkflowStepKind, WorkflowStepStatus
from models.hub import Hub
from models.priority import PriorityScore
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from models.workspace import ProjectComment, ProjectFile
from scheduling.workflow import derive_remaining
from schemas.workspace import (
    ActivityComment,
    ActivityEvent,
    CommentRead,
    FileRead,
    HealthBadge,
    WorkspacePriorityScore,
    WorkspaceProject,
    WorkspaceRead,
    WorkspaceSchedule,
    WorkspaceStage,
)
from services.active_run import get_active_run, slip_weeks
from services.hub_scope import hub_scope_filter, is_engineer_self_scoped
from services.progress import project_progress_pct
from services.project_access import effective_project_access

COMMENT_EDIT_WINDOW = timedelta(minutes=15)
ACTIVITY_DEFAULT_LIMIT = 50
ACTIVITY_MAX_LIMIT = 200
#: Audit actions for comments are not shown as events: the comment itself is
#: already in the feed.
_COMMENT_ACTION_PREFIX = "project_comment."
_FINANCIAL_FIELDS = ("customer_name", "tcogs_eur", "selling_price_eur", "gross_margin_pct")


# --- Pure helpers ---------------------------------------------------------------------


def is_step_skipped(duration: int, kind: WorkflowStepKind, cert_required: bool) -> bool:
    """ADR 0007: a 0-week step, or a lab step on a project without
    certification testing."""

    return duration == 0 or (kind == WorkflowStepKind.LAB and not cert_required)


def stage_overrun(
    run_step: ScheduleRunProjectStep | None, live: ProjectWorkflowStep | None
) -> int | None:
    """Weeks past the stage's lead-time duration in the active run:
    `(actual_end_week if Done else run end) − (run start + duration − 1)`,
    floored at 0. `None` for a skipped step or when the run has no row.
    """

    if run_step is None or run_step.skipped or run_step.duration_weeks == 0:
        return None
    end = run_step.end_week
    if (
        live is not None
        and live.status == WorkflowStepStatus.DONE
        and live.actual_end_week is not None
    ):
        end = live.actual_end_week
    planned_end = run_step.start_week + run_step.duration_weeks - 1
    return max(0, end - planned_end)


def health_badge(
    outcome: ScheduleRunProjectOutcome | None,
    run_steps: Sequence[ScheduleRunProjectStep],
    live_by_step: dict[str, ProjectWorkflowStep],
    run_current_week: int,
) -> HealthBadge:
    """DOMAIN_RULES "Health badge" (I13), from the active run's stored rows:

    - no outcome, or no finish week (excluded, rejected as a data error) →
      `unscheduled`;
    - `left_out` → `left_out`;
    - `blocked` (a Blocked stage held the project) → `blocked` (ruling 5);
    - projected finish (`last_step_end + delay`, delay terminal per ADR 0004)
      after `WITHIN_YEAR_WEEK` → `off_track`;
    - any stage overrunning its duration, or any stage the run ends before
      its current week that is not Done (overdue) → `at_risk`;
    - otherwise `on_track`.
    """

    if outcome is None:
        return "unscheduled"
    if outcome.left_out:
        return "left_out"
    # Gate remediation ruling 5: after Left Out, before the finish-week rules.
    if outcome.blocked:
        return "blocked"
    if outcome.last_step_end_week is None:
        return "unscheduled"
    finish = outcome.last_step_end_week + outcome.delay_weeks_applied
    if finish > dc.WITHIN_YEAR_WEEK:
        return "off_track"
    for step in run_steps:
        if step.skipped:
            continue
        live = live_by_step.get(step.step_template_id)
        overrun = stage_overrun(step, live)
        if overrun is not None and overrun > 0:
            return "at_risk"
        done = live is not None and live.status == WorkflowStepStatus.DONE
        if step.end_week < run_current_week and not done:
            return "at_risk"
    return "on_track"


def _name_if_self(principal: Principal, user_id: uuid.UUID | None) -> str | None:
    """OQ#8 / P3-T09: a person's name is shown only to that person."""

    return principal.full_name if user_id is not None and user_id == principal.user_id else None


def _engineer_name_if_self(
    engineer_id: uuid.UUID | None, engineers: dict[uuid.UUID, Engineer], principal: Principal
) -> str | None:
    if engineer_id is None:
        return None
    engineer = engineers.get(engineer_id)
    if engineer is None or engineer.user_id != principal.user_id:
        return None
    return engineer.name


# --- Scoping --------------------------------------------------------------------------


async def own_engineer_id(db: AsyncSession, principal: Principal) -> uuid.UUID | None:
    return (
        await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
    ).scalar_one_or_none()


async def get_scoped_project_or_404(
    db: AsyncSession, project_id: uuid.UUID, principal: Principal
) -> Project | None:
    """The project if it exists *and* is in the caller's row scope, else
    `None` (the router turns that into a 404).

    **2026-09-30 (ADR 0012, P10-T02).** The hub-scope/own-assignment query
    below is unchanged (rules 3/6 of `services.project_access.
    effective_project_access`, reproduced here exactly as before this task).
    When it finds nothing, a second lookup falls back to that resolver's
    full MAX (which additionally covers rule 5, an active
    `ProjectAccessGrant`) — this is how a grant can surface a project the
    caller's role/hub scope alone would not, per the ADR, without changing
    behaviour for every caller who was already in scope by the first query.
    """

    stmt = select(Project).options(selectinload(Project.hub)).where(Project.id == project_id)
    #: `None` here means "the hub/own-assignment query below is not even
    #: worth running" (an Engineer-self-scoped caller with no linked
    #: `Engineer` row at all) — NOT "not in scope, give up now": that early
    #: exit used to `return None` directly, which incorrectly skipped the
    #: rule-5 (grant) fallback below for exactly this caller shape. Falling
    #: through to the fallback instead is what fixed it.
    run_scoped_query = True
    if is_engineer_self_scoped(principal):
        engineer_id = await own_engineer_id(db, principal)
        if engineer_id is None:
            run_scoped_query = False
        else:
            active = await get_active_run(db)
            assigned = select(ScheduleRunProjectStep.project_id).where(
                ScheduleRunProjectStep.assigned_engineer_id == engineer_id,
                ScheduleRunProjectStep.schedule_run_id == (active.id if active else None),
            )
            stmt = stmt.where(
                or_(Project.leader_engineer_id == engineer_id, Project.id.in_(assigned))
            )
    else:
        hub_filter = hub_scope_filter(principal, Project.hub_id)
        if hub_filter is not None:
            stmt = stmt.where(hub_filter)
    if run_scoped_query:
        project = (await db.execute(stmt)).scalar_one_or_none()
        if project is not None:
            return project

    fallback = (
        await db.execute(
            select(Project).options(selectinload(Project.hub)).where(Project.id == project_id)
        )
    ).scalar_one_or_none()
    if fallback is None:
        return None
    role = await effective_project_access(db, principal, fallback)
    return fallback if role is not None else None


# --- Serialisers ----------------------------------------------------------------------


def comment_read(comment: ProjectComment, principal: Principal, now: datetime) -> CommentRead:
    can_edit = (
        comment.author_user_id == principal.user_id
        and comment.soft_deleted_at is None
        and now < comment.created_at + COMMENT_EDIT_WINDOW
    )
    return CommentRead(
        id=comment.id,
        body_md=comment.body_md,
        author_name=_name_if_self(principal, comment.author_user_id),
        author_user_id=comment.author_user_id,
        created_at=comment.created_at,
        edited_at=comment.edited_at,
        can_edit=can_edit,
        mentioned_user_ids=[],
    )


def file_read(f: ProjectFile, principal: Principal) -> FileRead:
    return FileRead(
        id=f.id,
        display_name=f.display_name,
        category=f.category,
        description=f.description,
        version=f.version,
        size_bytes=f.size_bytes,
        content_type=f.content_type,
        uploaded_by_name=_name_if_self(principal, f.uploaded_by_user_id),
        created_at=f.created_at,
    )


# --- Activity feed --------------------------------------------------------------------

_FIELD_LABELS: dict[str, str] = {
    "name": "Name",
    "external_code": "External code",
    "category": "Category",
    "type": "Type",
    "status": "Status",
    "priority": "Priority",
    "frozen": "Frozen",
    "actual_start_week": "Actual start week",
    "delay_weeks": "Delay (weeks)",
    "reg_year": "Registration year",
    "carry_over": "Carry-over",
    "capex_keur": "CAPEX (k€)",
    "rm_savings_keur": "RM savings (k€)",
    "target_end_week": "Target end week",
    "certification_testing_required": "Certification testing required",
    "estimated_design_weeks": "Estimated design weeks",
    "estimated_lab_weeks": "Estimated lab weeks",
}


def _fmt(value: Any) -> str:
    return "—" if value is None else str(value)


def _week(value: Any) -> str:
    return "none" if value is None else f"week {value}"


def event_summary(entry: AuditLogEntry) -> str:
    """One human-readable line per audit row. Only non-personal values are
    shown: no engineer or user ids, and never a financial field (those are
    stored as `"<redacted>"` anyway).
    """

    before: dict[str, Any] = entry.before_state or {}
    after: dict[str, Any] = entry.after_state or {}
    action = entry.action
    if action == "project.create":
        return "Project registered"
    if action == "project.update":
        changes = [
            f"{label} changed {_fmt(before.get(key))} → {_fmt(after.get(key))}"
            for key, label in _FIELD_LABELS.items()
            if before.get(key) != after.get(key)
        ]
        if before.get("hub_id") != after.get("hub_id"):
            changes.append("Hub changed")
        if before.get("leader_engineer_id") != after.get("leader_engineer_id"):
            changes.append("Leader changed")
        return "; ".join(changes) if changes else "Project details updated"
    if action == "project.submit":
        return f"Submitted: {_fmt(before.get('status'))} → {_fmt(after.get('status'))}"
    if action == "project.freeze":
        return f"Frozen at {_week(after.get('actual_start_week'))}"
    if action == "project.unfreeze":
        return "Unfrozen"
    if action == "project_stage.update":
        step = after.get("step_id", "Stage")
        if before.get("status") != after.get("status"):
            return f"{step} marked {after.get('status')}"
        return f"{step} progress updated ({after.get('percent_complete')}%)"
    if action == "project_file.upload":
        return f"{after.get('display_name')} uploaded (v{after.get('version')})"
    if action == "project_file.update":
        if before.get("display_name") != after.get("display_name"):
            return f"File renamed {before.get('display_name')} → {after.get('display_name')}"
        return f"{after.get('display_name')} details updated"
    if action == "project.recalculate_requested":
        return "Schedule recalculation requested"
    if action == "project.schedule_recalculated":
        return (
            "Schedule recalculated — finish moved "
            f"{_week(before.get('projected_end_week'))} → {_week(after.get('projected_end_week'))}"
        )
    if action.startswith("priority_score."):
        pct = after.get("normalized_pct")
        band = after.get("suggested_band")
        return f"Priority score updated ({_fmt(pct)}%, suggested {_fmt(band)})"
    return action.replace("_", " ").replace(".", ": ")


async def list_activity(
    db: AsyncSession,
    project: Project,
    principal: Principal,
    *,
    before: datetime | None = None,
    limit: int = ACTIVITY_DEFAULT_LIMIT,
) -> list[ActivityComment | ActivityEvent]:
    """Comments ∪ audit-log events for the project, newest first. An event
    belongs to the project when it targets the `Project` row itself or its
    before/after state names the project (`project_id`). `before` is
    exclusive.
    """

    pid = str(project.id)
    event_stmt = (
        select(AuditLogEntry)
        .where(
            or_(
                and_(AuditLogEntry.entity_type == "Project", AuditLogEntry.entity_id == pid),
                AuditLogEntry.after_state["project_id"].astext == pid,
                AuditLogEntry.before_state["project_id"].astext == pid,
            )
        )
        .where(~AuditLogEntry.action.startswith(_COMMENT_ACTION_PREFIX, autoescape=True))
    )
    comment_stmt = select(ProjectComment).where(
        ProjectComment.project_id == project.id, ProjectComment.soft_deleted_at.is_(None)
    )
    if before is not None:
        event_stmt = event_stmt.where(AuditLogEntry.occurred_at < before)
        comment_stmt = comment_stmt.where(ProjectComment.created_at < before)
    events = (
        (await db.execute(event_stmt.order_by(AuditLogEntry.occurred_at.desc()).limit(limit)))
        .scalars()
        .all()
    )
    comments = (
        (await db.execute(comment_stmt.order_by(ProjectComment.created_at.desc()).limit(limit)))
        .scalars()
        .all()
    )

    now = datetime.now(UTC)
    items: list[tuple[datetime, ActivityComment | ActivityEvent]] = []
    for c in comments:
        items.append((c.created_at, ActivityComment(comment=comment_read(c, principal, now))))
    for e in events:
        items.append(
            (
                e.occurred_at,
                ActivityEvent(
                    id=e.id,
                    occurred_at=e.occurred_at,
                    actor_name=_name_if_self(principal, e.actor_user_id),
                    summary=event_summary(e),
                    audit_entry_id=e.id,
                ),
            )
        )
    items.sort(key=lambda pair: pair[0], reverse=True)
    return [item for _, item in items[:limit]]


# --- The workspace payload ------------------------------------------------------------


async def build_workspace(
    db: AsyncSession, project: Project, principal: Principal
) -> WorkspaceRead:
    run: ScheduleRun | None = await get_active_run(db)

    templates = (
        (
            await db.execute(
                select(WorkflowStepTemplate)
                .where(WorkflowStepTemplate.workflow_id == project.workflow_id)
                .order_by(WorkflowStepTemplate.sequence_order)
            )
        )
        .scalars()
        .all()
    )
    live_rows = (
        (
            await db.execute(
                select(ProjectWorkflowStep).where(ProjectWorkflowStep.project_id == project.id)
            )
        )
        .scalars()
        .all()
    )
    live_by_step = {r.step_template_id: r for r in live_rows}

    outcome: ScheduleRunProjectOutcome | None = None
    run_steps: list[ScheduleRunProjectStep] = []
    if run is not None:
        outcome = (
            await db.execute(
                select(ScheduleRunProjectOutcome).where(
                    ScheduleRunProjectOutcome.schedule_run_id == run.id,
                    ScheduleRunProjectOutcome.project_id == project.id,
                )
            )
        ).scalar_one_or_none()
        run_steps = list(
            (
                await db.execute(
                    select(ScheduleRunProjectStep).where(
                        ScheduleRunProjectStep.schedule_run_id == run.id,
                        ScheduleRunProjectStep.project_id == project.id,
                    )
                )
            )
            .scalars()
            .all()
        )
    run_by_step = {s.step_template_id: s for s in run_steps}

    engineer_ids = {project.leader_engineer_id} | {
        s.assigned_engineer_id for s in run_steps if s.assigned_engineer_id
    }
    engineer_ids.discard(None)
    engineers = {
        e.id: e
        for e in (
            await db.execute(select(Engineer).where(Engineer.id.in_(list(engineer_ids))))
        )
        .scalars()
        .all()
    } if engineer_ids else {}
    chamber_ids = [s.assigned_chamber_id for s in run_steps if s.assigned_chamber_id]
    chamber_codes: dict[uuid.UUID, str] = (
        dict(
            (await db.execute(select(Chamber.id, Chamber.code).where(Chamber.id.in_(chamber_ids))))
            .tuples()
            .all()
        )
        if chamber_ids
        else {}
    )

    stages: list[WorkspaceStage] = []
    for t in templates:
        live = live_by_step.get(t.id)
        run_step = run_by_step.get(t.id)
        duration = live.duration_weeks if live is not None else 0
        status_ = live.status if live is not None else WorkflowStepStatus.NOT_STARTED
        percent = live.percent_complete if live is not None else 0
        override = live.remaining_weeks_override if live is not None else None
        skipped = (
            run_step.skipped
            if run_step is not None
            else is_step_skipped(duration, t.kind, project.certification_testing_required)
        )
        stages.append(
            WorkspaceStage(
                step_id=t.id,
                code=t.code,
                name=t.name,
                kind=t.kind,
                sequence_order=t.sequence_order,
                predecessor_ids=list(t.predecessor_ids or []),
                duration_weeks=duration,
                skipped=skipped,
                planned_start_week=run_step.start_week if run_step is not None else None,
                planned_end_week=run_step.end_week if run_step is not None else None,
                actual_start_week=live.actual_start_week if live is not None else None,
                actual_end_week=live.actual_end_week if live is not None else None,
                status=status_,
                percent_complete=percent,
                remaining_weeks=0 if skipped else derive_remaining(duration, percent, override),
                remaining_weeks_override=override,
                blocked_reason=live.blocked_reason if live is not None else None,
                assigned_engineer_name=_engineer_name_if_self(
                    run_step.assigned_engineer_id if run_step is not None else None,
                    engineers,
                    principal,
                ),
                assigned_chamber_code=(
                    chamber_codes.get(run_step.assigned_chamber_id)
                    if run_step is not None and run_step.assigned_chamber_id
                    else None
                ),
                overrun_weeks=stage_overrun(run_step, live),
            )
        )

    # Ruling 3: one formula for every project (frozen included), over the
    # stored percents, with skipped steps weighted 0 exactly as the scheduler
    # does.
    kind_by_step = {t.id: t.kind for t in templates}
    progress = project_progress_pct(
        (
            r.percent_complete,
            0
            if is_step_skipped(
                r.duration_weeks,
                kind_by_step.get(r.step_template_id, WorkflowStepKind.DESIGN),
                project.certification_testing_required,
            )
            else r.duration_weeks,
        )
        for r in live_rows
    )

    expected = outcome.expected_end_week if outcome is not None else None
    projected = outcome.projected_end_week if outcome is not None else None
    schedule = WorkspaceSchedule(
        has_active_run=run is not None,
        run_version=run.version if run is not None else None,
        expected_end_week=expected,
        projected_end_week=projected,
        unconstrained_end_week=outcome.unconstrained_end_week if outcome is not None else None,
        slip_weeks=slip_weeks(projected, expected),
        within_year=outcome.within_year if outcome is not None else None,
        left_out=outcome.left_out if outcome is not None else False,
        schedule_stale=project.schedule_stale,
    )
    health = health_badge(
        outcome, run_steps, live_by_step, run.current_week if run is not None else dc.CURRENT_WEEK
    )

    score = (
        await db.execute(select(PriorityScore).where(PriorityScore.project_id == project.id))
    ).scalar_one_or_none()
    priority_score = (
        WorkspacePriorityScore.model_validate(score, from_attributes=True)
        if score is not None
        else None
    )

    files = (
        (
            await db.execute(
                select(ProjectFile)
                .where(ProjectFile.project_id == project.id)
                .order_by(ProjectFile.display_name, ProjectFile.version.desc())
            )
        )
        .scalars()
        .all()
    )

    project_payload = WorkspaceProject.model_validate(
        {
            **{
                name: getattr(project, name)
                for name in WorkspaceProject.model_fields
                if name not in ("hub", "leader_engineer_name") and name not in _FINANCIAL_FIELDS
            },
            **_financials(project, principal),
            "hub": (
                await db.execute(select(Hub.name).where(Hub.id == project.hub_id))
            ).scalar_one(),
            "leader_engineer_name": _engineer_name_if_self(
                project.leader_engineer_id, engineers, principal
            ),
        }
    )

    return WorkspaceRead(
        project=project_payload,
        health=health,
        schedule=schedule,
        progress_pct=progress,
        stages=stages,
        priority_score=priority_score,
        files=[file_read(f, principal) for f in files],
        activity=await list_activity(db, project, principal),
    )


def _financials(project: Project, principal: Principal) -> dict[str, Any]:
    """The four encrypted fields, decrypted only for a caller with Project
    Registration READ. Everyone else gets `null`, and the values are never
    read.
    """

    if not principal_can(principal, Surface.PROJECT_REGISTRATION, Action.READ):
        return {name: None for name in _FINANCIAL_FIELDS}
    return {name: getattr(project, name) for name in _FINANCIAL_FIELDS}



# --- Stage PATCH rules ----------------------------------------------------------------

_STAGE_FIELDS = (
    "status",
    "percent_complete",
    "actual_start_week",
    "actual_end_week",
    "remaining_weeks_override",
    "blocked_reason",
)


def merge_stage_update(
    row: ProjectWorkflowStep, explicit: dict[str, Any]
) -> tuple[dict[str, Any], list[tuple[str, str]]]:
    """Merge a PATCH body into the stage row and check DOMAIN_RULES
    "Per-stage progress fields". Returns `(merged_values, errors)`, where each
    error is `(field, message)`.

    Fields the body does *not* mention follow the new status when the status
    changes, so a client can send just `{"status": "Done"}` plus the actuals:
    Done → percent 100; Not Started → percent 0 and both actuals null;
    In Progress / Blocked → actual end null; any non-Blocked status → blocked
    reason null. A value the body states explicitly is never overridden. If
    it contradicts the rules, that is a 422.
    """

    merged: dict[str, Any] = {name: getattr(row, name) for name in _STAGE_FIELDS}
    merged.update(explicit)
    if isinstance(merged["blocked_reason"], str):
        merged["blocked_reason"] = merged["blocked_reason"].strip() or ""

    new_status: WorkflowStepStatus = merged["status"]
    if "status" in explicit:
        if new_status == WorkflowStepStatus.DONE and "percent_complete" not in explicit:
            merged["percent_complete"] = 100
        if new_status == WorkflowStepStatus.NOT_STARTED:
            for name, value in (
                ("percent_complete", 0),
                ("actual_start_week", None),
                ("actual_end_week", None),
            ):
                if name not in explicit:
                    merged[name] = value
        if (
            new_status in (WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED)
            and "actual_end_week" not in explicit
        ):
            merged["actual_end_week"] = None
        if new_status != WorkflowStepStatus.BLOCKED and "blocked_reason" not in explicit:
            merged["blocked_reason"] = None

    errors: list[tuple[str, str]] = []
    start, end = merged["actual_start_week"], merged["actual_end_week"]
    percent = merged["percent_complete"]
    if new_status == WorkflowStepStatus.NOT_STARTED:
        if percent != 0:
            errors.append(("percent_complete", "must be 0 when status is Not Started"))
        if start is not None:
            errors.append(("actual_start_week", "must be null when status is Not Started"))
        if end is not None:
            errors.append(("actual_end_week", "must be null when status is Not Started"))
    elif new_status == WorkflowStepStatus.DONE:
        if percent != 100:
            errors.append(("percent_complete", "must be 100 when status is Done"))
        if start is None:
            errors.append(("actual_start_week", "is required when status is Done"))
        if end is None:
            errors.append(("actual_end_week", "is required when status is Done"))
    else:  # In Progress / Blocked
        if start is None:
            errors.append(("actual_start_week", f"is required when status is {new_status.value}"))
        if end is not None:
            errors.append(("actual_end_week", f"must be null when status is {new_status.value}"))
    if start is not None and end is not None and end < start:
        errors.append(("actual_end_week", "must be >= actual_start_week"))
    reason = merged["blocked_reason"]
    if new_status == WorkflowStepStatus.BLOCKED:
        if not reason:
            errors.append(("blocked_reason", "is required when status is Blocked"))
    elif reason is not None:
        errors.append(("blocked_reason", "must be null unless status is Blocked"))
    return merged, errors
