"""Pydantic request/response models for the Capacity Planning surface's
Engineer CRUD (`docs/PROJECT_AND_STACK.md` §2: "Configure engineers (FTE,
`allowed_categories`) ... per hub").
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator
from pydantic_core import PydanticCustomError

from schemas.capacity import YearRemaining
from schemas.category import EligibilityCode

#: P19-R01 (S19-L3): the request models are strict (CLAUDE.md "Pydantic v2
#: (strict)"): `{"fte": true}` or `{"fte": "0.5"}` is a 422, not a coerced
#: 1.0 / 0.5. JSON numbers still pass (a strict float accepts a JSON integer).
#: UUID and enum values opt out of strict mode only because a strict UUID /
#: enum accepts an instance, never its JSON string (same pattern as
#: `schemas/checkin.py` and `schemas/project.py`).
#: P33-T07 (ADR 0047, contract B3): an eligibility value is a category code or
#: the reserved blanket `OEM`, checked against the `categories` table by the
#: router (`services.categories.check_eligibility_codes`); here, format only.
_Category = EligibilityCode

#: P19-R01 (S19-L1): the engineer columns that are NOT NULL. An explicit
#: `null` for one of them in a PATCH body is a 422 here; before, it reached
#: the DB as an IntegrityError (500) whose message carried the row (the
#: engineer's name, personal data) into the error log. `user_id` is nullable
#: (null unlinks the user) and is not listed.
NON_NULLABLE_UPDATE_FIELDS = (
    "name",
    "hub_id",
    "fte",
    "allowed_categories",
    "counts_in_capacity",
)


def reject_explicit_null(value: Any) -> Any:
    """Field validator body for PATCH models: absent means "unchanged", an
    explicit `null` for a NOT NULL column is a client error. Runs only on
    fields the client sent (Pydantic does not validate defaults)."""

    if value is None:
        raise PydanticCustomError("null_not_allowed", "This field cannot be null.")
    return value


class EngineerCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: str = Field(min_length=1, max_length=200)
    hub_id: uuid.UUID = Field(strict=False)
    #: `gt=0` only, no upper bound — `models/engineer.py`'s own docstring notes
    #: the reference data is 0 < fte <= 1 but is deliberately NOT DB-constrained
    #: to that range "in case a future client answer allows >1.0 (multi-role)".
    #: Mirroring that here rather than re-introducing the cap at the API layer.
    #: P20-T02 (ADR 0032, FTE gates speed; an FTE of 0 is a scheduler
    #: `data_error`): the floor is the column's smallest positive value, 0.01,
    #: because `Numeric(3, 2)` would round 0.004 to 0.00; the ceiling 9.99 is
    #: the column's physical limit (not a policy cap); NaN / infinity refused.
    fte: float = Field(default=1.0, ge=0.01, le=9.99, allow_inf_nan=False)
    allowed_categories: list[_Category] = Field(default_factory=list)
    user_id: uuid.UUID | None = Field(default=None, strict=False)
    #: P29 (ADR 0042 §5): part of the hub's design supply. Only Admin /
    #: Super Admin may set it to false (403 `COUNTS_IN_CAPACITY_ADMIN_ONLY`).
    counts_in_capacity: bool = True


class EngineerUpdateRequest(BaseModel):
    """All fields optional — partial update (PATCH semantics). An omitted
    field is unchanged; an explicit `null` is accepted only for `user_id`
    (P19-R01, S19-L1). Strict like the create model (S19-L3)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    name: str | None = Field(default=None, min_length=1, max_length=200)
    hub_id: uuid.UUID | None = Field(default=None, strict=False)
    #: Same bounds as `EngineerCreateRequest.fte` (P20-T02).
    fte: float | None = Field(default=None, ge=0.01, le=9.99, allow_inf_nan=False)
    allowed_categories: list[_Category] | None = None
    user_id: uuid.UUID | None = Field(default=None, strict=False)
    #: P29 (ADR 0042 §5): Admin / Super Admin only (403
    #: `COUNTS_IN_CAPACITY_ADMIN_ONLY` for anyone else, even unchanged).
    counts_in_capacity: bool | None = None

    @field_validator(*NON_NULLABLE_UPDATE_FIELDS, mode="before")
    @classmethod
    def _no_explicit_null(cls, value: Any) -> Any:
        return reject_explicit_null(value)


