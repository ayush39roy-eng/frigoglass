"""P9-R02 remediation checks that do not belong to one surface:

- S-03: CORS allows only exact origins (no `*.vercel.app` wildcard), keeps the
  two hosted-demo origins, and allows `X-Dev-User-Email` only in dev mode.
- S-04: `TRUNCATE project_comments` is rejected by the new trigger.
- S-02: the auditor's 50-comment stall repro now reads fast.
- Ruling 6: `solver_status` is persisted on the run and exposed on
  `ScheduleRunSummary`.
- `services.rate_limit` token-bucket arithmetic.
"""

from __future__ import annotations

import time
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

import api.main as main_module
from api.db import get_db
from api.main import app
from models.enums import RoleName, SolverType
from models.workspace import ProjectComment
from scheduling.types import ScheduleInput, ScheduleOutput
from services.rate_limit import TokenBucketLimiter
from services.schedule_persistence import persist_schedule_output
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_hub, make_project, make_user


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


# --- S-03 CORS ------------------------------------------------------------------------


async def _preflight(origin: str, headers: str = "authorization") -> dict[str, str]:
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.options(
            "/projects",
            headers={
                "Origin": origin,
                "Access-Control-Request-Method": "GET",
                "Access-Control-Request-Headers": headers,
            },
        )
    return {"status": str(r.status_code), **{k.lower(): v for k, v in r.headers.items()}}


async def test_cors_rejects_arbitrary_vercel_origin():
    evil = await _preflight("https://attacker-demo.vercel.app")
    assert evil["status"] == "400"
    assert "access-control-allow-origin" not in evil


@pytest.mark.parametrize(
    "origin",
    ["https://frontend-rosy-mu-51.vercel.app", "https://frigoglass-hu6f.onrender.com",
     "http://localhost:5173"],
)
async def test_cors_keeps_exact_demo_origins(origin):
    ok = await _preflight(origin)
    assert ok["status"] == "200"
    assert ok["access-control-allow-origin"] == origin


async def test_cors_dev_header_not_allowed_outside_dev_mode():
    # The app under test was imported with dev mode off.
    assert "X-Dev-User-Email" not in main_module.cors_allowed_headers()
    r = await _preflight("http://localhost:5173", "x-dev-user-email")
    assert r["status"] == "400"


def test_cors_helpers_follow_env(monkeypatch):
    monkeypatch.setenv("RPD_DEV_MODE", "true")
    assert "X-Dev-User-Email" in main_module.cors_allowed_headers()
    monkeypatch.setenv("RPD_CORS_ORIGINS", "https://rpd.frigoglass.local, ")
    assert main_module.cors_origins_from_env()[-1] == "https://rpd.frigoglass.local"
    assert "https://frigoglass-hu6f.onrender.com" in main_module.cors_origins_from_env()
    monkeypatch.setenv("RPD_CORS_ORIGINS_MODE", "replace")
    assert main_module.cors_origins_from_env() == ["https://rpd.frigoglass.local"]
    monkeypatch.setenv("RPD_CORS_ORIGINS", "")
    assert main_module.cors_origins_from_env() == []


# --- S-04 TRUNCATE guard ----------------------------------------------------------------


async def test_truncate_project_comments_is_rejected(db_session):
    with pytest.raises(DBAPIError) as exc:
        async with db_session.begin_nested():
            await db_session.execute(text("TRUNCATE project_comments"))
    assert "TRUNCATE is not permitted" in str(exc.value)


# --- S-02 stall repro ----------------------------------------------------------------------


async def test_fifty_worst_case_comments_read_fast(db_session):
    """The P9-T07 repro: 50 comments of `"!["*5000`. Before P9-R02 the
    workspace read took 12.3 s and `activity?limit=200` 23.6 s."""

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    user = await make_user(db_session, RoleName.ADMIN)
    for _ in range(50):
        db_session.add(
            ProjectComment(project_id=project.id, body_md="![" * 5000, author_user_id=user.id)
        )
    await db_session.flush()
    override_current_principal(make_principal(RoleName.ADMIN, user_id=user.id))
    async with _client(db_session) as client:
        t0 = time.perf_counter()
        ws = await client.get(f"/projects/{project.id}/workspace")
        t1 = time.perf_counter()
        act = await client.get(f"/projects/{project.id}/activity", params={"limit": 200})
        t2 = time.perf_counter()
    assert ws.status_code == 200 and act.status_code == 200
    print(f"\nS-02 repro: workspace {t1 - t0:.3f}s, activity(200) {t2 - t1:.3f}s")
    assert t1 - t0 < 2.0 and t2 - t1 < 2.0


# --- Ruling 6: solver_status ---------------------------------------------------------------


async def test_solver_status_persisted_and_exposed(db_session):
    run = await persist_schedule_output(
        db_session,
        ScheduleInput(projects=(), engineers=(), chambers=()),
        ScheduleOutput(project_outcomes=(), scheduling_order=()),
        solver_type=SolverType.CP_SAT,
        trigger_reason="test",
        activate=False,
        sync_live_workflow_steps=False,
        solver_status="FEASIBLE",
    )
    assert run.solver_status == "FEASIBLE"
    # Taken from the output when P9-R01's `ScheduleOutput.solver_status` exists.
    fake_output = SimpleNamespace(project_outcomes=(), solver_status="OPTIMAL")
    run2 = await persist_schedule_output(
        db_session,
        ScheduleInput(projects=(), engineers=(), chambers=()),
        fake_output,  # type: ignore[arg-type]
        solver_type=SolverType.CP_SAT,
        trigger_reason="test",
        activate=False,
        sync_live_workflow_steps=False,
    )
    assert run2.solver_status == "OPTIMAL"
    override_current_principal(make_principal(RoleName.ADMIN))
    async with _client(db_session) as client:
        runs = (await client.get("/schedule-runs")).json()
    statuses = {r["id"]: r["solver_status"] for r in runs}
    assert statuses[str(run.id)] == "FEASIBLE" and statuses[str(run2.id)] == "OPTIMAL"


# --- Token bucket ------------------------------------------------------------------------------


def test_token_bucket():
    limiter = TokenBucketLimiter(capacity=2, refill_per_second=0.5)
    assert limiter.allow("u", now=0)[0] and limiter.allow("u", now=0)[0]
    allowed, retry = limiter.allow("u", now=0)
    assert not allowed and retry == pytest.approx(2.0)
    assert limiter.allow("other", now=0)[0]
    assert limiter.allow("u", now=2.0)[0]
    limiter.reset()
    assert limiter.allow("u", now=2.0)[0]
