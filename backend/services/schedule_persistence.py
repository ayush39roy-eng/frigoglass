"""Map DB rows <-> `scheduling/`'s pure dataclasses, and persist a
`scheduling.types.ScheduleOutput` as a new versioned, immutable `ScheduleRun`
snapshot (`models.schedule.ScheduleRun` /
`ScheduleRunProjectStep` / `ScheduleRunProjectOutcome`).

**Scope boundary, read this before touching this file**: everything in this
module is pure persistence/adapter code. It never calls
`scheduling.greedy.run_greedy_sgs` (or, obviously, CP-SAT) itself — the
caller (an `api/routers/*` handler, or a future Celery task) is responsible
for actually invoking the scheduler and handing this module the resulting
`ScheduleOutput`. This keeps `backend/scheduling/` (algorithm-engineer's pure
functions) and the DB-touching adapter code (this module) on opposite sides
of a hard line, per CLAUDE.md: "CP-SAT and the greedy scheduler are
algorithm-engineer's pure functions ... you call them, you do not
reimplement or inline scheduling logic here."

A full async CP-SAT dispatch pipeline (Celery task -> solver-worker ->
progress publish -> this module on completion) is P3-T06's job, not built
here. `api/routers/schedule_runs.py`'s `POST /schedule-runs/greedy-recalc`
is the only caller of `persist_schedule_output` in this task's scope, and it
only ever calls the GREEDY scheduler synchronously, per
`docs/PROJECT_AND_STACK.md` §4's explicit allowance ("The greedy SGS
scheduler ... may run synchronously for small/fast recalculations").

**P3-T06 update**: this module now also supports the async CP-SAT dispatch
pipeline described above, via two additions used exclusively by
`workers/schedule_tasks.py`'s Celery task (never by the synchronous
greedy-recalc endpoint, which continues to use every parameter's original
default):

- `create_queued_schedule_run(...)` — creates and commits a `ScheduleRun` row
  in `QUEUED` status, reserving its `version` number, *before* any solver
  runs at all. This is what makes `POST /schedule-runs/cp-sat-dispatch` able
  to return a stable `schedule_run_id`/`celery_task_id` pair immediately
  (202-style), for the client to open a P3-T05 SSE connection against, while
  the actual solve happens later in a Celery worker process.
- `persist_schedule_output(..., existing_run=...)` — when given an already-
  persisted `ScheduleRun` (typically one `create_queued_schedule_run`
  produced, now `RUNNING`), updates that SAME row in place (transitioning it
  to `COMPLETED`) instead of inserting a new one. Without this, the
  QUEUED/RUNNING row and the eventual COMPLETED snapshot would be two
  different rows with two different `version` numbers, contradicting
  `models.schedule.ScheduleRun`'s own docstring ("`celery_task_id` links
  this row to that job") and this task's acceptance criterion ("Dispatching
  a run creates a ScheduleRun row, transitions its status through the
  lifecycle" — singular row, not row-then-replace).

**Sharp edge, read before calling with `existing_run` or `activate=False`**:
`sync_live_workflow_steps` (default `True`) is intentionally an INDEPENDENT
flag from `activate`, not implicitly nested inside it, despite this
docstring's own "(if activate=True ...)" phrasing above describing the
*common* (greedy, always-activates) case. A CP-SAT run that is not being
activated (this task's own default — see `docs/MEMORY.md`'s P3-T06 entry for
why) must NEVER sync the *live* `ProjectWorkflowStep` planned-week fields —
doing so would silently corrupt the Gantt's live view with an unreviewed,
not-yet-committed run's numbers. This function actively guards against that
combination (raises `ValueError` if `sync_live_workflow_steps=True` and
`activate=False` are both requested) rather than trusting every future
caller to remember the coupling.
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import ScheduleRunStatus, SolverType
from models.project import Project, workflow_id_for_hub
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    LeadTime,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    StepProgressInput,
)
from scheduling.types import WorkflowStepTemplate as SchedWorkflowStepTemplate
from services.notifications import generate_schedule_change_notifications
from services.schedule_stale import clear_stale_for_run


def _lead_time_sort_key(lt: WorkflowLeadTime) -> tuple[str, str, str]:
    return (lt.workflow_id, lt.category.value, lt.step_id)


def build_workflow_snapshot(
    templates: Sequence[WorkflowStepTemplate], lead_times: Sequence[WorkflowLeadTime]
) -> dict[str, Any]:
    """`ScheduleRun.workflow_snapshot` (ADR 0009, Invariant I15): the workflow
    settings in force when a run is created —

        {"workflows": [{"id", "steps": [{"step_id", "code", "name", "kind",
                                         "sequence_order", "predecessor_ids"}]}],
         "lead_times": [{"workflow_id", "category", "step_id", "weeks"}]}

    Deterministically ordered (workflow id, then sequence order; lead times by
    workflow/category/step) so two runs under identical settings snapshot
    byte-identically (I8).
    """
    by_workflow: dict[str, list[dict[str, Any]]] = {}
    for t in sorted(templates, key=lambda t: (t.workflow_id, t.sequence_order)):
        by_workflow.setdefault(t.workflow_id, []).append(
            {
                "step_id": t.id,
                "code": t.code,
                "name": t.name,
                "kind": t.kind.value,
                "sequence_order": t.sequence_order,
                "predecessor_ids": list(t.predecessor_ids or []),
            }
        )
    return {
        "workflows": [{"id": wf, "steps": steps} for wf, steps in sorted(by_workflow.items())],
        "lead_times": [
            {
                "workflow_id": lt.workflow_id,
                "category": lt.category.value,
                "step_id": lt.step_id,
                "weeks": lt.weeks,
            }
            for lt in sorted(lead_times, key=_lead_time_sort_key)
        ],
    }


def build_workflow_snapshot_from_input(schedule_input: ScheduleInput) -> dict[str, Any]:
    """Same shape and ordering as `build_workflow_snapshot`, built from the
    templates and lead times *inside the solver input*. P9-T03: this is what
    `persist_schedule_output` stores, so the snapshot equals the settings the
    run was actually solved with (I15), even when Workflow Settings changed
    while a CP-SAT solve was running.
    """

    by_workflow: dict[str, list[dict[str, Any]]] = {}
    for t in sorted(schedule_input.workflow_steps, key=lambda t: (t.workflow_id, t.sequence_order)):
        by_workflow.setdefault(t.workflow_id, []).append(
            {
                "step_id": t.step_id,
                "code": t.code,
                "name": t.name,
                "kind": t.kind,
                "sequence_order": t.sequence_order,
                "predecessor_ids": list(t.predecessor_ids),
            }
        )
    return {
        "workflows": [{"id": wf, "steps": steps} for wf, steps in sorted(by_workflow.items())],
        "lead_times": [
            {
                "workflow_id": lt.workflow_id,
                "category": lt.category,
                "step_id": lt.step_id,
                "weeks": lt.weeks,
            }
            for lt in sorted(
                schedule_input.lead_times, key=lambda lt: (lt.workflow_id, lt.category, lt.step_id)
            )
        ],
    }


async def build_schedule_input_from_db(
    db: AsyncSession,
    *,
    current_week: int = dc.CURRENT_WEEK,
    horizon_weeks: int = dc.HORIZON_WEEKS,
    within_year_week: int = dc.WITHIN_YEAR_WEEK,
) -> ScheduleInput:
    """Load every `Project`/`Engineer`/`Chamber`/`WorkflowStepTemplate` row and
    map it into `scheduling.types.ScheduleInput`.

    All projects are included (not pre-filtered by status) — `run_greedy_sgs`
    itself classifies non-schedulable statuses (Commercialized/On Hold/Draft)
    as `excluded` per its own docstring; duplicating that filter here would
    risk silently diverging from `scheduling/`'s own logic.
    """

    project_rows = (
        (await db.execute(select(Project).options(selectinload(Project.hub)))).scalars().all()
    )
    engineer_rows = (
        (await db.execute(select(Engineer).options(selectinload(Engineer.hub)))).scalars().all()
    )
    chamber_rows = (await db.execute(select(Chamber))).scalars().all()
    template_stmt = select(WorkflowStepTemplate).order_by(
        WorkflowStepTemplate.workflow_id, WorkflowStepTemplate.sequence_order
    )
    template_rows = (await db.execute(template_stmt)).scalars().all()
    lead_time_rows = (await db.execute(select(WorkflowLeadTime))).scalars().all()

    # Per-stage progress (ADR 0006, DOMAIN_RULES.md "How progress feeds a
    # schedule run"): the live step rows are advisory *inputs* to the solver,
    # passed in sequence order so the hashed input (I8) is deterministic.
    step_rows = (
        (
            await db.execute(
                select(ProjectWorkflowStep).order_by(
                    ProjectWorkflowStep.project_id, ProjectWorkflowStep.sequence_order
                )
            )
        )
        .scalars()
        .all()
    )
    progress_by_project: dict[uuid.UUID, list[StepProgressInput]] = {}
    for s in step_rows:
        progress_by_project.setdefault(s.project_id, []).append(
            StepProgressInput(
                step_id=s.step_template_id,
                status=s.status.value,
                percent_complete=s.percent_complete,
                actual_start_week=s.actual_start_week,
                actual_end_week=s.actual_end_week,
                remaining_weeks_override=s.remaining_weeks_override,
            )
        )

    projects = tuple(
        ProjectInput(
            project_id=str(p.id),
            name=p.name,
            hub=p.hub.name.value,
            status=p.status.value,
            category=p.category.value if p.category else None,
            priority=p.priority.value if p.priority else None,
            frozen=p.frozen,
            leader_engineer_id=str(p.leader_engineer_id) if p.leader_engineer_id else None,
            actual_start_week=p.actual_start_week,
            delay_weeks=p.delay_weeks,
            workflow_id=workflow_id_for_hub(p.hub.is_oem),
            certification_testing_required=p.certification_testing_required,
            target_end_week=p.target_end_week,
            step_progress=tuple(progress_by_project.get(p.id, ())),
        )
        for p in project_rows
    )

    engineers = tuple(
        EngineerInput(
            engineer_id=str(e.id),
            name=e.name,
            hub=e.hub.name.value,
            allowed_categories=tuple(c.value for c in (e.allowed_categories or ())),
            fte=float(e.fte),
        )
        for e in engineer_rows
    )

    chambers = tuple(
        ChamberInput(
            chamber_id=str(c.id),
            code=c.code,
            lab_region=c.lab_region.value,
            max_concurrent=c.max_concurrent,
            allowed_stages=tuple(c.allowed_stages or ()),
            efficiency=float(c.efficiency),
        )
        for c in chamber_rows
    )

    workflow_steps = tuple(
        SchedWorkflowStepTemplate(
            workflow_id=t.workflow_id,
            step_id=t.id,
            code=t.code,
            name=t.name,
            kind=t.kind.value,
            sequence_order=t.sequence_order,
            predecessor_ids=tuple(t.predecessor_ids or ()),
        )
        for t in template_rows
    )

    lead_times = tuple(
        LeadTime(
            workflow_id=lt.workflow_id,
            category=lt.category.value,
            step_id=lt.step_id,
            weeks=lt.weeks,
        )
        for lt in sorted(lead_time_rows, key=_lead_time_sort_key)
    )

    return ScheduleInput(
        projects=projects,
        engineers=engineers,
        chambers=chambers,
        workflow_steps=workflow_steps,
        lead_times=lead_times,
        current_week=current_week,
        horizon_weeks=horizon_weeks,
        within_year_week=within_year_week,
    )


async def _next_version(db: AsyncSession) -> int:
    stmt = select(ScheduleRun.version).order_by(ScheduleRun.version.desc()).limit(1)
    latest = (await db.execute(stmt)).scalar_one_or_none()
    return (latest or 0) + 1


async def persist_schedule_output(
    db: AsyncSession,
    schedule_input: ScheduleInput,
    schedule_output: ScheduleOutput,
    *,
    solver_type: SolverType,
    trigger_reason: str,
    triggered_by_user_id: uuid.UUID | None = None,
    activate: bool = True,
    sync_live_workflow_steps: bool = True,
    existing_run: ScheduleRun | None = None,
    objective_value: float | None = None,
    solver_status: str | None = None,
) -> ScheduleRun:
    """Persist one `ScheduleOutput` as an immutable, versioned `ScheduleRun`
    snapshot — either a brand-new row (`existing_run=None`, the original
    greedy-recalc behaviour, unchanged) or an in-place update of an
    already-persisted row (`existing_run=<a QUEUED/RUNNING ScheduleRun>`, the
    P3-T06 CP-SAT dispatch path — see module docstring). `objective_value`
    (CP-SAT only; always `None` for `solver_type=GREEDY`, matching
    `ScheduleRun.objective_value`'s own docstring) is written verbatim,
    un-transformed.

    If `activate=True` (the default), also:

    - deactivates whatever `ScheduleRun` was previously `is_active` (at most
      one row may satisfy `WHERE is_active` — the partial unique index added
      in P1-T02's migration enforces this at the DB layer too);
    - (if `sync_live_workflow_steps=True`) copies each step's planned dates /
      conflict flags into the *live* `ProjectWorkflowStep` rows, per that
      model's own docstring ("holds ... the planned schedule as computed by
      the most recent applied ScheduleRun") — this is what makes the newly
      active run the one the Gantt's "live" per-project rows reflect, not
      just the versioned snapshot tables.

    Does NOT write an `AuditLogEntry` itself — the caller (the router) does,
    since it also knows the human-facing `action` name and any request
    context (P3-T01 has no authenticated actor yet; see the callers'
    docstrings for the same "MUST-FIX BEFORE P3 CLOSES" flag already used by
    `api/routers/currency_rates.py`).

    **P5-T06 addition**: when `activate=True`, also calls
    `services.notifications.generate_schedule_change_notifications` — diffing
    this new run's outcomes against whatever `ScheduleRun` was `is_active`
    immediately before this call (captured below, before the deactivate
    UPDATE runs) and writing one `Notification` row per (delay/left-out/
    conflict event, eligible recipient) pair. This is the single trigger
    point for that feature (see that module's own docstring for why) — it is
    deliberately NOT called when `activate=False` (a completed-but-not-
    activated CP-SAT run never notifies anyone about a schedule nobody has
    reviewed/applied yet).
    """

    if sync_live_workflow_steps and not activate:
        # See module docstring's "Sharp edge" note — never let a
        # not-activated run's numbers leak into the live Gantt view.
        raise ValueError(
            "persist_schedule_output: sync_live_workflow_steps=True requires activate=True "
            "(syncing live ProjectWorkflowStep fields for a run that is not becoming the "
            "active schedule would corrupt the Gantt's live view)"
        )

    project_id_map = {str(p.id): p for p in (await db.execute(select(Project))).scalars().all()}

    previous_active_run_id: uuid.UUID | None = None
    if activate:
        # Captured BEFORE the deactivate UPDATE below, so P5-T06's
        # notification diff has a real "what was live before this call"
        # baseline to compare against — `None` only for the very first-ever
        # active run (nothing was previously active), which
        # `generate_schedule_change_notifications` treats as "no baseline,
        # generate nothing" rather than a bug.
        previous_active_run_id = (
            await db.execute(select(ScheduleRun.id).where(ScheduleRun.is_active.is_(True)))
        ).scalar_one_or_none()
        deactivate_stmt = (
            update(ScheduleRun).where(ScheduleRun.is_active.is_(True)).values(is_active=False)
        )
        await db.execute(deactivate_stmt)

    # ADR 0009 / I15: snapshot the workflow settings this run was solved
    # with. P9-T03 changed this from a DB re-read at persist time to the
    # templates/lead times inside `schedule_input`. The greedy path builds
    # its input in the same transaction, so the result is the same there. On
    # the CP-SAT path a Workflow Settings edit during the solve no longer
    # leaks into the snapshot.
    snapshot = build_workflow_snapshot_from_input(schedule_input)
    # Ruling 6 (P9-R02): an explicit `solver_status` wins; otherwise take the
    # one P9-R01 adds to `ScheduleOutput` (getattr, so this module does not
    # depend on the landing order of that field).
    effective_solver_status = solver_status or getattr(schedule_output, "solver_status", None)

    if existing_run is not None:
        run = existing_run
        run.solver_type = solver_type
        run.status = ScheduleRunStatus.COMPLETED
        run.is_active = activate
        run.horizon_weeks = schedule_input.horizon_weeks
        run.current_week = schedule_input.current_week
        run.objective_value = objective_value
        run.trigger_reason = trigger_reason
        run.completed_at = datetime.now(UTC)
        run.workflow_snapshot = snapshot
        run.solver_status = effective_solver_status
        if triggered_by_user_id is not None:
            run.triggered_by_user_id = triggered_by_user_id
        db.add(run)
    else:
        version = await _next_version(db)
        run = ScheduleRun(
            version=version,
            solver_type=solver_type,
            status=ScheduleRunStatus.COMPLETED,
            is_active=activate,
            horizon_weeks=schedule_input.horizon_weeks,
            current_week=schedule_input.current_week,
            objective_value=objective_value,
            triggered_by_user_id=triggered_by_user_id,
            trigger_reason=trigger_reason,
            workflow_snapshot=snapshot,
            solver_status=effective_solver_status,
        )
        db.add(run)
    await db.flush()  # assigns run.id (new-row case) / persists in-place edits

    # Reset live per-project-step planned fields/flags for every project
    # touched by this run, before writing the new values, so a project that
    # regresses from (say) 14 booked steps to a LEFT_OUT-with-fewer-steps
    # outcome doesn't keep stale planned_* data on steps the new run didn't
    # book at all.
    if sync_live_workflow_steps:
        touched_ids = [uuid.UUID(o.project_id) for o in schedule_output.project_outcomes]
        if touched_ids:
            await db.execute(
                update(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id.in_(touched_ids))
                .values(
                    planned_start_week=None,
                    planned_end_week=None,
                    eng_conflict=False,
                    chamber_overlap=False,
                )
            )

    for outcome in schedule_output.project_outcomes:
        project = project_id_map.get(outcome.project_id)
        if project is None:  # pragma: no cover - defensive, should never happen
            continue

        for step in outcome.steps:
            db.add(
                ScheduleRunProjectStep(
                    schedule_run_id=run.id,
                    project_id=project.id,
                    step_template_id=step.step_id,
                    sequence_order=step.sequence_order,
                    duration_weeks=step.duration_weeks,
                    start_week=step.start_week,
                    end_week=step.end_week,
                    assigned_engineer_id=(
                        uuid.UUID(step.assigned_engineer_id) if step.assigned_engineer_id else None
                    ),
                    assigned_chamber_id=(
                        uuid.UUID(step.assigned_chamber_id) if step.assigned_chamber_id else None
                    ),
                    eng_conflict=outcome.eng_conflict,
                    chamber_overlap=outcome.overlap,
                    skipped=step.skipped,
                )
            )
            if sync_live_workflow_steps:
                await db.execute(
                    update(ProjectWorkflowStep)
                    .where(
                        ProjectWorkflowStep.project_id == project.id,
                        ProjectWorkflowStep.step_template_id == step.step_id,
                    )
                    .values(
                        planned_start_week=step.start_week,
                        planned_end_week=step.end_week,
                        eng_conflict=outcome.eng_conflict,
                        chamber_overlap=outcome.overlap,
                    )
                )

        db.add(
            ScheduleRunProjectOutcome(
                schedule_run_id=run.id,
                project_id=project.id,
                left_out=outcome.left_out,
                cat_not_allowed=outcome.cat_not_allowed,
                spillover=outcome.spillover,
                within_year=outcome.within_year,
                last_step_end_week=outcome.end_week,
                delay_weeks_applied=project.delay_weeks,
                # DOMAIN_RULES.md "Expected vs projected completion" (I16) and
                # the progress-aware outcome fields (ADR 0006) — stored, never
                # recomputed by a reader.
                unconstrained_end_week=outcome.unconstrained_end_week,
                expected_end_week=outcome.expected_end_week,
                projected_end_week=outcome.projected_end_week,
                blocked=outcome.blocked,
                progress_pct=outcome.progress_pct,
                data_error=outcome.data_error,
            )
        )

    await db.flush()

    if activate:
        # P9-T03: activating a run clears `schedule_stale` for every project
        # in it (ADR 0006). This function is the only activation path.
        await clear_stale_for_run(db, run.id)
        # P5-T06: see module/function docstring — the sole trigger point for
        # in-app schedule-change notifications. Never called for
        # `activate=False` runs.
        await generate_schedule_change_notifications(
            db,
            new_run=run,
            previous_active_run_id=previous_active_run_id,
            project_outcomes=schedule_output.project_outcomes,
        )

    return run


async def create_queued_schedule_run(
    db: AsyncSession,
    *,
    solver_type: SolverType,
    trigger_reason: str,
    triggered_by_user_id: uuid.UUID | None,
    horizon_weeks: int = dc.HORIZON_WEEKS,
    current_week: int = dc.CURRENT_WEEK,
) -> ScheduleRun:
    """Create and COMMIT (not just flush) a new `ScheduleRun` row in
    `QUEUED` status, reserving its `version` number, before any solver runs
    at all. **P3-T06-only** — used by `api/routers/schedule_runs.py`'s async
    CP-SAT dispatch endpoint so a stable `schedule_run_id` exists for the
    client to reference (and, once `celery_task_id` is set immediately after
    this call returns, for a P3-T05 SSE connection to be opened against)
    before the actual solve has even been enqueued.

    Commits immediately (unlike `persist_schedule_output`, which only
    flushes and lets its caller commit) because the row must be durably
    visible to a *different* DB session/connection — the Celery worker
    process that will later load it by id — as soon as this function
    returns, not merely visible within the current request's still-open
    transaction.

    NOT used by the synchronous greedy-recalc path
    (`trigger_greedy_recalc`), which computes its `ScheduleOutput` first and
    calls `persist_schedule_output` directly with no intermediate QUEUED
    row — greedy is fast enough (per `docs/PROJECT_AND_STACK.md` §4) that
    there is no meaningful "in progress" state worth representing.

    `is_active` is always `False` here and is never toggled `True` by this
    function — see `docs/MEMORY.md`'s P3-T06 entry for the "CP-SAT runs do
    not auto-activate" decision. Callers must never assume a QUEUED (or
    RUNNING, FAILED, CANCELLED) row is safe to ignore when counting `WHERE
    is_active` rows; it is never the active one.
    """

    version = await _next_version(db)
    # P9-T03 (I15): snapshot the settings in force at creation too, so even a
    # run that later fails or is cancelled records them. On completion,
    # `persist_schedule_output(existing_run=...)` rewrites it from the
    # settings read when the solver input was built.
    snapshot = build_workflow_snapshot(
        (await db.execute(select(WorkflowStepTemplate))).scalars().all(),
        (await db.execute(select(WorkflowLeadTime))).scalars().all(),
    )
    run = ScheduleRun(
        version=version,
        solver_type=solver_type,
        status=ScheduleRunStatus.QUEUED,
        is_active=False,
        horizon_weeks=horizon_weeks,
        current_week=current_week,
        triggered_by_user_id=triggered_by_user_id,
        trigger_reason=trigger_reason,
        workflow_snapshot=snapshot,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run
