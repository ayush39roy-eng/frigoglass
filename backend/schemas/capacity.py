"""Read models for the RPD Capacity surface (`docs/PROJECT_AND_STACK.md` §2).

Load figures are sourced from the active `ScheduleRun`'s snapshot
(`ScheduleRunProjectStep`), per Invariants I6/I7 ("must reconcile with the
Capacity surface"). Since P9-T03 the *supply* figures are the client's
formulas (docs/DOMAIN_RULES.md "Capacity supply", ADR 0008), computed by
`services.capacity_supply` (I17). Per ADR 0002 they are reporting figures:
FTE and downtime still do not gate week-level booking.
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, Field

from models.enums import HubName, LabRegion, ProjectCategory


class CapacityChamberRow(BaseModel):
    """One chamber's supply inputs and derived figures (ADR 0008), 2 dp."""

    chamber_id: uuid.UUID
    code: str
    platforms: int
    efficiency: float
    working_weeks_per_chamber: float
    efficient_lab_weeks: float


class HubCapacityRow(BaseModel):
    """One hub's load vs. supply (docs/API_CONTRACT_P9.md §4, ADR 0008).

    Load (Invariants I6/I7), from the active `ScheduleRun`:
    - `design_load_weeks`: Σ design-kind step durations of this hub's projects.
    - `lab_load_weeks`: Σ lab-kind step durations × 1.0 over every project of
      this hub's *lab region*. Region-level, repeated on each hub of the region.
    - `*_estimated_weeks`: Σ the projects' hand-entered estimates
      (`Project.estimated_*_weeks`, docs/OPEN_QUESTIONS.md #12). Taken over
      schedulable projects; lab estimates only count projects with
      `certification_testing_required`, like the process-derived lab load.

    Supply (DOMAIN_RULES "Capacity supply", `services.capacity_supply`): the
    `design_*` figures are per hub and the `lab_*` figures are per region.
    `gap = load − capacity` and `completion_pct = capacity / load`, `None`
    when load is 0. Year and remaining-year variants both use the
    process-derived load. Floats are rounded to 2 dp, `remaining_fraction`
    to 4 dp.
    """

    hub: HubName
    lab_region: LabRegion
    design_load_weeks: int
    design_load_estimated_weeks: float
    lab_load_weeks: float
    lab_load_estimated_weeks: float
    engineer_fte_total: float
    working_weeks_per_engineer: float
    design_capacity_year: float
    design_capacity_remaining: float
    lab_capacity_year: float
    lab_capacity_remaining: float
    design_gap_year: float
    design_completion_pct_year: float | None
    design_gap_remaining: float
    design_completion_pct_remaining: float | None
    lab_gap_year: float
    lab_completion_pct_year: float | None
    lab_gap_remaining: float
    lab_completion_pct_remaining: float | None
    remaining_fraction: float
    chambers: list[CapacityChamberRow]
    #: Deprecated alias of `design_capacity_remaining`, kept for one release.
    design_capacity_weeks: float | None = Field(default=None, deprecated=True)
    #: Deprecated alias of `lab_capacity_remaining`, kept for one release.
    lab_capacity_units: float | None = Field(default=None, deprecated=True)
    #: Deprecated. This hub's *own* lab load (× 1.0, ADR 0007). The
    #: region-level `lab_load_weeks` supersedes it. Kept for one release.
    lab_load_units: float | None = Field(default=None, deprecated=True)


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
