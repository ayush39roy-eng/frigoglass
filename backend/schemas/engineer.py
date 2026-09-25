"""Pydantic request/response models for the Capacity Planning surface's
Engineer CRUD (`docs/PROJECT_AND_STACK.md` §2: "Configure engineers (FTE,
`allowed_categories`) ... per hub").
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import EngineerAllowedCategory


class EngineerCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=200)
    hub_id: uuid.UUID
    #: `gt=0` only, no upper bound — `models/engineer.py`'s own docstring notes
    #: the reference data is 0 < fte <= 1 but is deliberately NOT DB-constrained
    #: to that range "in case a future client answer allows >1.0 (multi-role)".
    #: Mirroring that here rather than re-introducing the cap at the API layer.
    fte: float = Field(default=1.0, gt=0)
    allowed_categories: list[EngineerAllowedCategory] = Field(default_factory=list)
    user_id: uuid.UUID | None = None


class EngineerUpdateRequest(BaseModel):
    """All fields optional — partial update (PATCH semantics)."""

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=200)
    hub_id: uuid.UUID | None = None
    fte: float | None = Field(default=None, gt=0)
    allowed_categories: list[EngineerAllowedCategory] | None = None
    user_id: uuid.UUID | None = None


class EngineerRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    hub_id: uuid.UUID
    fte: float
    allowed_categories: list[EngineerAllowedCategory]
    user_id: uuid.UUID | None
    created_at: datetime
    updated_at: datetime
