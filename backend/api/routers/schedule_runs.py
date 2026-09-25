"""`ScheduleRun` listing, a synchronous greedy-only recalculation trigger
(P3-T01), and the async CP-SAT dispatch + cancellation primitives (P3-T06).

**Read this before assuming this file is the "Apply Priorities"/"Auto-assign"
action** — it is not, for either the greedy or the CP-SAT path.
`POST /schedule-runs/greedy-recalc` runs ONLY `scheduling.greedy.run_greedy_sgs`
(never CP-SAT), synchronously, inline in this FastAPI request handler. This
is allowed — not a violation of the "CP-SAT never runs inside FastAPI"
Standing Decision — per `docs/PROJECT_AND_STACK.md` §4: "The greedy SGS
scheduler (P2-T01) may run synchronously for small/fast recalculations if
profiling shows it's cheap enough." At 46 seed projects this comfortably
qualifies; this task does not re-profile at the full ~236-project scale.
`POST /schedule-runs/cp-sat-dispatch` (P3-T06) is the CP-SAT equivalent, and
is the *opposite* shape on purpose: it never calls
`scheduling.cp_sat.run_cp_sat` itself — it only creates a `QUEUED`
`ScheduleRun` row and enqueues `workers.schedule_tasks.run_cp_sat_schedule`
onto Celery (`solver-worker`), then returns immediately (202-style). The
actual solve happens entirely inside that Celery task/process — see
`workers/schedule_tasks.py`'s module docstring for the full lifecycle,
persistence, and cancellation design.

Both endpoints exist because, as of P3-T01, there was otherwise **no way for
any `ScheduleRun` row to ever exist** — the Dashboard/Capacity/Gantt read
models (Invariant I9) all require an active `ScheduleRun` snapshot to read
from. They are deliberately low-level "recompute now" primitives, not
business actions:

- Neither is "Apply Priorities" (`docs/PROJECT_AND_STACK.md` §2) — that
  action additionally re-runs the 13-dimension band assignment across the
  whole portfolio, writes a versioned `PriorityApplicationRun`, and would
  then trigger a recalculation as a downstream *consequence* — none of the
  priority-band part is built here (`api/routers/priorities.py`).
- Neither is "Auto-assign" (Capacity Planning) — that is a bulk
  resource-configuration action, not a scheduling recalculation.
  `docs/OPEN_QUESTIONS.md` #10 is still open and blocking specifically for
  P4-T07 (Auto-assign), not for this task — this router's CP-SAT dispatch
  endpoint is a low-level primitive `Auto-assign` could later call, not
  itself a stand-in for that named business feature.

**Auto-activate decision (P3-T06, flagged for orchestrator review)**: a
completed CP-SAT run does **NOT** automatically become the active schedule
(`is_active` stays `False`, and the live `ProjectWorkflowStep` planned-week
fields the Gantt reads are left untouched — see
`services.schedule_persistence.persist_schedule_output`'s `activate`/
`sync_live_workflow_steps` parameters, both explicitly `False` in
`workers/schedule_tasks.py`). Rationale: CP-SAT auto-replacing the live,
portfolio-wide committed schedule with no human review in between is a much
bigger deal than the greedy path's synchronous "recompute now" (which a user
explicitly, synchronously requested and can see the result of immediately) —
a CP-SAT run may take up to a minute, run unattended, and land while nobody
is looking at the result. **This task does NOT build a separate "activate a
completed CP-SAT run" endpoint** — that is a real, currently-unfilled
product-feature gap (a completed, non-active CP-SAT `ScheduleRun` is
inspectable via `GET /schedule-runs` but has no way to become live yet),
flagged here loudly rather than silently built as an afterthought; it likely
belongs alongside whichever future phase gives "Apply Priorities"/review-and-
apply its real UI treatment.

**RBAC (P3-T02) — flagged interpretation, not a literal matrix row**:
`docs/PROJECT_AND_STACK.md` §5's role/permission matrix has no dedicated
"schedule run" surface/column; these endpoints back the Dashboard/Capacity/
Gantt read models, and the recalc/dispatch/cancel mutations are all
whole-portfolio (not hub-scoped) actions with no single obvious role owner.
Decisions made here (see `docs/MEMORY.md`'s P3-T02 entry for the original
rationale, re-confirmed rather than blindly copied for P3-T06's two new
endpoints):
- `GET /schedule-runs` / `GET /schedule-runs/active` require READ on at
  least one of `DASHBOARD`/`CAPACITY`/`GANTT` (`require_any_permission`) —
  any role that can read any of the three surfaces this data feeds can see
  which run is active/what versions exist.
- `POST /schedule-runs/greedy-recalc`, `POST /schedule-runs/cp-sat-dispatch`,
  and `POST /schedule-runs/{id}/cancel` all require `RoleName.ADMIN`
  specifically — the most conservative, default-deny choice. For CP-SAT
  dispatch specifically this is, if anything, an EASIER call than the
  greedy endpoint's original reasoning: it consumes real shared
  `solver-worker` compute capacity (not just a request-handler CPU-second)
  and produces schedule data with no obvious single-role owner in the
  matrix, so the same conservative default applies at least as strongly.
  Cancellation is gated identically to dispatch (whoever can start a run can
  stop one; there is no notion of "my own run" vs. "someone else's run" yet
  since `triggered_by_user_id` is recorded but not used for authorization).

**Hub-scoping (P3-T03) — reviewed, no change needed here, re-confirmed for
P3-T06's additions**: every response model in this file
(`ScheduleRunSummary`/`GreedyRecalcResponse`/`CpSatDispatchResponse`, see
`schemas/schedule_run.py`) is `ScheduleRun`-level metadata only (version,
solver_type, status, trigger_reason, aggregate counts / celery_task_id) — it
carries no per-project or per-hub fields at all. The *per-project* data
these endpoints' surfaces (Dashboard/Capacity/Gantt) read from the same
`ScheduleRun` snapshot is hub-scoped where it is actually exposed, in
`api/routers/dashboard.py`/`capacity.py`/`gantt.py` — filtering *this*
router's "which run is active"/"dispatch a new run"/"cancel a run" metadata
by hub would be both meaningless (there is exactly one active run,
portfolio-wide, by construction — see `ScheduleRun.is_active`'s partial
unique index) and wrong (it would make a Hub Planner unable to even discover
a run exists). Per this task's own guidance: "filter the *projects* within
the snapshot by hub, not filter which schedule run is active."

---

**P3-T05 — `GET /schedule-runs/{schedule_run_id}/progress` (SSE)**: relays
`workers.progress.publish_progress`'s Redis pub/sub channel
(`workers.progress.channel_name(schedule_run_id)`, never re-derived by
hand — see that module's docstring for the exact wire contract this endpoint
consumes verbatim, no reshaping) to the client as Server-Sent Events. Five
decisions made explicitly here, each re-derived rather than defaulted to:

1. **SSE framing** — plain `data: <json>\n\n` frames, one per relayed
   message, no custom SSE `event:` line. A consumer distinguishes message
   *kinds* via the JSON payload's own `"status"` field (`queued` / `running`
   / `completed` / `failed` / `cancelled`), not via the SSE protocol's event
   name — deliberately, so a naive `onmessage`-only (or fetch-body-line-by-
   line) consumer sees every event without needing to register per-event-type
   listeners. A `: heartbeat\n\n` SSE *comment* line (ignored by every SSE
   client/parser, including a hand-rolled fetch-based reader) is sent every
   ~15s of silence, purely to keep long-lived proxies (Nginx/Traefik, per
   CLAUDE.md's infra) from timing out an idle connection; the response also
   sets `X-Accel-Buffering: no` for the same reason (disables Nginx's
   response buffering, which would otherwise hold frames until the buffer
   fills instead of flushing them immediately).
2. **Auth — deliberately the plain `Authorization: Bearer <token>` header,
   the SAME `_read_any` dependency every other read endpoint in this file
   uses, NOT a token/ticket in the URL query string.** Read this before
   building a P4 SSE client: the browser's native `EventSource` API cannot
   set custom headers, which is exactly why a bearer-token-as-query-param
   shortcut is common — and exactly why it was rejected here. A URL query
   parameter leaks into server access logs, browser history, and any
   `Referer` header a subsequent cross-origin request happens to send, which
   is a real problem given CLAUDE.md's stated security posture (TLS 1.3,
   ModSecurity/OWASP CRS, an immutable audit log that must never itself
   become a vector for credential leakage via its own access logs). The
   alternative considered and rejected for THIS task's scope was a
   short-lived, single-use "SSE ticket" endpoint (mint an opaque token
   scoped to one `schedule_run_id` + principal, accepted via query param
   instead of the real bearer credential) — a strictly more secure design,
   but a materially bigger build (a new mint-endpoint, a ticket store/TTL,
   its own audit trail) than this task's scope justifies given the
   established `Authorization`-header pattern already works correctly for a
   non-`EventSource` SSE client. **Consequence for P4, stated loudly so it
   isn't rediscovered the hard way**: the frontend consumer for this
   endpoint MUST NOT be a bare `new EventSource(url)` (it cannot attach the
   required header) — it must be a `fetch()`-based streaming reader (e.g.
   `fetch(url, {headers: {Authorization: ...}})` + `response.body.getReader()`
   / `ReadableStream`, or a library like `@microsoft/fetch-event-source`
   built specifically around this exact `EventSource` limitation). This is a
   real, binding constraint on P4's implementation choice, not a footnote.
3. **RBAC — re-derived, not copied from dispatch/cancel's Admin-only
   gate**: this endpoint is a *read* of an in-flight run's status, the same
   class of operation as `GET /schedule-runs`/`GET /schedule-runs/active`
   (both `_read_any`, i.e. READ on any of DASHBOARD/CAPACITY/GANTT) — reusing
   `_read_any` here rather than `_admin_only`. Reasoning: there is no
   security reason watching a run's progress should be MORE restrictive than
   viewing that same run's eventual result via `GET /schedule-runs` once it
   lands (both surfaces expose only `ScheduleRun`-level status metadata, per
   Decision 4 below — no project/financial data flows through this channel
   at all, so the "who dispatched a run" `_admin_only` gate on the *mutating*
   endpoints doesn't need to extend to *observing* one that's already
   running). Any role that can see schedule-run data at all can watch a run's
   progress.
4. **Hub-scoping — not hub-scoped, same reasoning as the rest of this
   file**: the relayed payload (`schedule_run_id`, `status`, `timestamp`,
   optional `percent`/`message`/`error`) carries no per-project or per-hub
   field, and `ScheduleRun` rows themselves carry none either (re-confirmed
   from P3-T06's review, not re-derived from scratch) — there is nothing here
   *to* hub-scope.
5. **Already-terminal-by-connect-time handling — a real gap, handled
   explicitly, not silently**: Redis pub/sub has no replay/history, so a
   client that connects after a run has already reached `completed` /
   `failed` / `cancelled` would otherwise subscribe to a channel that will
   never publish again and hang forever. Handled by ordering the two reads
   deliberately: (1) a first `db.get(ScheduleRun, id)` for the plain
   existence check (404 if `None`) — this alone never opens a Redis
   connection, so an unknown id is a cheap, Redis-free 404; (2) if it exists,
   **subscribe to the Redis channel, THEN take a second, authoritative
   `db.refresh(run)` read of its current status.** Because every writer in
   this codebase commits its DB status change strictly before calling
   `publish_progress` (see `trigger_greedy_recalc`/`dispatch_cp_sat_run`/
   `cancel_schedule_run` above, and `workers/schedule_tasks.py`'s documented
   lifecycle), this ordering closes the race almost entirely: any transition
   to terminal that happens strictly after this endpoint's subscribe() call
   will still be delivered live over the already-open subscription, even if
   it raced ahead of the second (`refresh`) read. Only a transition that
   completed *before* the subscribe() call falls through to the DB-terminal
   branch, which
   synthesizes ONE terminal SSE event directly from the `ScheduleRun` row's
   own columns (`status`, `completed_at`/`created_at`, `error_message`) —
   clearly marked in that payload's own `"message"` field as a
   connect-time-synthesized event, not a relayed publish — and closes the
   stream immediately without ever entering the live-subscribe loop.
6. **Clean close on terminal / disconnect / safety cap** — the live-relay
   loop breaks (and its `finally` block unsubscribes + closes both the
   `PubSub` and the `redis.asyncio.Redis` client it opened) on any of: (a)
   relaying a message whose `"status"` is terminal, (b)
   `request.is_disconnected()` becoming true (the client went away), or (c) a
   safety wall-clock cap of `CelerySettings.task_time_limit_seconds + 120`s —
   a defensive-only backstop against a worker that dies without ever
   publishing a terminal event (e.g. the OS-process-death gap
   `workers/schedule_tasks.py`'s own docstring already flags as open), NOT a
   normal code path; hitting it sends one `:`-comment note and closes without
   fabricating a fake terminal status (a client that ever sees this should
   fall back to polling `GET /schedule-runs/{id}` — not built as a
   single-lookup endpoint yet, see P3-T06's "Deviations from plan" — or
   `GET /schedule-runs` filtered client-side).
"""

