"""`categories`: the project categories as data (ADR 0047, P33-T07).

One row per category. The `code` is the wire value and the natural key that
`projects.category` and `workflow_lead_times.category` reference (FK, ON
UPDATE / ON DELETE RESTRICT). `engineers.allowed_categories` is a `text[]`
whose elements a trigger checks against `code` ∪ {`OEM`} (an array cannot
carry an FK); `OEM` is a reserved eligibility value, never a category code.

Seeded by migration `p33a_categories` with the seven codes of
`domain_constants.CATEGORY_ORDER` at ranks 1..7 (A+, A, B, C, A-OEM, B-OEM,
C-OEM). `rank` is scheduling order key 5 (DOMAIN_RULES "Category templates"
§E): the scheduler receives the list as `ScheduleInput.categories`
(`services.categories.schedule_categories`).

Rename, deactivate, delete and re-rank are out of scope (OQ #79); `active`
is always true in P33.
"""

from __future__ import annotations

import enum
import uuid
from collections.abc import Iterable
from datetime import datetime

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base

#: ADR 0047 §1 / contract B2: 1..16 characters of `[A-Za-z0-9+\- ]`.
CATEGORY_CODE_PATTERN = r"^[A-Za-z0-9+\- ]+$"
CATEGORY_CODE_MAX_LENGTH = 16
CATEGORY_LABEL_MAX_LENGTH = 60
#: The reserved engineer-eligibility value ("any OEM-workflow category").
RESERVED_ELIGIBILITY_CODE = "OEM"


def category_code(value: object) -> str | None:
    """A category value as its wire code: an enum member (the seed / test
    vocabulary `models.enums.ProjectCategory` / `EngineerAllowedCategory`)
    becomes its `.value`, a string stays as is, `None` stays `None`. Used by
    the ORM validators so a mapped category attribute always holds a plain
    `str` (byte-identical serialisation, I8)."""

    if value is None:
        return None
    if isinstance(value, enum.Enum):
        return str(value.value)
    return str(value)


def category_codes(values: Iterable[object] | None) -> list[str | None] | None:
    """`category_code` over a list (`engineers.allowed_categories`). A `None`
    element is kept (never silently dropped): the trigger rejects it."""

    if values is None:
        return None
    return [category_code(v) for v in values]


class Category(Base):
    """A project category (ADR 0047 §1)."""

    __tablename__ = "categories"

    code: Mapped[str] = mapped_column(Text, primary_key=True)
    label: Mapped[str] = mapped_column(Text, nullable=False)
    workflow_id: Mapped[str] = mapped_column(ForeignKey("workflows.id"), nullable=False)
    #: Scheduling order key 5; unique, dense 1..n. The constraint is
    #: DEFERRABLE (initially immediate) so a renumbering UPDATE (P33-T11) is
    #: checked at statement end, not row by row.
    rank: Mapped[int] = mapped_column(Integer, nullable=False)
    #: ADR 0045 §6: bumped by every template apply (P33-T10).
    template_version: Mapped[int] = mapped_column(
        Integer, nullable=False, default=1, server_default="1"
    )
    copied_from_code: Mapped[str | None] = mapped_column(
        ForeignKey("categories.code", onupdate="RESTRICT", ondelete="RESTRICT"), nullable=True
    )
    active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    __table_args__ = (
        UniqueConstraint("rank", deferrable=True, initially="IMMEDIATE"),
        CheckConstraint(
            f"char_length(code) BETWEEN 1 AND {CATEGORY_CODE_MAX_LENGTH} "
            f"AND code ~ '{CATEGORY_CODE_PATTERN}' "
            f"AND upper(code) <> '{RESERVED_ELIGIBILITY_CODE}'",
            name="code_format",
        ),
        CheckConstraint(
            f"char_length(label) BETWEEN 1 AND {CATEGORY_LABEL_MAX_LENGTH}", name="label_length"
        ),
        CheckConstraint("rank >= 1", name="rank_positive"),
        CheckConstraint("template_version >= 1", name="template_version_positive"),
        # Unique case-insensitively (ADR 0047 §1). An expression index:
        # Alembic autogenerate does not compare these, so the migration owns it.
        Index("ux_categories_code_lower", text("lower(code)"), unique=True),
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return f"<Category {self.code} {self.workflow_id} rank={self.rank}>"
