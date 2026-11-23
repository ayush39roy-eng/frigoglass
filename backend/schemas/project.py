"""Pydantic request/response models for the Project Registration surface
(`docs/PROJECT_AND_STACK.md` §2) — full CRUD on `Project`.

Financial fields (`tcogs_eur`, `selling_price_eur`, `gross_margin_pct`,
`customer_name`) are exactly CLAUDE.md's four named encrypted fields
(`models.types.FINANCIAL_FIELD_NAMES`). They round-trip through this schema
like any other field in a normal, authenticated read/write of a project a
caller is entitled to see — "never logged" (CLAUDE.md) is about audit rows
and application logs (see `services/audit_helpers.py`), not about hiding them
from an authorized API response entirely. No RBAC exists yet to decide who is
"authorized" (P3-T02/T03) — see the router module docstring for that gap.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    computed_field,
    field_validator,
)

from models.enums import (
    PRIORITY_NOT_APPLICABLE_STATUSES,
    HubName,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    ScoringTag,
    WorkflowStepKind,
)
from models.project import canonical_tags
from schemas.category import CategoryCode, CategoryCodeOut
from schemas.edit_conflict import EditBase


def _distinct_tags(tags: list[ScoringTag]) -> list[ScoringTag]:
    if len(set(tags)) != len(tags):
        raise ValueError("each scoring tag may appear once")
    return canonical_tags(tags)


def _two_dp(value: float) -> float:
    if Decimal(str(value)) != Decimal(str(value)).quantize(Decimal("0.01")):
        raise ValueError("at most 2 decimal places")
    return value


#: ADR 0041: a per-project effort figure, stored `Numeric(6, 2)` (0..9999.99,
#: at most two decimals). A JSON number; read exactly through its decimal
#: string (`scheduling.effort_split.to_decimal`), never its binary value.
#: P30-R01 (S30-L1): strict (CLAUDE.md "Pydantic v2 (strict)"), so `"4"` and
#: `true` are a 422, not a coerced 4.0 / 1.0. A JSON integer or float still
#: passes (a strict float accepts an int), as in `schemas/engineer.py`.
EffortWeeks = Annotated[float, Field(ge=0, le=9999.99, strict=True), AfterValidator(_two_dp)]


#: ADR 0038: zero or more of the six fixed tags, no duplicates (422), served
#: and stored in canonical order.
ScoringTags = Annotated[
    list[ScoringTag], Field(max_length=len(ScoringTag)), AfterValidator(_distinct_tags)
]



def blank_external_code_to_none(value: object) -> object:
    """`projects.external_code` is UNIQUE: a blank or whitespace-only code is
    stored as NULL (no code), never as '' (two '' rows collide). Non-strings
    pass through to the normal type check."""
    if isinstance(value, str):
        stripped = value.strip()
        return stripped or None
    return value

class ProjectCreateRequest(BaseModel):
    """ADR 0034 (2026-10-21): registration creates the project `In Queue`.

    `name` and `hub_id` are schema-required (a missing one is FastAPI's
    validation 422). P56 (2026-11-19): every other field is optional;
    `services.project_hard_gates.HARD_GATE_FIELDS` is empty. A project
    created without a priority or a category is saved `In Queue` and served
    "Not scheduled — missing …" until the field is set
    (`services.schedule_readiness`). `status` is not accepted here.
    """

    #: `extra="forbid"` per `docs/PROJECT_AND_STACK.md` §3's "Pydantic v2
    #: (strict mode)" — an unknown field (e.g. a typo, or an attempt to set
    #: `frozen`/`status` directly) is a 422, not a silently-ignored no-op.
    model_config = ConfigDict(extra="forbid")

    name: str = Field(min_length=1, max_length=300)
    external_code: str | None = Field(default=None, max_length=100)

    @field_validator("external_code", mode="before")
    @classmethod
    def _normalise_external_code(cls, value: object) -> object:
        return blank_external_code_to_none(value)
    hub_id: uuid.UUID
    leader_engineer_id: uuid.UUID | None = None
    #: P33-T07 (ADR 0047): a `categories.code`; existence and the hub's
    #: workflow are checked against the table by the router (contract B3).
    category: CategoryCode | None = None
    type: ProjectType | None = None
    priority: ProjectPriority | None = None
    actual_start_week: int | None = Field(default=None, ge=1)
    delay_weeks: int = Field(default=0, ge=0)
    reg_year: int | None = None
    carry_over: bool = False
    comments: str | None = None
    customer_name: str | None = None
    tcogs_eur: float | None = Field(default=None, ge=0)
    selling_price_eur: float | None = Field(default=None, ge=0)
    gross_margin_pct: float | None = None
    capex_keur: float | None = Field(default=None, ge=0)
    rm_savings_keur: float | None = Field(default=None, ge=0)
    # --- P9 (docs/API_CONTRACT_P9.md §6) ---------------------------------
    #: Charter "Project End Date - LATEST" as a week number (DOMAIN_RULES
    #: "Expected vs projected completion").
    #: P53 (R53-8): `1 <= t <= current_week + 520`, the upper bound checked by
    #: the router (`TARGET_END_OUT_OF_RANGE`); 5200 is the schema sanity cap.
    target_end_week: int | None = Field(default=None, ge=1, le=5200)
    #: When false, every lab-kind step is skipped (ADR 0007).
    certification_testing_required: bool = True
    #: Capacity "Estimated" column only; never a schedule input (OQ #12).
    estimated_design_weeks: float | None = Field(default=None, ge=0, le=9999.99)
    estimated_lab_weeks: float | None = Field(default=None, ge=0, le=9999.99)
    #: ADR 0041 (docs/API_CONTRACT_P30.md §2): the client's per-project design
    #: / lab effort in man-weeks (2 dp). When > 0 it drives the schedule and
    #: the load (split over the steps); blank or 0 = the lead-time table.
    design_effort_weeks: EffortWeeks | None = None
    lab_effort_weeks: EffortWeeks | None = None
    #: ADR 0038 (docs/API_CONTRACT_P27.md §2): "project nature" tags; each
    #: pre-fills its mapped dimension score with 5.
    scoring_tags: ScoringTags = Field(default_factory=list)


class ProjectUpdateRequest(BaseModel):
    """Partial update (PATCH semantics) — every field optional.

    Deliberately excludes `frozen` — the freeze toggle is a dedicated action
    on the Gantt surface (`POST /gantt/projects/{id}/freeze`,
    `api/routers/gantt.py`) with its own audit action name, per
    `docs/PROJECT_AND_STACK.md` §2's "A freeze toggle per project."

    `status` may be changed here EXCEPT to leave `Draft` — that transition
    must go through `POST /projects/{id}/submit`, which runs the hard-gate
    check. Attempting to set `status` away from `Draft` via this endpoint
    raises 400. ADR 0034: `status: "Draft"` is a 422 `DRAFT_RETIRED`.
    """

    model_config = ConfigDict(extra="forbid")

    name: str | None = Field(default=None, min_length=1, max_length=300)
    external_code: str | None = Field(default=None, max_length=100)

    @field_validator("external_code", mode="before")
    @classmethod
    def _normalise_external_code(cls, value: object) -> object:
        return blank_external_code_to_none(value)
    hub_id: uuid.UUID | None = None
    leader_engineer_id: uuid.UUID | None = None
    #: P33-T07 (ADR 0047): a `categories.code`; existence and the hub's
    #: workflow are checked against the table by the router (contract B3).
    category: CategoryCode | None = None
    type: ProjectType | None = None
    priority: ProjectPriority | None = None
    status: ProjectStatus | None = None
    actual_start_week: int | None = Field(default=None, ge=1)
    #: P35 (D35-3): `null` clears it. Checked against the effective
    #: `actual_start_week` after the patch: end < start is a 422
    #: `ACTUAL_END_BEFORE_START`. Not a scheduler input.
    actual_end_week: int | None = Field(default=None, ge=1)
    delay_weeks: int | None = Field(default=None, ge=0)
    reg_year: int | None = None
    carry_over: bool | None = None
    comments: str | None = None
    customer_name: str | None = None
    tcogs_eur: float | None = Field(default=None, ge=0)
    selling_price_eur: float | None = Field(default=None, ge=0)
    gross_margin_pct: float | None = None
    capex_keur: float | None = Field(default=None, ge=0)
    rm_savings_keur: float | None = Field(default=None, ge=0)
    #: P53 (R53-8): `1 <= t <= current_week + 520`, the upper bound checked by
    #: the router (`TARGET_END_OUT_OF_RANGE`); 5200 is the schema sanity cap.
    target_end_week: int | None = Field(default=None, ge=1, le=5200)
    certification_testing_required: bool | None = None
    estimated_design_weeks: float | None = Field(default=None, ge=0, le=9999.99)
    estimated_lab_weeks: float | None = Field(default=None, ge=0, le=9999.99)
    #: ADR 0041: `null` clears the figure (the lead-time table applies again).
    #: A change re-derives the step effort split (ADR 0041 R6) and marks the
    #: project `schedule_stale`; never solves.
    design_effort_weeks: EffortWeeks | None = None
    lab_effort_weeks: EffortWeeks | None = None
    #: ADR 0038: the FULL new tag set (replaces it; `null` is a 422
    #: `NULL_NOT_ALLOWED`). Only a not-set -> set tag pre-fills a score.
    scoring_tags: ScoringTags | None = None
    #: P47 (ADR 0059): the values the user started from, per changed field
    #: (`{"status": "In Queue", ...}`). Optional; see `schemas.edit_conflict`.
    base: EditBase = Field(default_factory=dict)
    #: ADR 0069 (manual recalculation mode): `true` saves, audits and marks
    #: the changed projects `schedule_stale` as usual but dispatches NO run
    #: (`recalc_status: "deferred"`). Default `false`: unchanged behaviour.
    defer_recalc: bool = Field(default=False, strict=True)


class ProjectRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    external_code: str | None
    hub_id: uuid.UUID
    leader_engineer_id: uuid.UUID | None
    #: P29 (ADR 0042 §7): the leader was assigned provisionally by the seed /
    #: migration (least-loaded eligible engineer of the capacity hub), not by a
    #: person. Cleared when a PATCH changes `leader_engineer_id`.
    leader_is_provisional: bool
    category: CategoryCodeOut | None
    type: ProjectType | None
    #: The STORED priority (ADR 0067: kept, and round-tripped by edit forms,
    #: even when `priority_applicable` is false).
    priority: ProjectPriority | None
    status: ProjectStatus
    frozen: bool
    actual_start_week: int | None
    #: P35 (D35-3): the week the project actually finished; null = not set.
    actual_end_week: int | None
    delay_weeks: int
    reg_year: int | None
    carry_over: bool
    comments: str | None
    customer_name: str | None
    tcogs_eur: float | None
    selling_price_eur: float | None
    gross_margin_pct: float | None
    capex_keur: float | None
    rm_savings_keur: float | None
    target_end_week: int | None
    certification_testing_required: bool
    estimated_design_weeks: float | None
    estimated_lab_weeks: float | None
    # --- ADR 0041 (docs/API_CONTRACT_P30.md §2) ----------------------------
    #: The client's per-project effort figures (man-weeks, 2 dp). Writable on
    #: create / PATCH; not financial.
    design_effort_weeks: float | None
    lab_effort_weeks: float | None
    #: Display only (client workbook cols 22, 17, 23, 24, 3); read-only.
    safety_lab_weeks: float | None
    actual_design_weeks: float | None
    actual_testing_weeks: float | None
    safety_certification_required: bool
    capacity_flag: bool
    #: ADR 0035: the client workbook's charter fields, as written (read-only).
    plant: str | None
    requesting_department: str | None
    product_type: str | None
    #: ADR 0038: Registration "project nature" tags, canonical order.
    scoring_tags: Annotated[list[ScoringTag], AfterValidator(canonical_tags)]
    #: ADR 0038: the rubric dimension keys those tags map to (the scores the
    #: UI marks "from registration"), canonical tag order.
    tag_dimension_keys: list[str]
    #: Progress or settings changed since the active run (ADR 0006).
    schedule_stale: bool
    #: "PDD" | "OEM", a function of the hub (ADR 0007).
    workflow_id: Literal["PDD", "OEM"]
    created_at: datetime
    updated_at: datetime
    # --- P54 (ADR 0064 R1) -------------------------------------------------
    #: Read-only. The position in the FULL priority band (dense 1..n, all
    #: hubs), the same value as the Priority board card's `band_rank`; null
    #: when the project is not a band member. Changed only through
    #: `POST /projects/{id}/band-rank[/preview]` (ADR 0050); never accepted on
    #: create / PATCH / register edits (`extra="forbid"`, 422).
    band_rank: int | None = None
    #: Read-only. The number of ranked projects in that band (the `n` of
    #: `band_rank`, all hubs); null exactly when `band_rank` is null. Filled
    #: by `services.band_rank.with_band_size` (one grouped count per request).
    band_size: int | None = None
    # --- P60 (ADR 0068): hub rank, derived, never stored ------------------
    #: Read-only. The 1-based position among the projects of the SAME hub in
    #: the same band, in `band_rank` order; null exactly when `band_rank` is
    #: null. Over the full band, never hub-scoped (a Hub Planner sees the same
    #: value). Set through `POST /projects/{id}/band-rank` with `hub_rank`.
    hub_rank: int | None = None
    #: Read-only. The number of that hub's ranked projects in the band (the
    #: `n` of `hub_rank`); null exactly when `band_rank` is null.
    hub_band_size: int | None = None

    @computed_field  # type: ignore[prop-decorator]
    @property
    def priority_applicable(self) -> bool:
        """ADR 0067: false for a Commercialized / Cancelled project; its
        priority shows "Not applicable" and cannot be changed."""

        return self.status not in PRIORITY_NOT_APPLICABLE_STATUSES


class ProjectListItem(ProjectRead):
    """Same shape as `ProjectRead` for now — kept as a distinct name so a
    future lighter-weight list projection (e.g. dropping financial fields for
    a non-financially-scoped role, per P3-T03) can diverge from the detail
    view without a breaking rename.
    """


class HardGateStatus(BaseModel):
    """Response for `GET /projects/{id}/hard-gate-status` — lets the frontend
    show which fields are still missing before a Draft project can be
    submitted, without guessing at the submit endpoint's validation rules.
    ADR 0034: only legacy Draft rows still need it.
    """

    can_leave_draft: bool
    missing_fields: list[str]


class ProjectSubmitRequest(BaseModel):
    """Body for `POST /projects/{id}/submit`. `target_status` defaults to
    `In Queue` — the natural first non-Draft state for a newly registered
    project (lowest scheduling-order ordinal, per `docs/DOMAIN_RULES.md`
    "Scheduling order") — but may be set explicitly to any of the four
    schedulable statuses if the caller already knows the project belongs
    further along (e.g. data migration from the spreadsheet process, P7).
    Setting it to `Draft`/`Commercialized`/`On Hold` is rejected (400) — this
    endpoint's entire purpose is leaving Draft, not re-entering it or
    jumping straight to a terminal status. `Cancelled` (P9) is rejected the
    same way.
    """

    model_config = ConfigDict(extra="forbid")

    target_status: ProjectStatus = ProjectStatus.IN_QUEUE


#: ADR 0015: what a priority move did to the schedule.
#: - `queued`: a greedy run was dispatched (follow it on the SSE stream);
#: - `deferred`: another run was queued or running; the project stays stale;
#: - `not_needed`: the project's status is not schedulable;
#: - `unchanged`: the requested priority equals the current one; nothing written.
#: P14 (ADR 0026): `applied` = a confirm with a current `preview_token`; the
#: greedy run was computed in-process and is already active.
#: P14-T01 (M3): `dispatch_failed` = the change is saved and the project stays
#: stale, but the broker refused the run (row FAILED, `DISPATCH_FAILED`).
RecalcStatus = Literal[
    "queued", "deferred", "not_needed", "unchanged", "applied", "dispatch_failed"
]


class PriorityMoveRequest(BaseModel):
    """Body for `POST /projects/{id}/priority` (docs/API_CONTRACT_P11.md §1).

    Strict, unknown keys rejected. `priority` alone opts out of strict mode
    because a strict enum field only accepts an enum *instance*, never its
    JSON string. Lax enum validation still accepts only the five values
    (P1–P4, Q); `null`, numbers and other strings are a 422.
    """

    model_config = ConfigDict(extra="forbid", strict=True)

    priority: ProjectPriority = Field(strict=False)
    #: P14 (ADR 0026 §2): from `POST /projects/{id}/priority/preview`. With
    #: a current token the move is applied in-process (`applied`); a stale
    #: one is 409 `PREVIEW_STALE`. Absent: ADR 0015 behaviour, unchanged.
    preview_token: str | None = Field(default=None, min_length=16, max_length=128)
    #: P47 (ADR 0059): `{"priority": <the priority the user started from>}`.
    base: EditBase = Field(default_factory=dict)
    #: ADR 0069 (manual recalculation mode): `true` saves, audits and marks
    #: the changed projects `schedule_stale` as usual but dispatches NO run
    #: (`recalc_status: "deferred"`). Default `false`: unchanged behaviour.
    defer_recalc: bool = Field(default=False, strict=True)


class PriorityPreviewRequest(BaseModel):
    """Body for `POST /projects/{id}/priority/preview` (P14 contract §1)."""

    model_config = ConfigDict(extra="forbid", strict=True)

    priority: ProjectPriority = Field(strict=False)
    #: ADR 0069: accepted so the UI can send one body shape; a preview
    #: writes nothing and dispatches nothing either way, so it is ignored.
    defer_recalc: bool = Field(default=False, strict=True)


class BandRankPreviewRequest(BaseModel):
    """Body for `POST /projects/{id}/band-rank/preview` (ADR 0050 §4,
    docs/API_CONTRACT_P36.md §2). At most one anchor: place the project
    directly before / after that project in the full band; both null = last
    in the band. Both set is a 422 `BOTH_ANCHORS` (coded, from the route).

    Alternative (owner ask 2026-11-17, contract §2 amendment): `to_rank`,
    the target position 1..n in the FULL band, resolved server-side. With
    an anchor it is a 422 `ANCHOR_AND_RANK`; outside 1..n a 422 `BAD_RANK`
    (no clamping; the message never states n). Range-checked by the service,
    not here, so every out-of-range value answers the same coded error."""

    model_config = ConfigDict(extra="forbid")

    before_project_id: uuid.UUID | None = None
    after_project_id: uuid.UUID | None = None
    #: Strict: a JSON integer only (no bool, no "3").
    to_rank: int | None = Field(default=None, strict=True)
    #: P60 (ADR 0068): the target position among the project's OWN hub's
    #: projects of the band (1-based). The project is placed just before the
    #: hub peer now at that hub rank; past the hub's end, just after its last
    #: peer; a project alone in its hub of the band keeps its place. Other
    #: hubs' relative order is untouched. Exactly one of `to_rank` /
    #: `hub_rank` (422 `RANK_AND_HUB_RANK`); not with an anchor (422
    #: `ANCHOR_AND_RANK`); below 1 is 422 `BAD_RANK`. Strict JSON integer.
    hub_rank: int | None = Field(default=None, strict=True)
    #: ADR 0069: on the preview it is ignored (a preview writes nothing); on
    #: `BandRankMoveRequest` (which inherits it) `true` writes the re-rank but
    #: applies NO run (`recalc_status: "deferred"`). Default `false`.
    defer_recalc: bool = Field(default=False, strict=True)


class BandRankMoveRequest(BandRankPreviewRequest):
    """Body for `POST /projects/{id}/band-rank` (contract §3): the previewed
    placement plus the preview's token (409 `PREVIEW_STALE` when stale)."""

    preview_token: str = Field(min_length=16, max_length=128)


