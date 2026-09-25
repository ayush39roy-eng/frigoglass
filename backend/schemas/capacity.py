"""Read models for the RPD Capacity surface (`docs/PROJECT_AND_STACK.md` §2).

Load figures (`design_load_weeks`/`lab_load_units`) are sourced from the
active `ScheduleRun`'s snapshot (`ScheduleRunProjectStep`), per Invariants
I6/I7 ("must reconcile with the Capacity surface"). Capacity *supply*
figures (`design_capacity_weeks`/`lab_capacity_units`) have no
`docs/DOMAIN_RULES.md` formula to reconcile against — I6/I7 only define the
*load* side — so their formula is this task's own documented judgement call;
see `api/routers/capacity.py`'s module docstring for exactly what they mean
and why. Per ADR 0002/0003, both are reporting-only figures that do NOT
imply the scheduler itself applies FTE/efficiency scaling.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel

from models.enums import HubName, ProjectCategory


class HubCapacityRow(BaseModel):
    hub: HubName
    #: Sum of design-step durations booked to this hub's projects in the
    #: active ScheduleRun (Invariant I6).
    design_load_weeks: int
    #: Sum of `engineer.fte * remaining_weeks` for this hub's engineers
    #: (FTE-scaled reporting figure, ADR 0002). `remaining_weeks =
    #: horizon_weeks - current_week`, per the active ScheduleRun's own
    #: snapshotted horizon.
    design_capacity_weeks: float
    #: Sum of (lab-step durations × 0.5) for this hub's lab-region projects
    #: in the active ScheduleRun (Invariant I7).
    lab_load_units: float
    #: Sum of `chamber.max_concurrent * remaining_weeks * chamber.efficiency`
    #: for chambers in this hub's lab region (efficiency-scaled reporting
    #: figure, ADR 0003).
    lab_capacity_units: float


class HubCapacitySummary(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    remaining_weeks: int
    rows: list[HubCapacityRow]


class ClassBreakdownRow(BaseModel):
    category: ProjectCategory
    deliverable_count: int
    left_out_count: int


class ClassBreakdown(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    rows: list[ClassBreakdownRow]


class EngineerWeekLoad(BaseModel):
    """Per-engineer weekly load row for `GET /capacity/utilization-matrix`.

    P3-T09 (security remediation, finding #1 / OQ#8 dependency — GDPR):
    deliberately has NO `name` field. `docs/OPEN_QUESTIONS.md` #8 (whether
    per-engineer utilization is personal data requiring a GDPR lawful basis)
    is unresolved and explicitly hard-blocking (`docs/IMPLEMENTATION_PLAN.md`
    P0-T02: "provisional-proceed does not apply to it"). Named per-engineer
    utilization was served here until security-auditor's P3-T08 finding #1
    (High) — this schema now withholds the name at the API layer rather than
    relying on the frontend not rendering it (mirrors the P4-T03 UI decision,
    but enforced server-side). `engineer_id`/`hub`/`busy_weeks` are not
    personal data on their own (a UUID and an aggregate hub/week count
    reveal no identity) and remain reportable.

    This is consciously reversible: once the DPO signs off on OQ#8, re-add
    `name: str` here and in `api/routers/capacity.py`'s
    `EngineerWeekLoad(...)` construction — do not restore it before then.
    """

    engineer_id: uuid.UUID
    hub: HubName
    #: Week numbers (against the active run's horizon) this engineer is
    #: booked to a design step. Sparse list, not a full 78-length array, to
    #: keep the payload proportional to actual bookings.
    busy_weeks: list[int]


class ChamberWeekLoad(BaseModel):
    chamber_id: uuid.UUID
    code: str
    lab_region: str
    max_concurrent: int
    #: One entry per week that has >=1 project booked, `count` = number of
    #: concurrently-booked projects that week (compare against
    #: `max_concurrent` to see over/under-utilization).
    week_counts: dict[int, int]


class UtilizationMatrix(BaseModel):
    has_active_schedule_run: bool
    schedule_run_version: int | None
    engineers: list[EngineerWeekLoad]
    chambers: list[ChamberWeekLoad]
