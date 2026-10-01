from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import ProjectAccessRole

if TYPE_CHECKING:
    from models.project import Project
    from models.user import User


class ProjectAccessGrant(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A project-scoped Viewer/Editor/Admin access grant (2026-09-30, ADR
    0012). Gives one user access to one project beyond whatever their
    global role + hub scope (ADR 0010) already provides —
    `services.project_access.effective_project_access` composes a grant's
    `project_role` with the ADR 0010 matrix via MAX, never as a reduction:
    revoking a grant returns a principal to whatever their global role/hub
    scope alone would give them, never below it.

    `created_at` (from `TimestampMixin`) doubles as "granted at". Revoking
    sets `revoked_at` and never deletes the row (an audit-friendly append
    style — see `services/audit_helpers.py`'s neighbouring convention of
    never hard-deleting history); re-granting after a revoke inserts a NEW
    row rather than reusing this one.

    **At most one active grant per `(project, user)`** is enforced by the
    partial UNIQUE index `ux_project_access_grants_one_active` on
    `(project_id, user_id) WHERE revoked_at IS NULL`, created in the P10-T01
    migration — a real DB constraint (not an application-level
    check-then-insert, which would race under concurrent grant attempts),
    deliberately NOT declared here as a SQLAlchemy `Index`/`UniqueConstraint`
    object. This mirrors `models.schedule.ScheduleRun.is_active`'s identical
    convention exactly (see that model's own docstring: "...migration
    (`WHERE is_active`)") — Alembic autogenerate has repeatedly produced
    false-positive drop/recreate diffs for these hand-written partial
    indexes (see `alembic/versions/2418c6385a72_notifications.py`'s comment),
    so keeping them out of the ORM model sidesteps that entirely. The same
    index also serves as this table's hot-path lookup index for "does this
    user have an active grant on this project".
    """

    __tablename__ = "project_access_grants"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    project_role: Mapped[ProjectAccessRole] = mapped_column(
        Enum(
            ProjectAccessRole,
            name="project_access_role",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )
    #: Who created this grant (the manager/Admin/Super Admin that authorized
    #: it per I18) — not necessarily the same principal who later revokes it.
    granted_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"), nullable=False)
    #: NULL while active. See class docstring: set once, the row is never
    #: reused for a later re-grant.
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    project: Mapped[Project] = relationship(foreign_keys=[project_id])
    user: Mapped[User] = relationship(foreign_keys=[user_id])
    granted_by: Mapped[User] = relationship(foreign_keys=[granted_by_user_id])

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return (
            f"<ProjectAccessGrant project={self.project_id} user={self.user_id} "
            f"role={self.project_role}>"
        )