PriorityPreviewResult = Literal["preview", "unchanged", "not_needed"]


class PriorityPreviewMoved(BaseModel):
    """The moved project's own outcome: `before` from the active run (null
    when there is none, or the project has no outcome row in it), `after`
    from the preview (or the applied run)."""

    end_week_before: int | None
    end_week_after: int | None
    within_year_before: bool | None
    within_year_after: bool | None
    left_out_before: bool | None
    left_out_after: bool | None
    # --- P42 (ADR 0056 R42-8, docs/API_CONTRACT_P42.md §7) ---
    #: The stored / previewed flags on each side; null with no outcome row.
    counts_toward_year_before: bool | None = None
    counts_toward_year_after: bool | None = None
    not_scheduled_priority_before: bool | None = None
    not_scheduled_priority_after: bool | None = None
    #: R42-8: `leaves_plan` when the move makes the project not scheduled
    #: (into P4/Q); `joins_queue` when it leaves P4/Q but stays non-counting
    #: (In Queue, P4 → P3); else null. A `leaves_plan` move is never counted as
    #: "drops out of the year".
    effect: Literal["leaves_plan", "joins_queue"] | None = None
    #: The R42-8 copy for `effect`: "leaves the plan" / "joins the queue —
    #: not counted this year"; null when `effect` is null.
    effect_label: str | None = None


