"""Workflow templates: timeline preview, apply preview, apply, add category
(P33-T09..T11; `docs/API_CONTRACT_P33.md` Parts B2, D and E; ADR 0045, ADR
0046 as ruled (owner ruling OR-1..OR-6 > R33 > text), ADR 0047).

Requests are strict (`extra="forbid"`; an int never accepts a string or a
bool). UUIDs and the selection mode opt out of strict mode only where a
strict UUID would refuse its JSON string form. Errors use the `{code,
detail}` envelope of `api.errors.CodedHTTPException`.

Nothing here carries a financial field or an engineer name.
"""

from __future__ import annotations

import uuid
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from models.enums import HubName, ProjectStatus, WorkflowStepStatus
from schemas.category import CategoryCodeOut, CategoryRead
from schemas.project import RecalcStatus
from schemas.workflow_settings import CategoryTimeline

#: Template ranges (DOMAIN_RULES "Category templates" §A).
WEEKS_MIN, WEEKS_MAX = 0, 104
GAP_MIN, GAP_MAX = -104, 104
#: Contract E1: at most 20 (workflow, category) entries per change set.
MAX_CHANGE_ENTRIES = 20
#: A workflow has 14 steps; a change entry lists each at most once.
MAX_STEPS_PER_ENTRY = 14

_STRICT = ConfigDict(extra="forbid", strict=True)
#: A strict UUID refuses its JSON string form; ids opt out (as `schemas.checkin`).
_LooseUuid = Annotated[uuid.UUID, Field(strict=False)]


# --- Part D: timeline preview --------------------------------------------------------


#: P62 (contract P62 §4.1): the wire value that sets a step's room weeks to
#: NULL ("Full", the whole length).
LAB_HOLD_FULL = "full"


class TemplateStepOverride(BaseModel):
    """One overridden step: its length, its signed gap and / or (P62, ADR
    0071) its room weeks. A missing field keeps the saved template value.

    `lab_hold_weeks`: an integer (room weeks, `0..weeks` where `weeks` is
    this override's if given, else the saved one; otherwise 422
    `LAB_HOLD_OUT_OF_RANGE`) or `"full"` (NULL). A non-null value on a
    non-lab step is 422 `LAB_HOLD_NOT_LAB`; `"full"` there is a no-op. The
    range and kind checks need the saved template, so they run in
    `services.template_editor.resolve_entry`, not here."""

    model_config = _STRICT

    step_id: str = Field(min_length=1, max_length=10)
    weeks: int | None = Field(default=None, ge=WEEKS_MIN, le=WEEKS_MAX)
    gap_weeks: int | None = Field(default=None, ge=GAP_MIN, le=GAP_MAX)
    lab_hold_weeks: int | Literal["full"] | None = None

    @model_validator(mode="after")
    def _one_value(self) -> TemplateStepOverride:
        if self.weeks is None and self.gap_weeks is None and self.lab_hold_weeks is None:
            raise ValueError("a step must carry weeks, gap_weeks and/or lab_hold_weeks")
        return self


class TimelinePreviewRequest(BaseModel):
    """`POST /workflow-templates/timeline-preview` (contract D). `steps`
    lists only the overridden steps; the others take the saved template."""

    model_config = _STRICT

    workflow_id: str = Field(min_length=1, max_length=10)
    category: str = Field(min_length=1, max_length=16)
    steps: list[TemplateStepOverride] = Field(default_factory=list, max_length=MAX_STEPS_PER_ENTRY)


class TimelinePreviewResponse(CategoryTimeline):
    """One C2 category object computed with the overrides, plus the ids of
    the steps whose length or gap differs from the saved template."""

    changed_step_ids: list[str]


# --- Part E: apply -------------------------------------------------------------------


class TemplateChangeEntry(BaseModel):
    """One (workflow, category) of a change set (contract E1)."""

    model_config = _STRICT

    workflow_id: str = Field(min_length=1, max_length=10)
    category: str = Field(min_length=1, max_length=16)
    #: The `template_version` the editor read; 409 `TEMPLATE_CHANGED` if it
    #: is no longer current.
    base_version: int = Field(ge=1)
    steps: list[TemplateStepOverride] = Field(min_length=1, max_length=MAX_STEPS_PER_ENTRY)


class TemplateChangeSet(BaseModel):
    """`POST /workflow-templates/apply-preview` body (contract E1/E2)."""

    model_config = _STRICT

    changes: list[TemplateChangeEntry] = Field(min_length=1, max_length=MAX_CHANGE_ENTRIES)

    @model_validator(mode="after")
    def _unique_pairs(self) -> TemplateChangeSet:
        keys = [(c.workflow_id, c.category) for c in self.changes]
        if len(keys) != len(set(keys)):
            raise ValueError("changes lists the same (workflow_id, category) more than once")
        return self


