"""What-if planner API (P18-T02, ADR 0031, docs/API_CONTRACT_P18.md section 9).

* `POST /whatif/estimate`  instant formula sizing (`analytic_requirements`)
* `POST /whatif/simulate`  the real greedy scheduler on a copy of the plan
* `POST /whatif/solve`     the smallest additions that meet a target
* `POST /whatif/ask`       the chat: a model that only translates and explains

**Pure read.** Nothing here writes to the plan, a schedule run, a project, an
engineer or a chamber. The one write is the audit row (coalesced per user,
kind and scenario per minute).

**RBAC.** `CAPACITY_PLANNING` / `READ` (the surface the What-if lives on):
Portfolio Manager, Hub Planner, Admin, Super Admin. Everyone else is 403.

**Hub scope.** The simulation always runs on the WHOLE plan (lab capacity is
shared by a lab region); only what is returned is narrowed to the caller's
hubs and their lab regions (`services.whatif`). A scenario that names a hub or
lab region outside the caller's scope is 403 `SCENARIO_OUT_OF_SCOPE`.

**Errors.** `422 INVALID_SCENARIO` for a scenario the engine rejects,
`429` with `Retry-After` from the per-user rate limit, `503 WHATIF_TIMEOUT`
past the time cap, `503 AGENT_UNAVAILABLE` when the chat has no API key
configured (the forms keep working), `502` when the model provider fails.
"""

from __future__ import annotations

import math

import httpx
from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from schemas.whatif import (
    AskRequest,
    AskResponse,
    EstimateRequest,
    EstimateResponse,
    SimulateRequest,
    SimulateResponse,
    SolveRequest,
    SolveResponse,
)
from services.llm_client import LlmClient, configured_llm_client
from services.rate_limit import TokenBucketLimiter
from services.whatif import (
    audit_whatif,
    digest_of,
    do_estimate,
    do_simulate,
    do_solve,
    scenario_shape,
)
from services.whatif_baseline import load_context
from services.whatif_chat import run_chat

router = APIRouter(prefix="/whatif", tags=["whatif"])

_read = require_permission(Surface.CAPACITY_PLANNING, Action.READ)

#: Per user. Estimate and simulate are cheap (tens of ms); solve runs up to 60
#: schedules; a chat message costs real money (as in ADR 0014).
WHATIF_RATE_LIMIT = TokenBucketLimiter(capacity=30, refill_per_second=0.5)
WHATIF_SOLVE_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=1 / 10)
WHATIF_ASK_RATE_LIMIT = TokenBucketLimiter(capacity=5, refill_per_second=1 / 12)


def _throttle(limiter: TokenBucketLimiter, principal: Principal) -> None:
    allowed, retry_after = limiter.allow(str(principal.user_id))
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Too many what-if requests. Please wait a moment before trying again.",
            headers={"Retry-After": str(max(1, math.ceil(retry_after)))},
        )


def get_llm_client() -> LlmClient | None:
    """Dependency so tests (and a future self-hosted model) can substitute the
    client; the default is the configured OpenAI-compatible endpoint."""

    return configured_llm_client()


@router.post("/estimate", response_model=EstimateResponse)
async def estimate(
    body: EstimateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> EstimateResponse:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user)
    result = await do_estimate(ctx, body.scenario, basis=body.basis, designer_fte=body.designer_fte)
    await audit_whatif(
        db, current_user, "estimate",
        {**scenario_shape(body.scenario), "basis": body.basis},
    )  # fmt: skip
    await db.commit()
    return result


@router.post("/simulate", response_model=SimulateResponse)
async def simulate_scenario(
    body: SimulateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> SimulateResponse:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user)
    result = await do_simulate(ctx, body.scenario)
    await audit_whatif(db, current_user, "simulate", scenario_shape(body.scenario))
    await db.commit()
    return result


@router.post("/solve", response_model=SolveResponse)
async def solve(
    body: SolveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> SolveResponse:
    _throttle(WHATIF_SOLVE_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user)
    result = await do_solve(
        ctx,
        body.scenario,
        target=body.target,
        designer_fte=body.designer_fte,
        max_runs=body.max_runs,
        max_units_per_dimension=body.max_units_per_dimension,
    )
    await audit_whatif(
        db, current_user, "solve",
        {**scenario_shape(body.scenario), "target": body.target},
        extra={"runs_used": result.runs_used, "met": result.met},
    )  # fmt: skip
    await db.commit()
    return result


@router.post("/ask", response_model=AskResponse)
async def ask(
    body: AskRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    llm: LlmClient | None = Depends(get_llm_client),
) -> AskResponse | JSONResponse:
    if llm is None:
        # Checked before anything is loaded or called (ADR 0014 section 3).
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error": "AGENT_UNAVAILABLE"},
        )
    _throttle(WHATIF_ASK_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user)
    try:
        result = await run_chat(db, current_user, ctx, llm, body)
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The assistant's upstream provider failed to answer.",
        ) from exc
    # Audit: the question is NOT stored (a typed question may carry names);
    # its length and a digest are, with the scenario the assistant built.
    shape = scenario_shape(result.scenario) if result.scenario is not None else {"scenario": None}
    await audit_whatif(
        db, current_user, "ask",
        shape,
        extra={
            "question_digest": digest_of(body.question),
            "question_length": len(body.question),
            "tools": [r.tool for r in result.results],
            "rounds": result.rounds_used,
            "refused": result.refused,
            "grounded": result.grounded,
        },
        coalesce=False,
    )  # fmt: skip
    await db.commit()
    return result
