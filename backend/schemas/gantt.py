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
    ProjectPriority,
    ProjectType,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from schemas.category import CategoryCodeOut
from schemas.dashboard import ScheduleOutcome
from schemas.edit_conflict import EditBase


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
    #: P12 (ADR 0019) / P33 (ADR 0046 §B, contract P33 Part G).
    #: `duration_weeks` above is the effective duration the active run booked.
    #: `lead_time_weeks` is the project's own copy of its category template
    #: length (`plan_weeks`, served under both names for compatibility);
    #: `effort_weeks` is the derived per-project effort (0..104, never a user
    #: edit).
    lead_time_weeks: int
    effort_weeks: int | None
    #: P33-T12 (ADR 0046/0048, contract P33 Part G): the project's copy of
    #: the category template for this step. `plan_weeks` is the copied length
    #: (0..104). `gap_weeks` is the signed copied gap (`plan_gap_weeks`,
    #: −104..104): negative = the step runs in parallel with the work it waits
    #: for by that many weeks ("parallel N wk"), positive = it waits that many
    #: weeks after it ("wait N wk"), 0 = neither. `own_effort` is true when the
    #: step's kind follows the project's own effort figure (`ownEffort(p,
    #: kind(s))`, OR-1), so its duration is `effort_weeks`, not `plan_weeks`.
    #: All read-only: per-project timing editing is retired (ADR 0048), and
    #: `timing_editable`, `duration_override_weeks`, `start_not_before_week`
    #: and `overlap_weeks` are no longer served.
    plan_weeks: int
    gap_weeks: int
    own_effort: bool
    #: ADR 0043: the step's precedence predecessors from the live workflow
    #: template (the DAG the next run will use), sorted. Empty for the
    #: workflow's first step.
    predecessor_ids: list[str]
    #: P20-T02 (ADR 0032): the leader FTE the active run used to stretch this
    #: step to `ceil(duration_weeks / fte)` elapsed weeks
    #: (`ScheduleRunProjectStep.span_fte`, from the run's own input). `null`
    #: for lab, elapsed, skipped and Done steps, frozen projects, steps with
    #: no leader, rows of runs persisted before P20-T02, and, for privacy
    #: (OQ #8: part-time status is personal data), for every caller without
    #: GANTT/WRITE on the project's hub (the freeze toggle's check). Unchanged
    #: by P33 (contract Part G does not touch it).
    span_fte: float | None
    #: P40 (ADR 0054 R40-2 / R40-13, docs/API_CONTRACT_P40.md §2). The LIVE
    #: pin (`null`/`null` when none); end inclusive. While it differs from
    #: this row's run window, the pin applies on the next run.
    manual_start_week: int | None = None
    manual_end_week: int | None = None
    #: The active run placed this step on a pin (its effective window, R40-5).
    pinned: bool = False
    #: The pinned row starts before its release allows (R40-7). Warning only.
    manual_overlap: bool = False
    #: R40-2 "current length": the live pin's length, else the run row's
    #: window length (0 when skipped), else `ceil(eff / fte)` for a design
    #: step of a non-frozen project, else `eff`. Typing a Start gives
    #: `End = Start + current_length_weeks − 1`. The browser never derives it.
    current_length_weeks: int = 0
    #: The caller may set a pin on this step now (role, hub scope, R40-2).
    pin_editable: bool = False
    #: Why not, when `pin_editable` is false: `NOT_ALLOWED` (role / scope),
    #: `PROJECT_FROZEN`, `PROJECT_CLOSED`, `STEP_STARTED`, `STEP_SKIPPED`.
    pin_block_reason: (
        Literal[
            "NOT_ALLOWED", "PROJECT_FROZEN", "PROJECT_CLOSED", "STEP_STARTED", "STEP_SKIPPED"
        ]
        | None
    ) = None
    #: P40-R02: this step's own lapse. True iff the active run's row is
    #: `pinned` and its window `(planned_start_week, planned_end_week)`
    #: differs from the pin recorded for the step in that run's
    #: `workflow_snapshot.step_pins` (R40-5: placed from the run's week).
    #: False with no run row, an unpinned row or no recorded pin. The
    #: project row's `pin_lapsed` (the run outcome) can also be true for a
    #: lapsed pin whose project was left out (that step has no run row).
    pin_lapsed: bool = False
    #: P40-R02: the caller may **clear** this step's pin now, by the save
    #: endpoint's rules: Admin / Super Admin role, project in the caller's hub
    #: scope, a live step row, and the project not frozen. Independent of
    #: `pin_editable` (Clear is allowed on a started, skipped or closed step).
    pin_clearable: bool = False