SelectionMode = Literal["all_not_reached", "selected", "none"]


class ApplySelection(BaseModel):
    """Which choosable projects receive the change (contract E3). Automatic
    projects always receive it, whatever the mode."""

    model_config = _STRICT

    mode: SelectionMode
    project_ids: list[_LooseUuid] = Field(default_factory=list, max_length=400)

    @model_validator(mode="after")
    def _ids_match_mode(self) -> ApplySelection:
        if self.mode == "selected":
            if not self.project_ids:
                raise ValueError("project_ids is required and non-empty for mode 'selected'")
            if len(self.project_ids) != len(set(self.project_ids)):
                raise ValueError("project_ids repeats a project")
        elif self.project_ids:
            raise ValueError(f"project_ids must be empty for mode {self.mode!r}")
        return self


class TemplateApplyRequest(TemplateChangeSet):
    """`POST /workflow-templates/apply` body (contract E3)."""

    selection: ApplySelection
    reason: str | None = Field(default=None, max_length=500)
    #: ADR 0069 (manual recalculation mode): `true` saves, audits and marks
    #: the changed projects `schedule_stale` as usual but dispatches NO run
    #: (`recalc_status: "deferred"`). Default `false`: unchanged behaviour.
    defer_recalc: bool = Field(default=False, strict=True)


StepFlag = Literal[
    "revived",
    "skipped_now",
    "gap_ignored_skipped",
    "cert_off_no_effect",
    "own_effort_length_not_applied",
    # P35 (R35-8): the step is excluded for this project; the copy is still
    # written (re-include gets it), but it has no effect while excluded.
    "excluded_no_effect",
    # P62 (ADR 0071, contract P62 §4.1 / §4.2): the room weeks were clamped
    # to a shortened length (I65).
    "room_weeks_clamped",
    # P62 (R62-8): the room weeks flip NULL <-> value on an own-lab-figure
    # project, so its lab split is re-derived (R62-1).
    "lab_split_rederived",
    # P62 (R62-12): a length change on a `partialRoom` step of an
    # own-lab-figure project; it IS applied.
    "partial_room_length_applied",
]


class ApplyPreviewStep(BaseModel):
    """One changed step of one project: DOMAIN_RULES §B `eff` and the copy's
    signed gap, before and after (R33-11)."""

    step_id: str
    eff_before: int
    eff_after: int
    gap_before: int
    gap_after: int
    #: P62 (contract P62 §4.2): the copy's room weeks before / after
    #: (`plan_lab_hold_weeks`, null = Full; always null on a non-lab step).
    hold_before: int | None
    hold_after: int | None
    flags: list[StepFlag]


class ApplyPreviewProject(BaseModel):
    """A project in the `automatic` list."""

    project_id: uuid.UUID
    name: str
    hub: HubName
    status: ProjectStatus
    steps: list[ApplyPreviewStep]


class CurrentStage(BaseModel):
    step_id: str
    name: str
    status: WorkflowStepStatus


class ApplyPreviewChoosableProject(ApplyPreviewProject):
    """A project in the `choosable` list. `current_stage` is the In Progress
    / Blocked stage with the lowest `sequence_order`, else the last Done
    one."""

    current_stage: CurrentStage | None


class ApplyPreviewOwnEffortProject(BaseModel):
    """A project whose only receivable changes are lengths of a kind it has
    its own effort figure for (OR-4). Nothing is written to it."""

    project_id: uuid.UUID
    name: str
    hub: HubName
    status: ProjectStatus
    step_ids: list[str]
    kinds: list[Literal["design", "lab"]]
    reason: Literal["own_effort_length_not_applied"]


NeverReason = Literal["frozen", "cancelled", "commercialized", "reached_stage"]


class ApplyPreviewNeverProject(BaseModel):
    """A project (or some of its changed steps) that never receives the
    change (DOMAIN_RULES §C `never`)."""

    project_id: uuid.UUID
    name: str
    hub: HubName
    reason: NeverReason
    step_ids: list[str]


class ApplyPreviewCategory(BaseModel):
    workflow_id: str
    category: CategoryCodeOut
    #: The C2 timeline of the template after the change.
    timeline: CategoryTimeline


class ApplyPreviewCounts(BaseModel):
    automatic: int
    choosable: int
    own_effort: int
    never: int


