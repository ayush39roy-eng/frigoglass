from __future__ import annotations

import uuid
from collections.abc import Iterable
from decimal import Decimal
from typing import TYPE_CHECKING

from sqlalchemy import (
    ARRAY,
    Boolean,
    CheckConstraint,
    Enum,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    case,
    literal,
    select,
)
from sqlalchemy.orm import Mapped, column_property, mapped_column, relationship

import domain_constants as dc
from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import (
    OEM_PROJECT_CATEGORIES,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
    ScoringTag,
)
from models.hub import Hub
from models.types import EncryptedNumeric, EncryptedString

if TYPE_CHECKING:
    from models.engineer import Engineer
    from models.priority import PriorityScore
    from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
    from models.workflow import ProjectWorkflowStep
    from models.workspace import ProjectComment, ProjectFile


def category_allowed_for_hub(hub_is_oem: bool, category: ProjectCategory | None) -> bool:
    """docs/DOMAIN_RULES.md "Lead times": non-OEM hubs use `A+/A/B/C`; OEM hubs
    use `A-OEM/B-OEM/C-OEM`. A `None` category is allowed (a Draft row before
    Project Registration's hard gates are satisfied).

    This is the model-layer half of the rule. A plain CHECK constraint on
    `projects` cannot see `hubs.is_oem`, so the DB half is the trigger
    `trg_projects_category_matches_hub` (P9-T01 migration), which raises a
    `check_violation` (SQLSTATE 23514 → `IntegrityError`) on INSERT/UPDATE of
    `category`/`hub_id`. Callers (API layer, seed) use this function to give a
    422 *before* hitting the trigger.
    """
    if category is None:
        return True
    return (category in OEM_PROJECT_CATEGORIES) == hub_is_oem


def workflow_id_for_hub(hub_is_oem: bool) -> str:
    """`Hub.is_oem` → `Workflow.id` ("OEM" or "PDD"), per DOMAIN_RULES.md
    "A project's workflow is a function of its hub".
    """
    return dc.WORKFLOW_ID_FOR_OEM_HUB if hub_is_oem else dc.WORKFLOW_ID_FOR_NON_OEM_HUB


def canonical_tags(tags: Iterable[ScoringTag | str] | None) -> list[ScoringTag]:
    """ADR 0038: tags de-duplicated, in `ScoringTag` declaration order."""

    present = {ScoringTag(t) for t in (tags or ())}
    return [t for t in ScoringTag if t in present]


