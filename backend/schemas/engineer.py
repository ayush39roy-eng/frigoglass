"""Pydantic request/response models for the Capacity Planning surface's
Engineer CRUD (`docs/PROJECT_AND_STACK.md` §2: "Configure engineers (FTE,
`allowed_categories`) ... per hub").
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import EngineerAllowedCategory
from schemas.capacity import YearRemaining


class EngineerCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    hub_id: uuid.UUID
    #: `gt=0` only, no upper bound — `models/engineer.py`'s own docstring notes
    #: the reference data is 0 < fte <= 1 but is deliberately NOT DB-constrained
    #: to that range "in case a future client answer allows >1.0 (multi-role)".
    #: Mirroring that here rather than re-introducing the cap at the API layer.
    #: P20-T02 (ADR 0032, FTE gates speed; an FTE of 0 is a scheduler
    #: `data_error`): the floor is the column's smallest positive value, 0.01,
    #: because `Numeric(3, 2)` would round 0.004 to 0.00; the ceiling 9.99 is
    #: the column's physical limit (not a policy cap); NaN / infinity refused.
    fte: float = Field(default=1.0, ge=0.01, le=9.99, allow_inf_nan=False)
    allowed_categories: list[EngineerAllowedCategory] = Field(default_factory=list)
    user_id: uuid.UUID | None = None


class EngineerUpdateRequest(BaseModel):
    """All fields optional — partial update (PATCH semantics)."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    hub_id: uuid.UUID | None = None
    #: Same bounds as `EngineerCreateRequest.fte` (P20-T02).
    fte: float | None = Field(default=None, ge=0.01, le=9.99, allow_inf_nan=False)
    allowed_categories: list[EngineerAllowedCategory] | None = None
    user_id: uuid.UUID | None = None


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
