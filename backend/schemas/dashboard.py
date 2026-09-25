"""Read models for the Global RPD Dashboard surface
(`docs/PROJECT_AND_STACK.md` §2). Every field that concerns a *scheduling
outcome* (within-year, spillover, left-out) is sourced from the active
`ScheduleRun`'s snapshot tables — never independently calculated — per
Invariant I9. See `api/routers/dashboard.py` for the query that enforces
this.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel

from models.enums import HubName, ProjectCategory, ProjectPriority, ProjectStatus, ProjectType


class PipelineTotals(BaseModel):
    """`docs/PROJECT_AND_STACK.md` §2: "pipeline totals split by spillover /
    newly registered / total." Interpreted here as `Project.carry_over`
    (spillover = carried over from a prior year's registration) vs newly
    registered (`carry_over=False`) — a portfolio-*composition* metric,
    distinct from the schedule-outcome `SPILLOVER` flag (a project not
    completing within the current scheduling year; see
    `CompletingWithinYearRow`/`CompletingWithinYear` below). Both concepts are
    legitimately called "spillover" in the source docs but are NOT the same
    number — flagged as a judgement call since DOMAIN_RULES.md does not
    define "pipeline totals" itself. Scope: every project except
    `Commercialized` (no longer "in the pipeline").
    """

    spillover_count: int
    new_count: int
    total_count: int


class StatusOverview(BaseModel):
    """Counts for the four schedulable statuses named in
    `docs/PROJECT_AND_STACK.md` §2 ("In Buyoff / Under Industrialization / In
    Development / In Queue"). `Draft`/`Commercialized`/`On Hold` counts are
    included too (as `other_counts`) so the total is reconcilable, but are not
    part of the four named "status overview cards."
    """

    in_buyoff: int
    under_industrialization: int
    in_development: int
    in_queue: int
    other_counts: dict[str, int]


class HubTypePipelineRow(BaseModel):
    hub: HubName
    type: ProjectType | None
    count: int


class CompletingWithinYearRow(BaseModel):
    """One project's outcome from the active `ScheduleRun` snapshot
    (`models.schedule.ScheduleRunProjectOutcome` joined to `Project`).
    """

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: ProjectCategory | None
    priority: ProjectPriority | None
    within_year: bool
    spillover: bool
    left_out: bool
    cat_not_allowed: bool
    last_step_end_week: int | None


class CompletingWithinYear(BaseModel):
    """Response for `GET /dashboard/completing-within-year`.

    `has_active_schedule_run=False` (with empty `rows` and all counts 0) is a
    legitimate, non-error state — nothing has necessarily triggered a
    `ScheduleRun` yet (see `api/routers/schedule_runs.py`'s
    `POST /schedule-runs/greedy-recalc`). Callers must handle it, not assume a
    run always exists.
    """

    has_active_schedule_run: bool
    schedule_run_version: int | None
    within_year_count: int
    spillover_count: int
    left_out_count: int
    rows: list[CompletingWithinYearRow]


class ProjectFilterRow(BaseModel):
    """One row of the "analytics breakdown with filters" endpoint — a light
    projection, not the full `ProjectRead` (Project Registration's job).
    """

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: ProjectCategory | None
    status: ProjectStatus
    priority: ProjectPriority | None


class ProjectFilterResult(BaseModel):
    total_count: int
    rows: list[ProjectFilterRow]
