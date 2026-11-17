"""What-if planner API (P18-T02, ADR 0031, docs/API_CONTRACT_P18.md section 9).

* `POST /whatif/estimate`  instant formula sizing (`analytic_requirements`)
* `POST /whatif/simulate`  the real greedy scheduler on a copy of the plan
* `POST /whatif/solve`     the smallest additions that meet a target
* `POST /whatif/ask`       the chat: a model that only translates and explains
* `POST /whatif/export.xlsx` P43 (ADR 0057 D3): the simulation as a workbook
  (Summary, a drawn Gantt, Gantt data), recomputed on the server

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

import io
import math
import uuid

import httpx
from fastapi import APIRouter, Depends, File, HTTPException, Query, Response, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission, require_roles
from api.errors import HTTP_413, HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import RoleName
from schemas.import_scenarios import (
    ImportFormatOut,
    ImportFormatResetIn,
    ImportFormatUpdateIn,
    SavedScenarioListOut,
    SavedScenarioOut,
    ScenarioExportIn,
    ScenarioPatchIn,
    ScenarioSaveIn,
)
from schemas.whatif import (
    AskRequest,
    AskResponse,
    EstimateRequest,
    EstimateResponse,
    SimulateExportIn,
    SimulateRequest,
    SimulateResponse,
    SolveRequest,
    SolveResponse,
)
from schemas.whatif_import import (
    ImportParseResponse,
    ImportSimulateRequest,
    ImportSimulateResponse,
)
from services import whatif_import_scenarios as scenarios
from services.file_sniff import UploadRejected, extension_of, sniff
from services.import_format import (
    current_aliases,
    format_out,
    reset_format,
    template_xlsx,
    update_format,
)
from services.llm_client import LlmClient, configured_llm_client
from services.plan_clock import PlanClock, get_plan_clock
from services.plan_import_xlsx import (
    MAX_FILE_BYTES,
    FieldAliases,
    ImportFormatError,
    parse_plan_workbook,
)
from services.rate_limit import TokenBucketLimiter
from services.whatif import (
    WHATIF_TIME_CAP_SECONDS,
    audit_whatif,
    digest_of,
    do_estimate,
    do_simulate,
    do_solve,
    run_capped,
    scenario_shape,
)
from services.whatif_baseline import load_context
from services.whatif_chat import run_chat
from services.whatif_export import planner_export, planner_xlsx
from services.whatif_import import (
    audit_import_simulate,
    audit_parse,
    build_parse_context,
    do_import_simulate,
    import_format_error,
    parse_response,
    safe_file_name,
    sha256_hex,
)

router = APIRouter(prefix="/whatif", tags=["whatif"])

_read = require_permission(Surface.CAPACITY_PLANNING, Action.READ)
#: ADR 0055 D1: the import format is edited by Admin and Super Admin only.
_format_admin = require_roles(RoleName.ADMIN, RoleName.SUPER_ADMIN)

#: Per user. Estimate and simulate are cheap (tens of ms); solve runs up to 60
#: schedules; a chat message costs real money (as in ADR 0014).
WHATIF_RATE_LIMIT = TokenBucketLimiter(capacity=30, refill_per_second=0.5)
WHATIF_SOLVE_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=1 / 10)
WHATIF_ASK_RATE_LIMIT = TokenBucketLimiter(capacity=5, refill_per_second=1 / 12)
#: P43-R01 (security L-1): the planner export simulates AND writes a
#: workbook, so it has its own, smaller bucket (as solve does).
WHATIF_EXPORT_RATE_LIMIT = TokenBucketLimiter(capacity=6, refill_per_second=1 / 10)


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
    clock: PlanClock = Depends(get_plan_clock),
) -> EstimateResponse:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
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
    clock: PlanClock = Depends(get_plan_clock),
) -> SimulateResponse:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
    result = await do_simulate(ctx, body.scenario)
    await audit_whatif(db, current_user, "simulate", scenario_shape(body.scenario))
    await db.commit()
    return result


@router.post("/export.xlsx", response_class=Response)
async def export_simulation(
    body: SimulateExportIn,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> Response:
    """P43 (ADR 0057 D3, docs/API_CONTRACT_P43.md §3): the What-if read's
    RBAC and hub scope; its own rate limit (P43-R01). The server simulates the scenario again;
    no result is accepted from the browser."""

    _throttle(WHATIF_EXPORT_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
    sim, book = await planner_export(ctx, body)
    # P43-R01: the workbook is built in the What-if pool under the same
    # per-user in-flight slot and time cap as the simulation.
    data = await run_capped(
        lambda: planner_xlsx(book), WHATIF_TIME_CAP_SECONDS, user_key=ctx.user_key
    )
    await audit_whatif(
        db, current_user, "export",
        scenario_shape(body.scenario),
        extra={"projects": len(sim.projects), "named": body.name is not None},
    )  # fmt: skip
    await db.commit()
    return _xlsx_response(data, scenarios.safe_download_name(body.name, "whatif-scenario"))


@router.post("/solve", response_model=SolveResponse)
async def solve(
    body: SolveRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> SolveResponse:
    _throttle(WHATIF_SOLVE_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
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
    clock: PlanClock = Depends(get_plan_clock),
    llm: LlmClient | None = Depends(get_llm_client),
) -> AskResponse | JSONResponse:
    if llm is None:
        # Checked before anything is loaded or called (ADR 0014 section 3).
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"error": "AGENT_UNAVAILABLE"},
        )
    _throttle(WHATIF_ASK_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
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


# --- plan import (P32-T04, ADR 0044, docs/API_CONTRACT_P32.md B2/B3) ----------------------

_UPLOAD_CHUNK = 256 * 1024


def _read_upload_capped(upload: UploadFile) -> bytes | None:
    """The upload's bytes, or None as soon as it passes `MAX_FILE_BYTES`."""

    upload.file.seek(0)
    buf = bytearray()
    while chunk := upload.file.read(_UPLOAD_CHUNK):
        buf.extend(chunk)
        if len(buf) > MAX_FILE_BYTES:
            return None
    return bytes(buf)


