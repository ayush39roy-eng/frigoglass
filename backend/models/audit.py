from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, String, Text, func
from sqlalchemy.dialects.postgresql import INET, JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base

if TYPE_CHECKING:
    from models.hub import Hub
    from models.user import User

#: `before_state` / `after_state` JSONB snapshots must never contain the raw
#: value of a financial/PII field. Cross-reference with
#: `models.types.FINANCIAL_FIELD_NAMES` — whoever writes an AuditLogEntry (P3)
#: must redact these keys (e.g. replace with `"<redacted>"`) before serialising
#: a model instance's `__dict__`/diff into these columns. This module cannot
#: enforce that at the DB layer (JSONB has no schema); it is a hard requirement
#: on the writer, called out here per CLAUDE.md's "never logged" non-negotiable.


class AuditLogEntry(Base):
    """Immutable, append-only audit log. Every mutation (per CLAUDE.md: "Every
    mutation writes an audit row to the immutable append-only audit log")
    writes exactly one row here.

    Deliberately has NO `updated_at` / `TimestampMixin` and no ORM-level update
    path is expected to ever touch an existing row — application code (P3)
    must only ever INSERT into this table. True DB-level append-only enforcement
    (e.g. a Postgres trigger rejecting UPDATE/DELETE, or REVOKE on those grants)
    is a P1-T02 migration concern, not expressible in the SQLAlchemy model
    layer alone — flagged here so P1-T02 doesn't forget it.
    """

    __tablename__ = "audit_log_entries"

    id: Mapped[uuid.UUID] = mapped_column(primary_key=True, default=uuid.uuid4)
    occurred_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    #: Nullable: some audit rows originate from system/background processes
    #: (e.g. an unattended scheduled ScheduleRun) with no human actor.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)

    #: e.g. "project.create", "project.update", "priority.apply",
    #: "schedule_run.create", "engineer.update", "chamber.update". Free text
    #: (not an enum) since the set of auditable actions spans every mutating
    #: endpoint across P3-P5 and is expected to grow; a DB migration per new
    #: action would be an unreasonable coupling.
    action: Mapped[str] = mapped_column(String(150), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(100), nullable=False)
    entity_id: Mapped[str] = mapped_column(String(100), nullable=False)

    #: For hub-scoped audit filtering (Auditor role has R access to "all", but
    #: a Hub Planner reviewing their own hub's history benefits from this being
    #: indexed and queryable directly rather than joined out of entity_id).
    #: Nullable for hub-agnostic actions (e.g. user/role admin).
    hub_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("hubs.id"), nullable=True)

    #: Redacted JSON snapshots — see module-level note above. Nullable (e.g. a
    #: pure "create" has no before_state; a pure "delete" has no after_state).
    before_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    after_state: Mapped[dict | None] = mapped_column(JSONB, nullable=True)

    request_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    ip_address: Mapped[str | None] = mapped_column(INET, nullable=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    actor: Mapped[User | None] = relationship(foreign_keys=[actor_user_id])
    hub: Mapped[Hub | None] = relationship(foreign_keys=[hub_id])

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        # Never include before_state/after_state here.
        return f"<AuditLogEntry {self.action} {self.entity_type}:{self.entity_id}>"
