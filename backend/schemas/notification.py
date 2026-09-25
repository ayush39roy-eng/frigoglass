"""Pydantic request/response models for `GET /notifications`,
`POST /notifications/{id}/read` and `POST /notifications/read-all`
(P5-T06) — `docs/PROJECT_AND_STACK.md` §2's cross-cutting "Notifications"
line.

No financial field ever appears here — `NotificationRead.message` is the
free text `services.notifications._reason_message` composed at generation
time (project name / hub name / plain week numbers only; see
`models/notification.py`'s module docstring for the CLAUDE.md rationale).
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

from models.enums import NotificationReason


class NotificationRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    reason: NotificationReason
    project_id: uuid.UUID
    hub_id: uuid.UUID
    message: str
    schedule_run_id: uuid.UUID
    previous_schedule_run_id: uuid.UUID | None
    read_at: datetime | None
    created_at: datetime


class NotificationList(BaseModel):
    """Response for `GET /notifications`. `unread_count` always reflects the
    caller's TOTAL unread count (ignoring `unread_only`/pagination) so a UI
    can render a badge from this same response without a second request;
    `total_count` reflects the filtered result set's size, for pagination.
    """

    items: list[NotificationRead]
    total_count: int
    unread_count: int
    limit: int
    offset: int


class NotificationMarkReadResponse(BaseModel):
    """Response for `POST /notifications/{id}/read`. Idempotent: marking an
    already-read notification read again returns its existing `read_at`
    unchanged, not an error.
    """

    id: uuid.UUID
    read_at: datetime


class NotificationMarkAllReadResponse(BaseModel):
    """Response for `POST /notifications/read-all`."""

    marked_count: int = Field(
        description="Number of previously-unread notifications this call marked read."
    )