class PriorityPreviewSummary(BaseModel):
    """Counts over the listed (in-scope) `changes` rows. Out-of-scope rows
    are only in `hidden_count`."""

    affected: int
    #: `end_week_after > end_week_before` (both set).
    delayed: int
    #: `end_week_after < end_week_before` (both set).
    earlier: int
    #: within year before, not after (P42: and counting after).
    pushed_out_of_year: int
    #: not within year before, within after.
    pulled_into_year: int


class PriorityPreviewChange(BaseModel):
    """One *other* project whose `projected_end_week`, `within_year`,
    `left_out` or `blocked` differs (the ADR 0015 §4 comparison,
    `services.run_changes`). A side with no outcome row reads null/false."""

    project_id: uuid.UUID
    name: str
    hub: HubName
    priority: ProjectPriority | None
    end_week_before: int | None
    end_week_after: int | None
    within_year_before: bool
    within_year_after: bool
    left_out_before: bool
    left_out_after: bool
    blocked_before: bool
    blocked_after: bool
    #: P42 (R42-6, I20): the two compared flags; a side with no row reads false.
    counts_toward_year_before: bool = True
    counts_toward_year_after: bool = True
    not_scheduled_priority_before: bool = False
    not_scheduled_priority_after: bool = False
    #: P42 (R42-1): the band label of `priority`; null with no band.
    priority_label: str | None = None


