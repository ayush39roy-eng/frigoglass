"""Workflow DAG, lead-time lookup and progress-aware per-project planning.

Shared by `greedy.py`, `cp_sat.py` and `invariants.py` so the three agree, by
construction, on:

  - which steps a project has and in what deterministic order they are walked
    (topological order of the precedence DAG, `sequence_order` as tie-break —
    ADR 0009: "sequence_order is … the deterministic tie-break when the
    scheduler walks steps; it is no longer a dependency statement");
  - each step's lead-time duration (`lead_time[workflow][category][step]`,
    ADR 0007 — no multiplier, no `max(1, …)`), and whether it is *skipped*
    (`duration == 0`, or a `lab` step when `certification_testing_required`
    is false);
  - the per-step progress state (DOMAIN_RULES.md "Per-stage progress
    capture"): normalised status, derived `remaining`, the `data_error` that
    rejects a project with inconsistent actuals, the `Blocked` hold set;
  - the two pure by-products of a run that need no solve: the
    *unconstrained* finish week and the duration-weighted `progress_pct` (I12).

Pure, deterministic, no I/O. Every mapping built here is keyed and every
iteration is over an explicitly sorted sequence (Invariant I8).
"""

from __future__ import annotations

import math
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from scheduling.types import (
    CATEGORY_RANK,
    PROGRESS_STATUSES,
    STEP_KINDS,
    LeadTime,
    ProjectInput,
    StepProgressInput,
    WorkflowStepTemplate,
)

STATUS_NOT_STARTED = "Not Started"
STATUS_IN_PROGRESS = "In Progress"
STATUS_BLOCKED = "Blocked"
STATUS_DONE = "Done"

#: Statuses whose steps are *anchored*: their placement is fixed by recorded
#: actuals (Done) or by the "book the remaining tail from the current week"
#: rule (In Progress / Blocked), never searched for. Capacity is consumed
#: regardless of conflict, so an ENG_CONFLICT / OVERLAP may be raised.
ANCHORED_STATUSES: frozenset[str] = frozenset({STATUS_IN_PROGRESS, STATUS_BLOCKED, STATUS_DONE})


# --- Workflow (DAG) -------------------------------------------------------------


@dataclass(frozen=True)
class Workflow:
    """One validated workflow: its steps (sorted by `sequence_order`), the
    deterministic walk order, and the direct successor map."""

    workflow_id: str
    steps: tuple[WorkflowStepTemplate, ...]
    steps_by_id: Mapping[str, WorkflowStepTemplate]
    walk_order: tuple[str, ...]
    successors: Mapping[str, tuple[str, ...]]

    @property
    def first_step_id(self) -> str:
        return self.steps[0].step_id


