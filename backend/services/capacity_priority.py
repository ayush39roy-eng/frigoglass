"""Priority split of the capacity load (P13-T11/T12, docs/API_CONTRACT_P13.md §6).

Read-only helpers shared by the Capacity surface and the Priority board.
Nothing here is a scheduling rule.

Bases (corrected at P45-T01; the earlier text predated ADR 0041):
- The hub rows' `*_load_by_priority` / `*_demand_by_priority` split the
  full-year DEMAND (I25, ADR 0041 R12) and `*_remaining_by_priority` the
  remaining DEMAND, from live rows (`services.demand_load`). The split is
  built in `api.routers.capacity` with `priority_bucket` + `split_to_total`.
- `remaining_run_load_by_project` (Priority board column weeks) is still
  read from the active `ScheduleRun`'s stored rows (I6/I7 basis), with step
  kinds from that run's `workflow_snapshot`.

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
from services.run_step_effort import effort_from, spread_effort, weekly_effort_for_rows

PriorityBucket = Literal["P1", "P2", "P3", "P4", "Queue"]

#: Served key order (contract §6).
PRIORITY_BUCKETS: tuple[PriorityBucket, ...] = ("P1", "P2", "P3", "P4", "Queue")

#: P42 (ADR 0056 R42-1): the display label of each bucket key. The key
#: `Queue` stays (wire compatibility) but must not read "Queue" any more: P3
#: is now "In queue". It is displayed "Q".
PRIORITY_BUCKET_LABELS: Mapping[PriorityBucket, str] = {
    "P1": "P1",
    "P2": "P2",
    "P3": "P3",
    "P4": "P4",
    "Queue": "Q",
}

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


def need_to_finish(
    remaining: Mapping[PriorityBucket, float], capacity_remaining: float
) -> tuple[float, float]:
    """P45 D45-2: `(need_p1, need_p1_p2)` in weeks, 2 dp.

    `need_p1 = max(0, R(P1) − C_rem)` and `need_p1_p2 = max(0, R(P1) + R(P2)
    − C_rem)`, where `remaining` is the SERVED remaining-demand split (2 dp,
    from `split_to_total`) and `capacity_remaining` the SERVED remaining
    capacity (rounded to 2 dp here), so a reader re-derives both from the
    response. An aggregate capacity view, not the scheduler's verdict.
    `need_p1_p2 >= need_p1` always, since R(P2) >= 0.
    """

    cap = round2(capacity_remaining)
    p1 = round2(float(remaining.get("P1", 0.0)))
    p2 = round2(float(remaining.get("P2", 0.0)))
    return round2(max(0.0, p1 - cap)), round2(max(0.0, p1 + p2 - cap))


def count_split(counts: Mapping[str, int]) -> dict[PriorityBucket, int]:
    """Every bucket present, 0 when absent."""

    return {b: int(counts.get(b, 0)) for b in PRIORITY_BUCKETS}


async def remaining_run_load_by_project(
    db: AsyncSession, run: ScheduleRun | None, project_ids: Iterable[uuid.UUID]
) -> dict[uuid.UUID, tuple[float, float]]:
    """Each project's remaining `(design_weeks, lab_weeks)` in the active run.

    Remaining = the part of each non-skipped step's stored window
    (`start_week..end_week`, inclusive) at or after the run's
    `current_week`. A step whose live status is `Done` adds 0. For a
    `Not Started` step the window equals its effective duration (I21); for an
    `In Progress` / `Blocked` step the part from `current_week` on is the
    booked tail (the derived remaining duration, I21). Lab weeks use the same
    `LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK` as the Capacity lab load.

    ADR 0032: design weeks are **effort**, like every load figure. A design
    row spans `ceil(duration / fte)` elapsed weeks, so its weeks from
    `current_week` on are counted at the row's effort per week
    (`services.run_step_effort.weekly_effort_for_rows`), not one per elapsed
    week. At FTE 1.0 this is the elapsed count, unchanged. Lab rows are never
    stretched and keep the elapsed count, except a pinned lab row (P40, ADR
    0054 R40-3 / F6), whose window may differ from its effort: its
    `duration_weeks` is spread evenly over the window and the part from
    `current_week` on counts.

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
        (
            await db.execute(
                select(ScheduleRunProjectStep)
                .where(ScheduleRunProjectStep.schedule_run_id == run.id)
                .where(ScheduleRunProjectStep.project_id.in_(ids))
            )
        )
        .scalars()
        .all()
    )
    design_rows = [
        r
        for r in rows
        if not r.skipped
        and (r.project_id, r.step_template_id) not in done
        and kinds.get(r.step_template_id) == WorkflowStepKind.DESIGN
    ]
    effort = await weekly_effort_for_rows(db, run, design_rows)

    design: dict[uuid.UUID, float] = defaultdict(float)
    lab: dict[uuid.UUID, float] = defaultdict(float)
    seen: set[uuid.UUID] = set()
    for r in rows:
        pid = r.project_id
        seen.add(pid)
        if r.skipped or (pid, r.step_template_id) in done:
            continue
        kind = kinds.get(r.step_template_id)
        if kind == WorkflowStepKind.DESIGN:
            design[pid] += effort_from(effort.get(r.id, {}), run.current_week)
        elif kind == WorkflowStepKind.LAB and r.pinned:
            weekly = spread_effort(r.start_week, r.end_week, r.duration_weeks)
            lab[pid] += effort_from(weekly, run.current_week) * (
                dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
            )
        elif kind == WorkflowStepKind.LAB:
            weeks = max(0, r.end_week - max(r.start_week, run.current_week) + 1)
            lab[pid] += weeks * dc.LAB_STEP_CONSUMPTION_PER_PROJECT_WEEK
    return {pid: (round2(design.get(pid, 0.0)), lab.get(pid, 0.0)) for pid in seen}
