"""Read model for the Project Execution Timeline (Gantt) surface
(`docs/PROJECT_AND_STACK.md` §2), plus the freeze-toggle request/response.

Per that section: "Solid bars = planned; hatched bars = actual + delay; a red
connector = delay; badges for `ENG_CONFLICT`/`OVERLAP`/`LEFT_OUT`." Planned
weeks and the conflict/overlap flags come from the active `ScheduleRun`'s
`ScheduleRunProjectStep` snapshot (never recomputed — Invariant I9's
"no independent calculation anywhere" spirit extends here even though I9's
literal text is about the Dashboard's within_year count specifically).
Actual weeks come from the *live* `ProjectWorkflowStep` row, per that model's
own "solid vs hatched" docstring.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, Field

from models.enums import HubName, ProjectCategory, ProjectPriority, WorkflowStepKind


class GanttStepRow(BaseModel):
    step_id: str
    step_name: str
    kind: WorkflowStepKind
    sequence_order: int
    duration_weeks: int | None
    planned_start_week: int | None
    planned_end_week: int | None
    actual_start_week: int | None
    actual_end_week: int | None
    #: P3-T09 (security remediation, finding #1 / OQ#8 dependency — GDPR):
    #: only populated when the caller IS the assigned engineer, viewing their
    #: own self-scoped Gantt (`services.hub_scope.is_engineer_self_scoped`).
    #: For every other reader (Hub Planner, Portfolio Manager, Executive
    #: Viewer, Admin) this is always `None`, regardless of what engineer is
    #: actually assigned — see `api/routers/gantt.py`'s `get_gantt` for the
    #: gate. `docs/OPEN_QUESTIONS.md` #8 is unresolved and hard-blocking;
    #: this is consciously reversible once the DPO signs off (re-add the
    #: value for non-self readers at that point, do not restore it before).
    assigned_engineer_name: str | None
    assigned_chamber_code: str | None
    eng_conflict: bool
    chamber_overlap: bool


class GanttProjectRow(BaseModel):
    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: ProjectCategory | None
    priority: ProjectPriority | None
    frozen: bool
    delay_weeks: int
    #: Project-level badges, from the active ScheduleRun's outcome snapshot.
    left_out: bool
    spillover: bool
    cat_not_allowed: bool
    steps: list[GanttStepRow]


class GanttResponse(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    total_count: int
    rows: list[GanttProjectRow]


class FreezeToggleRequest(BaseModel):
    """Body for `POST /gantt/projects/{project_id}/freeze`.

    Per `docs/DOMAIN_RULES.md` booking rules ("Frozen projects: dates are
    locked at `actual_start`") and `scheduling/greedy.py`'s own input
    validation (`_validate_schedulable_project`: "frozen=True but
    actual_start_week is None" is rejected) — `actual_start_week` is required
    whenever `frozen=True`.
    """

    model_config = ConfigDict(extra="forbid")

    frozen: bool
    actual_start_week: int | None = Field(default=None, ge=1)