def build_workflows(templates: tuple[WorkflowStepTemplate, ...]) -> dict[str, Workflow]:
    """Group `templates` by `workflow_id` and validate each DAG. Raises
    `ValueError` (input validation, never a silent default) on: unknown
    `kind`, duplicate `step_id`, a self-reference, a predecessor outside the
    same workflow, an empty predecessor set on any step but the first, or a
    cycle (DOMAIN_RULES.md "Precedence", I15).
    """

    by_wf: dict[str, list[WorkflowStepTemplate]] = {}
    for t in templates:
        if t.kind not in STEP_KINDS:
            raise ValueError(
                f"workflow step {t.step_id!r}: kind {t.kind!r} is not one of {STEP_KINDS}"
            )
        by_wf.setdefault(t.workflow_id, []).append(t)

    workflows: dict[str, Workflow] = {}
    for workflow_id in sorted(by_wf):
        steps = tuple(sorted(by_wf[workflow_id], key=lambda s: (s.sequence_order, s.step_id)))
        steps_by_id: dict[str, WorkflowStepTemplate] = {}
        for s in steps:
            if s.step_id in steps_by_id:
                raise ValueError(f"workflow {workflow_id!r}: duplicate step_id {s.step_id!r}")
            steps_by_id[s.step_id] = s

        first_id = steps[0].step_id
        for s in steps:
            if s.step_id != first_id and not s.predecessor_ids:
                raise ValueError(
                    f"workflow {workflow_id!r}: step {s.step_id!r} has an empty predecessor "
                    f"set but is not the first step ({first_id!r})"
                )
            for p in s.predecessor_ids:
                if p == s.step_id:
                    raise ValueError(
                        f"workflow {workflow_id!r}: step {s.step_id!r} references itself"
                    )
                if p not in steps_by_id:
                    raise ValueError(
                        f"workflow {workflow_id!r}: step {s.step_id!r} has predecessor {p!r} "
                        "which is not a step of the same workflow"
                    )

        # Kahn's algorithm with the ready set drained in (sequence_order, step_id)
        # order — deterministic, and identical to plain sequence order whenever
        # sequence order is itself topological (always true for the seeded chain).
        indegree = {s.step_id: len(set(s.predecessor_ids)) for s in steps}
        successors: dict[str, list[str]] = {s.step_id: [] for s in steps}
        for s in steps:
            for p in sorted(set(s.predecessor_ids)):
                successors[p].append(s.step_id)
        seq_of = {s.step_id: s.sequence_order for s in steps}
        ready = sorted((sid for sid, d in indegree.items() if d == 0), key=lambda x: (seq_of[x], x))
        walk: list[str] = []
        while ready:
            sid = ready.pop(0)
            walk.append(sid)
            for succ in sorted(successors[sid], key=lambda x: (seq_of[x], x)):
                indegree[succ] -= 1
                if indegree[succ] == 0:
                    ready.append(succ)
            ready.sort(key=lambda x: (seq_of[x], x))
        if len(walk) != len(steps):
            stuck = sorted(sid for sid, d in indegree.items() if d > 0)
            raise ValueError(
                f"workflow {workflow_id!r}: precedence graph has a cycle among {stuck}"
            )

        workflows[workflow_id] = Workflow(
            workflow_id=workflow_id,
            steps=steps,
            steps_by_id=steps_by_id,
            walk_order=tuple(walk),
            successors={
                sid: tuple(sorted(succs, key=lambda x: (seq_of[x], x)))
                for sid, succs in successors.items()
            },
        )
    return workflows


def transitive_successors(workflow: Workflow, step_id: str) -> frozenset[str]:
    """Every step reachable from `step_id` along predecessor -> successor edges."""

    seen: set[str] = set()
    frontier = list(workflow.successors[step_id])
    while frontier:
        sid = frontier.pop()
        if sid in seen:
            continue
        seen.add(sid)
        frontier.extend(workflow.successors[sid])
    return frozenset(seen)


# --- Lead times ------------------------------------------------------------------


def build_lead_time_table(lead_times: tuple[LeadTime, ...]) -> dict[tuple[str, str, str], int]:
    table: dict[tuple[str, str, str], int] = {}
    for lt in lead_times:
        if lt.weeks < 0:
            raise ValueError(
                f"lead time ({lt.workflow_id!r}, {lt.category!r}, {lt.step_id!r}) is negative"
            )
        key = (lt.workflow_id, lt.category, lt.step_id)
        if key in table and table[key] != lt.weeks:
            raise ValueError(f"conflicting duplicate lead-time rows for {key}")
        table[key] = lt.weeks
    return table


# --- Per-project plan -----------------------------------------------------------


@dataclass(frozen=True)
class StepPlan:
    """Everything the schedulers need to know about one step of one project
    *before* any capacity is consulted."""

    step: WorkflowStepTemplate
    duration: int  # lead-time weeks (0 when skipped)
    skipped: bool
    status: str  # normalised; skipped steps are always "Done" (treated as complete)
    percent_complete: int
    actual_start_week: int | None
    actual_end_week: int | None
    remaining: int  # derived per DOMAIN_RULES.md (0 when skipped / Done / Not Started)

    @property
    def anchored(self) -> bool:
        return not self.skipped and self.status in ANCHORED_STATUSES