class PriorityPreviewResponse(BaseModel):
    """P14 contract §1. Writes nothing. `changes` ordered: pushed out of the
    year first, then the largest delay, then name.

    - `unchanged`: same priority; `preview_token`, `moved` null.
    - `not_needed`: non-schedulable status; no greedy pass, `changes` empty,
      `moved` null, but `preview_token` is set (the confirm checks it).
    - no active run: `baseline_run_id` null, `changes` empty, `note` set.
    """

    result: PriorityPreviewResult
    project_id: uuid.UUID
    from_priority: ProjectPriority | None
    to_priority: ProjectPriority
    baseline_run_id: uuid.UUID | None
    preview_token: str | None
    moved: PriorityPreviewMoved | None
    summary: PriorityPreviewSummary
    changes: list[PriorityPreviewChange]
    hidden_count: int
    #: Wall time of the snapshot build plus the greedy pass; null when no
    #: pass ran.
    elapsed_ms: int | None
    note: str | None = None


class PriorityMoveResponse(BaseModel):
    """Always 200; `recalc_status` says what happened (ADR 0015).

    `schedule_run_id` and `task_id` are set only when `queued`.
    `baseline_run_id` is the run that was active before the move, set only
    when `queued` and a run was active; pass it as `against` to
    `GET /schedule-runs/{schedule_run_id}/changes` once the run completes.
    """

    project_id: uuid.UUID
    priority_before: ProjectPriority | None
    priority_after: ProjectPriority
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None
    baseline_run_id: uuid.UUID | None
    task_id: str | None
    #: P14 (ADR 0026): set on `applied` only, computed from the two persisted
    #: runs through `services.run_changes`; the same shapes as the preview.
    moved: PriorityPreviewMoved | None = None
    summary: PriorityPreviewSummary | None = None
    changes: list[PriorityPreviewChange] = Field(default_factory=list)
    hidden_count: int = 0
    #: P60 (ADR 0068), band-rank moves only (null on a priority move): the
    #: project's global `band_rank` and its `hub_rank` after the move (its
    #: current ones when `unchanged`).
    band_rank: int | None = None
    hub_rank: int | None = None


