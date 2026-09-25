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

# Structured logging (P6-T06) must be configured before anything else in
# this process logs a line — including the router imports below, several of
# which create a module-level `logger = logging.getLogger(__name__)` at
# import time (`api/routers/schedule_runs.py`). `configure_logging` is
# idempotent (safe if a Gunicorn worker process re-imports this module) and
# itself has zero FastAPI/app dependencies.
from core.logging_config import configure_logging

configure_logging("api")

from api.db import dispose_engine  # noqa: E402 - see configure_logging() call above
from api.routers.audit_log import router as audit_log_router  # noqa: E402
from api.routers.capacity import router as capacity_router  # noqa: E402
from api.routers.chambers import router as chambers_router  # noqa: E402
from api.routers.currency_rates import router as currency_rates_router  # noqa: E402
from api.routers.dashboard import router as dashboard_router  # noqa: E402
from api.routers.engineers import router as engineers_router  # noqa: E402
from api.routers.exports import router as exports_router  # noqa: E402
from api.routers.gantt import router as gantt_router  # noqa: E402
from api.routers.notifications import router as notifications_router  # noqa: E402
from api.routers.priorities import router as priorities_router  # noqa: E402
from api.routers.projects import router as projects_router  # noqa: E402
from api.routers.reference import router as reference_router  # noqa: E402
from api.routers.scenarios import router as scenarios_router  # noqa: E402
from api.routers.schedule_runs import router as schedule_runs_router  # noqa: E402
from core.observability import ObservabilityMiddleware, render_metrics  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await dispose_engine()


app = FastAPI(
    title="RPD Web Application API",
    version="0.3.0",
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
cors_origins = [
    "http://localhost:3000",
    "http://localhost:5173",
    "http://localhost:5183",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:5173",
    "http://127.0.0.1:5183",
    # Ad hoc Render/Vercel demo deployment (not the client's on-prem
    # target topology — see docs/MEMORY.md). Hardcoded in addition to the
    # `allow_origin_regex` below as a quick, explicit fallback.
    "https://frontend-rosy-mu-51.vercel.app",
    "https://frigoglass-hu6f.onrender.com",
]
extra_origins = os.environ.get("RPD_CORS_ORIGINS", "")
if extra_origins:
    cors_origins.extend([o.strip() for o in extra_origins.split(",") if o.strip()])

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_origin_regex=r"https://.*\.vercel\.app",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
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