@dataclass(frozen=True)
class ProjectPlan:
    project: ProjectInput
    workflow: Workflow
    steps: Mapping[str, StepPlan]
    data_error: str | None
    progress_tracked: bool  # any non-skipped step with status != Not Started
    blocked: bool  # any non-skipped step with status == Blocked
    held_step_ids: frozenset[str]  # Blocked steps with remaining > 0 + their transitive successors

    def step_plans_in_walk_order(self) -> tuple[StepPlan, ...]:
        return tuple(self.steps[sid] for sid in self.workflow.walk_order)


def validate_schedulable_project(
    project: ProjectInput,
    workflows: Mapping[str, Workflow],
    lead_time_table: Mapping[tuple[str, str, str], int],
    *,
    hub_lab_region: Mapping[str, str],
    priority_order: tuple[str, ...],
) -> None:
    """Fail loudly (`ValueError`) on malformed *configuration-level* input for a
    project whose status participates in scheduling. Inconsistent *progress
    data* is not a `ValueError` — it is a per-project `data_error` outcome
    (see `analyse_project`)."""

    if project.priority not in priority_order:
        raise ValueError(
            f"project {project.project_id!r}: priority {project.priority!r} is not one of "
            f"{priority_order} (required for any project whose status participates in "
            "scheduling)"
        )
    if project.category not in CATEGORY_RANK:
        raise ValueError(
            f"project {project.project_id!r}: category {project.category!r} is not one of "
            f"{CATEGORY_RANK}"
        )
    if project.hub not in hub_lab_region:
        raise ValueError(
            f"project {project.project_id!r}: hub {project.hub!r} is not one of "
            f"{sorted(hub_lab_region)}"
        )
    if project.workflow_id not in workflows:
        raise ValueError(
            f"project {project.project_id!r}: workflow_id {project.workflow_id!r} is not one of "
            f"{sorted(workflows)}"
        )
    if project.frozen and project.actual_start_week is None:
        raise ValueError(
            f"project {project.project_id!r}: frozen=True but actual_start_week is None "
            "(DOMAIN_RULES.md: frozen projects' dates are locked at actual_start)"
        )
    wf = workflows[project.workflow_id]
    for s in wf.steps:
        if (project.workflow_id, project.category, s.step_id) not in lead_time_table:
            raise ValueError(
                f"project {project.project_id!r}: no lead-time row for "
                f"({project.workflow_id!r}, {project.category!r}, {s.step_id!r})"
            )


def derive_remaining(
    duration: int, percent_complete: int, remaining_weeks_override: int | None
) -> int:
    """DOMAIN_RULES.md "Derived remaining duration"."""

    if remaining_weeks_override is not None:
        remaining = remaining_weeks_override
    else:
        remaining = math.ceil(duration * (1 - percent_complete / 100))
    return max(0, remaining)