class Project(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A single R&D/PD project moving through the 14-step PDD workflow.

    Financial fields (`tcogs_eur`, `selling_price_eur`, `gross_margin_pct`,
    `customer_name`) use `EncryptedString`/`EncryptedNumeric` (backend/models/
    types.py) per CLAUDE.md's non-negotiable — these four, and only these four,
    are the fields CLAUDE.md and docs/DOMAIN_RULES.md name explicitly. `capex_keur`
    and `rm_savings_keur` are financial-*adjacent* scoring inputs but are not in
    that named list; they are left as plain (unencrypted) Numeric columns. This
    is a judgement call, not a DOMAIN_RULES.md instruction either way — flagged
    for security-auditor's P1-T06 review in case the encrypted set should be
    broadened.

    `roi` and `payback_yrs` (seen in the prototype's export column headers,
    derived as `(selling_price - tcogs) / capex` etc.) are intentionally NOT
    persisted columns — they are pure derivations of already-stored values and
    would otherwise be a second, driftable source of truth. Compute them at the
    API/read-model layer (P3) instead.
    """

    __tablename__ = "projects"

    name: Mapped[str] = mapped_column(String(300), nullable=False)
    #: Optional legacy/spreadsheet reference code, for P7 data migration
    #: traceability. Not the primary key.
    external_code: Mapped[str | None] = mapped_column(String(100), nullable=True, unique=True)

    hub_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hubs.id"), nullable=False)
    leader_engineer_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("engineers.id"), nullable=True
    )
    #: ADR 0042 §7: the leader was assigned by the seed / migration
    #: `p29a_capacity_hubs` (the least-loaded eligible engineer of the capacity
    #: hub), not by a person. The UI badges it; the client is asked who should
    #: lead (docs/OPEN_QUESTIONS.md #52). Cleared when a PATCH changes
    #: `leader_engineer_id` (a person chose the leader).
    leader_is_provisional: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )

    #: Nullable to allow ProjectStatus.DRAFT rows before Project Registration's
    #: hard gates are satisfied (docs/PROJECT_AND_STACK.md §2). The API layer
    #: (P3) is responsible for enforcing "required before leaving draft", not a
    #: DB NOT NULL constraint, since that would make saving a draft impossible.
    category: Mapped[ProjectCategory | None] = mapped_column(
        Enum(
            ProjectCategory,
            name="project_category",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )
    #: See models/enums.py ProjectType docstring: sourced from the prototype,
    #: not DOMAIN_RULES.md. Flagged for orchestrator review.
    type: Mapped[ProjectType | None] = mapped_column(
        Enum(
            ProjectType,
            name="project_type",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )

    #: ADR 0034 (P23-T02): no default. The ORM used to default to `Draft`;
    #: Draft is retired from registration, so every writer states the status
    #: explicitly (`POST /projects` writes `In Queue`) and an omitted status
    #: fails loudly on `NOT NULL` instead of silently creating a Draft row.
    status: Mapped[ProjectStatus] = mapped_column(
        Enum(
            ProjectStatus,
            name="project_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    #: The committed/working priority used by the scheduler's sort order
    #: (docs/DOMAIN_RULES.md "Scheduling order"). This is the prototype's
    #: "set_priority" — may differ from PriorityScore.suggested_band if a
    #: Portfolio Manager manually overrides the computed band (Prioritization
    #: Matrix surface). Hard gates (PriorityScore.hard_gates) pin this to P1 at
    #: the API layer when set (docs/DOMAIN_RULES.md "Hard gates").
    priority: Mapped[ProjectPriority | None] = mapped_column(
        Enum(
            ProjectPriority,
            name="project_priority",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=True,
    )

    #: Locks `actual_start_week` and excludes the project from re-scheduling,
    #: per docs/DOMAIN_RULES.md booking rules and Invariant I10.
    frozen: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    #: Week number (against the 78-week horizon / CURRENT_WEEK=31 convention),
    #: not a calendar date — matches DOMAIN_RULES.md's week-integer model.
    actual_start_week: Mapped[int | None] = mapped_column(Integer, nullable=True)

    #: Terminal delay adjustment (weeks), per ADR 0004 — added only to the
    #: completing-within-year check (`last_step_end + delay <= WITHIN_YEAR_WEEK`),
    #: never propagated into individual step start/end times.
    delay_weeks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    reg_year: Mapped[int | None] = mapped_column(Integer, nullable=True)
    carry_over: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    comments: Mapped[str | None] = mapped_column(Text, nullable=True)

    # --- 2026-09-27 additions (ADR 0007, P9-T01) ------------------------------
    #: Charter column "Project End Date - LATEST", as a week number. When set it
    #: is the project's `expected_end_week`; otherwise the unconstrained finish
    #: computed by the scheduler is (docs/DOMAIN_RULES.md "Expected vs projected
    #: completion", docs/OPEN_QUESTIONS.md #19).
    target_end_week: Mapped[int | None] = mapped_column(Integer, nullable=True)
    #: When false, every `lab`-kind step is skipped (docs/DOMAIN_RULES.md
    #: "Lead times"). ADR 0041 §3: the client import sets it when col 18 is
    #: "Yes" OR the project carries lab weeks (`lab_effort_weeks > 0`).
    certification_testing_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    #: Optional hand-entered figures for the Capacity surface's "Estimated"
    #: column only — never affect the schedule (docs/OPEN_QUESTIONS.md #12).
    estimated_design_weeks: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    estimated_lab_weeks: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    # --- ADR 0041 (P30-T02, migration p30a): the client's per-project figures
    #: `Process Design Man Week` (workbook col 16): the project's design
    #: effort in man-weeks. When > 0 it is apportioned over the category's
    #: non-zero design-kind steps (`services.project_effort`, the exact split
    #: of `scheduling.effort_split`) into `ProjectWorkflowStep.effort_weeks`,
    #: which drives both the schedule and the load (R1). Blank or 0: the
    #: lead-time table applies. Not a financial field.
    design_effort_weeks: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    #: `Lab Weeks- Process Derived` (col 21): apportioned over the lab-kind
    #: steps when certification testing is on (R7).
    lab_effort_weeks: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    #: Display only (cols 22, 17, 23, 24): never a scheduling input.
    safety_lab_weeks: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    actual_design_weeks: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    actual_testing_weeks: Mapped[Decimal | None] = mapped_column(Numeric(6, 2), nullable=True)
    safety_certification_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: `Project to be considered for Capacity Calculation` = Y (col 3,
    #: decision (a) of docs/DATA_RECONCILIATION_2026.md). Display / QA only;
    #: the demand scope is by status (I25), not by this flag.
    capacity_flag: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: Set by a progress edit / workflow-settings change; cleared when a new
    #: `ScheduleRun` is activated. A stale flag never auto-solves (ADR 0006).
    schedule_stale: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: ADR 0022 (P12): a planner pinned this project as VIP. A project flag,
    #: not per year; never changes scheduling order and never recalculates.
    is_vip: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    #: "PDD" or "OEM": the project's workflow, a function of its hub
    #: (`workflow_id_for_hub`, DOMAIN_RULES "A project's workflow is a
    #: function of its hub"). A read-only correlated subquery, not a stored
    #: column, so it can never disagree with `hubs.is_oem`. It loads with the
    #: row, so async code never triggers a lazy load. P9-T03.
    workflow_id: Mapped[str] = column_property(
        select(
            case(
                (Hub.is_oem.is_(True), literal(dc.WORKFLOW_ID_FOR_OEM_HUB)),
                else_=literal(dc.WORKFLOW_ID_FOR_NON_OEM_HUB),
            )
        )
        .where(Hub.id == hub_id)
        .correlate_except(Hub)
        .scalar_subquery()
    )

    # --- ADR 0035 (P24-T01): charter fields from the client workbook --------
    #: The workbook's `Plant/OEM`, `Requesting Department` and `Product Type`
    #: as written (lists: `domain_constants.PLANT_OPTIONS`,
    #: `REQUESTING_DEPARTMENT_OPTIONS`, `PRODUCT_TYPE_OPTIONS`). Not financial.
    plant: Mapped[str | None] = mapped_column(String(100), nullable=True)
    requesting_department: Mapped[str | None] = mapped_column(String(100), nullable=True)
    product_type: Mapped[str | None] = mapped_column(String(100), nullable=True)

    # --- ADR 0038 (P27-T01): Registration "project nature" tags ----------
    #: Zero or more `ScoringTag`s, stored in canonical (enum declaration)
    #: order. No duplicates and no null elements (CHECK
    #: `scoring_tags_distinct`, migration p27a). Setting a tag pre-fills the
    #: mapped dimension's score with 5 (`services.scoring_tags`); the tags
    #: are not a scheduler input and never touch `priority`.
    scoring_tags: Mapped[list[ScoringTag]] = mapped_column(
        ARRAY(
            Enum(
                ScoringTag,
                name="project_scoring_tag",
                values_callable=lambda enum_cls: [e.value for e in enum_cls],
            )
        ),
        nullable=False,
        default=list,
        server_default="{}",
    )

    # --- Encrypted financial fields (CLAUDE.md non-negotiable) ---
    customer_name: Mapped[str | None] = mapped_column(EncryptedString, nullable=True)
    tcogs_eur: Mapped[object | None] = mapped_column(EncryptedNumeric, nullable=True)
    selling_price_eur: Mapped[object | None] = mapped_column(EncryptedNumeric, nullable=True)
    gross_margin_pct: Mapped[object | None] = mapped_column(EncryptedNumeric, nullable=True)

    # --- Plain (unencrypted) financial-adjacent scoring inputs ---
    capex_keur: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)
    rm_savings_keur: Mapped[float | None] = mapped_column(Numeric(12, 2), nullable=True)

    hub: Mapped[Hub] = relationship(back_populates="projects")
    leader_engineer: Mapped[Engineer | None] = relationship()
    workflow_steps: Mapped[list[ProjectWorkflowStep]] = relationship(
        back_populates="project", order_by="ProjectWorkflowStep.sequence_order"
    )
    priority_score: Mapped[PriorityScore | None] = relationship(back_populates="project")
    schedule_run_steps: Mapped[list[ScheduleRunProjectStep]] = relationship(
        back_populates="project"
    )
    schedule_run_outcomes: Mapped[list[ScheduleRunProjectOutcome]] = relationship(
        back_populates="project"
    )
    files: Mapped[list[ProjectFile]] = relationship(back_populates="project")
    comments_thread: Mapped[list[ProjectComment]] = relationship(back_populates="project")

    __table_args__ = (
        CheckConstraint(
            "target_end_week IS NULL OR target_end_week >= 1", name="target_end_week_positive"
        ),
        CheckConstraint(
            "estimated_design_weeks IS NULL OR estimated_design_weeks >= 0",
            name="estimated_design_weeks_non_negative",
        ),
        CheckConstraint(
            "estimated_lab_weeks IS NULL OR estimated_lab_weeks >= 0",
            name="estimated_lab_weeks_non_negative",
        ),
        CheckConstraint("rpd_scoring_tags_distinct(scoring_tags)", name="scoring_tags_distinct"),
        # ADR 0041 (migration p30a).
        *(
            CheckConstraint(f"{name} IS NULL OR {name} >= 0", name=f"{name}_non_negative")
            for name in (
                "design_effort_weeks",
                "lab_effort_weeks",
                "safety_lab_weeks",
                "actual_design_weeks",
                "actual_testing_weeks",
            )
        ),
    )

    @property
    def tag_dimension_keys(self) -> list[str]:
        """ADR 0038: the rubric dimension keys backed by this project's
        Registration tags, in canonical tag order (served so the UI can mark
        those scores "from registration")."""

        return [dc.SCORING_TAG_DIMENSION_KEY[t.value] for t in canonical_tags(self.scoring_tags)]

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        # Never include financial fields here — __repr__ output can end up in
        # logs/tracebacks.
        return f"<Project {self.id} {self.name!r} status={self.status}>"
