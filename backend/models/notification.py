"""In-app notifications (P5-T06) — `docs/PROJECT_AND_STACK.md` §2's
cross-cutting "Notifications" line: "in-app notification of schedule changes
affecting a user's hub or assigned projects (delay introduced, project left
out, conflict raised)."

**Design decision — read before extending this module.** This is a
per-recipient FANOUT table (one row per (event, recipient) pair, `read_at`
directly on the row), not a single event row plus a separate join table for
per-user read state. Chosen over the alternative (one row per event +
`NotificationRead(notification_id, user_id, read_at)`) because:

1. It matches this task's own suggested shape most closely (`read_at` living
   directly on the row being listed as a top-level column).
2. `GET /notifications`'s unread-count and `POST /notifications/{id}/read`
   both become a plain `WHERE recipient_user_id = :me` filter/update — no
   join, no upsert-or-update-if-exists branching.
3. Audience membership (who is hub-scoped to hub X, who is Engineer-assigned
   to project Y) is resolved ONCE, at generation time
   (`services/notifications.py::generate_schedule_change_notifications`),
   reusing `core.rbac`/`services.hub_scope`'s existing role/hub-scope model
   rather than inventing a second one — see that module's docstring for the
   full recipient-resolution algorithm.

Trade-off, stated explicitly: a user's audience membership (hub scope, role,
Engineer link) is snapshotted at generation time. A user added to a hub (or
promoted to Hub Planner) AFTER a notification was generated will not
retroactively see that older notification, even though a live "who can see
what" query would now include them. Judged acceptable for an in-app
notification feed (which is inherently forward-looking — "notify me of
changes from here on", not a retroactive audit trail; `AuditLogEntry`
already exists for the latter, unaffected by this design). Revisit if a
future requirement needs guaranteed-retroactive visibility.

**Financial fields**: `message` is free text, always composed only from
`Project.name` / `Hub.name` / plain week-number integers
(`services/notifications.py::_reason_message`) — never `tcogs_eur`/
`selling_price_eur`/`gross_margin_pct`/`customer_name`, per CLAUDE.md's
non-negotiable ("Never log their values" — an in-app notification that a
user's browser renders and that could end up in a screenshot/support ticket
is exactly the kind of surface that rule guards against, even though it is
not literally a server log).
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Enum, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from models.base import Base, TimestampMixin, UUIDPrimaryKeyMixin
from models.enums import NotificationReason

if TYPE_CHECKING:
    from models.hub import Hub
    from models.project import Project
    from models.schedule import ScheduleRun
    from models.user import User


class Notification(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One in-app notification for exactly one recipient, per module
    docstring's fanout design. Immutable except for `read_at`
    (`NULL` -> a single timestamp write, never reverted to `NULL` again —
    see `api/routers/notifications.py`'s mark-read endpoints).
    """

    __tablename__ = "notifications"

    recipient_user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id"), nullable=False
    )

    reason: Mapped[NotificationReason] = mapped_column(
        Enum(
            NotificationReason,
            name="notification_reason",
            values_callable=lambda enum_cls: [e.value for e in enum_cls],
        ),
        nullable=False,
    )

    #: The project this notification is about. Always populated — all three
    #: `NotificationReason` values are inherently per-project (see
    #: `models/enums.py`'s `NotificationReason` docstring); there is no
    #: portfolio-wide/hub-wide-only notification in this task's scope.
    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id"), nullable=False)
    #: Denormalised copy of `Project.hub_id` at generation time, same
    #: rationale as `ScenarioApplyChange.hub_id` (`models/scenario.py`) —
    #: lets `services.hub_scope.hub_scope_filter` compose directly against
    #: this column without a join, and stays correct even if a project's hub
    #: is later reassigned (this row describes the hub the event happened
    #: in, not the project's current hub).
    hub_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("hubs.id"), nullable=False)

    #: Free text, composed once at generation time
    #: (`services.notifications._reason_message`) — never containing a
    #: financial field, per module docstring.
    message: Mapped[str] = mapped_column(String(500), nullable=False)

    #: The newly-activated `ScheduleRun` this notification's event was
    #: detected on.
    schedule_run_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("schedule_runs.id"), nullable=False
    )
    #: The immediately-prior active `ScheduleRun` this event was diffed
    #: against. Nullable only in the sense that the column itself allows it
    #: for schema flexibility, but `services.notifications
    #: .generate_schedule_change_notifications` never actually writes a row
    #: with this `None` — no prior baseline means no diff means no event at
    #: all (see that module's docstring), so every persisted row always has
    #: a real value here in practice.
    previous_schedule_run_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("schedule_runs.id"), nullable=True
    )

    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    recipient: Mapped[User] = relationship(foreign_keys=[recipient_user_id])
    project: Mapped[Project] = relationship()
    hub: Mapped[Hub] = relationship()
    schedule_run: Mapped[ScheduleRun] = relationship(foreign_keys=[schedule_run_id])
    previous_schedule_run: Mapped[ScheduleRun | None] = relationship(
        foreign_keys=[previous_schedule_run_id]
    )

    def __repr__(self) -> str:  # pragma: no cover - debug convenience only
        return (
            f"<Notification {self.reason} project={self.project_id} "
            f"recipient={self.recipient_user_id}>"
        )
