"""`GET/PUT /scheduling-settings` (docs/API_CONTRACT_P53.md §2, R53-2)."""

from __future__ import annotations

from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field


class SchedulingSettingsOut(BaseModel):
    #: N: the next run searches `current_week + 52 × N` weeks (1..10).
    horizon_years: int = Field(ge=1, le=10)
    #: Optimistic lock; 0 = never saved (the default 5 is in force).
    version: int = Field(ge=0)
    updated_at: datetime | None
    #: The calendar week of this response.
    current_week: int
    #: `current_week + 52 × horizon_years`.
    horizon_weeks_next_run: int


class SchedulingSettingsIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    horizon_years: int = Field(ge=1, le=10)
    version: int = Field(ge=0)
