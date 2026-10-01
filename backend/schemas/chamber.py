"""Pydantic request/response models for the Capacity Planning surface's
Chamber CRUD (`docs/PROJECT_AND_STACK.md` §2: "Configure ... chambers
(`platforms`, `efficiency`, `max` concurrent, `allowed_stages`) per hub").

2026-09-27 (ADR 0008, P9-T01): `weeks_per_chamber` is retired; the yearly
downtime inputs `maintenance_weeks` / `breakdown_weeks` / `calibration_weeks`
replace it and feed the capacity-supply formula.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from models.enums import LabRegion


def _drop_retired_weeks_per_chamber(data: Any) -> Any:
    """Orchestrator decision for P9-T03 (docs/MEMORY.md P9-T03, "chamber
    request shape"): for ONE release, silently accept and ignore a
    `weeks_per_chamber` key, so the pre-P9 Capacity Planning form does not
    422 before frontend-builder removes the field (P9-T04b). ADR 0008
    retired the column; the value is never stored. Remove this hook in the
    release after P9.
    """

    if isinstance(data, dict) and "weeks_per_chamber" in data:
        data = {k: v for k, v in data.items() if k != "weeks_per_chamber"}
    return data


#: P9-F01/R04-L2: non-finite floats (`inf`/`-inf`/`NaN`) and absurd magnitudes
#: (e.g. `1e308`) must 422, not fall through to an asyncpg
#: `NumericValueOutOfRangeError` (500) or an unrenderable `NaN` in the 422
#: body. `le=104.0` bounds every yearly-downtime/efficiency field at roughly
#: 2x a year (52 weeks) — comfortably above any real value while still
#: rejecting the pathological ones the pentest sent.
_YEARLY_WEEKS_CEILING = 104.0


class ChamberCreateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def _ignore_weeks_per_chamber(cls, data: Any) -> Any:
        return _drop_retired_weeks_per_chamber(data)

    code: str = Field(min_length=1, max_length=50)
    lab_region: LabRegion
    max_concurrent: int = Field(gt=0, le=1000)
    platforms: int = Field(default=1, gt=0, le=1000)
    efficiency: float = Field(default=1.0, gt=0, le=1.0)
    # 2026-09-27 (ADR 0008): yearly downtime inputs replacing `weeks_per_chamber`.
    maintenance_weeks: float = Field(default=2.0, ge=0, le=_YEARLY_WEEKS_CEILING)
    breakdown_weeks: float = Field(default=0.0, ge=0, le=_YEARLY_WEEKS_CEILING)
    calibration_weeks: float = Field(default=1.0, ge=0, le=_YEARLY_WEEKS_CEILING)
    #: `PDD-<letter>` step IDs (lab-kind steps only). Not DB-constrained to
    #: lab-kind steps (`models/chamber.py`'s own docstring) — validated here
    #: instead, since this is exactly the "app-layer validation" it defers to.
    allowed_stages: list[str] = Field(default_factory=list)


class ChamberUpdateRequest(BaseModel):
    """All fields optional — partial update (PATCH semantics)."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)

    @model_validator(mode="before")
    @classmethod
    def _ignore_weeks_per_chamber(cls, data: Any) -> Any:
        return _drop_retired_weeks_per_chamber(data)

    code: str | None = Field(default=None, min_length=1, max_length=50)
    lab_region: LabRegion | None = None
    max_concurrent: int | None = Field(default=None, gt=0, le=1000)
    platforms: int | None = Field(default=None, gt=0, le=1000)
    efficiency: float | None = Field(default=None, gt=0, le=1.0)
    maintenance_weeks: float | None = Field(default=None, ge=0, le=_YEARLY_WEEKS_CEILING)
    breakdown_weeks: float | None = Field(default=None, ge=0, le=_YEARLY_WEEKS_CEILING)
    calibration_weeks: float | None = Field(default=None, ge=0, le=_YEARLY_WEEKS_CEILING)
    allowed_stages: list[str] | None = None


class ChamberRead(BaseModel):
    """`working_weeks_per_chamber` / `efficient_lab_weeks` are derived by
    `services.capacity_supply` (ADR 0008, 2 dp), the same figures the
    Capacity surface and Workflow Settings show (I17).
    """

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    code: str
    lab_region: LabRegion
    max_concurrent: int
    platforms: int
    efficiency: float
    maintenance_weeks: float
    breakdown_weeks: float
    calibration_weeks: float
    allowed_stages: list[str]
    working_weeks_per_chamber: float
    efficient_lab_weeks: float
    created_at: datetime
    updated_at: datetime
