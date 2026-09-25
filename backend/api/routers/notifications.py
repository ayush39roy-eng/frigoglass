"""In-app notifications (P5-T06) — `docs/PROJECT_AND_STACK.md` §2's
cross-cutting "Notifications" line: "in-app notification of schedule changes
affecting a user's hub or assigned projects (delay introduced, project left
out, conflict raised)." Read-only browse + mark-read only, per that line's
"in-app" scope — no email/Slack/push, no SSE (a simple pollable list is
sufficient; see `docs/MEMORY.md`'s P5-T06 entry for why SSE was considered
and declined). Generation happens elsewhere (`services/notifications.py`,
triggered from `services.schedule_persistence.persist_schedule_output`) —
this router only ever reads/mutates already-written rows, never computes a
notification itself.

**RBAC — deliberately `Depends(get_current_principal)`, NOT
`require_permission`/`require_roles`.** Every other router in this codebase
gates on `core.rbac.Surface`/`Action` (a per-SURFACE permission) because
those endpoints expose data scoped by ROLE — "can a Hub Planner read
Capacity at all". Notifications are different: `GET /notifications` (and
the two mark-read endpoints) are inherently PER-USER, not per-surface —
every authenticated role (including Auditor, who reads no surface this
feature's recipient-eligibility check would otherwise grant, per
`services.notifications._NOTIFICATION_SURFACES`) is allowed to read/manage
their own notification inbox; a role that was simply never resolved as a
recipient for anything just sees an empty list, which is the correct
"nothing to show you" outcome, not a 403. Checked `core/rbac.py` first for a
precedent (per this task's brief) — there is none; every existing
`Surface` maps to one of the six client-facing surfaces plus Audit Log/User-
Role-Admin, and none of them is "a user's own inbox". Row-level scoping here
is therefore `recipient_user_id == current_user.user_id` (enforced in every
query below), not `services.hub_scope.hub_scope_filter` — a Notification row
already encodes ITS recipient at generation time (see
`models/notification.py`'s fanout design), so there is nothing left to
hub-scope at read time; hub-scoping already happened once, upstream, at
generation.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import get_current_principal
from core.principal import Principal
from models.audit import AuditLogEntry
from models.notification import Notification
from schemas.notification import (
    NotificationList,
    NotificationMarkAllReadResponse,
    NotificationMarkReadResponse,
    NotificationRead,
)

router = APIRouter(prefix="/notifications", tags=["notifications"])


@router.get("", response_model=NotificationList)
async def list_notifications(
    unread_only: bool = False,
    limit: int = 50,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> NotificationList:
    """The caller's own notifications, unread-first then newest-first.
    `unread_only=True` narrows the LIST to unread rows only; `unread_count`
    in the response always reflects the caller's total unread count
    regardless of that filter (see `schemas.notification.NotificationList`).
    """

    if limit < 1 or limit > 200:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 200")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")

    base_filter = Notification.recipient_user_id == current_user.user_id

    unread_count_stmt = select(func.count()).select_from(Notification).where(
        base_filter, Notification.read_at.is_(None)
    )
    unread_count = (await db.execute(unread_count_stmt)).scalar_one()

    count_stmt = select(func.count()).select_from(Notification).where(base_filter)
    if unread_only:
        count_stmt = count_stmt.where(Notification.read_at.is_(None))
    total_count = (await db.execute(count_stmt)).scalar_one()

    stmt = select(Notification).where(base_filter)
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    # Unread first (NULL read_at sorts as True/"1" under `.is_(None)`, so
    # `.desc()` puts unread rows before read ones), then newest first within
    # each group.
    stmt = (
        stmt.order_by(Notification.read_at.is_(None).desc(), Notification.created_at.desc())
        .limit(limit)
        .offset(offset)
    )
    rows = (await db.execute(stmt)).scalars().all()
    items = [NotificationRead.model_validate(row) for row in rows]

    return NotificationList(
        items=items,
        total_count=total_count,
        unread_count=unread_count,
        limit=limit,
        offset=offset,
    )


@router.post("/{notification_id}/read", response_model=NotificationMarkReadResponse)
async def mark_notification_read(
    notification_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> NotificationMarkReadResponse:
    """Mark ONE of the caller's own notifications read. 404 (never 403) for
    a notification that doesn't exist or belongs to a different recipient —
    matching this codebase's established not-found-over-403 convention
    (`api/routers/exports.py`'s owner-scoped job endpoints; `api/routers/
    scenarios.py`'s hub-scoped version detail) rather than confirming a
    specific notification id exists to a caller who cannot see it. Idempotent:
    an already-read notification's existing `read_at` is returned unchanged.
    """

    notification = await db.get(Notification, notification_id)
    if notification is None or notification.recipient_user_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Notification not found")

    if notification.read_at is None:
        notification.read_at = datetime.now(UTC)
        db.add(notification)
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="notification.read",
                entity_type="Notification",
                entity_id=str(notification.id),
                hub_id=notification.hub_id,
                before_state=None,
                after_state={"read_at": notification.read_at.isoformat()},
            )
        )
        await db.commit()
        await db.refresh(notification)

    return NotificationMarkReadResponse(id=notification.id, read_at=notification.read_at)


@router.post("/read-all", response_model=NotificationMarkAllReadResponse)
async def mark_all_notifications_read(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> NotificationMarkAllReadResponse:
    """Mark every currently-unread notification of the caller's own read, in
    one bulk `UPDATE`. `hub_id=None` on the audit row, same rationale as
    `api/routers/scenarios.py`'s own `apply_scenario` audit entry — this
    action can span notifications from more than one hub.

    `marked_count` is derived from a `SELECT`-first list of the exact ids
    being updated (rather than the `UPDATE` result's `.rowcount`) —
    `AsyncSession.execute(...)`'s declared return type (`Result[Any]`) does
    not expose `.rowcount` at all under strict mypy, and this avoids
    depending on a driver-specific runtime attribute for something this
    endpoint can just as easily know upfront.
    """

    unread_ids = (
        (
            await db.execute(
                select(Notification.id).where(
                    Notification.recipient_user_id == current_user.user_id,
                    Notification.read_at.is_(None),
                )
            )
        )
        .scalars()
        .all()
    )
    marked_count = len(unread_ids)
    if marked_count:
        await db.execute(
            update(Notification)
            .where(Notification.id.in_(unread_ids))
            .values(read_at=datetime.now(UTC))
        )

    if marked_count:
        db.add(
            AuditLogEntry(
                actor_user_id=current_user.user_id,
                action="notification.read_all",
                entity_type="Notification",
                entity_id="*",
                hub_id=None,
                before_state=None,
                after_state={"marked_count": marked_count},
            )
        )
    await db.commit()

    return NotificationMarkAllReadResponse(marked_count=marked_count)