def _parse_or_error(data: bytes, pctx: object, aliases: FieldAliases) -> object:
    """Run in the What-if pool. A format problem is RETURNED (not raised) so
    `run_capped` does not turn it into a scenario error. `aliases` is the
    stored import format (ADR 0055 D1)."""

    try:
        return parse_plan_workbook(data, pctx, aliases)  # type: ignore[arg-type]
    except ImportFormatError as exc:
        return exc


@router.post("/import/parse", response_model=ImportParseResponse)
async def import_parse(
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> ImportParseResponse:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    data = await run_in_threadpool(_read_upload_capped, file)
    if data is None:
        raise CodedHTTPException(HTTP_413, "FILE_TOO_LARGE", "Plan files are limited to 5 MB.")
    if not data:
        raise import_format_error("The file is empty.")
    try:
        if extension_of(file.filename) != "xlsx":
            raise UploadRejected("Only .xlsx workbooks can be imported.")
        await run_in_threadpool(sniff, "xlsx", io.BytesIO(data))
    except UploadRejected as exc:
        raise import_format_error(f"Only .xlsx workbooks can be imported. {exc}") from exc
    ctx = await load_context(db, current_user, clock=clock)
    pctx = await build_parse_context(db, current_user, ctx)
    aliases = await current_aliases(db)
    result = await run_capped(
        lambda: _parse_or_error(data, pctx, aliases),
        WHATIF_TIME_CAP_SECONDS,
        user_key=ctx.user_key,
    )
    if isinstance(result, ImportFormatError):
        raise import_format_error(str(result))
    response = parse_response(safe_file_name(file.filename), pctx, result, ctx)  # type: ignore[arg-type]
    await audit_parse(db, current_user, sha256_hex(data), result)  # type: ignore[arg-type]
    await db.commit()
    return response


@router.post("/import/simulate", response_model=ImportSimulateResponse)
async def import_simulate(
    body: ImportSimulateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> ImportSimulateResponse:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
    result = await do_import_simulate(ctx, body)
    await audit_import_simulate(db, current_user, body, result)
    await db.commit()
    return result


# --- P41 (ADR 0055, docs/API_CONTRACT_P41.md): import format, saved scenarios, exports --------


def _xlsx_response(data: bytes, filename: str) -> Response:
    return Response(
        content=data,
        media_type=scenarios.XLSX_MEDIA_TYPE,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@router.get("/import/format", response_model=ImportFormatOut)
async def get_import_format(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> ImportFormatOut:
    return await format_out(db, current_user)


@router.put("/import/format", response_model=ImportFormatOut)
async def put_import_format(
    body: ImportFormatUpdateIn,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_format_admin),
) -> ImportFormatOut:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    await update_format(db, current_user, version=body.version, changes=body.fields)
    await db.commit()
    return await format_out(db, current_user)


@router.post("/import/format/reset", response_model=ImportFormatOut)
async def reset_import_format(
    body: ImportFormatResetIn,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_format_admin),
) -> ImportFormatOut:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    await reset_format(db, current_user, version=body.version)
    await db.commit()
    return await format_out(db, current_user)


@router.get("/import/format/template.xlsx", response_class=Response)
async def import_format_template(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Response:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    data = await run_in_threadpool(template_xlsx, await current_aliases(db))
    return _xlsx_response(data, "plan-import-template.xlsx")


@router.post("/import/export.xlsx", response_class=Response)
async def export_current_result(
    body: ScenarioExportIn,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> Response:
    """ADR 0055 D5: the server recomputes from the request; a browser-supplied
    result is never accepted."""

    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
    result = await do_import_simulate(ctx, body.request)
    data = await run_in_threadpool(scenarios.current_result_xlsx, result, body.name)
    scenarios.audit_export(
        db, current_user, "current",
        names=[body.name] if body.name else [], projects=len(result.projects),
    )  # fmt: skip
    await db.commit()
    return _xlsx_response(data, scenarios.safe_download_name(body.name, "whatif-import-result"))


@router.post(
    "/import/scenarios", response_model=SavedScenarioOut, status_code=status.HTTP_201_CREATED
)
async def save_import_scenario(
    body: ScenarioSaveIn,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
    clock: PlanClock = Depends(get_plan_clock),
) -> SavedScenarioOut:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    ctx = await load_context(db, current_user, clock=clock)
    out = await scenarios.save_scenario(db, current_user, ctx, body)
    await db.commit()
    return out


@router.get("/import/scenarios", response_model=SavedScenarioListOut)
async def list_import_scenarios(
    source_file_sha256: str | None = Query(default=None, pattern=r"^[0-9a-f]{64}$"),
    limit: int = Query(default=scenarios.DEFAULT_LIST_LIMIT, ge=1, le=scenarios.MAX_LIST_LIMIT),
    offset: int = Query(default=0, ge=0, le=1_000_000),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> SavedScenarioListOut:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    items, total = await scenarios.list_scenarios(
        db, current_user, source_file_sha256, limit=limit, offset=offset
    )
    return SavedScenarioListOut(items=items, total=total, limit=limit, offset=offset)


def _compare_ids(ids: str) -> list[uuid.UUID]:
    parts = [p.strip() for p in ids.split(",") if p.strip()]
    try:
        parsed = [uuid.UUID(p) for p in parts]
    except ValueError as exc:
        raise CodedHTTPException(
            HTTP_422, scenarios.INVALID_COMPARE, "ids must be scenario ids, comma-separated."
        ) from exc
    if not scenarios.MIN_COMPARE <= len(parsed) <= scenarios.MAX_COMPARE or len(set(parsed)) != len(
        parsed
    ):
        raise CodedHTTPException(
            HTTP_422,
            scenarios.INVALID_COMPARE,
            f"Compare takes {scenarios.MIN_COMPARE} to {scenarios.MAX_COMPARE} different "
            "scenarios.",
        )
    return parsed


# Declared before `/import/scenarios/{scenario_id}` so `compare.xlsx` is not
# read as an id.
@router.get("/import/scenarios/compare.xlsx", response_class=Response)
async def export_scenario_comparison(
    ids: str = Query(..., max_length=200),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Response:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    parsed = _compare_ids(ids)
    rows = await scenarios.visible_rows(db, current_user, parsed)
    data = await run_in_threadpool(scenarios.compare_xlsx, rows)
    scenarios.audit_export(
        db, current_user, "compare",
        ids=[r.id for r in rows], names=[r.name for r in rows],
        projects=sum(len(r.result.get("projects", [])) for r in rows),
    )  # fmt: skip
    await db.commit()
    return _xlsx_response(data, "whatif-scenario-comparison.xlsx")


@router.get("/import/scenarios/{scenario_id}", response_model=SavedScenarioOut)
async def get_import_scenario(
    scenario_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> SavedScenarioOut:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    return await scenarios.get_scenario(db, current_user, scenario_id)


@router.patch("/import/scenarios/{scenario_id}", response_model=SavedScenarioOut)
async def patch_import_scenario(
    scenario_id: uuid.UUID,
    body: ScenarioPatchIn,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> SavedScenarioOut:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    out = await scenarios.patch_scenario(db, current_user, scenario_id, body)
    await db.commit()
    return out


@router.delete(
    "/import/scenarios/{scenario_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_class=Response,
)
async def delete_import_scenario(
    scenario_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Response:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    await scenarios.delete_scenario(db, current_user, scenario_id)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/import/scenarios/{scenario_id}/export.xlsx", response_class=Response)
async def export_import_scenario(
    scenario_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> Response:
    _throttle(WHATIF_RATE_LIMIT, current_user)
    (row,) = await scenarios.visible_rows(db, current_user, [scenario_id])
    data = await run_in_threadpool(scenarios.saved_scenario_xlsx, row)
    scenarios.audit_export(
        db, current_user, "scenario",
        ids=[row.id], names=[row.name], projects=len(row.result.get("projects", [])),
    )  # fmt: skip
    await db.commit()
    return _xlsx_response(data, scenarios.safe_download_name(row.name, "whatif-scenario"))