# --- P35: Projects register batch save (`POST /projects/register-edits`) -----------

#: Most rows one register Save may carry.
REGISTER_EDITS_MAX = 100


#: A workflow step id as served by the register (`current_step_code`, e.g.
#: "PDD-E", "OEM-B"). An unknown id for the project's workflow is a per-row
#: 422 `UNKNOWN_STEP`.
StepCode = Annotated[str, StringConstraints(min_length=1, max_length=10)]


class StepExclusionEdit(BaseModel):
    """P35-T05 (ADR 0049, R35-2): switch one step off (`true`) or back on
    (`false`) for the project. Sending a step's current value is a no-op."""

    model_config = ConfigDict(extra="forbid")

    step_code: StepCode
    step_excluded: bool = Field(strict=True)


def _unique_step_codes(edits: list[StepExclusionEdit] | None) -> list[StepExclusionEdit] | None:
    if edits is not None and len({e.step_code for e in edits}) != len(edits):
        raise ValueError("each step_code may appear once")
    return edits


class RegisterEditPatch(BaseModel):
    """One project's changes from the register's Edit mode / Edit popup. A
    subset of `ProjectUpdateRequest` (same types and bounds, same PATCH
    semantics: only the keys sent are applied, `null` clears where the PATCH
    allows it) plus `actual_end_week`. No financial field.
    `requesting_department` is read-only (workbook charter field, ADR 0035)
    and so is not accepted either.

    Register popup (2026-11-17, docs/API_CONTRACT_REGISTER_POPUP.md):
    `hub_id` and `certification_testing_required` follow the PATCH's rules
    (a hub move needs write scope on the old and the new hub, else the batch
    is a 403 `FORBIDDEN_PROJECT`; `null` is 422 `NULL_NOT_ALLOWED`);
    `step_exclusions` (P35-T05) and `current_step_code` are applied after the
    project fields, exclusions first. `null` on either of those two means
    "no change"."""

    model_config = ConfigDict(extra="forbid")

    project_id: uuid.UUID
    status: ProjectStatus | None = None
    leader_engineer_id: uuid.UUID | None = None
    actual_start_week: int | None = Field(default=None, ge=1)
    actual_end_week: int | None = Field(default=None, ge=1)
    design_effort_weeks: EffortWeeks | None = None
    lab_effort_weeks: EffortWeeks | None = None
    hub_id: uuid.UUID | None = None
    certification_testing_required: bool | None = Field(default=None, strict=True)
    step_exclusions: Annotated[
        list[StepExclusionEdit] | None,
        Field(max_length=14),
        AfterValidator(_unique_step_codes),
    ] = None
    current_step_code: StepCode | None = None
    #: P59-B (bulk edit / Priority board bulk move): the PATCH's rules. A
    #: changed priority is applied as a priority move (ADR 0015 / 0050): the
    #: project goes last in its new band (several moved into one band keep
    #: their current rank, then name, order), one `project.priority_move`
    #: audit row each, the batch's one recalculation. The same priority is
    #: unchanged. Commercialized / Cancelled: per-project error
    #: `PRIORITY_NOT_APPLICABLE` (ADR 0067; `null` there is the unchanged
    #: round-trip); a hard-gated project to P2+: `HARD_GATE_FORCES_P1`;
    #: `null` on a schedulable project: `NULL_NOT_ALLOWED`. On a
    #: non-schedulable status (On Hold) it is saved without a recalculation.
    priority: ProjectPriority | None = None
    #: P59-B: a `categories.code` (unknown: the PATCH's enum-shaped 422 at
    #: `body.edits.<i>.category`); not in the hub's workflow: per-project
    #: `CATEGORY_WORKFLOW_MISMATCH`. `null` clears it, as the PATCH.
    category: CategoryCode | None = None
    #: P59-B: the project type (the PATCH's / `ProjectRead`'s `type`; the
    #: batch writes it to the same column).
    project_type: ProjectType | None = None
    #: P47 (ADR 0059): this row's values the user started from, per changed
    #: field; `step_exclusions` as `{step_code: excluded}` (or the request's
    #: own list shape), `current_step_code` as the code served.
    base: EditBase = Field(default_factory=dict)


