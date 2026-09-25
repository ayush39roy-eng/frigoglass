"""Pydantic request/response models for the Capacity Planning surface's
Chamber CRUD (`docs/PROJECT_AND_STACK.md` §2: "Configure ... chambers
(`platforms`, `efficiency`, `weeks_per_chamber`, `max` concurrent,
`allowed_stages`) per hub").
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import LabRegion


class ChamberCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=1, max_length=50)
    lab_region: LabRegion
    max_concurrent: int = Field(gt=0)
    platforms: int = Field(default=1, gt=0)
    efficiency: float = Field(default=1.0, gt=0)
    weeks_per_chamber: float = Field(default=0.0, ge=0)
    #: `PDD-<letter>` step IDs (lab-kind steps only). Not DB-constrained to
    #: lab-kind steps (`models/chamber.py`'s own docstring) — validated here
    #: instead, since this is exactly the "app-layer validation" it defers to.
    allowed_stages: list[str] = Field(default_factory=list)


class ChamberUpdateRequest(BaseModel):
    """All fields optional — partial update (PATCH semantics)."""

    model_config = ConfigDict(extra="forbid")

    code: str | None = Field(default=None, min_length=1, max_length=50)
    lab_region: LabRegion | None = None
    max_concurrent: int | None = Field(default=None, gt=0)
    platforms: int | None = Field(default=None, gt=0)
    efficiency: float | None = Field(default=None, gt=0)
    weeks_per_chamber: float | None = Field(default=None, ge=0)
    allowed_stages: list[str] | None = None


class ChamberRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    lab_region: LabRegion
    max_concurrent: int
    platforms: int
    efficiency: float
    weeks_per_chamber: float
    allowed_stages: list[str]
    created_at: datetime
    updated_at: datetime