from __future__ import annotations

import json
import logging
import time
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import redis.asyncio as redis_asyncio
from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_any_permission, require_roles
from core.celery_config import get_celery_settings, get_redis_settings
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import RoleName, ScheduleRunStatus, SolverType
from models.schedule import ScheduleRun
from scheduling.greedy import run_greedy_sgs
from schemas.schedule_run import (
    CpSatDispatchRequest,
    CpSatDispatchResponse,
    GreedyRecalcResponse,
    ScheduleRunSummary,
)
from services.schedule_persistence import (
    build_schedule_input_from_db,
    create_queued_schedule_run,
    persist_schedule_output,
)
from workers.celery_app import celery_app
from workers.progress import channel_name, publish_progress
from workers.schedule_tasks import run_cp_sat_schedule

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/schedule-runs", tags=["schedule-runs"])

#: `models.enums.ScheduleRunStatus` member *values* that are terminal — kept
#: as a plain string frozenset (not the enum itself) because this set is
#: compared against BOTH `ScheduleRun.status.value` (DB reads) AND a relayed
#: Redis message's `payload["status"]` (already a lowercase string per
#: `workers/progress.py`'s documented schema), so a single representation
#: avoids two parallel comparisons drifting apart.
_TERMINAL_STATUS_VALUES = frozenset({"completed", "failed", "cancelled"})