class RegisterEditsRequest(BaseModel):
    """1..100 per-project patches, applied all-or-nothing in one transaction."""

    model_config = ConfigDict(extra="forbid")

    edits: list[RegisterEditPatch] = Field(min_length=1, max_length=REGISTER_EDITS_MAX)
    #: ADR 0069 (manual recalculation mode): `true` saves, audits and marks
    #: the changed projects `schedule_stale` as usual but dispatches NO run
    #: (`recalc_status: "deferred"`). Default `false`: unchanged behaviour.
    defer_recalc: bool = Field(default=False, strict=True)


class RegisterEditError(BaseModel):
    """One element of `detail.errors` on a 403 `REGISTER_EDITS_FORBIDDEN` or
    a 422 `REGISTER_EDITS_INVALID`. `code` is the single PATCH's code for
    the same failure (e.g. `ACTUAL_END_BEFORE_START`, `NULL_NOT_ALLOWED`,
    `DRAFT_RETIRED`, `EFFORT_SPLIT_REJECTED`), or `DUPLICATE_PROJECT`,
    `FORBIDDEN_PROJECT` (no write right, out of scope or not found: existence
    is never revealed) and `STATUS_DRAFT_SUBMIT_ONLY`."""

    project_id: uuid.UUID
    code: str
    message: str


