"""Priority split of the capacity load (P13-T11/T12, docs/API_CONTRACT_P13.md §6).

Two read-only helpers shared by the Capacity surface and the Priority board.
Nothing here is a scheduling rule: every figure is read from the active
`ScheduleRun`'s stored rows (I9), and the step kind comes from that run's
`workflow_snapshot` (`services.active_run.step_kinds_for_run`), exactly as the
existing `design_load_weeks` / `lab_load_weeks` are built (I6/I7).

**Priority bucket.** A project's bucket is its `Project.priority` band, which
is what the scheduler orders by (DOMAIN_RULES "Scheduling order"):
`P1`..`P4` map to themselves; `Q` and a null priority map to `"Queue"` (the
prototype's own label for `Q`). The live priority is used: a priority move
recalculates automatically (ADR 0015), and the run stores no priority
snapshot, the same basis as the class breakdown's live `category`.

**Reconciliation.** `split_to_total` rounds each bucket to 2 dp and puts any
rounding residual on the largest bucket, so the served buckets always sum
to the served total to 2 dp (I19 style: the browser never re-derives).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable, Mapping
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.enums import ProjectPriority, ProjectStatus, WorkflowStepKind, WorkflowStepStatus
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from services.active_run import step_kinds_for_run
from services.capacity_supply import round2

PriorityBucket = Literal["P1", "P2", "P3", "P4", "Queue"]

#: Served key order (contract §6).
PRIORITY_BUCKETS: tuple[PriorityBucket, ...] = ("P1", "P2", "P3", "P4", "Queue")

#: P13-F06 (2026-10-19): the statuses the scheduler plans
#: (DOMAIN_RULES "Status `Commercialized`, `On Hold`, `Cancelled` and `Draft`
#: are excluded from scheduling entirely"). The class breakdown counts only
#: these as Deliverable / Left out.
SCHEDULABLE_STATUSES: tuple[ProjectStatus, ...] = tuple(
    ProjectStatus(s) for s in dc.SCHEDULABLE_STATUS_ORDER
)

_BAND_TO_BUCKET: dict[ProjectPriority, PriorityBucket] = {
    ProjectPriority.P1: "P1",
    ProjectPriority.P2: "P2",
    ProjectPriority.P3: "P3",
    ProjectPriority.P4: "P4",
    ProjectPriority.Q: "Queue",
}


def priority_bucket(priority: ProjectPriority | None) -> PriorityBucket:
    """`P1`..`P4` → themselves; `Q` or null → `"Queue"`."""

    if priority is None:
        return "Queue"
    return _BAND_TO_BUCKET[priority]


def split_to_total(parts: Mapping[str, float], total: float) -> dict[PriorityBucket, float]:
    """Round each bucket to 2 dp so that they sum to `round2(total)`.

    Any rounding residual goes to the largest bucket (first in served order
    on a tie). With today's integer step durations the residual is always 0;
    the adjustment only guards the 2 dp sum if a fractional consumption
    factor is ever configured.
    """

    rounded: dict[PriorityBucket, float] = {
        b: round2(float(parts.get(b, 0.0))) for b in PRIORITY_BUCKETS
    }
    residual = round2(round2(total) - sum(rounded.values()))
    if residual != 0.0:
        largest = max(PRIORITY_BUCKETS, key=lambda b: (rounded[b], -PRIORITY_BUCKETS.index(b)))
        rounded[largest] = round2(rounded[largest] + residual)
    return rounded


def count_split(counts: Mapping[str, int]) -> dict[PriorityBucket, int]:
    """Every bucket present, 0 when absent."""

    return {b: int(counts.get(b, 0)) for b in PRIORITY_BUCKETS}


async def remaining_run_load_by_project(
    db: AsyncSession, run: ScheduleRun | None, project_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[float, float]]:
    """Each project's remaining `(design_weeks, lab_weeks)` in the active run.

    Remaining = the weeks of each non-skipped step's stored window
    (`start_week..end_week`, inclusive) at or after the run's
    `current_week`. A step whose live status is `Done` adds 0. For a
    `Not Started` step the window equals its effective duration (I21); for an
    `In Progress` / `Blocked` step the part from `current_week` on is the
    booked tail (the derived remaining duration, I21). Lab weeks use the same
    `LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK` as the Capacity lab load.

    Projects not in the run (no stored step) are absent from the result.
    """

    ids = list(project_ids)
    if run is None or not ids:
        return {}
    kinds = await step_kinds_for_run(db, run)
    done = {
        (pid, step_id)
        for pid, step_id in (
            await db.execute(
                select(ProjectWorkflowStep.project_id, ProjectWorkflowStep.step_template_id)
                .where(ProjectWorkflowStep.project_id.in_(ids))
                .where(ProjectWorkflowStep.status == WorkflowStepStatus.DONE)
            )
        ).all()
    }
    rows = (
        await db.execute(
            select(
                ScheduleRunProjectStep.project_id,
                ScheduleRunProjectStep.step_template_id,
                ScheduleRunProjectStep.start_week,
                ScheduleRunProjectStep.end_week,
                ScheduleRunProjectStep.skipped,
            )
            .where(ScheduleRunProjectStep.schedule_run_id == run.id)
            .where(ScheduleRunProjectStep.project_id.in_(ids))
        )
    ).all()

    design: dict[uuid.UUID, float] = defaultdict(float)
    lab: dict[uuid.UUID, float] = defaultdict(float)
    seen: set[uuid.UUID] = set()
    for pid, step_id, start, end, skipped in rows:
        seen.add(pid)
        if skipped or (pid, step_id) in done:
            continue
        weeks = max(0, end - max(start, run.current_week) + 1)
        kind = kinds.get(step_id)
        if kind == WorkflowStepKind.DESIGN:
            design[pid] += weeks
        elif kind == WorkflowStepKind.LAB:
            lab[pid] += weeks * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
    return {pid: (design.get(pid, 0.0), lab.get(pid, 0.0)) for pid in seen}