#: SSE keep-alive comment cadence — see module docstring point 1.
_HEARTBEAT_INTERVAL_SECONDS = 15.0
#: How long a single `PubSub.get_message(timeout=...)` poll blocks before
#: returning `None` — bounds how quickly this generator notices a client
#: disconnect / the heartbeat deadline / the safety cap, without busy-looping.
_POLL_TIMEOUT_SECONDS = 1.0

_read_any = require_any_permission(
    (Surface.DASHBOARD, Action.READ),
    (Surface.CAPACITY, Action.READ),
    (Surface.GANTT, Action.READ),
)
_admin_only = require_roles(RoleName.ADMIN)


@router.get("", response_model=list[ScheduleRunSummary])
async def list_schedule_runs(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_any),
) -> list[ScheduleRun]:
    """All schedule run versions, newest first — "Versions & History"."""

    result = await db.execute(select(ScheduleRun).order_by(ScheduleRun.version.desc()))
    return list(result.scalars().all())


@router.get("/active", response_model=ScheduleRunSummary)
async def get_active_schedule_run(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_any),
) -> ScheduleRun:
    """The single `is_active=True` run every Dashboard/Capacity/Gantt read
    model must source its figures from (Invariant I9). 404 if none exists yet
    (nothing has ever been computed) — callers must handle this, not assume
    a run always exists.
    """

    result = await db.execute(select(ScheduleRun).where(ScheduleRun.is_active.is_(True)))
    run = result.scalar_one_or_none()
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active ScheduleRun yet — trigger one via POST /schedule-runs/greedy-recalc.",
        )
    return run