def analyse_project(
    project: ProjectInput,
    workflow: Workflow,
    lead_time_table: Mapping[tuple[str, str, str], int],
) -> ProjectPlan:
    """Build the `ProjectPlan`: durations, skips, normalised progress, `remaining`,
    the Blocked hold set, and any `data_error`.

    `frozen` wins over progress (ADR 0006 precedence): a frozen project's
    progress rows are ignored entirely (every step reads as Not Started) and it
    can never be progress-tracked, blocked or rejected for a data error.
    """

    progress_by_step: dict[str, StepProgressInput] = {}
    errors: list[str] = []
    for pr in sorted(project.step_progress, key=lambda r: r.step_id):
        if pr.step_id not in workflow.steps_by_id:
            errors.append(f"progress row for unknown step {pr.step_id!r}")
            continue
        if pr.step_id in progress_by_step:
            errors.append(f"duplicate progress row for step {pr.step_id!r}")
            continue
        progress_by_step[pr.step_id] = pr

    plans: dict[str, StepPlan] = {}
    for step in workflow.steps:
        duration = lead_time_table[(project.workflow_id, project.category, step.step_id)]  # type: ignore[index]
        skipped = duration == 0 or (
            step.kind == "lab" and not project.certification_testing_required
        )
        progress = None if project.frozen else progress_by_step.get(step.step_id)

        if skipped:
            # A skipped step has no progress state of its own — always complete.
            plans[step.step_id] = StepPlan(
                step=step,
                duration=0,
                skipped=True,
                status=STATUS_DONE,
                percent_complete=100,
                actual_start_week=None,
                actual_end_week=None,
                remaining=0,
            )
            continue

        if progress is None:
            plans[step.step_id] = StepPlan(
                step=step,
                duration=duration,
                skipped=False,
                status=STATUS_NOT_STARTED,
                percent_complete=0,
                actual_start_week=None,
                actual_end_week=None,
                remaining=duration,
            )
            continue

        status = progress.status
        if status not in PROGRESS_STATUSES:
            errors.append(f"step {step.step_id!r}: unknown status {status!r}")
            continue
        if not 0 <= progress.percent_complete <= 100:
            errors.append(
                f"step {step.step_id!r}: percent_complete "
                f"{progress.percent_complete} outside 0..100"
            )
            continue
        if status in ANCHORED_STATUSES and progress.actual_start_week is None:
            errors.append(f"step {step.step_id!r}: status {status!r} but actual_start_week is null")
            continue
        if status == STATUS_DONE and progress.actual_end_week is None:
            errors.append(f"step {step.step_id!r}: status Done but actual_end_week is null")
            continue
        if (
            progress.actual_start_week is not None
            and progress.actual_end_week is not None
            and progress.actual_end_week < progress.actual_start_week
        ):
            errors.append(
                f"step {step.step_id!r}: actual_end_week {progress.actual_end_week} < "
                f"actual_start_week {progress.actual_start_week}"
            )
            continue
        if progress.remaining_weeks_override is not None and progress.remaining_weeks_override < 0:
            errors.append(
                f"step {step.step_id!r}: remaining_weeks_override "
                f"{progress.remaining_weeks_override} is negative"
            )
            continue

        # Consistency coercions (DOMAIN_RULES.md field table): Not Started ⇒ 0,
        # Done ⇒ 100. Enforced at write time upstream; re-applied here so the
        # I12 roll-up never depends on a stale percentage.
        pct = progress.percent_complete
        if status == STATUS_NOT_STARTED:
            pct = 0
        elif status == STATUS_DONE:
            pct = 100

        if status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
            remaining = derive_remaining(duration, pct, progress.remaining_weeks_override)
        elif status == STATUS_DONE:
            remaining = 0
        else:
            remaining = duration

        plans[step.step_id] = StepPlan(
            step=step,
            duration=duration,
            skipped=False,
            status=status,
            percent_complete=pct,
            actual_start_week=progress.actual_start_week if status != STATUS_NOT_STARTED else None,
            actual_end_week=progress.actual_end_week if status == STATUS_DONE else None,
            remaining=remaining,
        )

    data_error = "; ".join(errors) if errors else None
    if data_error is not None:
        # The project is rejected; fill any missing plans so the mapping is
        # complete for callers that still want durations (progress_pct etc.).
        for step in workflow.steps:
            if step.step_id not in plans:
                duration = lead_time_table[(project.workflow_id, project.category, step.step_id)]  # type: ignore[index]
                plans[step.step_id] = StepPlan(
                    step=step,
                    duration=duration,
                    skipped=False,
                    status=STATUS_NOT_STARTED,
                    percent_complete=0,
                    actual_start_week=None,
                    actual_end_week=None,
                    remaining=duration,
                )

    tracked = any(not sp.skipped and sp.status != STATUS_NOT_STARTED for sp in plans.values())
    blocked = any(not sp.skipped and sp.status == STATUS_BLOCKED for sp in plans.values())

    held: set[str] = set()
    for sid in workflow.walk_order:
        sp = plans[sid]
        if not sp.skipped and sp.status == STATUS_BLOCKED and sp.remaining > 0:
            held.add(sid)
            held.update(transitive_successors(workflow, sid))
    # Skipped steps are rendered as skipped regardless of the hold.
    held = {sid for sid in held if not plans[sid].skipped}

    return ProjectPlan(
        project=project,
        workflow=workflow,
        steps=plans,
        data_error=data_error,
        progress_tracked=tracked,
        blocked=blocked,
        held_step_ids=frozenset(held),
    )


