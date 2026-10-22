"""Pydantic request/response models for the Prioritization Matrix surface
(`docs/DOMAIN_RULES.md` "Prioritization scoring"; ADR 0037 editable rubric;
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
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

from models.enums import (
    CurrencyCode,
    HardGateReason,
    HubName,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    ScoringTag,
)


class DimensionPoints(BaseModel):
    """One dimension's contribution to a project's score (ADR 0029).
    `points = score / 5 * weight`; `scaled_points = points * 100 / total_weight`."""

    points: float
    scaled_points: float


class DimensionScore(BaseModel):
    """P21-T01 (docs/API_CONTRACT_P21.md §3), P26-T01 (ADR 0037): one ACTIVE
    dimension of the rubric for a project, in `display_order`. Not financial:
    visible to every Matrix reader.

    `points = score / 5 * weight` (0 at score 0, ADR 0033), `max_points =
    weight`; both on the raw scale, so `Σ points == weighted_score` (a null
    `points` counts 0). `score` and `points` are null when the project has no
    score on this dimension (then it is in `missing_dimension_keys`) or is
    unscored.
    """

    key: str
    label: str
    pillar: str
    score: int | None
    weight: int
    points: float | None
    max_points: float


#: P26-T01 (ADR 0037): one dimension score, 0..5 (ADR 0033), or null = not
#: scored (counts 0 points; the project is then "incomplete").
DimensionScoreValue = Annotated[int, Field(ge=0, le=5, strict=True)] | None
#: Upper bound on the keys of one score map (the rubric is far smaller).
MAX_SCORE_KEYS = 200


class PriorityScoreUpdateRequest(BaseModel):
    """`PUT /priorities/{project_id}` (ADR 0037, docs/API_CONTRACT_P26.md §5).

    `scores` maps ACTIVE dimension keys (`GET /scoring-rubric`) to 0..5 or
    null. A key that is not an active dimension is a 422
    `UNKNOWN_DIMENSION_KEY`. Active keys left out keep their stored value
    (null for a new score row); inactive dimensions' historic scores are never
    touched. Replaces the 13 fixed fields of P3..P25.
    """

    model_config = ConfigDict(extra="forbid")

    scores: dict[
        Annotated[str, StringConstraints(min_length=1, max_length=64)], DimensionScoreValue
    ] = Field(max_length=MAX_SCORE_KEYS)
    hard_gates: list[HardGateReason] = Field(default_factory=list)


class PriorityScoreRead(BaseModel):
    """The stored score after a write (ADR 0037): the per-dimension list of
    the ACTIVE rubric, which of them are missing, and the cached results."""

    id: uuid.UUID
    project_id: uuid.UUID
    hard_gates: list[HardGateReason]
    weighted_score: float | None
    normalized_pct: int | None
    #: The pure score band (stored), null when no active dimension is scored.
    suggested_band: ProjectPriority | None
    dimension_scores: list[DimensionScore]
    missing_dimension_keys: list[str]
    rubric_version: int


class DimensionInfo(BaseModel):
    """One row of the served dimension table (ADR 0029, I9)."""

    key: str
    label: str
    pillar: str
    weight: int
    #: `weight * 100 / total_weight`, 2 dp.
    scaled_weight: float


class PriorityDimensionsResponse(BaseModel):
    """`GET /priorities/dimensions`: the ACTIVE dimensions of the current
    rubric in `display_order` (ADR 0037); `total_weight` = Σ their weights."""

    dimensions: list[DimensionInfo]
    total_weight: int
    rubric_version: int


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
    hard_gates: list[HardGateReason]
    weighted_score: float | None
    normalized_pct: int | None
    #: ADR 0036 (P25): the suggested band AFTER the P1 capacity fill: `"P1"` when
    #: `capacity_fill` is true, else `score_band`. Null when unscored.
    suggested_band: ProjectPriority | None
    #: ADR 0036: the pure score band (>= 70 P1, >= 55 P2, >= 40 P3, else P4).
    score_band: ProjectPriority | None
    #: ADR 0036: promoted to P1 by the hub's P1 capacity fill (show "P1 (capacity fill)").
    capacity_fill: bool
    #: ADR 0036: short reason for a promoted, stopped or zero-load-skipped
    #: candidate; null for every project the fill walk did not decide on.
    capacity_fill_reason: str | None
    #: ADR 0029: per ACTIVE dimension points keyed by key (0 for a missing
    #: score); `null` when unscored.
    dimension_points: dict[str, DimensionPoints] | None = None
    #: P26-T01 (ADR 0037): one entry per ACTIVE rubric dimension, in
    #: `display_order` (scores and points null when unscored or missing). The
    #: "out of 100" figure is `normalized_pct`. Replaces the 13 flat fields.
    dimension_scores: list[DimensionScore]
    #: ADR 0037: active dimensions this SCORED project has no score on (they
    #: count 0 points; the score is "incomplete"). Empty when complete and
    #: when unscored.
    missing_dimension_keys: list[str]
    #: ADR 0037: the rubric version the score was computed with (the current
    #: one: a rubric change recomputes every score in the same transaction).
    rubric_version: int
    #: ADR 0038 (P27): the project's Registration "project nature" tags.
    scoring_tags: list[ScoringTag]
    #: ADR 0038: dimension keys backed by those tags (show "from registration"
    #: on these `dimension_scores` entries; the score stays editable).
    tag_dimension_keys: list[str]

    is_new_model: bool
    is_rm_saving_project: bool
    #: ADR 0027: the VIP pin (`projects.is_vip`), set by `PUT /projects/{id}/vip`.
    #: Served so the Matrix can show, filter and float VIP projects (owner ask
    #: 2026-10-22).
    is_vip: bool

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
    #: ADR 0036: counts of the (capacity-fill promoted) `suggested_band`.
    suggested_band_counts: dict[str, int]
    #: ADR 0036: counts of the pure `score_band`.
    score_band_counts: dict[str, int]
    #: ADR 0036: projects promoted to P1 by the capacity fill.
    capacity_fill_count: int
    set_priority_counts: dict[str, int]


class BandShare(BaseModel):
    """P21-T01: one bucket of `PriorityDistribution.band_distribution`.
    `band` is a score band (`suggested_band`) or `"Unscored"`; `share_pct =
    count / total_projects * 100`, 2 dp (0.0 when there are no projects)."""

    band: Literal["P1", "P2", "P3", "P4", "Q", "Unscored"]
    count: int
    share_pct: float


class ScoreHistogramBucket(BaseModel):
    """P21-T01: scored projects whose `normalized_pct` is in
    `[bucket_from, bucket_to)`; the last bucket `[90, 100]` includes 100."""

    bucket_from: int
    bucket_to: int
    count: int


class PriorityDistribution(BaseModel):
    """`GET /priorities/distribution` (docs/API_CONTRACT_P21.md §4): the band
    distribution and score histogram of exactly the rows `GET /priorities`
    returns for the same filters and the caller's hub scope."""

    total_projects: int
    scored_projects: int
    #: ADR 0036: rows of this set promoted to P1 by the capacity fill. They are
    #: counted in the `"P1"` bucket of `band_distribution` (promoted band).
    capacity_fill_count: int
    band_distribution: list[BandShare]
    score_histogram: list[ScoreHistogramBucket]