@router.post(
    "/greedy-recalc",
    response_model=GreedyRecalcResponse,
    status_code=status.HTTP_201_CREATED,
)
async def trigger_greedy_recalc(
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_admin_only),
) -> GreedyRecalcResponse:
    """Synchronously recompute the schedule over every current `Project`/
    `Engineer`/`Chamber` row using the greedy scheduler, persist it as a new
    versioned `ScheduleRun`, and activate it. See module docstring for why
    this is in-scope (greedy-only, synchronous) and what is explicitly out of
    scope (CP-SAT, "Apply Priorities", "Auto-assign" — all P3-T06/deferred).
    """

    schedule_input = await build_schedule_input_from_db(db)
    try:
        schedule_output = run_greedy_sgs(schedule_input)
    except ValueError as exc:
        # Malformed scheduling input (e.g. a schedulable project missing
        # category/priority) is a data-quality problem, not a server bug —
        # surfaced as a 422, not a 500.
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(exc)
        ) from exc

    run = await persist_schedule_output(
        db,
        schedule_input,
        schedule_output,
        solver_type=SolverType.GREEDY,
        trigger_reason="manual_recalc",
        triggered_by_user_id=current_user.user_id,
        activate=True,
    )

    left_out = sum(1 for o in schedule_output.project_outcomes if o.left_out)
    within_year = sum(1 for o in schedule_output.project_outcomes if o.within_year)
    spillover = sum(1 for o in schedule_output.project_outcomes if o.spillover)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="schedule_run.greedy_recalc",
            entity_type="ScheduleRun",
            entity_id=str(run.id),
            hub_id=None,
            before_state=None,
            after_state={
                "version": run.version,
                "solver_type": run.solver_type.value,
                "project_count": len(schedule_output.project_outcomes),
                "left_out_count": left_out,
                "within_year_count": within_year,
                "spillover_count": spillover,
            },
        )
    )
    await db.commit()
    await db.refresh(run)

    return GreedyRecalcResponse(
        schedule_run=ScheduleRunSummary.model_validate(run),
        project_count=len(schedule_output.project_outcomes),
        left_out_count=left_out,
        within_year_count=within_year,
        spillover_count=spillover,
    )


