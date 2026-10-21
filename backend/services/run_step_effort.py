"""Effort per week of a stored run row (ADR 0032, FTE gates speed).

Since ADR 0032 a design row of a non-frozen project spans
`ceil(duration_weeks / fte)` elapsed weeks while `duration_weeks` stays the
**effort** figure. Load figures sum effort, never the elapsed span (I6;
DOMAIN_RULES "Capacity supply"). A per-week view of a row therefore spreads
its `duration_weeks` over the weeks the row occupies, so the weeks sum back to
`duration_weeks` exactly:

- Not Started / Done rows, frozen projects, and any row without a usable
  progress split: `duration_weeks / (end_week − start_week + 1)` on every week
  of `[start_week, end_week]`.
- In Progress / Blocked rows (live status, non-frozen project): the stored
  row runs from `actual_start_week` to the end of the booked tail. The tail
  starts at `max(run.current_week, pred_end + 1, start_week)` (the
  scheduler's own rule, DOMAIN_RULES "How progress feeds a schedule run";
  `pred_end` from the same run's rows and the run's workflow snapshot). The
  remaining effort `derive_remaining(duration, percent, override)` (the
  scheduler's function, clamped to `[0, duration]` and to the tail's length)
  is spread over the tail,
  and the done effort (`duration − remaining`) over the weeks before it. When
  either part has no weeks, the whole row is spread evenly instead.

Nothing here re-schedules anything: it only reads stored run rows and the
live progress fields that the run was computed from.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import WorkflowStepStatus
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from scheduling.workflow import derive_remaining

_TAIL_STATUSES = frozenset({WorkflowStepStatus.IN_PROGRESS, WorkflowStepStatus.BLOCKED})


def spread_effort(
    start_week: int,
    end_week: int,
    duration_weeks: int,
    *,
    tail_start_week: int | None = None,
    remaining_weeks: int | None = None,
) -> dict[int, float]:
    """`{week: effort}` for one row; the values sum to `duration_weeks`.

    Without a tail (`tail_start_week` / `remaining_weeks` is `None`) the effort
    is spread evenly over `[start_week, end_week]`. With one, the remaining
    effort goes on `[tail_start_week, end_week]` and the rest before it.
    """

    if duration_weeks <= 0 or end_week < start_week:
        return {}
    if (
        tail_start_week is not None
        and remaining_weeks is not None
        and start_week < tail_start_week <= end_week
    ):
        tail_len = end_week - tail_start_week + 1
        # Capped at the tail's length: at FTE <= 1 effort never exceeds the
        # elapsed weeks, and a run that is stale against the live progress
        # (e.g. percent edited after the run) must not book more than one
        # effort week per booked week. The excess stays in the done part, so
        # the row still sums to `duration_weeks`.
        remaining = min(max(remaining_weeks, 0), duration_weeks, tail_len)
        done = duration_weeks - remaining
        past_len = tail_start_week - start_week
        if done > 0 and remaining > 0:
            out = {w: done / past_len for w in range(start_week, tail_start_week)}
            out.update({w: remaining / tail_len for w in range(tail_start_week, end_week + 1)})
            return out
    per_week = duration_weeks / (end_week - start_week + 1)
    return {w: per_week for w in range(start_week, end_week + 1)}


def _snapshot_predecessors(snapshot: dict[str, Any] | None) -> dict[str, tuple[str, ...]]:
    out: dict[str, tuple[str, ...]] = {}
    if not snapshot:
        return out
    for workflow in snapshot.get("workflows", []):
        for step in workflow.get("steps", []):
            try:
                out[str(step["step_id"])] = tuple(str(p) for p in step.get("predecessor_ids") or ())
            except (KeyError, TypeError):
                continue
    return out


async def step_predecessors_for_run(
    db: AsyncSession, run: ScheduleRun
) -> dict[str, tuple[str, ...]]:
    """`{step_id: predecessor ids}` as recorded on the run's workflow snapshot
    (ADR 0009, I15), filled in from the current templates for older runs."""

    current = {
        t.id: tuple(t.predecessor_ids or ())
        for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    return {**current, **_snapshot_predecessors(run.workflow_snapshot)}


@dataclass(frozen=True)
class _Progress:
    status: WorkflowStepStatus
    percent_complete: int
    remaining_weeks_override: int | None


async def weekly_effort_for_rows(
    db: AsyncSession, run: ScheduleRun, rows: Sequence[ScheduleRunProjectStep]
) -> dict[uuid.UUID, dict[int, float]]:
    """`{row.id: {week: effort}}` for the given rows of `run` (module rules).
    Skipped rows get an empty map. Each map sums to the row's
    `duration_weeks`."""

    live_rows = [r for r in rows if not r.skipped and r.duration_weeks > 0]
    if not live_rows:
        return {r.id: {} for r in rows}

    project_ids = {r.project_id for r in live_rows}
    progress: dict[tuple[uuid.UUID, str], _Progress] = {}
    frozen: set[uuid.UUID] = set()
    for pid, step_id, status, pct, override, is_frozen in (
        await db.execute(
            select(
                ProjectWorkflowStep.project_id,
                ProjectWorkflowStep.step_template_id,
                ProjectWorkflowStep.status,
                ProjectWorkflowStep.percent_complete,
                ProjectWorkflowStep.remaining_weeks_override,
                Project.frozen,
            )
            .join(Project, Project.id == ProjectWorkflowStep.project_id)
            .where(ProjectWorkflowStep.project_id.in_(project_ids))
        )
    ).all():
        progress[(pid, step_id)] = _Progress(status, pct, override)
        if is_frozen:
            frozen.add(pid)

    tail_rows = [
        r
        for r in live_rows
        if r.project_id not in frozen
        and (p := progress.get((r.project_id, r.step_template_id))) is not None
        and p.status in _TAIL_STATUSES
    ]
    ends: dict[uuid.UUID, dict[str, int]] = defaultdict(dict)
    preds: Mapping[str, tuple[str, ...]] = {}
    if tail_rows:
        preds = await step_predecessors_for_run(db, run)
        tail_projects = {r.project_id for r in tail_rows}
        for pid, step_id, end in (
            await db.execute(
                select(
                    ScheduleRunProjectStep.project_id,
                    ScheduleRunProjectStep.step_template_id,
                    ScheduleRunProjectStep.end_week,
                ).where(
                    ScheduleRunProjectStep.schedule_run_id == run.id,
                    ScheduleRunProjectStep.project_id.in_(tail_projects),
                )
            )
        ).all():
            ends[pid][step_id] = end
    tail_ids = {r.id for r in tail_rows}

    out: dict[uuid.UUID, dict[int, float]] = {}
    for r in rows:
        if r.skipped or r.duration_weeks <= 0:
            out[r.id] = {}
            continue
        if r.id not in tail_ids:
            out[r.id] = spread_effort(r.start_week, r.end_week, r.duration_weeks)
            continue
        p = progress[(r.project_id, r.step_template_id)]
        mine = ends[r.project_id]
        pred_ends = [mine[s] for s in preds.get(r.step_template_id, ()) if s in mine]
        tail_start = max(
            run.current_week, (max(pred_ends) + 1) if pred_ends else r.start_week, r.start_week
        )
        out[r.id] = spread_effort(
            r.start_week,
            r.end_week,
            r.duration_weeks,
            tail_start_week=tail_start,
            remaining_weeks=derive_remaining(
                r.duration_weeks, p.percent_complete, p.remaining_weeks_override
            ),
        )
    return out


def effort_from(weekly: Mapping[int, float], first_week: int) -> float:
    """Σ effort on weeks `>= first_week`."""

    return sum(v for w, v in weekly.items() if w >= first_week)


__all__ = [
    "effort_from",
    "spread_effort",
    "step_predecessors_for_run",
    "weekly_effort_for_rows",
]