class ApplyPreviewResponse(BaseModel):
    """`POST /workflow-templates/apply-preview` (contract E2). Projects are
    ordered by name, then id. No writes."""

    categories: list[ApplyPreviewCategory]
    counts: ApplyPreviewCounts
    automatic: list[ApplyPreviewProject]
    choosable: list[ApplyPreviewChoosableProject]
    own_effort: list[ApplyPreviewOwnEffortProject]
    never: list[ApplyPreviewNeverProject]


class TemplateVersion(BaseModel):
    workflow_id: str
    category: CategoryCodeOut
    template_version: int


class AppliedCounts(BaseModel):
    automatic: int
    selected: int
    own_effort_not_applied: int


class NotApplied(BaseModel):
    project_id: uuid.UUID
    reason: Literal["reached_stage", "not_choosable"]


class TemplateApplyResponse(BaseModel):
    """`POST /workflow-templates/apply` (contract E3)."""

    template_change_id: uuid.UUID
    versions: list[TemplateVersion]
    applied: AppliedCounts
    not_applied: list[NotApplied]
    recalc_status: RecalcStatus
    schedule_run_id: uuid.UUID | None
    task_id: str | None


class TemplateChangedDetail(BaseModel):
    """The 409 `TEMPLATE_CHANGED` body's `detail` (documentation model)."""

    message: str
    versions: list[TemplateVersion]


# --- Part B2: add category ------------------------------------------------------------


class CategoryCreateRequest(BaseModel):
    """`POST /workflow-templates/categories` (contract B2). `code` is checked
    by the router (trimmed, 1..16 of `[A-Za-z0-9+\\- ]`, not `OEM`, unique
    case-insensitively) so a bad one gets 422 `BAD_CATEGORY_CODE`, not a
    generic validation error."""

    model_config = _STRICT

    code: str = Field(max_length=64)
    label: str | None = Field(default=None, max_length=60)
    workflow_id: str = Field(min_length=1, max_length=10)
    copy_from: str = Field(min_length=1, max_length=16)
    #: An existing code (any workflow), or null for first place.
    insert_after: str | None = Field(max_length=16)


class CategoryCreateResponse(BaseModel):
    category: CategoryRead
    #: The full list in rank order, after the insert.
    categories: list[CategoryRead]
    template_rows: int
    engineers_extended: int


# --- ADR 0070: one-time effort-weight sync (Super Admin) ------------------------------


class EffortWeightSyncRequest(BaseModel):
    """`POST /workflow-templates/sync-effort-weights`. `dry_run` is required
    (no default), so an apply is always explicit."""

    model_config = _STRICT

    dry_run: bool


class EffortWeightSyncStep(BaseModel):
    """One template row whose weight is (or would be) revived: 0 -> weeks."""

    step_id: str
    kind: Literal["design", "lab", "elapsed"]
    weeks: int
    weight_before: int
    weight_after: int


class EffortWeightSyncCategory(BaseModel):
    workflow_id: str
    category: CategoryCodeOut
    steps: list[EffortWeightSyncStep]


class EffortWeightSyncProject(BaseModel):
    """A project that receives the revive: its copy of the revived steps
    becomes the template length and its effort is re-derived. `effort_before`
    / `effort_after` list only the steps whose `effort_weeks` changes."""

    project_id: uuid.UUID
    name: str
    category: CategoryCodeOut
    step_ids: list[str]
    effort_before: dict[str, int | None]
    effort_after: dict[str, int | None]


EffortWeightSyncSkipReason = Literal[
    "frozen", "cancelled", "commercialized", "reached_stage", "started_share", "split_rejected"
]


class EffortWeightSyncSkipped(BaseModel):
    """A project with its own effort for a revived step's kind that does not
    receive it (never touched)."""

    project_id: uuid.UUID
    name: str
    category: CategoryCodeOut
    reason: EffortWeightSyncSkipReason
    step_ids: list[str]


class EffortWeightSyncCounts(BaseModel):
    template_rows: int
    categories: int
    projects_rederived: int
    projects_skipped: int


class EffortWeightSyncResponse(BaseModel):
    """ADR 0070 catch-up result. With `dry_run` nothing was written; the
    lists are what an apply would do now. Projects are ordered by name, id.
    `project_ids` = the projects re-derived (and marked `schedule_stale`)."""

    dry_run: bool
    counts: EffortWeightSyncCounts
    categories: list[EffortWeightSyncCategory]
    projects: list[EffortWeightSyncProject]
    skipped: list[EffortWeightSyncSkipped]
    project_ids: list[uuid.UUID]