@router.post(
    "/cp-sat-dispatch",
    response_model=CpSatDispatchResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def dispatch_cp_sat_run(
    request: CpSatDispatchRequest = CpSatDispatchRequest(),
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_admin_only),
) -> CpSatDispatchResponse:
    """Enqueue an async CP-SAT schedule run on a Celery worker
    (`solver-worker`) and return immediately (202) with the new
    `ScheduleRun`'s id/`celery_task_id`, so the client can open a P3-T05 SSE
    connection against `workers.progress.channel_name(schedule_run_id)` to
    follow `queued -> running -> completed/failed/cancelled`. See module
    docstring for the full RBAC/auto-activate/hub-scoping reasoning, and
    `workers/schedule_tasks.py` for what actually happens inside the worker.

    Deliberately does NOT attempt to pre-validate the scheduling input (e.g.
    the way `trigger_greedy_recalc` catches `ValueError` and 422s) before
    dispatching — the same validation `scheduling.cp_sat.run_cp_sat` performs
    only happens deep inside that pure function, and evaluating it here would
    mean partially running solver-adjacent logic inside the FastAPI process.
    A malformed-input failure instead surfaces asynchronously as this run's
    `status=FAILED` / `error_message`, and as a `"failed"` progress event —
    the natural, correct shape for a fire-and-forget background job, not a
    workaround.
    """

    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.CP_SAT,
        trigger_reason="cp_sat_dispatch",
        triggered_by_user_id=current_user.user_id,
    )

    async_result = run_cp_sat_schedule.delay(
        str(run.id),
        triggered_by_user_id=str(current_user.user_id),
        max_time_in_seconds=request.max_time_in_seconds,
    )
    run.celery_task_id = async_result.id
    db.add(run)

    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="schedule_run.cp_sat_dispatch",
            entity_type="ScheduleRun",
            entity_id=str(run.id),
            hub_id=None,
            before_state=None,
            after_state={
                "version": run.version,
                "solver_type": run.solver_type.value,
                "status": run.status.value,
                "celery_task_id": run.celery_task_id,
            },
        )
    )
    await db.commit()
    await db.refresh(run)

    publish_progress(str(run.id), status="queued")

    return CpSatDispatchResponse(
        schedule_run=ScheduleRunSummary.model_validate(run),
        celery_task_id=run.celery_task_id,
    )


@router.post("/{schedule_run_id}/cancel", response_model=ScheduleRunSummary)
async def cancel_schedule_run(
    schedule_run_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_admin_only),
) -> ScheduleRun:
    """Request cancellation of a `QUEUED` or `RUNNING` `ScheduleRun`. See
    module docstring + `workers/schedule_tasks.py`'s module docstring for the
    full, honest cancellation semantics: a `QUEUED` run is cleanly prevented
    from ever starting; a `RUNNING` run's worker process is hard-killed
    (`terminate=True`, an OS-level kill under Celery's default `prefork`
    pool — not a soft/cooperative signal) and this row is set to `CANCELLED`
    directly by THIS endpoint, not left to the (possibly-just-killed) task to
    update it itself.

    404 if the run doesn't exist; 409 if it is already in a terminal state
    (`COMPLETED`/`FAILED`/`CANCELLED`) — cancelling a finished run is a
    no-op-that-should-fail-loudly, not silently accepted.
    """

    run = await db.get(ScheduleRun, schedule_run_id)
    if run is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="ScheduleRun not found"
        )
    if run.status not in (ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Cannot cancel a ScheduleRun in status={run.status.value}",
        )

    if run.celery_task_id:
        celery_app.control.revoke(run.celery_task_id, terminate=True, signal="SIGTERM")

    run.status = ScheduleRunStatus.CANCELLED
    run.completed_at = datetime.now(UTC)
    db.add(run)
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="schedule_run.cancel",
            entity_type="ScheduleRun",
            entity_id=str(run.id),
            hub_id=None,
            before_state=None,
            after_state={"version": run.version, "status": run.status.value},
        )
    )
    await db.commit()
    await db.refresh(run)

    # Published even though the worker (if it was RUNNING) may already be
    # dead — a client already subscribed via P3-T05's SSE endpoint should see
    # "cancelled" promptly rather than only discover it by polling
    # `GET /schedule-runs/{id}` (not built by this task — see
    # `GET /schedule-runs`/`GET /schedule-runs/active` for the closest
    # existing reads).
    publish_progress(str(run.id), status="cancelled")

    return run


