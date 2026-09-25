from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import ARRAY, Enum, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import LabRegion

if TYPE_CHECKING:
    from models.project import ProjectWorkflowStep
    from models.schedule import ScheduleRunProjectStep


class Chamber(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A lab-step scheduling resource, per docs/DOMAIN_RULES.md's booking rules
    ("Lab step: a chamber in the project's lab region whose allowed_stages
    includes this step, with concurrent project count < chamber.max...").

    `efficiency` and `weeks_per_chamber` are stored, reportable fields (surfaced
    on Capacity Planning per docs/PROJECT_AND_STACK.md §2) but do NOT constrain
    booking in v1 — only `max` gates lab-step capacity, per ADR 0003. This is a
    provisional decision; see docs/OPEN_QUESTIONS.md #3.
    """

    __tablename__ = "chambers"

    #: Business-facing chamber code, e.g. "GR-CH1" in the reference data.
    #: Distinct from the surrogate UUID `id` so hub planners can keep using a
    #: short human-readable identifier.
    code: Mapped[str] = mapped_column(String(50), unique=True, nullable=False)

    lab_region: Mapped[LabRegion] = mapped_column(
        Enum(
            LabRegion,
            name="lab_region",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )

    #: Max concurrent projects — the ONLY field that gates booking in v1 (ADR 0003).
    max_concurrent: Mapped[int] = mapped_column(Integer, nullable=False)

    #: Number of physical platforms/slots in the chamber. Reporting-only.
    platforms: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    #: Reporting-only efficiency multiplier (ADR 0003), e.g. 0.7.
    efficiency: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False, default=1.0)

    #: Reporting-only weeks-per-chamber capacity figure (ADR 0003).
    weeks_per_chamber: Mapped[float] = mapped_column(Numeric(6, 2), nullable=False, default=0)

    #: Lab-kind workflow step IDs this chamber may book (e.g. ["PDD-F",
    #: "PDD-H", "PDD-J", "PDD-L"]), per Invariant I4. Stored as the canonical
    #: "PDD-<letter>" IDs from DOMAIN_RULES.md, not the prototype's bare-letter
    #: shorthand. Not DB-constrained to lab-kind steps only — app-layer
    #: validation (P3) should reject design-step IDs here.
    allowed_stages: Mapped[list[str]] = mapped_column(
        ARRAY(String(10)), nullable=False, default=list
    )

    project_steps: Mapped[list[ProjectWorkflowStep]] = relationship(
        back_populates="assigned_chamber"
    )
    scheduled_run_steps: Mapped[list[ScheduleRunProjectStep]] = relationship(
        back_populates="assigned_chamber"
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Chamber {self.code!r}>"
