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
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from models.enums import (
    HubName,
    ProjectCategory,
    ProjectPriority,
    ProjectType,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from schemas.step_timing import TimingEditable


class GanttStepRow(BaseModel):
    """P9 (docs/API_CONTRACT_P9.md §5): `kind` is the kind recorded on the
    active run's `workflow_snapshot` (`design`/`lab`/`elapsed`). `skipped`
    comes from the run's step row. `status`/`percent_complete` come from the
    live `ProjectWorkflowStep` (ADR 0006). Step rows may overlap in time
    (ADR 0009).
    """

    step_id: str
    step_name: str
    kind: WorkflowStepKind
    sequence_order: int
    skipped: bool
    status: WorkflowStepStatus
    percent_complete: int
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
    #: P12 (ADR 0019, docs/API_CONTRACT_P12.md §3). `duration_weeks` above is
    #: the effective duration the active run booked (`override ?? lead
    #: time`). `lead_time_weeks` is the lead-time table value for the
    #: project's workflow/category; the two timing fields are the live
    #: planner inputs (they may be newer than the run while it recalculates).
    #: ADR 0041 R4 (docs/API_CONTRACT_P30.md §4): `duration_override_weeks`
    #: is the USER's figure only (1..104); `effort_weeks` is the derived
    #: per-project effort (0..104, never a user edit). Effective = user ??
    #: effort ?? lead. A "timing edit" (hasTimingEdit / Reset timing) is a
    #: non-null `duration_override_weeks` or `start_not_before_week`; Reset
    #: timing clears both and the step falls back to `effort_weeks`.
    lead_time_weeks: int
    duration_override_weeks: int | None
    effort_weeks: int | None
    start_not_before_week: int | None
    #: Computed server-side from ADR 0019 §4 and the caller's GANTT write
    #: permission on the project; the browser never derives it.
    timing_editable: TimingEditable
    #: P20-T02 (ADR 0032): the leader FTE the active run used to stretch this
    #: step to `ceil(duration_weeks / fte)` elapsed weeks
    #: (`ScheduleRunProjectStep.span_fte`, from the run's own input). The
    #: browser converts a right-edge drag's elapsed width back to effort with
    #: it. `null` for lab, elapsed, skipped and Done steps, frozen projects,
    #: steps with no leader, rows of runs persisted before P20-T02, and, for
    #: privacy (OQ #8: part-time status is personal data), for every caller
    #: who may not edit step timing on this project (GANTT/WRITE with the
    #: project's hub in scope, the check `PATCH .../timing` applies).
    span_fte: float | None


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
    #: docs/DOMAIN_RULES.md "Expected vs projected completion" (I16). All are
    #: stored values, from the project row (`target_end_week`) and the active
    #: run's outcome row (the rest). `slip_weeks = projected − expected`, null
    #: when either is null. The browser draws these and never derives them.
    target_end_week: int | None
    expected_end_week: int | None
    projected_end_week: int | None
    unconstrained_end_week: int | None
    slip_weeks: int | None
    #: A Blocked stage held the project in the active run (ADR 0006).
    blocked: bool
    #: Progress or settings changed since the active run was computed.
    schedule_stale: bool
    workflow_id: Literal["PDD", "OEM"]
    #: P12 (docs/API_CONTRACT_P12.md §3/§6, ADR 0022): pinned as VIP.
    is_vip: bool
    #: P12 (ADR 0021 §4): served by `services.tracking.tracking_status_for`.
    tracking_status: Literal["live", "due", "overdue", "idle"]
    #: P13-T13 (docs/API_CONTRACT_P13.md §7) row meta.
    external_code: str | None
    type: ProjectType | None
    #: OQ #8 / P3-T09: the leader's name only when the leader is the caller;
    #: `null` for every other reader. `leader_engineer_id` is always served
    #: (so the UI can tell "withheld" from "no leader").
    leader_name: str | None
    leader_engineer_id: uuid.UUID | None
    #: Σ of the active run's booked effective durations (`override ?? lead
    #: time`, ADR 0019) over the project's non-skipped steps of that kind —
    #: the same basis as the Capacity design/lab load (I6/I7). `total_weeks`
    #: sums every non-skipped step (design + lab + elapsed). All `null` when
    #: the project has no step in the active run.
    design_weeks: int | None
    lab_weeks: int | None
    total_weeks: int | None
    steps: list[GanttStepRow]


class GanttWeeklyActiveCount(BaseModel):
    """P13-T13: active steps in one display week (W1–W52, ADR 0024) over the
    whole filtered set, not just the returned page. A step is active in week
    `w` when it is not skipped and `start_week <= w <= end_week` in the
    active run (the bar the Gantt draws). Split by the project's workflow.
    """

    week: int
    pdd: int
    oem: int


class GanttResponse(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    total_count: int
    rows: list[GanttProjectRow]
    #: P13-T13: one entry per week 1..52 while an active run exists; `[]`
    #: without one.
    weekly_active_counts: list[GanttWeeklyActiveCount]


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