def _sse_data_frame(raw_json: str) -> bytes:
    """`data: <raw_json>\\n\\n`, per module docstring point 1 (no custom
    `event:` line — see there for why). `raw_json` is passed through
    byte-for-byte for a relayed publisher message (never re-serialized —
    "relay whatever the publisher actually sends... pass it through", per
    this task's brief) and is our own `json.dumps(...)` output for a locally
    synthesized (already-terminal-at-connect-time) event.
    """

    return f"data: {raw_json}\n\n".encode()


def _build_synthetic_terminal_payload(run: ScheduleRun) -> dict[str, str | float]:
    """Construct ONE terminal-status payload directly from a `ScheduleRun`
    row's own DB columns, matching `workers/progress.py`'s documented
    message schema field-for-field. Used only for the "client connected
    after this run already went terminal" case (module docstring point 5) —
    Redis pub/sub has no replay, so this is a synthesized substitute for the
    live publish this client structurally cannot have received, not a relay.
    Clearly self-identifies as such via `"message"` so a client/log reader
    can tell the two apart if it ever matters.
    """

    timestamp = run.completed_at or run.created_at
    payload: dict[str, str | float] = {
        "schedule_run_id": str(run.id),
        "status": run.status.value,
        "timestamp": timestamp.astimezone(UTC).isoformat(),
        "message": (
            "Synthesized on connect: this run had already reached a terminal "
            "state before this SSE client subscribed, and Redis pub/sub has "
            "no replay — this event reflects the ScheduleRun row's current "
            "DB state, not a relayed publish."
        ),
    }
    if run.status == ScheduleRunStatus.COMPLETED:
        payload["percent"] = 100.0
    if run.status == ScheduleRunStatus.FAILED and run.error_message:
        # P3-T09 (security remediation, finding #7, Low — info disclosure):
        # this synthesized payload is served to the same broad `_read_any`
        # audience (any DASHBOARD/CAPACITY/GANTT-read role) as the live
        # relay path in `workers/schedule_tasks.py` — a generic message here
        # too, not `run.error_message` verbatim. The full text remains on
        # `ScheduleRun.error_message` itself, reachable via `GET
        # /schedule-runs` (Admin-only, see `_admin_only` below) and in
        # server logs.
        payload["error"] = "Solver run failed — see server logs"
    return payload


