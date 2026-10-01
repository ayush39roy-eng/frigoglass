"""FastAPI app entry point.

Run with (from `backend/`, with a `.venv` that has this project's deps
installed, and `RPD_DATABASE_URL` / `RPD_FIELD_ENCRYPTION_KEY` set — same
env var convention as `backend/alembic/env.py` /
`backend/seed/seed_demo_data.py`):

    uvicorn api.main:app --reload

Serves the CRUD + read-model endpoints for all six surfaces (Project
Registration, Global RPD Dashboard, RPD Capacity, Prioritization Matrix,
Project Execution Timeline/Gantt, Capacity Planning) plus reference data,
the currency-rate config endpoints, the append-only audit-log read surface,
schedule-run history / activation, the CP-SAT solver-dispatch and SSE
solver-progress endpoints, CSV/XLSX export of every surface's current view
(`api/routers/exports.py`, P5-T04 — synchronous by default, or async via
MinIO + the general-purpose `worker` Celery process for large exports), and
in-app notifications of schedule changes affecting a user's hub/assigned
projects (`api/routers/notifications.py`, P5-T06).

Security posture (as built): every non-public endpoint requires a valid OIDC
bearer token (`core/oidc.py`), action-level RBAC is enforced against the
`docs/PROJECT_AND_STACK.md` §5 role/permission matrix (`core/rbac.py`), and
row-level hub scoping is applied in the data-access layer for every endpoint
that touches project data (`services/hub_scope.py`). Every mutation writes an
immutable audit row. CP-SAT never runs in this process — solver dispatch goes
through Celery (`workers/`); the greedy scheduler may run synchronously for
small recalcs only (`POST /schedule-runs/greedy-recalc`, Admin-only).
"""

from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response
from fastapi.exceptions import RequestValidationError

# Structured logging (P6-T06) must be configured before anything else in
# this process logs a line — including the router imports below, several of
# which create a module-level `logger = logging.getLogger(__name__)` at
# import time (`api/routers/schedule_runs.py`). `configure_logging` is
# idempotent (safe if a Gunicorn worker process re-imports this module) and
# itself has zero FastAPI/app dependencies.
from core.logging_config import configure_logging

configure_logging("api")

from api.db import dispose_engine  # noqa: E402 - see configure_logging() call above
from api.errors import (  # noqa: E402
    CodedHTTPException,
    coded_http_exception_handler,
    sanitizing_validation_exception_handler,
)
from api.routers.ask_agent import router as ask_agent_router  # noqa: E402
from api.routers.audit_log import router as audit_log_router  # noqa: E402
from api.routers.capacity import router as capacity_router  # noqa: E402
from api.routers.chambers import router as chambers_router  # noqa: E402
from api.routers.currency_rates import router as currency_rates_router  # noqa: E402
from api.routers.dashboard import router as dashboard_router  # noqa: E402
from api.routers.engineers import router as engineers_router  # noqa: E402
from api.routers.exports import router as exports_router  # noqa: E402
from api.routers.gantt import router as gantt_router  # noqa: E402
from api.routers.me import router as me_router  # noqa: E402
from api.routers.notifications import router as notifications_router  # noqa: E402
from api.routers.priorities import router as priorities_router  # noqa: E402
from api.routers.project_access import router as project_access_router  # noqa: E402
from api.routers.projects import router as projects_router  # noqa: E402
from api.routers.reference import router as reference_router  # noqa: E402
from api.routers.scenarios import router as scenarios_router  # noqa: E402
from api.routers.schedule_runs import router as schedule_runs_router  # noqa: E402
from api.routers.users import router as users_router  # noqa: E402
from api.routers.workflow_settings import router as workflow_settings_router  # noqa: E402
from api.routers.workspace import router as workspace_router  # noqa: E402
from core.config import is_dev_mode  # noqa: E402
from core.observability import ObservabilityMiddleware, render_metrics  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


app = FastAPI(
    title="RPD Web Application API",
    version="0.4.0",
    description=(
        "RPD Web Application backend. CRUD + read-model endpoints for all six "
        "surfaces, plus reference data, currency-rate config, the append-only "
        "audit-log read surface, schedule-run history/activation, CP-SAT solver "
        "dispatch (via Celery) and SSE solver-progress streaming. All "
        "non-public endpoints are OIDC-authenticated with action-level RBAC "
        "(PROJECT_AND_STACK.md §5) and row-level hub scoping; every mutation is "
        "audit-logged."
    ),
    lifespan=lifespan,
)

