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

from models.chamber import Chamber
from models.engineer import Engineer
from models.enums import ScheduleRunStatus, SolverType
from models.hub import Hub
from models.project import Project, workflow_id_for_hub
from models.schedule import (
    RULES_EPOCH_P53,
    ScheduleRun,
    ScheduleRunProjectOutcome,
    ScheduleRunProjectStep,
)
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from scheduling.delivery import outcome_left_out_reason
from scheduling.types import (
    ChamberInput,
    EngineerInput,
    LeadTime,
    ProjectInput,
    ScheduleInput,
    ScheduleOutput,
    StepPinInput,
    StepProgressInput,
    StepSchedule,
    StepTimingInput,
    require_plan_week,
)
from scheduling.types import WorkflowStepTemplate as SchedWorkflowStepTemplate
from scheduling.weeks import plan_year_end_week
from scheduling.workflow import canonical_categories, is_valid_fte
from services import plan_clock
from services.categories import load_catalog
from services.notifications import generate_schedule_change_notifications
from services.schedule_readiness import missing_input_fields
from services.schedule_stale import clear_stale_for_run
from services.scheduling_settings import horizon_weeks_for
from services.workflow_durations import EFFORT_KINDS, run_input_lead_and_override


def _lead_time_sort_key(lt: WorkflowLeadTime) -> tuple[str, str, str]:
    return (lt.workflow_id, lt.category, lt.step_id)


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
                "category": lt.category,
                "step_id": lt.step_id,
                "weeks": lt.weeks,
            }
            for lt in sorted(lead_times, key=_lead_time_sort_key)
        ],
    }


