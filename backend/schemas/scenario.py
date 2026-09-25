"""Pydantic request/response models for `POST /scenarios/apply` and the
Versions & History read endpoints (`GET /scenarios/versions`,
`GET /scenarios/versions/{version}`), per `docs/PROJECT_AND_STACK.md` §4's
scenario-Apply contract and §2's "every ... priority application is
versioned; historical versions are browsable and comparable".

**P5-T02 scope**: `ScenarioApplyRequest` only accepts `priority_scores` —
see `models/scenario.py`'s module docstring and `models/enums.py`'s
`ScenarioEntityType` for why `PROJECT`/`ENGINEER`/`CHAMBER` diffs are not yet
accepted here (a follow-up task's job, not this one's).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import HardGateReason, ProjectPriority, ScenarioEntityType


class ScenarioPriorityScoreChange(BaseModel):
    """One project's proposed new 13-dimension score, as part of a scenario
    diff. Field shape matches `schemas.priority.PriorityScoreUpdateRequest`
    exactly (this generalises that single-row PUT to a batched, versioned,
    snapshotted Apply) plus the `project_id` needed to address it in a batch.
    """

    model_config = ConfigDict(extra="forbid")

    project_id: uuid.UUID
    strategic_project: int = Field(ge=1, le=5)
    new_customer: int = Field(ge=1, le=5)
    new_options: int = Field(ge=1, le=5)
    regulatory_compliance: int = Field(ge=1, le=5)
    quality_improvements: int = Field(ge=1, le=5)
    rm_savings: int = Field(ge=1, le=5)
    total_rm_savings: int = Field(ge=1, le=5)
    gross_margins: int = Field(ge=1, le=5)
    profitability: int = Field(ge=1, le=5)
    annual_volume: int = Field(ge=1, le=5)
    three_year_volume: int = Field(ge=1, le=5)
    new_models: int = Field(ge=1, le=5)
    capex_investment: int = Field(ge=1, le=5)
    hard_gates: list[HardGateReason] = Field(default_factory=list)


class ScenarioApplyRequest(BaseModel):
    """The scenario "diff" POSTed on Apply. Every field is optional — an
    empty `priority_scores` list is rejected (nothing to apply), enforced in
    `services.scenario_apply`, not here, so the 422/400 distinction stays
    consistent with the rest of this codebase's validation-location
    convention (Pydantic for shape, the service/router layer for
    cross-field/DB-dependent rules).
    """

    model_config = ConfigDict(extra="forbid")

    notes: str | None = None
    priority_scores: list[ScenarioPriorityScoreChange] = Field(default_factory=list)


class ScenarioApplyChangeSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    entity_type: ScenarioEntityType
    entity_id: str
    project_id: uuid.UUID | None
    hub_id: uuid.UUID | None


class ScenarioApplyChangeDetail(ScenarioApplyChangeSummary):
    """Includes the full redacted before/after snapshots — safe for
    `PRIORITY_SCORE` (no financial fields at all); see `models/scenario.py`'s
    module docstring for the redaction requirement once `PROJECT` gets a
    writer.
    """

    before_state: dict | None
    after_state: dict


class ScenarioApplyRunSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    version: int
    applied_by_user_id: uuid.UUID | None
    notes: str | None
    entity_types_touched: list[str]
    change_count: int
    created_at: datetime


class ScenarioApplyRunDetail(ScenarioApplyRunSummary):
    changes: list[ScenarioApplyChangeDetail]


class ScenarioApplyResponse(BaseModel):
    """Response for `POST /scenarios/apply`."""

    run: ScenarioApplyRunSummary
    updated_priority_scores: list[uuid.UUID] = Field(
        default_factory=list,
        description="PriorityScore.id values written by this Apply, in request order.",
    )
    suggested_bands: dict[str, ProjectPriority] = Field(
        default_factory=dict,
        description="project_id (str) -> newly computed suggested_band, one entry per "
        "priority_scores item in the request.",
    )
