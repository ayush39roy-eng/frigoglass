from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import (
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

    status: Mapped[ProjectStatus] = mapped_column(
        Enum(
            ProjectStatus,
            name="project_status",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
        default=ProjectStatus.DRAFT,
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
    #: "Lead times"; the client's lab-load pivot, docs/CLIENT_FORMULAS.md §2.3).
    certification_testing_required: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    #: Optional hand-entered figures for the Capacity surface's "Estimated"
    #: column only — never affect the schedule (docs/OPEN_QUESTIONS.md #12).
    estimated_design_weeks: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    estimated_lab_weeks: Mapped[float | None] = mapped_column(Numeric(6, 2), nullable=True)
    #: Set by a progress edit / workflow-settings change; cleared when a new
    #: `ScheduleRun` is activated. A stale flag never auto-solves (ADR 0006).
    schedule_stale: Mapped[bool] = mapped_column(
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
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        # Never include financial fields here — __repr__ output can end up in
        # logs/tracebacks.
        return f"<Project {self.id} {self.name!r} status={self.status}>"