class GanttProjectRow(BaseModel):
    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: CategoryCodeOut | None
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
    #: Σ of the active run's booked effective durations (`user override ??
    #: effort ?? lead time`, ADR 0019 / ADR 0041 R4) over the project's
    #: non-skipped steps of that kind —
    #: the same basis as the Capacity design/lab load (I6/I7). `total_weeks`
    #: sums every non-skipped step (design + lab + elapsed). All `null` when
    #: the project has no step in the active run.
    design_weeks: int | None
    lab_weeks: int | None
    total_weeks: int | None
    # --- P42 (ADR 0056 R42-1/R42-4/R42-6, docs/API_CONTRACT_P42.md §4) ---
    #: The band's label; null with no band.
    priority_label: str | None = None
    #: The active run's stored flags (no outcome row: true / false).
    counts_toward_year: bool = True
    not_scheduled_priority: bool = False
    #: The R42-6 exclusive bucket; null with no outcome row or none of six.
    outcome: ScheduleOutcome | None = None
    #: "Not scheduled (P4)" / "Queued — fits by W{n}" / "Queued — after W52" /
    #: "Queued — no slot"; null for a counting project.
    outcome_label: str | None = None
    #: P40 (R40-5 / R40-7): from the active run's outcome. `pin_lapsed`: some
    #: pin's start had passed and the step was placed from the run's week;
    #: `manual_overlap`: OR of the steps' flag. Warnings only.
    pin_lapsed: bool = False
    manual_overlap: bool = False
    steps: list[GanttStepRow]
    #: P53 (R53-9): scheduled and finishing after Y0 + 1 ("Finishes {year} —
    #: check leader load"). A warning only (I63).
    far_finish: bool = False


class GanttWeeklyActiveCount(BaseModel):
    """P13-T13: active steps in one display week (W1–W52, ADR 0024) over the
    whole filtered set, not just the returned page. A step is active in week
    `w` when it is not skipped and `start_week <= w <= end_week` in the
    active run (the bar the Gantt draws). Split by the project's workflow.
    """

    week: int
    pdd: int
    oem: int
    #: P40-T01 (docs/API_CONTRACT_P40.md §3): the same active steps per step
    #: code (e.g. `"PDD-A"`), codes with a zero count omitted. Sums to
    #: `pdd + oem`.
    by_step: dict[str, int] = Field(default_factory=dict)


class GanttResponse(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    total_count: int
    rows: list[GanttProjectRow]
    #: P13-T13: one entry per week 1..52 while an active run exists; `[]`
    #: without one.
    weekly_active_counts: list[GanttWeeklyActiveCount]
    #: P40-T01 (docs/API_CONTRACT_P40.md §3): projects of the whole filtered
    #: set with an active (non-skipped) run step covering the current week,
    #: per step code. A project in two steps that week counts once in each.
    #: `{}` without an active run.
    current_step_counts: dict[str, int] = Field(default_factory=dict)
    #: The plan week `current_step_counts` was taken at (`plan_clock`).
    current_week: int | None = None
    #: P53 (R53-6, API_CONTRACT_P53 §7): the run's plan-year window and the
    #: Timeline axis end (largest non-skipped end week, never below the plan
    #: year end, rounded up to a year end). Null without an active run.
    plan_year_start_week: int | None = None
    plan_year_end_week: int | None = None
    last_finish_week: int | None = None


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
    #: P47 (ADR 0059): `{"frozen": <bool>, "actual_start_week": <int|null>}` as
    #: the user read them; only the fields this request changes are checked.
    base: EditBase = Field(default_factory=dict)
