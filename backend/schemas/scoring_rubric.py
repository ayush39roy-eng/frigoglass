"""Request / response models of the editable scoring rubric (ADR 0037,
P26-T01, docs/API_CONTRACT_P26.md). Requests are strict (no coercion) and
forbid extra keys."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from models.enums import HubName, ProjectPriority
from models.scoring_rubric import (
    KEY_MAX_LENGTH,
    LABEL_MAX_LENGTH,
    PILLAR_MAX_LENGTH,
    REASON_MAX_LENGTH,
    WEIGHT_MAX,
    WEIGHT_MIN,
)

#: Upper bound on the dimensions of one proposal.
MAX_DIMENSIONS = 100

_Label = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=LABEL_MAX_LENGTH)
]
_Pillar = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=PILLAR_MAX_LENGTH)
]
_Key = Annotated[
    str,
    StringConstraints(min_length=1, max_length=KEY_MAX_LENGTH, pattern=r"^[a-z][a-z0-9_]*$"),
]


class ScoringRubricDimensionInput(BaseModel):
    """One dimension of a proposed rubric. `key` = an existing dimension's
    key, or omitted / null for a NEW dimension (the server slugifies its key
    from the label). The list position is the new `display_order`."""

    model_config = ConfigDict(extra="forbid", strict=True)

    key: _Key | None = None
    label: _Label
    pillar: _Pillar
    weight: int = Field(ge=WEIGHT_MIN, le=WEIGHT_MAX)
    inverted: bool = False
    active: bool = True


class ScoringRubricPreviewRequest(BaseModel):
    """`POST /scoring-rubric/preview`: a proposed rubric (full replacement)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    dimensions: list[ScoringRubricDimensionInput] = Field(min_length=1, max_length=MAX_DIMENSIONS)


class ScoringRubricUpdateRequest(ScoringRubricPreviewRequest):
    """`PUT /scoring-rubric`: the full replacement plus the version it was
    edited from (409 `RUBRIC_VERSION_CONFLICT` when it is no longer current)
    and the reason recorded on the new version."""

    version: int = Field(ge=1)
    reason: Annotated[
        str, StringConstraints(strip_whitespace=True, min_length=1, max_length=REASON_MAX_LENGTH)
    ]


class ScoringRubricDimension(BaseModel):
    #: Null only on a preview, for a dimension that does not exist yet.
    id: uuid.UUID | None
    key: str
    label: str
    pillar: str
    weight: int
    #: `weight × 100 / total_weight`, 2 dp; null for an inactive dimension.
    scaled_weight: float | None
    inverted: bool
    active: bool
    display_order: int


class ScoringRubricRead(BaseModel):
    """`GET /scoring-rubric` and the `PUT` response: the current rubric."""

    version: int
    #: Σ weights of the ACTIVE dimensions.
    total_weight: int
    changed_at: datetime
    changed_by_user_id: uuid.UUID | None
    changed_by_name: str | None
    reason: str
    #: Every dimension, active and inactive, in `display_order`.
    dimensions: list[ScoringRubricDimension]
    #: Distinct pillar names in order of first appearance (for the picker; a
    #: new pillar is created by naming it on a dimension).
    pillars: list[str]
    #: The caller may `PUT` (Admin or Super Admin).
    can_edit: bool


class ScoringRubricVersionsResponse(BaseModel):
    """`GET /scoring-rubric/versions`: every version, newest first. Each
    entry's `dimensions` is its snapshot; `can_edit` is the caller's right
    today, not historical."""

    versions: list[ScoringRubricRead]


PreviewBand = Literal["P1", "P2", "P3", "P4", "Unscored"]


class RubricPreviewProject(BaseModel):
    project_id: uuid.UUID
    project_name: str
    hub: HubName
    old_normalized_pct: int | None
    new_normalized_pct: int | None
    old_score_band: ProjectPriority | None
    new_score_band: ProjectPriority | None
    #: After the P1 capacity fill (ADR 0036), as Matrix rows serve it.
    old_suggested_band: ProjectPriority | None
    new_suggested_band: ProjectPriority | None
    new_capacity_fill: bool
    score_band_changed: bool
    suggested_band_changed: bool
    #: Under the proposed rubric.
    missing_dimension_keys: list[str]


class RubricBandChange(BaseModel):
    from_band: PreviewBand
    to_band: PreviewBand
    count: int


class ScoringRubricPreview(BaseModel):
    """`POST /scoring-rubric/preview`: the impact of a proposed rubric,
    nothing saved. Projects are those in the caller's scope scored under the
    current or the proposed rubric, ordered by name."""

    current_version: int
    current_total_weight: int
    proposed_total_weight: int
    #: The proposed rubric as it would be saved (new keys slugified; `id`
    #: null for new dimensions).
    dimensions: list[ScoringRubricDimension]
    scored_projects: int
    score_band_change_count: int
    suggested_band_change_count: int
    #: Score band transitions (old → new), only pairs that changed.
    band_changes: list[RubricBandChange]
    projects: list[RubricPreviewProject]