# --- Pure by-products --------------------------------------------------------------


def first_step_frontier(project: ProjectInput, current_week: int) -> int:
    """Earliest week the project's first step may start (its "frontier").
    Frozen: locked at `actual_start_week`. Otherwise `max(CURRENT_WEEK,
    actual_start_week)` (P2-T01 earliest-start floor, unchanged)."""

    if project.frozen:
        assert project.actual_start_week is not None
        return project.actual_start_week
    frontier = current_week
    if project.actual_start_week is not None:
        frontier = max(frontier, project.actual_start_week)
    return frontier


def unconstrained_end_week(plan: ProjectPlan, current_week: int) -> int | None:
    """DOMAIN_RULES.md "Expected vs projected completion": the earliest finish
    assuming unlimited engineers and chambers — walk the DAG with the
    lead-time durations only. Done / In Progress stages keep their actual
    start and their derived `remaining` (progress rules); a Blocked stage is
    treated as In Progress (unlimited resources cannot unblock it, but the
    *unconstrained* figure deliberately assumes the block clears now — the
    constrained run reports the hold via `blocked=True`). `None` when every
    step is skipped.
    """

    frontier = first_step_frontier(plan.project, current_week)
    ends: dict[str, int] = {}
    for sid in plan.workflow.walk_order:
        sp = plan.steps[sid]
        preds = sp.step.predecessor_ids
        pred_end = max(ends[p] for p in preds) if preds else frontier - 1
        if sp.skipped:
            ends[sid] = pred_end
        elif sp.status == STATUS_DONE:
            assert sp.actual_end_week is not None
            ends[sid] = sp.actual_end_week
        elif sp.status in (STATUS_IN_PROGRESS, STATUS_BLOCKED):
            assert sp.actual_start_week is not None
            if sp.remaining == 0:
                ends[sid] = max(sp.actual_start_week, pred_end)
            else:
                tail_start = max(current_week, pred_end + 1, sp.actual_start_week)
                ends[sid] = tail_start + sp.remaining - 1
        else:
            start = pred_end + 1 if plan.project.frozen else max(current_week, pred_end + 1)
            ends[sid] = start + sp.duration - 1
    non_skipped = [ends[sid] for sid, sp in plan.steps.items() if not sp.skipped]
    return max(non_skipped) if non_skipped else None


def project_progress_pct(steps: Iterable[tuple[int, int]]) -> int | None:
    """The one project roll-up formula (DOMAIN_RULES "Project roll-up
    progress", I12; "Gate remediation rulings" #3). Public and pure so the
    API layer (Project Workspace) and both solvers share a single body.

    `steps` is one `(percent_complete, effective_duration_weeks)` pair per
    workflow step, where `percent_complete` is the **stored** value (0 for a
    step with no progress row) and `effective_duration_weeks` is the lead-time
    duration, or 0 when the step is skipped (duration 0, or a lab step with
    certification testing off). Returns
    `round(Σ(percent × duration) / Σ duration)` (Python `round`, i.e.
    half-to-even), or `None` when Σ duration == 0. Duration-weighted, never a
    14-way mean. Applies to every project, frozen ones included.
    """

    pairs = list(steps)
    total = sum(d for _, d in pairs)
    if total == 0:
        return None
    return round(sum(p * d for p, d in pairs) / total)


def compute_progress_pct(plan: ProjectPlan) -> int | None:
    """`project_progress_pct` over this project's stored progress rows
    (ruling 3). Uses the stored `percent_complete` exactly as the Workspace
    does -- including for a frozen project, whose rows the *scheduling* rules
    otherwise ignore (ADR 0006 "frozen wins") -- with skipped steps weighted 0.
    A duplicated row (a data error) counts once, first in input order."""

    stored: dict[str, int] = {}
    for pr in plan.project.step_progress:
        stored.setdefault(pr.step_id, pr.percent_complete)
    return project_progress_pct(
        (stored.get(sid, 0), sp.duration) for sid, sp in sorted(plan.steps.items())
    )
