"""The What-if import format and saved import scenarios (P41-T02, ADR 0055).

- `ImportFormatSettings`: one row (id = 1) holding the header aliases the
  workbook parser recognises per field (ADR 0055 D1). No row means the
  built-in aliases (`services.plan_import_xlsx._FIELDS`), `version` 0.
- `WhatifImportScenario`: a saved import scenario (ADR 0055 D3), a frozen
  record of a server-recomputed simulate request and its served response.
  It never feeds the live plan. Neither JSONB column carries a financial field:
  `ImportSimulateRequest` / `ImportSimulateResponse` have none (a test
  asserts this on a stored row).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import ARRAY, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin


class ImportFormatSettings(Base):
    __tablename__ = "import_format_settings"
    __table_args__ = (
        CheckConstraint("id = 1", name="single_row"),
        CheckConstraint("version >= 1", name="version_positive"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    #: field key -> list of normalised aliases (FIELD_KEYS order).
    field_aliases: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class WhatifImportScenario(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "whatif_import_scenarios"
    __table_args__ = (
        CheckConstraint("mode IN ('merge', 'file_only')", name="mode_valid"),
        CheckConstraint("plan_year_end_week IN (52, 104)", name="plan_year_end_valid"),
        CheckConstraint("char_length(name) BETWEEN 1 AND 120", name="name_length"),
        Index("ix_whatif_import_scenarios_created_by", "created_by"),
        Index("ix_whatif_import_scenarios_source_file_sha256", "source_file_sha256"),
        Index("ix_whatif_import_scenarios_created_at", text("created_at DESC")),
    )

    name: Mapped[str] = mapped_column(String(120), nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    source_file_name: Mapped[str] = mapped_column(String(200), nullable=False)
    source_file_sha256: Mapped[str] = mapped_column(String(64), nullable=False)
    imported_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    mode: Mapped[str] = mapped_column(String(16), nullable=False)
    plan_year_end_week: Mapped[int] = mapped_column(Integer, nullable=False)
    simulated_week: Mapped[int] = mapped_column(Integer, nullable=False)
    plan_version: Mapped[int | None] = mapped_column(Integer, nullable=True)
    hub_codes: Mapped[list[str]] = mapped_column(ARRAY(Text), nullable=False)
    request: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    result: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    #: P41-R01 (M-1): `result["kpis"]`, kept apart so the list never reads
    #: the (up to 8 MB) result.
    kpis: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
