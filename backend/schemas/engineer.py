"""Pydantic request/response models for the Capacity Planning surface's
Engineer CRUD (`docs/PROJECT_AND_STACK.md` §2: "Configure engineers (FTE,
`allowed_categories`) ... per hub").
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any

from pydantic import BaseModel, ConfigDict, Field, Strict, field_validator
from pydantic_core import PydanticCustomError

from models.enums import EngineerAllowedCategory
from schemas.capacity import YearRemaining

#: P19-R01 (S19-L3): the request models are strict (CLAUDE.md "Pydantic v2
#: (strict)"): `{"fte": true}` or `{"fte": "0.5"}` is a 422, not a coerced
#: 1.0 / 0.5. JSON numbers still pass (a strict float accepts a JSON integer).
#: UUID and enum values opt out of strict mode only because a strict UUID /
#: enum accepts an instance, never its JSON string (same pattern as
#: `schemas/checkin.py` and `schemas/project.py`).
_Category = Annotated[EngineerAllowedCategory, Strict(False)]

#: P19-R01 (S19-L1): the engineer columns that are NOT NULL. An explicit
#: `null` for one of them in a PATCH body is a 422 here; before, it reached
#: the DB as an IntegrityError (500) whose message carried the row (the
#: engineer's name, personal data) into the error log. `user_id` is nullable
#: (null unlinks the user) and is not listed.
NON_NULLABLE_UPDATE_FIELDS = ("name", "hub_id", "fte", "allowed_categories")


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
    allowed_categories: list[EngineerAllowedCategory]
    user_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
    # --- P19-T03 ------------------------------------------------------------
    weekdays_per_week: float
    capacity_weeks: YearRemaining
    capacity_days: YearRemaining
