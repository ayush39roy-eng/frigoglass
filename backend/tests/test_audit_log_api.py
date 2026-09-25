"""`GET /audit-log` (`api/routers/audit_log.py`, P3-T04) — the audit-log read
surface. The write-side (every mutation writes a real `AuditLogEntry`) and
DB-level append-only enforcement are already covered by
`tests/test_audit_trigger.py` / `tests/test_audit_truncate_trigger.py` /
`tests/test_currency_api.py` and every router's own mutation tests — this
file is only about the new `GET` endpoint: RBAC gating, filtering,
pagination, and financial-field redaction on read.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import HubName, LabRegion, RoleName
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_user


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _teardown():
    app.dependency_overrides.pop(get_db, None)
    clear_current_principal_override()


async def _as(db_session, *roles: RoleName) -> AsyncClient:
    user = await make_user(db_session, *roles)
    client = _client(db_session)
    override_current_principal(make_principal(*roles, user_id=user.id))
    return client, user


async def _make_entry(
    db_session,
    *,
    action: str = "project.update",
    entity_type: str = "Project",
    entity_id: str | None = None,
    actor_user_id: uuid.UUID | None = None,
    hub_id: uuid.UUID | None = None,
    occurred_at: datetime | None = None,
    before_state: dict | None = None,
    after_state: dict | None = None,
) -> AuditLogEntry:
    entry = AuditLogEntry(
        action=action,
        entity_type=entity_type,
        entity_id=entity_id or str(uuid.uuid4()),
        actor_user_id=actor_user_id,
        hub_id=hub_id,
        occurred_at=occurred_at or datetime.now(UTC),
        before_state=before_state,
        after_state=after_state,
    )
    db_session.add(entry)
    await db_session.flush()
    return entry


# --------------------------------------------------------------------------
# RBAC
# --------------------------------------------------------------------------


async def test_audit_log_requires_authentication(db_session):
    try:
        async with _client(db_session) as client:
            resp = await client.get("/audit-log")
        assert resp.status_code == 401
    finally:
        _teardown()


@pytest.mark.parametrize(
    "role",
    [
        RoleName.PORTFOLIO_MANAGER,
        RoleName.HUB_PLANNER,
        RoleName.ENGINEER,
        RoleName.EXECUTIVE_VIEWER,
    ],
)
async def test_audit_log_forbidden_for_every_non_auditor_non_admin_role(db_session, role):
    try:
        client, _ = await _as(db_session, role)
        async with client:
            resp = await client.get("/audit-log")
        assert resp.status_code == 403
    finally:
        _teardown()


async def test_audit_log_allowed_for_auditor(db_session):
    await _make_entry(db_session)
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp = await client.get("/audit-log")
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_count"] >= 1
        assert len(body["items"]) >= 1
    finally:
        _teardown()


async def test_audit_log_allowed_for_admin(db_session):
    await _make_entry(db_session)
    try:
        client, _ = await _as(db_session, RoleName.ADMIN)
        async with client:
            resp = await client.get("/audit-log")
        assert resp.status_code == 200
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Response shape
# --------------------------------------------------------------------------


async def test_audit_log_item_shape_matches_model_fields(db_session):
    entry = await _make_entry(
        db_session,
        action="project.create",
        entity_type="Project",
        before_state=None,
        after_state={"name": "X"},
    )
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp = await client.get("/audit-log", params={"entity_id": entry.entity_id})
        assert resp.status_code == 200
        item = resp.json()["items"][0]
        assert item["id"] == str(entry.id)
        assert item["action"] == "project.create"
        assert item["entity_type"] == "Project"
        assert item["entity_id"] == entry.entity_id
        assert item["before_state"] is None
        assert item["after_state"] == {"name": "X"}
        assert "occurred_at" in item
        assert "actor_user_id" in item
        assert "hub_id" in item
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Filtering
# --------------------------------------------------------------------------


async def test_audit_log_filters_by_entity_type_and_entity_id(db_session):
    target_id = str(uuid.uuid4())
    await _make_entry(db_session, entity_type="Project", entity_id=target_id)
    await _make_entry(db_session, entity_type="Project", entity_id=str(uuid.uuid4()))
    await _make_entry(db_session, entity_type="Engineer", entity_id=target_id)
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp = await client.get(
                "/audit-log", params={"entity_type": "Project", "entity_id": target_id}
            )
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_count"] == 1
        assert body["items"][0]["entity_type"] == "Project"
        assert body["items"][0]["entity_id"] == target_id
    finally:
        _teardown()


async def test_audit_log_filters_by_actor_user_id(db_session):
    hub = await make_hub(db_session)
    actor = await make_user(db_session, RoleName.HUB_PLANNER)
    other_actor = await make_user(db_session, RoleName.HUB_PLANNER)
    await _make_entry(db_session, actor_user_id=actor.id, hub_id=hub.id)
    await _make_entry(db_session, actor_user_id=other_actor.id, hub_id=hub.id)
    await _make_entry(db_session, actor_user_id=None, hub_id=hub.id)
    try:
        client, _ = await _as(db_session, RoleName.ADMIN)
        async with client:
            resp = await client.get("/audit-log", params={"actor_user_id": str(actor.id)})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_count"] == 1
        assert body["items"][0]["actor_user_id"] == str(actor.id)
    finally:
        _teardown()


async def test_audit_log_filters_by_action(db_session):
    await _make_entry(db_session, action="project.create")
    await _make_entry(db_session, action="project.update")
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp = await client.get("/audit-log", params={"action": "project.create"})
        assert resp.status_code == 200
        body = resp.json()
        assert body["total_count"] == 1
        assert body["items"][0]["action"] == "project.create"
    finally:
        _teardown()


async def test_audit_log_filters_by_hub_id_as_convenience_narrowing_not_access_control(db_session):
    """Confirms `hub_id` is a filter, not row-level scoping — an Auditor
    passing another hub's `hub_id` narrows their own view but is never 403'd
    (unlike P3-T03's hub-scoped surfaces), since the matrix's Auditor
    qualifier is "R (all)", not "(own hub)".
    """
    hub_a = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    hub_b = await make_hub(db_session, name=HubName.RD_INDIA, lab_region=LabRegion.INDIA)
    await _make_entry(db_session, hub_id=hub_a.id)
    await _make_entry(db_session, hub_id=hub_b.id)
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp_a = await client.get("/audit-log", params={"hub_id": str(hub_a.id)})
            resp_all = await client.get("/audit-log")
        assert resp_a.status_code == 200
        assert resp_a.json()["total_count"] == 1
        assert resp_all.status_code == 200
        assert resp_all.json()["total_count"] == 2
    finally:
        _teardown()


async def test_audit_log_filters_by_date_range(db_session):
    now = datetime.now(UTC)
    old = await _make_entry(db_session, occurred_at=now - timedelta(days=30))
    recent = await _make_entry(db_session, occurred_at=now - timedelta(hours=1))
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp = await client.get(
                "/audit-log",
                params={"occurred_from": (now - timedelta(days=1)).isoformat()},
            )
        assert resp.status_code == 200
        ids = {item["id"] for item in resp.json()["items"]}
        assert str(recent.id) in ids
        assert str(old.id) not in ids
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Pagination
# --------------------------------------------------------------------------


async def test_audit_log_pagination_limit_and_offset(db_session):
    for i in range(5):
        await _make_entry(
            db_session,
            entity_id=f"page-test-{i}",
            occurred_at=datetime.now(UTC) - timedelta(minutes=i),
        )
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            first_page = await client.get(
                "/audit-log", params={"entity_type": "Project", "limit": 2, "offset": 0}
            )
            second_page = await client.get(
                "/audit-log", params={"entity_type": "Project", "limit": 2, "offset": 2}
            )
        assert first_page.status_code == 200
        assert second_page.status_code == 200
        first_ids = [item["id"] for item in first_page.json()["items"]]
        second_ids = [item["id"] for item in second_page.json()["items"]]
        assert len(first_ids) == 2
        assert len(second_ids) == 2
        assert set(first_ids).isdisjoint(second_ids)
        assert first_page.json()["total_count"] >= 5
    finally:
        _teardown()


async def test_audit_log_limit_out_of_range_returns_422(db_session):
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            too_big = await client.get("/audit-log", params={"limit": 501})
            too_small = await client.get("/audit-log", params={"limit": 0})
        assert too_big.status_code == 422
        assert too_small.status_code == 422
    finally:
        _teardown()


async def test_audit_log_negative_offset_returns_422(db_session):
    try:
        client, _ = await _as(db_session, RoleName.AUDITOR)
        async with client:
            resp = await client.get("/audit-log", params={"offset": -1})
        assert resp.status_code == 422
    finally:
        _teardown()


# --------------------------------------------------------------------------
# Financial-field redaction on read (explicit acceptance item)
# --------------------------------------------------------------------------


async def test_audit_log_never_exposes_real_financial_values_to_admin_or_auditor(db_session):
    """A project create with real financial-field values, read back through
    `GET /audit-log` by BOTH Auditor and Admin, must show the literal string
    `"<redacted>"` for every one of `models.types.FINANCIAL_FIELD_NAMES` —
    never the real value — because `services.audit_helpers.project_audit_state`
    (called by `api/routers/projects.py::create_project`) writes that literal
    at audit-row-creation time and never reads the real value into the
    process at all. This test exercises the full real path (a real API
    mutation, not a hand-built `AuditLogEntry` fixture) specifically to prove
    the read surface doesn't add or need any redaction step of its own.
    """
    hub = await make_hub(db_session)
    try:
        write_client, _ = await _as(db_session, RoleName.HUB_PLANNER)
        async with write_client:
            create_resp = await write_client.post(
                "/projects",
                json={
                    "name": "Redaction Test Project",
                    "hub_id": str(hub.id),
                    "customer_name": "Coca-Cola HBC",
                    "tcogs_eur": 12345.67,
                    "selling_price_eur": 99999.99,
                    "gross_margin_pct": 42.5,
                },
            )
        assert create_resp.status_code == 201
        project_id = create_resp.json()["id"]
        # Sanity check: the *authorized project-registration read* DOES show
        # the real value (financial fields are ordinary authorized-read data
        # per `schemas/project.py`'s own docstring — only audit/log surfaces
        # redact). If this weren't true, the redaction test below would be
        # vacuous.
        assert create_resp.json()["customer_name"] == "Coca-Cola HBC"
    finally:
        _teardown()

    for role in (RoleName.AUDITOR, RoleName.ADMIN):
        try:
            read_client, _ = await _as(db_session, role)
            async with read_client:
                resp = await read_client.get(
                    "/audit-log",
                    params={
                        "entity_type": "Project",
                        "entity_id": project_id,
                        "action": "project.create",
                    },
                )
            assert resp.status_code == 200
            items = resp.json()["items"]
            assert len(items) == 1
            after = items[0]["after_state"]
            assert after["customer_name"] == "<redacted>"
            assert after["tcogs_eur"] == "<redacted>"
            assert after["selling_price_eur"] == "<redacted>"
            assert after["gross_margin_pct"] == "<redacted>"
            # And confirm none of the real values leaked in as a substring
            # anywhere in the raw response body, not just the four named keys.
            raw = resp.text
            assert "Coca-Cola HBC" not in raw
            assert "12345.67" not in raw
            assert "99999.99" not in raw
        finally:
            _teardown()
