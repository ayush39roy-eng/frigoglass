"""Workflow Settings (docs/API_CONTRACT_P9.md §3; ADRs 0007, 0008, 0009).

`GET /workflow-settings` returns `WorkflowSettings`, and so does every
successful `PUT`. The derived figures (`working_weeks_per_engineer`,
`working_weeks_per_chamber`, `efficient_lab_weeks`) are computed by
`services.capacity_supply`, the same code the Capacity surface uses (I17).
They are read-only here.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from models.enums import HubName, LabRegion, WorkflowStepKind
from schemas.category import CategoryCodeOut
from schemas.edit_conflict import EditBase

#: `scheduling.template_timeline` flags (contract P33 C2).
TemplateFlag = Literal["same_leader_serialised", "anchor_clamped", "gap_ignored_zero_length"]


class WorkflowStepSetting(BaseModel):
    step_id: str
    code: str
    name: str
    kind: WorkflowStepKind
    sequence_order: int
    predecessor_ids: list[str]


class WorkflowSetting(BaseModel):
    id: str
    name: str
    steps: list[WorkflowStepSetting]


class LeadTimeSetting(BaseModel):
    """One category-template row (`workflow_lead_times`). Read-only since
    P33-T10: `PUT /workflow-settings/lead-times` answers 410 and the template
    is edited through `POST /workflow-templates/apply` (contract P33 Part G).
    """

    workflow_id: str
    #: P33-T07: a `categories.code` of `workflow_id`.
    category: CategoryCodeOut
    step_id: str
    #: The category length, 0..104.
    weeks: int
    #: P33-T09 (contract C1): the signed template gap, -104..104 (negative =
    #: overlap, positive = wait; 0 on a workflow's first step).
    gap_weeks: int
    #: P33-T09 (contract C1): the immutable R2 split weight. Read-only: it is
    #: never accepted in any request.
    effort_weight_weeks: int


class CategorySetting(BaseModel):
    """P33-T09 (contract C1): one category of the `categories` table (the B1
    object) with its `template_version` (ADR 0045 §6, the apply's optimistic
    lock)."""

    code: CategoryCodeOut
    label: str
    workflow_id: str
    rank: int
    template_version: int


class HubCalendarSetting(BaseModel):
    hub_id: uuid.UUID
    hub: HubName
    weekdays_per_week: int
    national_holiday_days: float
    medical_leave_days: float
    casual_leave_days: float
    annual_leave_days: float
    weeks_in_year: int
    #: Derived (ADR 0008), 2 dp.
    working_weeks_per_engineer: float


class ChamberSetting(BaseModel):
    chamber_id: uuid.UUID
    code: str
    lab_region: LabRegion
    platforms: int
    efficiency: float
    maintenance_weeks: float
    breakdown_weeks: float
    calibration_weeks: float
    #: Derived (ADR 0008), 2 dp.
    working_weeks_per_chamber: float
    efficient_lab_weeks: float


class WorkflowSettings(BaseModel):
    workflows: list[WorkflowSetting]
    lead_times: list[LeadTimeSetting]
    #: P33-T09 (contract C1): every category in rank order, with its
    #: `template_version`. Empty in the scoped chamber-PUT payload.
    categories: list[CategorySetting]
    hub_calendars: list[HubCalendarSetting]
    chambers: list[ChamberSetting]
    current_week: int
    horizon_weeks: int
    within_year_week: int
    #: The time of the latest Workflow Settings audit row. Falls back to the
    #: newest template / calendar / chamber `updated_at` when there is none.
    updated_at: datetime
    #: Full name of the actor on that audit row. Account-admin data shown
    #: only to Admin / Super Admin (ADR 0010), not engineer data (OQ#8).
    updated_by: str | None


class StepPrecedenceUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    step_id: str = Field(min_length=1, max_length=10)
    kind: WorkflowStepKind
    predecessor_ids: list[str] = Field(max_length=14)
    #: P47 (ADR 0059): this step's `{"kind", "predecessor_ids"}` as the user
    #: read them. Optional; a step whose submitted values equal the stored
    #: ones is never checked.
    base: EditBase = Field(default_factory=dict)


class StepsUpdateRequest(BaseModel):
    """All 14 steps of one workflow."""

    model_config = ConfigDict(extra="forbid")

    #: Bounded loosely; the exact "all 14, each once" rule is the router's
    #: `BAD_STEP_SET` check, so a wrong count gets that code.
    steps: list[StepPrecedenceUpdate] = Field(min_length=1, max_length=28)


class HubCalendarUpdateRequest(BaseModel):
    """The five editable calendar fields. `weeks_in_year` stays 52."""

    model_config = ConfigDict(extra="forbid")

    weekdays_per_week: int = Field(ge=1, le=7)
    national_holiday_days: float = Field(ge=0, le=366)
    medical_leave_days: float = Field(ge=0, le=366)
    casual_leave_days: float = Field(ge=0, le=366)
    annual_leave_days: float = Field(ge=0, le=366)
    #: P47 (ADR 0059): the five fields as the user read them. Optional.
    base: EditBase = Field(default_factory=dict)


class ChamberSettingUpdateRequest(BaseModel):
    """Any subset. When `platforms` changes, `max_concurrent` is set to the
    same value, because DOMAIN_RULES "Booking rules" define
    `max_concurrent (= platform count)`.
    """

    model_config = ConfigDict(extra="forbid")

    platforms: int | None = Field(default=None, gt=0, le=100)
    efficiency: float | None = Field(default=None, gt=0, le=1)
    maintenance_weeks: float | None = Field(default=None, ge=0, le=52)
    breakdown_weeks: float | None = Field(default=None, ge=0, le=52)
    calibration_weeks: float | None = Field(default=None, ge=0, le=52)
    #: P47 (ADR 0059): the values the user started from, per changed field.
    base: EditBase = Field(default_factory=dict)


# --- P13-T16: previews (docs/API_CONTRACT_P13.md §5) ---------------------------


class TimelineStep(BaseModel):
    """One step of a category timeline. Weeks are 0-based offsets from the
    project's start (end-exclusive: the step occupies
    `[start_week, start_week + duration_weeks)`). `duration_weeks == 0` means
    the step is skipped for that category."""

    #: The step id, e.g. `PDD-E` (the same "step code" as the P13 register).
    code: str
    name: str
    resource_kind: WorkflowStepKind
    start_week: int
    duration_weeks: int
    #: P33-T09 (contract C2): the template's signed gap (requested) and the
    #: gap the walk actually produced (`start_week - release`; 0 on a skipped
    #: step). Both from `scheduling.template_timeline`.
    gap_weeks: int
    effective_gap_weeks: int
    #: Subset of `same_leader_serialised`, `anchor_clamped`,
    #: `gap_ignored_zero_length`, in that order.
    flags: list[TemplateFlag]
    #: The DAG in force.
    predecessor_ids: list[str]


class CategoryTimeline(BaseModel):
    """`GET /workflow-settings/category-timelines`: earliest start per step
    from the served template (lengths and signed gaps) and precedence DAG, no
    capacity, FTE 1.0 and the one-leader rule (`scheduling.template_timeline`,
    contract P33 C2/F3)."""

    category: CategoryCodeOut
    #: P33-T09 (contract C2): the category's label, workflow, rank and
    #: template version (the apply's `base_version`).
    label: str
    workflow_id: str
    rank: int
    template_version: int
    #: Always shown with a template timeline (DOMAIN_RULES §D).
    note: str
    #: The critical path (longest path through the DAG), in weeks.
    total_weeks: int
    #: Σ duration over design steps; Σ duration over lab steps.
    design_weeks: int
    lab_weeks: int
    #: In the workflow's display (`sequence_order`) order.
    steps: list[TimelineStep]


class BEquivalentRow(BaseModel):
    """`GET /workflow-settings/b-equivalent`: process-derived design and lab
    weeks, and their ratio to category B (PDD) or B-OEM (OEM), 2 dp. A ratio
    is null when the reference category's weeks are 0 (no ratio exists)."""

    category: CategoryCodeOut
    design_weeks: int
    lab_weeks: int
    design_ratio: float | None
    lab_ratio: float | None