async def _progress_event_source(
    *,
    request: Request,
    schedule_run_id: uuid.UUID,
    redis_client: redis_asyncio.Redis,
    pubsub: redis_asyncio.client.PubSub,
    initial_terminal_payload: dict[str, str | float] | None,
) -> AsyncIterator[bytes]:
    """The actual SSE body generator. Deliberately takes `redis_client`/
    `pubsub` as already-open objects it owns and closes itself (in `finally`)
    rather than a FastAPI `Depends(...)`-provided resource: FastAPI/Starlette
    tear down `yield`-based dependencies as soon as the endpoint function
    RETURNS the `Response` object, which for a `StreamingResponse` is BEFORE
    the body generator below has actually run — a real, documented FastAPI
    gotcha (dependencies-with-yield are not kept alive for the lifetime of a
    streamed response body). This generator therefore never touches the
    request-scoped `db: AsyncSession` at all; the caller
    (`stream_schedule_run_progress`) does every DB read it needs BEFORE
    constructing this generator / returning the `StreamingResponse`, and
    hands this function only plain values (`initial_terminal_payload`) plus
    Redis objects that are NOT FastAPI dependencies and therefore aren't
    subject to that teardown-timing gotcha.
    """

    if initial_terminal_payload is not None:
        yield _sse_data_frame(json.dumps(initial_terminal_payload))
        return

    channel = channel_name(schedule_run_id)
    max_stream_seconds = get_celery_settings().task_time_limit_seconds + 120
    deadline = time.monotonic() + max_stream_seconds
    last_heartbeat = time.monotonic()
    try:
        while True:
            if await request.is_disconnected():
                logger.info(
                    "SSE client disconnected from schedule-run-progress:%s", schedule_run_id
                )
                break
            now = time.monotonic()
            if now >= deadline:
                # Safety backstop only, not a normal path — see module
                # docstring point 6. Deliberately does NOT fabricate a
                # terminal status; a client hitting this should fall back to
                # polling `GET /schedule-runs/{id}`.
                logger.warning(
                    "SSE stream for schedule-run-progress:%s hit its %.0fs safety "
                    "cap without observing a terminal event — closing without a "
                    "synthesized status.",
                    schedule_run_id,
                    max_stream_seconds,
                )
                yield b": stream-timeout, closing - poll GET /schedule-runs/{id}\n\n"
                break

            try:
                msg = await pubsub.get_message(
                    ignore_subscribe_messages=True, timeout=_POLL_TIMEOUT_SECONDS
                )
            except Exception:
                logger.exception(
                    "Redis error while polling schedule-run-progress:%s — closing stream",
                    schedule_run_id,
                )
                yield b": upstream-error, closing\n\n"
                break

            if msg is None:
                if now - last_heartbeat >= _HEARTBEAT_INTERVAL_SECONDS:
                    yield b": heartbeat\n\n"
                    last_heartbeat = now
                continue

            raw = msg["data"]
            data_str = raw.decode() if isinstance(raw, (bytes, bytearray)) else raw
            yield _sse_data_frame(data_str)

            try:
                relayed_status = json.loads(data_str).get("status")
            except (json.JSONDecodeError, TypeError, AttributeError):
                relayed_status = None
            if relayed_status in _TERMINAL_STATUS_VALUES:
                break
    finally:
        try:
            await pubsub.unsubscribe(channel)
            await pubsub.aclose()
        finally:
            await redis_client.aclose()


@router.get("/{schedule_run_id}/progress")
async def stream_schedule_run_progress(
    schedule_run_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read_any),
) -> StreamingResponse:
    """Server-Sent Events stream of `workers.progress.publish_progress`'s
    Redis pub/sub messages for this `schedule_run_id` — see module docstring
    for the full auth/RBAC/hub-scoping/framing/already-terminal/clean-close
    reasoning (all six numbered decisions live there, not duplicated here).

    404 if no `ScheduleRun` with this id exists at all (same convention as
    `POST /schedule-runs/{id}/cancel`).
    """

    # Existence check first — a 404 for an unknown id never opens a Redis
    # connection at all (no need to; there is nothing to race against).
    run = await db.get(ScheduleRun, schedule_run_id)
    if run is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="ScheduleRun not found")

    redis_client = redis_asyncio.Redis.from_url(get_redis_settings().redis_url)
    pubsub = redis_client.pubsub()
    channel = channel_name(schedule_run_id)
    # Subscribe BEFORE the SECOND (authoritative) status read below — see
    # module docstring point 5 for why this ordering, not the reverse, is
    # what closes the "missed the terminal event" race: any transition that
    # happens strictly after this subscribe() call is still delivered live
    # over this subscription even if it raced ahead of the refresh() below.
    await pubsub.subscribe(channel)
    await db.refresh(run)

    initial_terminal_payload: dict[str, str | float] | None = None
    if run.status.value in _TERMINAL_STATUS_VALUES:
        initial_terminal_payload = _build_synthetic_terminal_payload(run)
        await pubsub.unsubscribe(channel)
        await pubsub.aclose()
        await redis_client.aclose()

    generator = _progress_event_source(
        request=request,
        schedule_run_id=schedule_run_id,
        redis_client=redis_client,
        pubsub=pubsub,
        initial_terminal_payload=initial_terminal_payload,
    )
    return StreamingResponse(
        generator,
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disables Nginx response buffering so frames flush immediately
            # instead of waiting for a buffer to fill — see module docstring
            # point 1.
            "X-Accel-Buffering": "no",
        },
    )
