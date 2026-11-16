"""HTTP shapes of P41 (ADR 0055, docs/API_CONTRACT_P41.md A, C, D).

The import format (D1) and saved import scenarios (D3). A saved scenario's
`request` / `result` are the existing `ImportSimulateRequest` /
`ImportSimulateResponse`: neither carries a customer, TCOGS, margin or price
field.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from schemas.whatif_import import ImportKpisOut, ImportSimulateRequest, ImportSimulateResponse

# --- A. import format -------------------------------------------------------------------------


class ImportFormatFieldOut(BaseModel):
    key: str
    label: str
    required: bool
    aliases: list[str]
    default_aliases: list[str]


class ImportFormatOut(BaseModel):
    #: 0 = the built-in default (no stored row yet).
    version: int
    is_default: bool
    fields: list[ImportFormatFieldOut]
    updated_at: datetime | None
    updated_by_name: str | None
    can_edit: bool


_Alias = Annotated[str, Field(max_length=200)]


class ImportFormatUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: int = Field(ge=0)
    #: field key -> aliases. A key left out keeps its current aliases. The
    #: list bound here is loose on purpose: the service answers with the
    #: contract's codes (`FORMAT_TOO_MANY_ALIASES`, `FORMAT_UNKNOWN_FIELD`).
    fields: dict[Annotated[str, Field(max_length=64)], list[_Alias]] = Field(max_length=64)


class ImportFormatResetIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    version: int = Field(ge=0)


# --- C. saved import scenarios ----------------------------------------------------------------

_Name = Annotated[str, Field(min_length=1, max_length=120)]
_Note = Annotated[str, Field(max_length=1000)]
_Sha256 = Annotated[str, Field(pattern=r"^[0-9a-f]{64}$")]


class ScenarioSaveIn(BaseModel):
    """Not strict at the top level (`imported_at` arrives as an ISO string);
    `request` is the strict `ImportSimulateRequest`."""

    model_config = ConfigDict(extra="forbid")

    name: _Name
    note: _Note | None = None
    source_file_name: str = Field(min_length=1, max_length=200)
    source_file_sha256: _Sha256
    imported_at: datetime
    request: ImportSimulateRequest


class ScenarioPatchIn(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)

    name: _Name | None = None
    #: `null` clears the note.
    note: _Note | None = None


class SavedScenarioSummary(BaseModel):
    id: uuid.UUID
    name: str
    note: str | None
    source_file_name: str
    source_file_sha256: str
    imported_at: datetime
    created_at: datetime
    created_by_name: str | None
    can_edit: bool
    mode: Literal["merge", "file_only"]
    plan_year_end_week: int
    simulated_week: int
    plan_version: int | None
    hub_codes: list[str]
    kpis: ImportKpisOut


class SavedScenarioOut(SavedScenarioSummary):
    request: ImportSimulateRequest
    result: ImportSimulateResponse


class SavedScenarioListOut(BaseModel):
    items: list[SavedScenarioSummary]


# --- D. export ------------------------------------------------------------------------------


class ScenarioExportIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: _Name | None = None
    request: ImportSimulateRequest
