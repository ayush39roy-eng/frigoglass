from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import ARRAY, CheckConstraint, Enum, Integer, Numeric, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import LabRegion

if TYPE_CHECKING:
    from models.schedule import ScheduleRunProjectStep
    from models.workflow import ProjectWorkflowStep


class Chamber(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A lab-step scheduling resource, per docs/DOMAIN_RULES.md's booking rules
    ("Lab step: a chamber in the project's lab region whose allowed_stages
    includes this step, with concurrent project count < chamber.max_concurrent
    (= platform count)").

    Booking is gated by `max_concurrent` only (ADR 0003, unchanged by ADR 0008).
    `platforms`, `efficiency` and the three downtime columns feed the
    Capacity surface's *supply* formula (docs/DOMAIN_RULES.md "Capacity supply",
    ADR 0008):

        working_weeks_per_chamber = 52 − holiday_weeks − maintenance_weeks
                                       − breakdown_weeks − calibration_weeks
        efficient_lab_weeks       = working_weeks_per_chamber × efficiency × platforms

    where `holiday_weeks` comes from the lab region's `HubWorkCalendar`. The
    prototype-era `weeks_per_chamber` column is retired (it was a hand-entered
    result of that formula, not an input).
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

    #: Max concurrent projects — the ONLY field that gates booking (ADR 0003).
    #: Per ADR 0007 this equals the platform count in the seeded data.
    max_concurrent: Mapped[int] = mapped_column(Integer, nullable=False)

    #: Number of physical platforms/slots in the chamber (supply input, ADR 0008).
    platforms: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

    #: Efficiency multiplier, e.g. 0.7 (supply input, ADR 0008).
    efficiency: Mapped[float] = mapped_column(Numeric(4, 3), nullable=False, default=1.0)

    # --- Yearly downtime, in weeks (docs/CLIENT_FORMULAS.md §2.2, ADR 0008) ---
    maintenance_weeks: Mapped[float] = mapped_column(
        Numeric(5, 2), nullable=False, default=2, server_default="2"
    )
    breakdown_weeks: Mapped[float] = mapped_column(
        Numeric(5, 2), nullable=False, default=0, server_default="0"
    )
    calibration_weeks: Mapped[float] = mapped_column(
        Numeric(5, 2), nullable=False, default=1, server_default="1"
    )

    #: Lab-kind workflow step IDs this chamber may book (e.g. ["PDD-F",
    #: "PDD-H", "OEM-E", "OEM-H"]), per Invariant I4. Stored as the canonical
    #: "<workflow>-<letter>" IDs from DOMAIN_RULES.md. Not DB-constrained to
    #: lab-kind steps only — app-layer validation rejects non-lab IDs here.
    allowed_stages: Mapped[list[str]] = mapped_column(
        ARRAY(String(10)), nullable=False, default=list
    )

    project_steps: Mapped[list[ProjectWorkflowStep]] = relationship(
        back_populates="assigned_chamber"
    )
    scheduled_run_steps: Mapped[list[ScheduleRunProjectStep]] = relationship(
        back_populates="assigned_chamber"
    )

    __table_args__ = (
        CheckConstraint("maintenance_weeks >= 0", name="maintenance_weeks_non_negative"),
        CheckConstraint("breakdown_weeks >= 0", name="breakdown_weeks_non_negative"),
        CheckConstraint("calibration_weeks >= 0", name="calibration_weeks_non_negative"),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Chamber {self.code!r}>"
