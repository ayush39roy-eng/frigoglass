"""`PUT /gantt/step-pins` (P40-T03b, ADR 0054 ruling R40-1 / R40-2 / R40-11;
docs/API_CONTRACT_P40.md §1).

One all-or-nothing batch of manual step pins. Each item names one step of one
project and its new pair (both null = Clear). The end is inclusive.
"""

from __future__ import annotations

import uuid
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from schemas.edit_conflict import EditBase
from schemas.project import RecalcStatus

#: Items per batch: 236 projects × 14 steps fit the Gantt's whole page in a
#: few saves; a larger body is a 422 from validation.
STEP_PINS_MAX = 500

#: R40-2 refusal codes, also served per step as `pin_block_reason`.
PinBlockReason = Literal[
    "NOT_ALLOWED", "PROJECT_FROZEN", "PROJECT_CLOSED", "STEP_STARTED", "STEP_SKIPPED"
]

StepPinErrorCode = Literal[
    "DUPLICATE_STEP",
    "PIN_INVALID",
    "PIN_OUT_OF_RANGE",
    "PROJECT_NOT_FOUND",
    "UNKNOWN_STEP",
    "PROJECT_FROZEN",
    "PROJECT_CLOSED",
    "STEP_STARTED",
    "STEP_SKIPPED",
]


class StepPinItem(BaseModel):
    """One step's new pair. Both weeks are required keys; both null clears
    the pin. A partial pair or `manual_end_week < manual_start_week` is 422
    `PIN_INVALID`; a changed pair outside `CW <= ms <= me <= 52` is 422
    `PIN_OUT_OF_RANGE`."""

    model_config = ConfigDict(extra="forbid", strict=True)

    project_id: uuid.UUID = Field(strict=False)
    step_template_id: str = Field(min_length=1, max_length=64)
    manual_start_week: int | None
    manual_end_week: int | None
    #: P47 (ADR 0059): `{"manual_start_week": <int|null>, "manual_end_week":
    #: <int|null>}` as the user read them. Optional.
    base: EditBase = Field(default_factory=dict)


class StepPinsRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    items: list[StepPinItem] = Field(min_length=1, max_length=STEP_PINS_MAX)


class StepPinError(BaseModel):
    """One element of `detail.errors` on a refused batch. `index` is the
    item's position in the request."""

    index: int
    project_id: uuid.UUID
    step_template_id: str
    code: StepPinErrorCode
    message: str


class StepPinChange(BaseModel):
    """One stored pair that changed (each has exactly one audit row)."""

    project_id: uuid.UUID
    step_template_id: str
    action: Literal["pinned", "cleared"]
    before_start_week: int | None
    before_end_week: int | None
    manual_start_week: int | None
    manual_end_week: int | None


class StepPinsResponse(BaseModel):
    """200 on success. `changes` lists every changed pair, in request order;
    items equal to the stored pair are counted in `unchanged_count` and write
    nothing. The recalc fields mirror the priority move (ADR 0015 lifecycle,
    ONE greedy run, `trigger_reason="step_pin"`): `unchanged` when nothing
    changed, `not_needed` when no schedulable project changed, `deferred`
    when a run is in flight (one coalesced follow-up), else `queued`
    (`schedule_run_id` / `task_id`; `baseline_run_id` when a run was active)
    or `dispatch_failed`. The same values are in the `X-Schedule-Recalc` /
    `X-Schedule-Run-Id` / `X-Schedule-Baseline-Run-Id` headers."""

    changes: list[StepPinChange]
    unchanged_count: int
    projects_marked_stale: list[uuid.UUID]
    current_week: int
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None
    baseline_run_id: uuid.UUID | None
    task_id: str | None


class StepPinsRefusalDetail(BaseModel):
    code: StepPinErrorCode
    message: str
    errors: list[StepPinError]


class StepPinsRefusal(BaseModel):
    """The body of a refused batch (404 / 409, and the coded 422s; a body that
    fails request validation is the standard 422). `code` = the first failing
    item's code; nothing was written."""

    detail: StepPinsRefusalDetail
    code: StepPinErrorCode