class PriorityCompareItem(BaseModel):
    """One project of `GET /priorities/compare` (docs/API_CONTRACT_P21.md §5).
    Field names follow `PriorityMatrixRow`. No financial fields."""

    project_id: uuid.UUID
    project_name: str
    hub: HubName
    set_priority: ProjectPriority | None
    has_score: bool
    weighted_score: float | None
    normalized_pct: int | None
    #: ADR 0036: as on `PriorityMatrixRow` (promoted band, pure score band, flag, reason).
    suggested_band: ProjectPriority | None
    score_band: ProjectPriority | None
    capacity_fill: bool
    capacity_fill_reason: str | None
    dimension_scores: list[DimensionScore]
    #: ADR 0037: as on `PriorityMatrixRow`.
    missing_dimension_keys: list[str]
    rubric_version: int


class PriorityCompareResponse(BaseModel):
    """`GET /priorities/compare`: the projects in the order the ids were given."""

    projects: list[PriorityCompareItem]


class HubP1Fill(BaseModel):
    """ADR 0036 (docs/API_CONTRACT_P25.md §2): one hub's P1 capacity fill.
    Effort weeks (ADR 0032), 2 dp.

    - `capacity_weeks`: the hub's remaining-year design capacity, equal to
      `GET /capacity/hub-load` `design_capacity_remaining` for the hub.
    - `base_load_weeks`: Σ remaining design weeks (active run) of the hub's
      projects whose score band is P1 (normalized score >= 70).
    - `filled_load_weeks`: `base_load_weeks` + the promoted projects' weeks
      (`<= capacity_weeks` whenever `promoted_count > 0`).
    """

    #: P29 (ADR 0042): the CAPACITY hub. R&D-Greece's walk covers its own,
    #: OEM-HCK's and OEM-Seltek's projects as one set.
    hub: HubName
    capacity_weeks: float
    base_load_weeks: float
    filled_load_weeks: float
    promoted_count: int
    #: P29: the member hubs of this capacity hub in the caller's scope, by
    #: name (`["OEM-HCK", "OEM-Seltek"]` on R&D-Greece, empty elsewhere).
    members: list[HubName]
    #: P29: the `hub_id` filter's hub when it resolves to this entry.
    selected_member: HubName | None


class PriorityCapacityFill(BaseModel):
    """`GET /priorities/capacity-fill`: the P1 capacity fill of every CAPACITY
    hub with a hub in the caller's scope (narrowed by `hub_id` / `region`; an
    OEM hub selects R&D-Greece, ADR 0042), ordered by hub name."""

    has_active_schedule_run: bool
    schedule_run_version: int | None
    hubs: list[HubP1Fill]
