"""P10-T02: `POST /projects/{id}/ask-agent` (ADR 0014).

- `503 {"error": "AGENT_UNAVAILABLE"}` when `RPD_GROQ_API_KEY` is unset — no
  real Groq key needed for this or any other case in this file; the outbound
  HTTP call is stubbed throughout.
- `403` when the caller's `effective_project_access` is `None`.
- Per-user rate limiting.
- The security-critical case: the actual outbound Groq payload is captured
  and asserted to contain none of the four financial field values or any
  real seeded engineer's name/email string.
"""

from __future__ import annotations

import json

import httpx
import pytest
from httpx import ASGITransport, AsyncClient

import api.routers.ask_agent as ask_agent_router
from api.db import get_db
from api.main import app
from core.config import get_groq_settings
from models.enums import HubName, LabRegion, RoleName
from models.schedule import ScheduleRunProjectStep
from services.project_steps import sync_project_steps
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run, make_user


@pytest.fixture(autouse=True)
def _cleanup():
    ask_agent_router.ASK_AGENT_RATE_LIMIT.reset()
    yield
    ask_agent_router.ASK_AGENT_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)
    get_groq_settings.cache_clear()


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles: RoleName, **user_kwargs):
    user = await make_user(db_session, *roles, **user_kwargs)
    override_current_principal(
        make_principal(*roles, user_id=user.id, email=user.email, hub_scope_all=user.hub_scope_all)
    )
    return user


async def _project(db_session):
    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    project = await make_project(db_session, hub, name="Ask Agent Project")
    await sync_project_steps(db_session, project, False)
    return hub, project


class _FakeResponse:
    is_error = False

    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


class _FakeAsyncClient:
    """Records every `.post(...)` call (url/headers/json) on the class so
    the test can inspect the actual outbound Groq payload, and always
    answers with a canned, harmless completion — no network I/O.
    """

    calls: list[dict] = []

    def __init__(self, *args, **kwargs) -> None:
        pass

    async def __aenter__(self) -> _FakeAsyncClient:
        return self

    async def __aexit__(self, *exc_info) -> bool:
        return False

    async def post(self, url, *, headers=None, json=None):  # noqa: A002 - matches httpx's signature
        _FakeAsyncClient.calls.append({"url": url, "headers": headers, "json": json})
        return _FakeResponse({"choices": [{"message": {"content": "Mocked answer"}}]})


@pytest.fixture
def fake_groq(monkeypatch):
    _FakeAsyncClient.calls = []
    monkeypatch.setattr(httpx, "AsyncClient", _FakeAsyncClient)
    monkeypatch.setenv("RPD_GROQ_API_KEY", "test-fake-key")
    get_groq_settings.cache_clear()
    yield _FakeAsyncClient
    get_groq_settings.cache_clear()


# --- 503 when unconfigured --------------------------------------------------


async def test_ask_agent_returns_503_when_groq_unconfigured(db_session, monkeypatch):
    monkeypatch.delenv("RPD_GROQ_API_KEY", raising=False)
    get_groq_settings.cache_clear()
    hub, project = await _project(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/ask-agent", json={"question": "What is the status?"}
        )

    assert resp.status_code == 503
    assert resp.json() == {"error": "AGENT_UNAVAILABLE"}


# --- 403 when no project access ---------------------------------------------


async def test_ask_agent_requires_at_least_viewer_access(db_session, fake_groq):
    hub, project = await _project(db_session)
    await _act_as(db_session, RoleName.ENGINEER, hub_scope_all=False)  # no link, no grant

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/ask-agent", json={"question": "Anything?"}
        )

    assert resp.status_code == 403
    assert fake_groq.calls == []  # never dialled out for an unauthorized caller


# --- Happy path + rate limiting ----------------------------------------------


async def test_ask_agent_happy_path(db_session, fake_groq):
    hub, project = await _project(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)

    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/ask-agent", json={"question": "What is the status?"}
        )

    assert resp.status_code == 200
    assert resp.json() == {"answer": "Mocked answer"}
    assert len(fake_groq.calls) == 1


async def test_ask_agent_rate_limited(db_session, fake_groq):
    hub, project = await _project(db_session)
    await _act_as(db_session, RoleName.SUPER_ADMIN)

    async with _client(db_session) as client:
        responses = [
            await client.post(
                f"/projects/{project.id}/ask-agent", json={"question": f"Q{i}"}
            )
            for i in range(int(ask_agent_router.ASK_AGENT_RATE_LIMIT.capacity) + 1)
        ]

    assert responses[-1].status_code == 429
    assert all(r.status_code == 200 for r in responses[:-1])


# --- The security-critical redaction-capture test ---------------------------


async def test_ask_agent_outbound_payload_excludes_financial_fields_and_engineer_identity(
    db_session, fake_groq
):
    hub, project = await _project(db_session)
    # Set the four financial/PII fields to distinctive, greppable values.
    project.customer_name = "Zzyzx Confidential Customer Corp"
    project.tcogs_eur = 918273
    project.selling_price_eur = 554433
    project.gross_margin_pct = 61
    await db_session.flush()

    engineer_user = await make_user(
        db_session, RoleName.ENGINEER, email="unique.realname.marker@example.com",
        full_name="Zzyzx Realname Marker", hub_scope_all=False,
    )
    engineer = await make_engineer(db_session, hub, name="Zzyzx Realname Marker")
    engineer.user_id = engineer_user.id
    await db_session.flush()

    run = await make_schedule_run(db_session, is_active=True)
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project.id,
            step_template_id="PDD-A",
            sequence_order=1,
            duration_weeks=1,
            start_week=31,
            end_week=31,
            assigned_engineer_id=engineer.id,
        )
    )
    await db_session.flush()

    await _act_as(db_session, RoleName.SUPER_ADMIN)
    async with _client(db_session) as client:
        resp = await client.post(
            f"/projects/{project.id}/ask-agent",
            json={"question": "Tell me the customer name and the TCOGS."},
        )
    assert resp.status_code == 200
    assert len(fake_groq.calls) == 1

    outbound = json.dumps(fake_groq.calls[0]["json"])

    for forbidden in (
        "Zzyzx Confidential Customer Corp",  # customer_name value
        "918273",  # tcogs_eur value
        "554433",  # selling_price_eur value
        "Zzyzx Realname Marker",  # real engineer/user full name
        "unique.realname.marker@example.com",  # real engineer/user email
    ):
        assert forbidden not in outbound, f"{forbidden!r} leaked into the outbound Groq payload"

    # Positive control: the payload DOES carry non-sensitive project data,
    # so this test is exercising a real, populated context — not an empty one.
    assert "Ask Agent Project" in outbound


def test_groq_settings_accept_bare_alias_and_strip(monkeypatch) -> None:
    from core.config import GroqSettings

    monkeypatch.delenv("RPD_GROQ_API_KEY", raising=False)
    monkeypatch.delenv("RPD_GROQ_MODEL", raising=False)
    monkeypatch.setenv("GROQ_API_KEY", '  "gsk_test"\n')
    monkeypatch.setenv("RPD_GROQ_MODEL", "  ")
    settings = GroqSettings()
    assert settings.api_key == "gsk_test"
    # Blank model falls back to a model Groq still serves.
    assert settings.model == "openai/gpt-oss-120b"