# P6-T06: request-id correlation + structured "request completed" access log
# + Prometheus request-count/latency metrics. Deliberately added before any
# router — see `core/observability.py`'s module docstring for why this is a
# raw ASGI middleware (not `BaseHTTPMiddleware`) and why it never touches
# query strings or bodies.
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402

app.add_middleware(ObservabilityMiddleware)
#: P9-R02 (security S-03): exact origins only, no wildcard regex. The two
#: hosted-demo origins stay so the owner's Render/Vercel demo keeps working.
#: `RPD_CORS_ORIGINS` (comma-separated) EXTENDS this list; with
#: `RPD_CORS_ORIGINS_MODE=replace` it REPLACES it (on-prem: set it to the
#: site's own origin, or leave it empty behind the same-origin nginx).
DEFAULT_CORS_ORIGINS = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5183",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5183",
    "https://frontend-rosy-mu-51.vercel.app",
    "https://frigoglass-hu6f.onrender.com",
]


def cors_origins_from_env() -> list[str]:
    extra = [o.strip() for o in os.environ.get("RPD_CORS_ORIGINS", "").split(",") if o.strip()]
    if os.environ.get("RPD_CORS_ORIGINS_MODE", "").strip().lower() == "replace":
        return extra
    return DEFAULT_CORS_ORIGINS + [o for o in extra if o not in DEFAULT_CORS_ORIGINS]


def cors_allowed_headers() -> list[str]:
    """Explicit request headers. `X-Dev-User-Email` is only allowed
    cross-origin when dev mode is on (read once at startup).
    """

    headers = ["Authorization", "Content-Type", "Accept", "X-Request-ID"]
    if is_dev_mode():
        headers.append("X-Dev-User-Email")
    return headers


app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins_from_env(),
    # Kept: the frontend client sends `credentials: "include"`, and the hosted
    # demo is cross-origin. Auth is bearer-only (no cookies), and with exact
    # origins the credentialed mode no longer trusts arbitrary sites.
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=cors_allowed_headers(),
    expose_headers=["X-Schedule-Stale-Count", "Content-Disposition", "Retry-After"],
)

app.include_router(currency_rates_router)
app.include_router(reference_router)
app.include_router(projects_router)
app.include_router(engineers_router)
app.include_router(chambers_router)
app.include_router(priorities_router)
app.include_router(dashboard_router)
app.include_router(capacity_router)
app.include_router(gantt_router)
app.include_router(schedule_runs_router)
app.include_router(scenarios_router)
app.include_router(exports_router)
app.include_router(audit_log_router)
app.include_router(notifications_router)
# P9-T03 (docs/API_CONTRACT_P9.md §1-§3, §7).
app.include_router(me_router)
app.include_router(users_router)
app.include_router(workflow_settings_router)
app.include_router(workspace_router)
# 2026-09-30 (ADR 0012/0014, P10-T02): project-level access grants + manager
# delegation, and Ask-the-agent (Groq).
app.include_router(project_access_router)
app.include_router(ask_agent_router)
app.add_exception_handler(CodedHTTPException, coded_http_exception_handler)
# P9-F01 (R04-L1/R04-L2): replaces FastAPI's default `RequestValidationError`
# handler, which crashes with a 500 (not the correct 422) when the rejected
# body contained a non-finite float — see
# `sanitizing_validation_exception_handler`'s own docstring.
app.add_exception_handler(RequestValidationError, sanitizing_validation_exception_handler)


@app.get("/healthz", tags=["meta"])
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/metrics", tags=["meta"], include_in_schema=False)
async def metrics() -> Response:
    """Prometheus text-exposition format (P6-T06 Part 2). Unauthenticated —
    same posture as `/healthz` — and deliberately NOT proxied through the
    internet-facing edge (`deploy/nginx/default.conf`, P6-T02's `/api/` /
    `/` / `/healthz` routes): an operator's own Prometheus is expected to
    run on the `rpd-internal` Docker network and scrape
    `http://api:8000/metrics` directly, never through the public edge/WAF.
    See `docs/MEMORY.md`'s P6-T06 entry for the full reasoning and the
    operator-facing scrape instructions.
    """

    body, content_type = render_metrics()
    return Response(content=body, media_type=content_type)