class EngineerRead(BaseModel):
    """P19-T03 (docs/API_CONTRACT_P19.md §2) adds the engineer's ADR 0008
    supply: `capacity_weeks.year = working_weeks_per_engineer(hub) × fte`,
    `.remaining = remaining working weeks(hub) × fte`; `capacity_days` = the
    served weeks × the hub's `weekdays_per_week`. All 2 dp.
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    hub_id: uuid.UUID
    fte: float
    allowed_categories: list[str]
    user_id: uuid.UUID | None
    #: P29 (ADR 0042 §5): false = "not in capacity roster" (booked by the
    #: scheduler, never counted as hub supply). The engineer's own
    #: `capacity_weeks` below is still served.
    counts_in_capacity: bool
    created_at: datetime
    updated_at: datetime
    # --- P19-T03 ------------------------------------------------------------
    weekdays_per_week: float
    capacity_weeks: YearRemaining
    capacity_days: YearRemaining
    # --- P38 (docs/API_CONTRACT_P38.md §1) -----------------------------------
    #: False once deactivated. `deactivated_by_user_id` is never served.
    active: bool = True
    deactivated_at: datetime | None = None
    #: Calendar week of the deactivation (it counts as worked), 1..52.
    deactivated_week: int | None = None
    #: The served `plan_year`, not the ISO year.
    deactivated_plan_year: int | None = None
    deactivation_reason: DeactivationReason | None = None


# --- P38: deactivation (docs/API_CONTRACT_P38.md §2) --------------------------------

#: The four fixed codes (OQ #97: never free text). Mirrors
#: `models.engineer.DEACTIVATION_REASONS` and the DB CHECK.
DeactivationReason = Literal["left_company", "changed_role", "long_absence", "other"]

#: `GET /engineers?status=` (default `active`); anything else is a 422.
EngineerStatusFilter = Literal["active", "inactive", "all"]


class DeactivationEngineer(BaseModel):
    id: uuid.UUID
    name: str
    #: The engineer's (capacity) hub name, e.g. "R&D-Greece".
    hub: str
    active: bool


class DeactivationCandidate(BaseModel):
    """An eligible active engineer of the project's capacity hub (R38-3)."""

    engineer_id: uuid.UUID
    name: str
    fte: float
    #: Remaining run-booked design load (effort weeks after the calendar
    #: week) in the active run, 2 dp.
    load_weeks: float


class DeactivationOpenProject(BaseModel):
    project_id: uuid.UUID
    name: str
    hub: str
    status: str
    priority: str | None
    category: str | None
    schedulable: bool
    frozen: bool
    progress_tracked: bool
    done_stages: int
    in_flight_lab: bool
    candidates: list[DeactivationCandidate]


class BeforeAfter(BaseModel):
    before: float
    after: float


class DeactivationSupplyEffect(BaseModel):
    capacity_hub: str
    yearly_design_capacity: BeforeAfter
    remaining_design_capacity: BeforeAfter


class DeactivationPreview(BaseModel):
    engineer: DeactivationEngineer
    deactivation_week: int
    has_linked_login: bool
    open_projects: list[DeactivationOpenProject]
    #: Present only when the engineer counts in capacity (null otherwise).
    supply_effect: DeactivationSupplyEffect | None = None
    led_projects_token: str


class DeactivationReassignment(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    project_id: uuid.UUID = Field(strict=False)
    #: `null` = leave the project with no leader ("Deactivate anyway").
    leader_engineer_id: uuid.UUID | None = Field(strict=False)


class DeactivateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    reason: DeactivationReason
    led_projects_token: str = Field(min_length=1, max_length=128)
    #: Exactly the open-project set found under lock (409 otherwise). The
    #: largest roster lead is far below the cap.
    reassignments: list[DeactivationReassignment] = Field(max_length=2000)

    @field_validator("reassignments")
    @classmethod
    def _unique_projects(
        cls, value: list[DeactivationReassignment]
    ) -> list[DeactivationReassignment]:
        seen: set[uuid.UUID] = set()
        for row in value:
            if row.project_id in seen:
                raise PydanticCustomError("duplicate_project", "A project appears more than once.")
            seen.add(row.project_id)
        return value


class DeactivationWarning(BaseModel):
    project_id: uuid.UUID
    #: `CAT_NOT_ALLOWED` (the new leader's categories exclude the project's)
    #: or `NOT_IN_CAPACITY_HUB` (the new leader is outside the project's
    #: capacity hub). Accepted, as a leader PATCH would be.
    code: Literal["CAT_NOT_ALLOWED", "NOT_IN_CAPACITY_HUB"]


DeactivationRunStatus = Literal["queued", "deferred", "not_needed", "dispatch_failed"]


class DeactivationRun(BaseModel):
    #: `dispatch_failed` only when the broker refused the task: the
    #: deactivation is saved and the projects stay stale (ADR 0023 / P14-T01).
    status: DeactivationRunStatus
    run_id: uuid.UUID | None = None


class DeactivateResponse(BaseModel):
    engineer: EngineerRead
    reassigned: int
    left_without_leader: int
    left_without_leader_project_ids: list[uuid.UUID]
    warnings: list[DeactivationWarning]
    run: DeactivationRun