def build_workflow_snapshot_from_input(schedule_input: ScheduleInput) -> dict[str, Any]:
    """Same shape and ordering as `build_workflow_snapshot`, built from the
    templates and lead times *inside the solver input*, plus (P12, ADR 0019)
    a `step_timing` list of the per-project step timing inputs. P9-T03: this is what
    `persist_schedule_output` stores, so the snapshot equals the settings the
    run was actually solved with (I15), even when Workflow Settings changed
    while a CP-SAT solve was running.

    P33 (R33-7, I30): `categories` (`scheduling.canonical_categories`) only
    when the input's list differs from the seeded seven; a timing row's
    `wait_weeks` only when non-zero and `lead_weeks` only when non-null. A
    run on default inputs therefore snapshots byte-identically to before P33
    (I14), and a stored snapshot without `categories` means the defaults.
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
    snapshot: dict[str, Any] = {
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
        # ADR 0019 (P12): the Gantt-set step timing the run was solved with,
        # so a run can be replayed. One row per (project, step) carrying any
        # timing, ordered by project id then step id.
        # ADR 0043 (P32): `overlap_weeks` is recorded only when non-zero, so
        # the snapshot of every run without an overlap is unchanged (I14).
        "step_timing": [
            {
                "project_id": p.project_id,
                "step_id": t.step_id,
                "duration_override_weeks": t.duration_override_weeks,
                "start_not_before_week": t.start_not_before_week,
                **({"overlap_weeks": t.overlap_weeks} if t.overlap_weeks else {}),
                **({"wait_weeks": t.wait_weeks} if t.wait_weeks else {}),
                **({"lead_weeks": t.lead_weeks} if t.lead_weeks is not None else {}),
            }
            for p in sorted(schedule_input.projects, key=lambda p: p.project_id)
            for t in sorted(p.step_timing, key=lambda t: t.step_id)
        ],
    }
    categories = canonical_categories(schedule_input.categories)
    if categories is not None:
        snapshot["categories"] = categories
    # P40 (ADR 0054 R40-12): the manual pins the run was solved with, only
    # when some project has one, so a run without pins snapshots exactly as
    # before (I48 (a)) and a run with pins can be replayed (I14, I15).
    step_pins = [
        {
            "project_id": p.project_id,
            "step_id": pin.step_id,
            "start_week": pin.start_week,
            "end_week": pin.end_week,
        }
        for p in sorted(schedule_input.projects, key=lambda p: p.project_id)
        for pin in sorted(p.step_pins, key=lambda pin: pin.step_id)
    ]
    if step_pins:
        snapshot["step_pins"] = step_pins
    return snapshot


def _project_step_pins(
    rows: Sequence[ProjectWorkflowStep],
    workflow_id: str,
    template_workflow: dict[str, str],
) -> tuple[StepPinInput, ...]:
    """P40 (ADR 0054 R40-12): a project's `ProjectInput.step_pins`, the live
    pins of its current workflow's steps, sorted by step id. Every live pin
    is passed (the scheduler decides which apply: started, skipped and held
    steps are inert there, R40-4 / R40-9). A pin left on another workflow's
    step cannot exist (a re-point clears it) and is dropped like timing."""

    pinned = [
        r
        for r in rows
        if r.manual_start_week is not None
        and r.manual_end_week is not None
        and template_workflow.get(r.step_template_id) == workflow_id
    ]
    return tuple(
        StepPinInput(
            step_id=r.step_template_id,
            start_week=r.manual_start_week,  # type: ignore[arg-type]
            end_week=r.manual_end_week,  # type: ignore[arg-type]
        )
        for r in sorted(pinned, key=lambda r: r.step_template_id)
    )


def _project_step_timing(
    rows: Sequence[StepTimingInput],
    workflow_id: str,
    template_workflow: dict[str, str],
) -> tuple[StepTimingInput, ...]:
    """ADR 0019: a project's `ProjectInput.step_timing`. Only rows that carry
    a value (the caller already drops rows with every field null or 0) and only
    steps of the project's *current* workflow: the scheduler rejects an
    unknown step id with `ValueError`, which would fail the whole run, so a
    row left behind by a PDD↔OEM hub change never reaches it
    (`services.project_steps` also clears timing on a re-point). Sorted by
    step id, so the hashed input is deterministic (I8).
    """

    return tuple(
        sorted(
            (t for t in rows if template_workflow.get(t.step_id) == workflow_id),
            key=lambda t: t.step_id,
        )
    )


async def build_schedule_input_from_db(
    db: AsyncSession,
    *,
    current_week: int,
    horizon_weeks: int | None = None,
    within_year_week: int | None = None,
    include_unschedulable: bool = False,
) -> ScheduleInput:
    """Load every `Project`/`Engineer`/`Chamber`/`WorkflowStepTemplate` row and
    map it into `scheduling.types.ScheduleInput`.

    P56: a project in a schedulable status that lacks a priority or a
    category (`services.schedule_readiness.missing_schedule_fields`) is left
    out of the returned input, so it never fails the run; it is served as
    "Not scheduled — missing …" until the field is filled in. With every
    field set the input is unchanged. `include_unschedulable=True` returns
    them too, for a caller that must transform the full input by project id
    (the priority / band-rank preview) and then applies
    `schedule_readiness.drop_unschedulable_inputs` itself.

    P37-T04 (ADR 0052 R37-2, I38): `current_week` is required. The worker
    passes the run row's stored week; a synchronous solve passes the request's
    `plan_clock` week. It never defaults to a value bound at import.

    All projects are included (not pre-filtered by status) — `run_greedy_sgs`
    itself classifies non-schedulable statuses (Commercialized/On Hold/Draft)
    as `excluded` per its own docstring; duplicating that filter here would
    risk silently diverging from `scheduling/`'s own logic.
    """

    # I41: the clock's or a stored row's week must be an absolute plan week.
    current_week = require_plan_week(current_week)
    # P53 (R53-2, I58): the search limit is `cw + 52 × N` with the stored
    # Admin setting N, unless the caller passes a run row's stored horizon
    # (the worker, R37-2 pattern). The within-year cut-off is the plan-year
    # end of the input week (I50 amended).
    if horizon_weeks is None:
        horizon_weeks = await horizon_weeks_for(db, current_week)
    if within_year_week is None:
        within_year_week = plan_year_end_week(current_week)
    project_rows = (
        (await db.execute(select(Project).options(selectinload(Project.hub)))).scalars().all()
    )
    # ADR 0042 (P29): each project's capacity hub, whose engineers form its
    # engineer pool (`ProjectInput.capacity_hub`). Read from `hubs`, not from
    # the project's loaded hub, so a member hub's parent need not be loaded.
    hub_name_by_id = {
        h_id: name.value for h_id, name in (await db.execute(select(Hub.id, Hub.name))).all()
    }
    # P38-T05 (ADR 0053, DOMAIN_RULES "Engineer deactivation" / I43): inactive
    # engineers are left out of `ScheduleInput.engineers`, so the scheduler,
    # Monte Carlo, the What-if pool and plan-import auto-assignment never give
    # them work. A project whose stored leader is inactive (only Commercialized
    # / Cancelled under I42) then resolves to no leader, the existing
    # `LEFT_OUT no_leader` rule for a schedulable status. Their supply before
    # the deactivation week reaches What-if / plan import through
    # `WhatIfBaseline.engineer_active_weeks` (services.whatif_baseline).
    engineer_rows = (
        (
            await db.execute(
                select(Engineer)
                .where(Engineer.active.is_(True))
                .options(selectinload(Engineer.hub))
            )
        )
        .scalars()
        .all()
    )
    chamber_rows = (await db.execute(select(Chamber))).scalars().all()
    template_stmt = select(WorkflowStepTemplate).order_by(
        WorkflowStepTemplate.workflow_id, WorkflowStepTemplate.sequence_order
    )
    template_rows = (await db.execute(template_stmt)).scalars().all()
    lead_time_rows = (await db.execute(select(WorkflowLeadTime))).scalars().all()
    # ADR 0047 §3 (P33-T07): the category list, sort key 5 = rank. Equal to
    # `default_categories()` on the seeded table, so the hashed input and the
    # run snapshot omit it (R33-7).
    category_catalog = await load_catalog(db)

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
    rows_by_project: dict[uuid.UUID, list[ProjectWorkflowStep]] = {}
    for s in step_rows:
        rows_by_project.setdefault(s.project_id, []).append(s)
    timing_by_project: dict[uuid.UUID, list[StepTimingInput]] = {}
    template_workflow = {t.id: t.workflow_id for t in template_rows}
    # P33-T08 (contract F4, OR-3): the table and the immutable R2 weights by
    # (workflow, category, step), each project's workflow / category, and the
    # kinds that follow each project's own effort figure (OR-1).
    table_weeks = {(lt.workflow_id, lt.category, lt.step_id): lt.weeks for lt in lead_time_rows}
    weight_weeks = {
        (lt.workflow_id, lt.category, lt.step_id): lt.effort_weight_weeks for lt in lead_time_rows
    }
    template_kind = {t.id: t.kind.value for t in template_rows}
    project_key = {
        p.id: (workflow_id_for_hub(p.hub.is_oem), p.category or "") for p in project_rows
    }
    own_kinds: dict[uuid.UUID, set[str]] = {}
    for s in step_rows:
        if s.effort_weeks is not None and template_kind.get(s.step_template_id) in EFFORT_KINDS:
            own_kinds.setdefault(s.project_id, set()).add(template_kind[s.step_template_id])
    # ADR 0043: a workflow's first step (no predecessors) never carries an
    # overlap; the scheduler rejects one with `ValueError`, which would fail
    # the whole run, so a stale value (e.g. after a template DAG edit) is
    # dropped here, like timing of another workflow below.
    template_has_predecessors = {t.id: bool(t.predecessor_ids) for t in template_rows}
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
        # Contract F4 (ADR 0046 OR-3), exact since p33c (P33-T13: the T05-A1
        # transitional terms are gone; the hand-set ADR 0019 / 0043 fields
        # are always null, CHECK `step_timing_retired`, ADR 0048):
        # - own-effort step: `lead_weeks` = the template's immutable
        #   `effort_weight_weeks`, override = `effort_weeks`;
        # - any other step: `lead_weeks` = the project's copy `plan_weeks`,
        #   no override;
        #   `lead_weeks` is None when equal to the input table (R33-9);
        # - `start_not_before_week` is None;
        # - `overlap_weeks` = `−plan_gap_weeks` when negative, `wait_weeks` =
        #   `plan_gap_weeks` when positive. Never on a workflow's first step:
        #   the scheduler rejects a gap there with `ValueError`, which would
        #   fail the whole run, so a stale value (e.g. after a template DAG
        #   edit) is dropped, as before.
        # With every copy equal to the table and every gap 0 (the p33b
        # backfill) this is exactly the pre-P33 input (I8, I14). Rows with
        # every field at its default are dropped; sorted by step_id below.
        workflow_id, category = project_key[s.project_id]
        key = (workflow_id, category, s.step_template_id)
        lead_weeks, override = run_input_lead_and_override(
            plan_weeks=s.plan_weeks,
            effort_weight_weeks=weight_weeks.get(key, 0),
            table_weeks=table_weeks.get(key, 0),
            own_effort=template_kind.get(s.step_template_id) in own_kinds.get(s.project_id, ()),
            effort_weeks=s.effort_weeks,
            # R35-9 (P35): an excluded step is `lead_weeks = 0`, no override.
            excluded=s.excluded,
        )
        has_predecessors = template_has_predecessors.get(s.step_template_id, False)
        overlap = wait = 0
        if has_predecessors:
            if s.plan_gap_weeks < 0:
                overlap = -s.plan_gap_weeks
            else:
                wait = s.plan_gap_weeks
        if override is not None or overlap or wait or lead_weeks is not None:
            timing_by_project.setdefault(s.project_id, []).append(
                StepTimingInput(
                    step_id=s.step_template_id,
                    duration_override_weeks=override,
                    start_not_before_week=None,
                    overlap_weeks=overlap,
                    wait_weeks=wait,
                    lead_weeks=lead_weeks,
                )
            )

    projects = tuple(
        ProjectInput(
            project_id=str(p.id),
            name=p.name,
            hub=p.hub.name.value,
            status=p.status.value,
            category=p.category,
            priority=p.priority.value if p.priority else None,
            frozen=p.frozen,
            leader_engineer_id=str(p.leader_engineer_id) if p.leader_engineer_id else None,
            actual_start_week=p.actual_start_week,
            delay_weeks=p.delay_weeks,
            workflow_id=workflow_id_for_hub(p.hub.is_oem),
            certification_testing_required=p.certification_testing_required,
            target_end_week=p.target_end_week,
            # P53 (R53-2b, I61): the delivered year of a Commercialized
            # project.
            actual_end_week=p.actual_end_week,
            step_progress=tuple(progress_by_project.get(p.id, ())),
            step_timing=_project_step_timing(
                timing_by_project.get(p.id, ()),
                workflow_id_for_hub(p.hub.is_oem),
                template_workflow,
            ),
            # ADR 0040: the manual VIP pin, sort key 2 of the scheduling order.
            is_vip=p.is_vip,
            # ADR 0042: OEM-HCK / OEM-Seitek -> R&D-Greece; else the hub itself.
            capacity_hub=hub_name_by_id.get(p.hub.capacity_hub_id or p.hub.id, p.hub.name.value),
            # ADR 0050 (P36): the planner-set position inside the band,
            # scheduling order key 3a. None for non-members (I37b).
            band_rank=p.band_rank,
            # P40 (ADR 0054 R40-12): the live pins, `()` when none (the
            # default, omitted from the hashed form: I48 (a)).
            step_pins=_project_step_pins(
                rows_by_project.get(p.id, ()),
                workflow_id_for_hub(p.hub.is_oem),
                template_workflow,
            ),
        )
        for p in project_rows
    )

    engineers = tuple(
        EngineerInput(
            engineer_id=str(e.id),
            name=e.name,
            hub=e.hub.name.value,
            allowed_categories=tuple(e.allowed_categories or ()),
            fte=float(e.fte),
            # ADR 0042 §5 (P29-T06): not on the capacity roster = booked but
            # never supply (the what-if engine sums counted engineers only).
            counts_in_capacity=e.counts_in_capacity,
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
            category=lt.category,
            step_id=lt.step_id,
            weeks=lt.weeks,
        )
        for lt in sorted(lead_time_rows, key=_lead_time_sort_key)
    )

    if not include_unschedulable:
        # P56: never hand the engine a project it would reject for the whole run.
        projects = tuple(p for p in projects if not missing_input_fields(p))

    return ScheduleInput(
        projects=projects,
        engineers=engineers,
        chambers=chambers,
        workflow_steps=workflow_steps,
        lead_times=lead_times,
        current_week=current_week,
        horizon_weeks=horizon_weeks,
        within_year_week=within_year_week,
        categories=category_catalog.schedule_categories(),
    )


async def _next_version(db: AsyncSession) -> int:
    stmt = select(ScheduleRun.version).order_by(ScheduleRun.version.desc()).limit(1)
    latest = (await db.execute(stmt)).scalar_one_or_none()
    return (latest or 0) + 1


def run_step_span_fte(
    project: ProjectInput,
    step: StepSchedule,
    fte_by_engineer: dict[str, float],
) -> float | None:
    """ADR 0032 (P20-T02): the leader FTE the run used to stretch `step`, read
    from the run's own input, or `None` when the step was not stretched: not a
    design step, skipped, Done in the input, a frozen project (I10), no
    assigned engineer (no leader, or an In Progress tail with nothing left),
    or an FTE that is not `is_valid_fte` (the scheduler rejects those as a
    data error). Persisted as `ScheduleRunProjectStep.span_fte`."""

    if step.kind != "design" or step.skipped or project.frozen:
        return None
    # P40 (ADR 0054 R40-3): a pin replaces the FTE span.
    if step.pinned:
        return None
    if step.assigned_engineer_id is None:
        return None
    if any(sp.step_id == step.step_id and sp.status == "Done" for sp in project.step_progress):
        return None
    fte = fte_by_engineer.get(step.assigned_engineer_id)
    if fte is None or not is_valid_fte(fte):
        return None
    return fte


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

    # Owner 2026-11-23: serialise with every band-rank writer (register
    # batch, priority move, re-rank) BEFORE this run takes any project row
    # lock (the FK checks of its step / outcome rows), or a concurrent
    # register Save deadlocks against it (`services.band_rank.wait_for_band_ranks`).
    from services.band_rank import wait_for_band_ranks

    await wait_for_band_ranks(db)

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
        # P37-T04 (R37-2, I38): the row's week was fixed when it was queued
        # and the worker built the input with it. A mismatch would mean the
        # input was built at another week; refuse instead of overwriting.
        if run.current_week != schedule_input.current_week:
            raise ValueError(
                "persist_schedule_output: schedule_input.current_week "
                f"({schedule_input.current_week}) differs from the run row's week "
                f"({run.current_week}); build the input with current_week=run.current_week"
            )
        run.objective_value = objective_value
        run.trigger_reason = trigger_reason
        run.completed_at = datetime.now(UTC)
        run.workflow_snapshot = snapshot
        run.solver_status = effective_solver_status
        run.rules_epoch = RULES_EPOCH_P53
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
            # P53 (R53-7): every run persisted from here on is a P53 run.
            rules_epoch=RULES_EPOCH_P53,
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

    project_inputs = {p.project_id: p for p in schedule_input.projects}
    fte_by_engineer = {e.engineer_id: e.fte for e in schedule_input.engineers}
    for outcome in schedule_output.project_outcomes:
        project = project_id_map.get(outcome.project_id)
        if project is None:  # pragma: no cover - defensive, should never happen
            continue
        project_input = project_inputs.get(outcome.project_id)

        for step in outcome.steps:
            span_fte = (
                run_step_span_fte(project_input, step, fte_by_engineer)
                if project_input is not None
                else None
            )
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
                    span_fte=span_fte,
                    # P40 (ADR 0054 R40-12, I45 / I47).
                    pinned=step.pinned,
                    manual_overlap=step.manual_overlap,
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
                manual_overlap=outcome.manual_overlap,
                pin_lapsed=outcome.pin_lapsed,
                # P42 (R42-4, I50): stored exactly as the scheduler emitted them.
                counts_toward_year=outcome.counts_toward_year,
                not_scheduled_priority=outcome.not_scheduled_priority,
                # P53 (R53-3): the band in the run input, and (R53-2) the
                # not-placed reason with the scheduler's diagnostics, which
                # the outcome row does not otherwise keep.
                priority_at_run=project_input.priority if project_input is not None else None,
                left_out_reason=outcome_left_out_reason(outcome),
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
    horizon_weeks: int | None = None,
    current_week: int | None = None,
) -> ScheduleRun:
    """Create and COMMIT (not just flush) a new `ScheduleRun` row in
    `QUEUED` status, reserving its `version` number, before any solver runs
    at all.

    P37-T04 (ADR 0052 R37-2, I38): the run's week is fixed HERE. With
    `current_week=None` (every production caller) the plan clock is read once,
    now, and stored; the worker later builds the solver input with
    `current_week=run.current_week` and never re-reads the clock, so a run
    queued Sunday 23:59 Athens and executed Monday solves at the Sunday week.
    An explicit value is for tests and scripts only.

    **P3-T06-only** — used by `api/routers/schedule_runs.py`'s async CP-SAT
    dispatch endpoint so a stable `schedule_run_id` exists for the client to
    reference (and, once `celery_task_id` is set immediately after
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

    if current_week is None:
        current_week = plan_clock.current_week()
    current_week = require_plan_week(current_week)  # I41
    # P53 (R53-2, I58): N is read once, here, with the week; the worker
    # builds the input with the stored horizon.
    if horizon_weeks is None:
        horizon_weeks = await horizon_weeks_for(db, current_week)
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
        rules_epoch=RULES_EPOCH_P53,
    )
    db.add(run)
    await db.commit()
    await db.refresh(run)
    return run
