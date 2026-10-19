"""Pydantic request/response models for the Prioritization Matrix surface
(`docs/DOMAIN_RULES.md` "Prioritization scoring — 13 dimensions";
`docs/PROJECT_AND_STACK.md` §2).

**Out of scope here, deferred to P3-T06** (per this task's explicit scope
note): the "Apply Priorities" action itself — re-running the band assignment
across the whole portfolio, writing a new `PriorityApplicationRun` +
`PriorityApplicationResult` rows, and re-triggering scheduling. Nothing in
this module or `api/routers/priorities.py` builds or stubs that action; only
the per-project scoring-grid CRUD and read models are built here. See that
router's module docstring for the exact boundary (this PUT updates
`PriorityScore` only, never `Project.priority`).
"""

from __future__ import annotations

import uuid

from pydantic import BaseModel, ConfigDict, Field

from models.enums import (
    CurrencyCode,
    HardGateReason,
    HubName,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)


class PriorityScoreUpdateRequest(BaseModel):
    """The 13 dimension scores (1-5 each, per DOMAIN_RULES.md) plus active
    hard gates. Field order/names match `models.priority.DIMENSION_FIELD_NAMES`
    exactly.
    """

    model_config = ConfigDict(extra="forbid")

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


class PriorityScoreRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    project_id: uuid.UUID
    strategic_project: int
    new_customer: int
    new_options: int
    regulatory_compliance: int
    quality_improvements: int
    rm_savings: int
    total_rm_savings: int
    gross_margins: int
    profitability: int
    annual_volume: int
    three_year_volume: int
    new_models: int
    capex_investment: int
    hard_gates: list[HardGateReason]
    weighted_score: float | None
    normalized_pct: int | None
    suggested_band: ProjectPriority | None


class DimensionPoints(BaseModel):
    """One dimension's contribution to a project's score (ADR 0029).
    `points = score / 5 * weight`; `scaled_points = points * 100 / total_weight`."""

    points: float
    scaled_points: float


class DimensionInfo(BaseModel):
    """One row of the served dimension table (ADR 0029, I9)."""

    key: str
    label: str
    pillar: str
    weight: int
    #: `weight * 100 / total_weight`, 2 dp.
    scaled_weight: float


class PriorityDimensionsResponse(BaseModel):
    """`GET /priorities/dimensions`: the dimension table in positional order."""

    dimensions: list[DimensionInfo]
    total_weight: int


class PriorityMatrixRow(BaseModel):
    """One row of the scoring grid: project identity + score (nullable —
    a project with no `PriorityScore` row yet shows `has_score=False` and
    null score fields, per `api/routers/priorities.py`'s left-join) +
    currency-converted financial columns.

    `is_new_model` / `is_rm_saving_project` are the "split by new-models vs.
    RM-saving projects" grouping `docs/PROJECT_AND_STACK.md` §2 asks for on
    the financial columns — interpreted (DOMAIN_RULES.md is silent on the
    exact split rule) as `type == "NM"` for new-models and
    `rm_savings_keur is not None` for RM-saving projects. Flagged as a
    judgement call, not a documented rule.
    """

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    category: ProjectCategory | None
    type: ProjectType | None
    set_priority: ProjectPriority | None
    #: P13-T14 (docs/API_CONTRACT_P13.md §7).
    status: ProjectStatus
    #: OQ #8 / P3-T09: the leader's name only when the leader is the caller;
    #: `null` for every other reader. `leader_engineer_id` is always served
    #: (so the UI can tell "withheld" from "no leader").
    leader_name: str | None
    leader_engineer_id: uuid.UUID | None
    #: 1-based, by `weighted_score` descending (then name, then id), within
    #: the filtered set of `GET /priorities`. `null` when unscored, and always
    #: `null` on `GET /priorities/{id}` (no list to rank within).
    rank: int | None

    has_score: bool
    strategic_project: int | None
    new_customer: int | None
    new_options: int | None
    regulatory_compliance: int | None
    quality_improvements: int | None
    rm_savings: int | None
    total_rm_savings: int | None
    gross_margins: int | None
    profitability: int | None
    annual_volume: int | None
    three_year_volume: int | None
    new_models: int | None
    capex_investment: int | None
    hard_gates: list[HardGateReason]
    weighted_score: float | None
    normalized_pct: int | None
    suggested_band: ProjectPriority | None
    #: ADR 0029: per-dimension points keyed by dimension key; `null` when unscored.
    dimension_points: dict[str, DimensionPoints] | None = None

    is_new_model: bool
    is_rm_saving_project: bool

    #: Financial columns, converted to `currency` (the query param the grid
    #: endpoint was called with). `gross_margin_pct` is a percentage, never
    #: currency-converted.
    currency: CurrencyCode
    capex_keur: float | None
    rm_savings_keur: float | None
    tcogs_eur: float | None
    selling_price_eur: float | None
    gross_margin_pct: float | None


class PriorityPortfolioSummary(BaseModel):
    """Portfolio decision summary, per `docs/PROJECT_AND_STACK.md` §2:
    counts of scored projects per computed `suggested_band` and per the
    currently *committed* `Project.priority` ("set_priority"), plus how many
    projects are hard-gate-forced to P1 and how many have no score yet.
    """

    total_projects: int
    scored_projects: int
    unscored_projects: int
    hard_gate_forced_count: int
    suggested_band_counts: dict[str, int]
    set_priority_counts: dict[str, int]
