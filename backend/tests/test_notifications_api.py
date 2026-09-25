"""P5-T06 — `GET /notifications`, `POST /notifications/{id}/read`,
`POST /notifications/read-all`.

Covers, per this task's verification checklist:

1. A caller only ever sees their OWN notifications, never another user's
   (`test_list_only_returns_own_notifications`).
2. `unread_only` filters the list; `unread_count` always reflects the
   caller's TOTAL unread count regardless of that filter
   (`test_unread_only_filter_and_unread_count`).
3. Ordering: unread before read, newest first within each group
   (`test_ordering_unread_first_then_newest`).
4. Mark-one-read: idempotent, 404 (not 403) for someone else's/nonexistent
   notification, writes an audit row (`test_mark_read_*`).
5. Mark-all-read: bulk, returns an accurate count, a second call is a no-op
   (`test_mark_all_read_*`).
6. RBAC — every authenticated role (including Auditor, who is never a
   notification recipient) can call these endpoints; only an *unauthenticated*
   caller is rejected (`test_any_authenticated_role_can_read_own_inbox`,
   `test_unauthenticated_rejected`).

Same conventions as `tests/test_scenario_apply_api.py`: a real DB-backed
`User` (for `AuditLogEntry.actor_user_id`'s FK) plus an overridden
`Principal` via `tests.auth_helpers`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, NotificationReason, RoleName
from models.notification import Notification
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_schedule_run, make_user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as_user(db_session, user, *, roles: tuple[RoleName, ...] = (RoleName.ADMIN,)):
    client = _client(db_session)
    override_current_principal(make_principal(*roles, user_id=user.id))
    return client


async def _make_notification(
    db_session,
    *,
    recipient_user_id: uuid.UUID,
    hub,
    project,
    schedule_run,
    reason: NotificationReason = NotificationReason.DELAY_INTRODUCED,
    read_at: datetime | None = None,
    created_at: datetime | None = None,
) -> Notification:
    notification = Notification(
        recipient_user_id=recipient_user_id,
        reason=reason,
        project_id=project.id,
        hub_id=hub.id,
        message=(
            'Project "Test" (R&D-Greece) was delayed: projected finish '
            "moved from week 35 to week 40."
        ),
        schedule_run_id=schedule_run.id,
        previous_schedule_run_id=None,
        read_at=read_at,
    )
    db_session.add(notification)
    await db_session.flush()
    if created_at is not None:
        # Bypass the server_default so ordering tests can control it
        # precisely — `TimestampMixin.created_at` has no app-level default,
        # only `server_default=func.now()`, so a direct UPDATE is needed to
        # backdate a row after insert.
        from sqlalchemy import update

        await db_session.execute(
            update(Notification).where(Notification.id == notification.id).values(
                created_at=created_at
            )
        )
        await db_session.refresh(notification)
    return notification


@pytest.fixture
async def scenario(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub)
    run = await make_schedule_run(db_session, is_active=True)
    recipient = await make_user(db_session, RoleName.PORTFOLIO_MANAGER)
    other_user = await make_user(db_session, RoleName.PORTFOLIO_MANAGER)
    return {
        "hub": hub,
        "project": project,
        "run": run,
        "recipient": recipient,
        "other_user": other_user,
    }


# ---------------------------------------------------------------------------
# GET /notifications
# ---------------------------------------------------------------------------


async def test_list_only_returns_own_notifications(db_session, scenario):
    own = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )
    await _make_notification(
        db_session,
        recipient_user_id=scenario["other_user"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )

    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp = await client.get("/notifications")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["total_count"] == 1
        assert body["unread_count"] == 1
        assert [item["id"] for item in body["items"]] == [str(own.id)]
        assert "$" not in body["items"][0]["message"]
    finally:
        _teardown()


async def test_unread_only_filter_and_unread_count(db_session, scenario):
    await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
        read_at=datetime.now(UTC),
    )
    unread = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )

    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp_all = await client.get("/notifications")
            resp_unread = await client.get("/notifications", params={"unread_only": True})
        assert resp_all.status_code == 200
        assert resp_all.json()["total_count"] == 2
        assert resp_all.json()["unread_count"] == 1

        assert resp_unread.status_code == 200
        unread_body = resp_unread.json()
        assert unread_body["total_count"] == 1
        assert unread_body["unread_count"] == 1
        assert [item["id"] for item in unread_body["items"]] == [str(unread.id)]
    finally:
        _teardown()


async def test_ordering_unread_first_then_newest(db_session, scenario):
    now = datetime.now(UTC)
    older_unread = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
        created_at=now - timedelta(hours=2),
    )
    newer_read = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
        read_at=now,
        created_at=now - timedelta(hours=1),
    )
    newest_unread = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
        created_at=now,
    )

    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp = await client.get("/notifications")
        assert resp.status_code == 200
        ids = [item["id"] for item in resp.json()["items"]]
        # Unread first (newest_unread before older_unread, both before the
        # read one), then newest-first within each group.
        assert ids == [str(newest_unread.id), str(older_unread.id), str(newer_read.id)]
    finally:
        _teardown()


async def test_limit_and_offset_validation(db_session, scenario):
    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp_bad_limit = await client.get("/notifications", params={"limit": 0})
            resp_bad_offset = await client.get("/notifications", params={"offset": -1})
        assert resp_bad_limit.status_code == 422
        assert resp_bad_offset.status_code == 422
    finally:
        _teardown()


# ---------------------------------------------------------------------------
# POST /notifications/{id}/read
# ---------------------------------------------------------------------------


async def test_mark_read_marks_and_is_idempotent(db_session, scenario):
    notification = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )

    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp1 = await client.post(f"/notifications/{notification.id}/read")
            assert resp1.status_code == 200, resp1.text
            first_read_at = resp1.json()["read_at"]
            assert first_read_at is not None

            resp2 = await client.post(f"/notifications/{notification.id}/read")
            assert resp2.status_code == 200
            assert resp2.json()["read_at"] == first_read_at  # unchanged, idempotent

        audit_rows = (
            (
                await db_session.execute(
                    select(AuditLogEntry).where(
                        AuditLogEntry.action == "notification.read",
                        AuditLogEntry.entity_id == str(notification.id),
                    )
                )
            )
            .scalars()
            .all()
        )
        assert len(audit_rows) == 1  # only the FIRST mark-read wrote an audit row
        assert audit_rows[0].hub_id == scenario["hub"].id
    finally:
        _teardown()


async def test_mark_read_404_for_other_users_notification(db_session, scenario):
    other_notification = await _make_notification(
        db_session,
        recipient_user_id=scenario["other_user"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )

    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp = await client.post(f"/notifications/{other_notification.id}/read")
        assert resp.status_code == 404
    finally:
        _teardown()


async def test_mark_read_404_for_nonexistent_notification(db_session, scenario):
    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp = await client.post(f"/notifications/{uuid.uuid4()}/read")
        assert resp.status_code == 404
    finally:
        _teardown()


# ---------------------------------------------------------------------------
# POST /notifications/read-all
# ---------------------------------------------------------------------------


async def test_mark_all_read(db_session, scenario):
    n1 = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )
    n2 = await _make_notification(
        db_session,
        recipient_user_id=scenario["recipient"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )
    # Someone else's unread notification must never be touched.
    other = await _make_notification(
        db_session,
        recipient_user_id=scenario["other_user"].id,
        hub=scenario["hub"],
        project=scenario["project"],
        schedule_run=scenario["run"],
    )

    try:
        client = await _as_user(db_session, scenario["recipient"])
        async with client:
            resp = await client.post("/notifications/read-all")
            assert resp.status_code == 200
            assert resp.json()["marked_count"] == 2

            resp_again = await client.post("/notifications/read-all")
            assert resp_again.status_code == 200
            assert resp_again.json()["marked_count"] == 0  # nothing left unread

        await db_session.refresh(n1)
        await db_session.refresh(n2)
        await db_session.refresh(other)
        assert n1.read_at is not None
        assert n2.read_at is not None
        assert other.read_at is None  # untouched — different recipient

        audit_rows = (
            (
                await db_session.execute(
                    select(AuditLogEntry).where(AuditLogEntry.action == "notification.read_all")
                )
            )
            .scalars()
            .all()
        )
        assert len(audit_rows) == 1  # only the first call (marked_count > 0) wrote one
        assert audit_rows[0].hub_id is None  # may span multiple hubs
    finally:
        _teardown()


# ---------------------------------------------------------------------------
# RBAC — per-user, not per-surface
# ---------------------------------------------------------------------------


async def test_any_authenticated_role_can_read_own_inbox(db_session, scenario):
    """Auditor holds no permission on DASHBOARD/CAPACITY/GANTT/MATRIX at all
    (per `core.rbac.PERMISSIONS`) and is therefore never a generation-time
    recipient — but this endpoint itself must still return 200 (an empty
    list), never 403: it is per-user, not per-surface.
    """

    auditor = await make_user(db_session, RoleName.AUDITOR)
    try:
        client = await _as_user(db_session, auditor, roles=(RoleName.AUDITOR,))
        async with client:
            resp = await client.get("/notifications")
        assert resp.status_code == 200
        assert resp.json()["items"] == []
        assert resp.json()["unread_count"] == 0
    finally:
        _teardown()


async def test_unauthenticated_rejected(db_session):
    client = _client(db_session)
    try:
        async with client:
            resp = await client.get("/notifications")
        assert resp.status_code == 401
    finally:
        _teardown()