class RegisterEditEffChange(BaseModel):
    """One step whose `eff` changed with a register Save (R35-7)."""

    project_id: uuid.UUID
    step_code: str
    eff_before: int
    eff_after: int
    #: `eff_before == 0 and eff_after > 0`.
    revived: bool
    #: `eff_before > 0 and eff_after == 0`.
    skipped_now: bool


class RegisterEditsResponse(BaseModel):
    """Always 200 on success. The recalc fields mirror
    `PriorityMoveResponse` (ADR 0015 lifecycle, one greedy run for the whole
    batch, `trigger_reason="register_edit"`): `schedule_run_id` / `task_id`
    only when `queued`, `baseline_run_id` only when `queued` and a run was
    active. `not_needed` when no scheduler input changed on a project that
    was schedulable before or after its edit."""

    project_ids: list[uuid.UUID]
    projects_marked_stale: list[uuid.UUID]
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None
    baseline_run_id: uuid.UUID | None
    task_id: str | None
    #: P35-T05 (R35-7): per project, every step whose effective duration
    #: (`eff`, DOMAIN_RULES R35-1) changed with this Save, so the popup can say
    #: "D now runs 1 wk" without re-splitting in the browser. Ordered by
    #: project id, then workflow order. Empty when nothing changed.
    eff_changes: list[RegisterEditEffChange] = Field(default_factory=list)


