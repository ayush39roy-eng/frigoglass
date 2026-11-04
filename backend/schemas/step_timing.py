"""Gantt drag: per-project step timing (ADR 0019, docs/API_CONTRACT_P12.md §3;
ADR 0043, docs/API_CONTRACT_P32.md A3).

`PATCH /projects/{project_id}/steps/{step_id}/timing` sets a step's
`duration_override_weeks` (right-edge resize), `start_not_before_week`
(bar move) and/or `overlap_weeks` (bar moved onto the work it waits for:
parallel steps, ADR 0043). Any subset may be sent; an explicit `null` clears
that field, an absent field is left as it is. An empty body is 422.
`overlap_weeks: 0` is normalised to null (0 = no overlap).

The ranges (1..104, 1..HORIZON_WEEKS) are checked by the service, so a range
error answers 422 with the coded `VALIDATION_ERROR` envelope the contract
names; they are also published in the OpenAPI schema (`minimum`/`maximum`).
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

import domain_constants as dc
from schemas.project import RecalcStatus

#: Upper bound of `duration_override_weeks` (ADR 0019).
DURATION_OVERRIDE_MAX_WEEKS = 104

#: Upper bound of `overlap_weeks` (ADR 0043).
OVERLAP_MAX_WEEKS = 104

#: What the Gantt may do with a step bar for this caller (ADR 0019 §4):
#: `move_resize` (Not Started), `resize` (In Progress / Blocked) or `none`
#: (Done, skipped, frozen or non-schedulable project, or no GANTT write).
TimingEditable = Literal["move_resize", "resize", "none"]


class StepTimingRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    duration_override_weeks: int | None = Field(
        default=None,
        description="This project's duration for the step, 1..104. null clears it.",
        json_schema_extra={"minimum": 1, "maximum": DURATION_OVERRIDE_MAX_WEEKS},
    )
    start_not_before_week: int | None = Field(
        default=None,
        description="Earliest start week for a Not Started step, 1..78. null clears it.",
        json_schema_extra={"minimum": 1, "maximum": dc.HORIZON_WEEKS},
    )
    overlap_weeks: int | None = Field(
        default=None,
        description=(
            "Weeks this step may overlap the work it waits for (parallel steps, ADR 0043), "
            "0..104; 0 is stored as null (no overlap). null clears it. Not allowed on the "
            "workflow's first step."
        ),
        json_schema_extra={"minimum": 0, "maximum": OVERLAP_MAX_WEEKS},
    )


class StepTimingResponse(BaseModel):
    project_id: uuid.UUID
    step_id: str
    duration_override_weeks: int | None
    start_not_before_week: int | None
    #: ADR 0043: 1..104, null = no overlap (0 is never served).
    overlap_weeks: int | None
    #: `duration_override_weeks ?? effort_weeks ?? lead time` (ADR 0019 §1,
    #: ADR 0041 R4); 0 for a skipped step.
    effective_duration_weeks: int
    #: ADR 0041 R4 (docs/API_CONTRACT_P30.md §4): the derived per-project
    #: effort of the step (0..104, null = none) — what "Reset timing" falls
    #: back to — and the lead-time table value.
    effort_weeks: int | None
    lead_time_weeks: int
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None
    baseline_run_id: uuid.UUID | None
    task_id: str | None