# --- Register popup read (`GET /projects/{id}/register-steps`) -----------------------

#: The stored stage status (`WorkflowStepStatus` wire values; `Blocked` is
#: shown as "On Hold", ADR 0017), or `Skipped` when the step's effective
#: duration is 0 (excluded, 0-length copy, lab without certification
#: testing, or an own-effort step the split gave 0): it then counts as
#: complete for the scheduler and cannot be the current step.
RegisterStepStatus = Literal["Not Started", "In Progress", "Blocked", "Done", "Skipped"]


class RegisterStepRead(BaseModel):
    """One of the project's 14 steps, in workflow order."""

    #: The workflow step id ("PDD-E"), the value `current_step_code` and
    #: `step_exclusions[].step_code` take.
    step_code: str
    step_name: str
    kind: WorkflowStepKind
    status: RegisterStepStatus
    step_excluded: bool
    #: R35-2 `applicable(p, s)` from the template copy, ignoring the step's own
    #: exclusion (a step the split gave 0 weeks is applicable).
    applicable: bool
    #: May be switched off now: applicable, not Done, and the project is not
    #: frozen, Cancelled or Commercialized. Re-including an excluded step
    #: needs only the project condition.
    excludable: bool
    is_current: bool


class RegisterStepsRead(BaseModel):
    """`GET /projects/{id}/register-steps`: the register popup's step chips."""

    project_id: uuid.UUID
    #: The register's current step (the same value `GET /dashboard/projects`
    #: serves as `current_step_code`); null when every step is Done or skipped.
    current_step_code: str | None
    #: The forecast finish week (the active run's projected end, the same
    #: value the register serves as `end_week`). Read-only.
    end_week: int | None
    #: P35 (D35-1, R35-12): Σ over the kind's steps of `eff` with the
    #: project's own figure ignored, excluded steps adding 0: the same values
    #: and predicate as the register list row (`GET /dashboard/projects`).
    design_weeks_calculated: int
    lab_weeks_calculated: int
    steps: list[RegisterStepRead]
