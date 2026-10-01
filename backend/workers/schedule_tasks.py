"""The Celery task that actually invokes `scheduling.cp_sat.run_cp_sat` — the
ONLY place in this codebase CP-SAT is ever called from, per CLAUDE.md's
non-negotiable ("CP-SAT dispatch always goes through a Celery task in
`solver-worker`, never inline in a FastAPI request handler") and
`models.schedule.ScheduleRun`'s own docstring ("CP-SAT runs always go
through a Celery task in `solver-worker`").

**Lifecycle this task drives** (see `services.schedule_persistence`'s
`create_queued_schedule_run` / `persist_schedule_output(existing_run=...)`
for the persistence half): a single `ScheduleRun` row, already created in
`QUEUED` status by `api/routers/schedule_runs.py`'s dispatch endpoint before
this task is even enqueued, transitions in place:

    QUEUED --(this task starts)--> RUNNING --(solve succeeds)--> COMPLETED
                                          \\--(solve raises)-----> FAILED
                                          \\--(cancelled, see below)-> CANCELLED

**Async DB access from a sync Celery task** — Celery tasks are plain
synchronous functions (no native `async def` task support); the rest of this
codebase's DB layer is async-only (`sqlalchemy.ext.asyncio`, `api/db.py`).
This module bridges the two via `asyncio.run(...)` wrapping a single async
inner coroutine — but, critically, it does NOT reuse `api.db.get_engine()`/
`get_session_factory()`'s module-level singleton `AsyncEngine`. This is a
DELIBERATE deviation from that module's own established "lazy singleton"
convention, not an oversight, and cost real debugging time during this
task's own live verification to discover, so it is documented here in full:

`asyncpg` connections (and the `AsyncEngine`/pool wrapping them) are bound to
the specific `asyncio` event loop they were created on and cannot be reused
from a different one. `api.db`'s singleton is safe for the FastAPI process
because that process has exactly ONE event loop for its entire lifetime
(uvicorn's own). A Celery worker process handling many tasks over its
lifetime is different: each `asyncio.run(...)` call in `run_cp_sat_schedule`
below creates a BRAND NEW event loop and destroys it when the coroutine
finishes. If this module called `api.db.get_engine()`, the engine created
during the FIRST task's event loop would still be the object returned on the
SECOND task's (new, different) event loop — and asyncpg raises `RuntimeError:
... got Future ... attached to a different loop` the moment it's used. This
was caught live, not by inspection: a second task dispatched to an
already-warm worker process failed with exactly that error before this fix.
The fix: this module creates its own fresh, disposable `AsyncEngine` +
`async_sessionmaker` INSIDE each `_run_cp_sat_schedule_async` invocation
(scoped to that call's own event loop) and disposes the engine before
returning — see `_open_session_factory` below. This still mirrors
`seed/seed_demo_data.py`'s "asyncio.run() at the top of a non-FastAPI
entrypoint" precedent for the asyncio-bridging shape, just not its (or
`api.db`'s) engine-reuse shape, for the reason above.

**Cancellation semantics — read before assuming this is a soft/graceful
cancel**: `scheduling.cp_sat.run_cp_sat` (read directly, not assumed) exposes
NO cancellation token / progress callback of its own — it is one single
blocking `solver.Solve(model)` call this module has no hook into (and
`backend/scheduling/` must not be edited to add one). This task therefore
implements two DIFFERENT cancellation paths, and is explicit about which is
which:

1. **QUEUED, not yet started**: `api/routers/schedule_runs.py`'s cancel
   endpoint calls `celery_app.control.revoke(task_id)` (no `terminate=True`
   needed) AND sets the DB row to `CANCELLED` directly. If a worker
   nonetheless happens to pick the task up in the narrow race window before
   the revoke propagates, this task's own first DB read (below) checks
   `run.status == CANCELLED` and no-ops immediately — a genuine, clean
   "never actually started" cancel.
2. **RUNNING, mid-solve**: there is no way to interrupt `solver.Solve(...)`
   from Python once it has been called. The cancel endpoint instead (a)
   sets the DB row to `CANCELLED` immediately (not waiting for this task to
   notice — see that endpoint's own docstring for why: otherwise a killed
   worker process would leave the row stuck in `RUNNING` forever) and (b)
   sends `celery_app.control.revoke(task_id, terminate=True, signal="SIGTERM")`
   — with Celery's default `prefork` worker pool, this is an OS-level kill
   of the worker CHILD PROCESS executing the task (via `billiard`), not a
   cooperative Python-level signal handler — it genuinely does stop a
   mid-solve CP-SAT computation dead, confirmed by this task's own live
   verification (see `docs/MEMORY.md`'s P3-T06 entry), NOT merely a
   best-effort request the solve might ignore. This is the honest reason
   this task ALSO checks `run.status == CANCELLED` again immediately after
   `run_cp_sat` returns (the "re-check cancellation flag" block below): in
   the rare case the terminate signal does not land before the (already
   in-flight) solve completes naturally, this task still discards the
   computed output rather than persisting/activating a result the caller
   explicitly asked to cancel.

**Known, accepted gap**: if the worker OS PROCESS itself is killed outright
for a reason OTHER than an explicit cancel request (OOM kill, host reboot,
`kill -9` from outside Celery, ...) — i.e. the process dies without this
function's own `except` block ever getting to run at all — the `ScheduleRun`
row is left stuck in `QUEUED`/`RUNNING` with no automatic reconciliation; no
watchdog/stale-row-sweeper is built here. Flagged as a real, documented
limitation for a later phase (e.g. a periodic Celery beat task), not
silently unhandled. This is narrower than it might first sound: this
function's own `try`/`except` wraps its ENTIRE body (not just the solve
step) specifically so that any exception the Python process itself can
still handle — including a failure importing `api.db`, opening the DB
session, or building/solving the schedule — DOES reliably mark the row
`FAILED` via a best-effort fresh session. This distinction (Python-level
exception vs. OS-level process death) is not academic: an earlier version of
this function only wrapped the solve step, and a real deployment
misconfiguration (the worker process launched without `backend/` on
`sys.path`, making its own first `from api.db import ...` raise
`ModuleNotFoundError`) left a `ScheduleRun` row stuck in `QUEUED` forever
during this task's own live verification — caught and fixed by widening the
`try` to cover the whole function body; see `docs/MEMORY.md`'s P3-T06 entry.
"""

from __future__ import annotations

import asyncio
import logging
import os
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from celery import Task
from sqlalchemy import select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from core.celery_config import get_celery_settings
from models.audit import AuditLogEntry
from models.enums import ScheduleRunStatus, SolverType
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from scheduling.cp_sat import run_cp_sat
from scheduling.greedy import run_greedy_sgs
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from workers.celery_app import celery_app
from workers.progress import publish_progress

logger = logging.getLogger(__name__)

#: Celery task name — explicit (not left to Celery's auto-derived
#: `module.function` name) so it stays stable across any future module move.
TASK_NAME = "workers.run_cp_sat_schedule"


def _database_url() -> str:
    """Same `RPD_DATABASE_URL` env var / "fail loudly if unset" convention as
    `api/db.py::_database_url` — deliberately NOT imported from that module
    (a two-line duplication) so this module never depends on `api.db`'s
    engine-reuse-across-requests-in-one-event-loop assumption at all — see
    module docstring's "Async DB access" section for why that assumption
    does not hold for this worker.
    """

    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError(
            "RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN). "
            "See backend/api/db.py / backend/alembic/env.py for the same convention."
        )
    return url


@asynccontextmanager
async def _open_session_factory() -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """A fresh `AsyncEngine` + `async_sessionmaker`, scoped to (and disposed
    at the end of) THIS `async with` block — never a module-level singleton.
    See module docstring's "Async DB access" section for exactly why reusing
    one across separate `asyncio.run()`-created event loops breaks asyncpg.
    """

    engine: AsyncEngine = create_async_engine(_database_url())
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@celery_app.task(bind=True, name=TASK_NAME)
def run_cp_sat_schedule(
    self: Task,
    schedule_run_id: str,
    *,
    triggered_by_user_id: str | None = None,
    deterministic_time: float | None = None,
    activate: bool = False,
    recalc_project_id: str | None = None,
    **legacy_kwargs: Any,
) -> dict[str, Any]:
    """Celery entry point (sync). `schedule_run_id` must already reference an
    existing `ScheduleRun` row in `QUEUED` status (created by
    `services.schedule_persistence.create_queued_schedule_run`, via `POST
    /schedule-runs/cp-sat-dispatch`). `deterministic_time` is the CP-SAT
    pass-1 budget in deterministic-time units (DOMAIN_RULES "Gate remediation
    rulings" #6); if omitted it falls back to
    `core.celery_config.CelerySettings.cp_sat_deterministic_time`, then to the
    solver's own default. P9-R02b: `**legacy_kwargs` swallows a
    `max_time_in_seconds` kwarg on messages enqueued before this release, so
    they still run; the wall-clock value is ignored. Remove after P9.
    """

    _ = legacy_kwargs  # deliberately unused (ruling 6)

    return asyncio.run(
        _run_cp_sat_schedule_async(
            self,
            schedule_run_id=schedule_run_id,
            triggered_by_user_id=triggered_by_user_id,
            deterministic_time=deterministic_time,
            activate=activate,
            recalc_project_id=recalc_project_id,
        )
    )


#: P9-T03 follow-up. Explicit name, same reason as `TASK_NAME`.
GREEDY_TASK_NAME = "workers.run_greedy_schedule"


@celery_app.task(bind=True, name=GREEDY_TASK_NAME)
def run_greedy_schedule(
    self: Task,
    schedule_run_id: str,
    *,
    triggered_by_user_id: str | None = None,
    activate: bool = False,
    recalc_project_id: str | None = None,
) -> dict[str, Any]:
    """The greedy scheduler on the same Celery lifecycle as
    `run_cp_sat_schedule` (QUEUED → RUNNING → COMPLETED/FAILED, SSE progress,
    `persist_schedule_output`). Used by the Project Workspace's "Recalculate
    schedule" (`POST /projects/{id}/recalculate`). docs/OPEN_QUESTIONS.md #10
    keeps CP-SAT out of user-facing actions until the client answers. Greedy
    is allowed on either side of the API/worker boundary
    (docs/PROJECT_AND_STACK.md §4); running it here keeps the endpoint's
    202 + SSE contract.
    """

    return asyncio.run(
        _run_cp_sat_schedule_async(
            self,
            schedule_run_id=schedule_run_id,
            triggered_by_user_id=triggered_by_user_id,
            deterministic_time=None,
            activate=activate,
            recalc_project_id=recalc_project_id,
            solver=SolverType.GREEDY,
        )
    )


async def _projected_finish(
    db: AsyncSession, schedule_run_id: uuid.UUID | None, project_id: uuid.UUID
) -> int | None:
    """The project's stored `projected_end_week` in a run, or `None`."""

    if schedule_run_id is None:
        return None
    return (
        await db.execute(
            select(ScheduleRunProjectOutcome.projected_end_week).where(
                ScheduleRunProjectOutcome.schedule_run_id == schedule_run_id,
                ScheduleRunProjectOutcome.project_id == project_id,
            )
        )
    ).scalar_one_or_none()


async def _run_cp_sat_schedule_async(
    task: Task,
    *,
    schedule_run_id: str,
    triggered_by_user_id: str | None,
    deterministic_time: float | None,
    activate: bool = False,
    recalc_project_id: str | None = None,
    solver: SolverType = SolverType.CP_SAT,
) -> dict[str, Any]:
    """`activate=True` is the Project Workspace "Recalculate schedule" path
    (P9-T03, ADR 0006): the user asked for a new live schedule, so the
    completed run becomes active, the live step rows are synced and the
    stale flags of its projects are cleared (inside
    `persist_schedule_output`). `recalc_project_id` then gets a system event
    on its activity feed, "Schedule recalculated — finish moved week X →
    week Y" (an `AuditLogEntry`, action `project.schedule_recalculated`).
    The admin `POST /schedule-runs/cp-sat-dispatch` path keeps the P3-T06
    default: `activate=False`, never auto-activated.
    """

    run_uuid = uuid.UUID(schedule_run_id)

    try:
        # Opening the session itself is DELIBERATELY inside the SAME broad
        # `try` the "mark FAILED" `except` below covers — a real bug caught
        # during this task's own live verification (see `docs/MEMORY.md`'s
        # P3-T06 entry): an earlier version of this function only wrapped
        # the solve step in a `try`/`except`, so a failure before that point
        # (a real PYTHONPATH/deployment misconfiguration that made an
        # earlier version's `from api.db import ...` raise
        # `ModuleNotFoundError` when the worker process was launched without
        # `backend/` on `sys.path`) left the `ScheduleRun` row stuck in
        # `QUEUED` forever — Celery's own task state correctly showed
        # `FAILURE`, but nothing ever told the `ScheduleRun` row or a P3-T05
        # SSE subscriber. This function now marks the row `FAILED` for ANY
        # exception raised anywhere in its body, not just ones raised after
        # the DB session was already open.
        async with _open_session_factory() as session_factory, session_factory() as db:
            run = await db.get(ScheduleRun, run_uuid)
            if run is None:
                raise RuntimeError(
                    f"ScheduleRun {schedule_run_id} not found — deleted before the task started?"
                )

            if run.status == ScheduleRunStatus.CANCELLED:
                logger.info(
                    "ScheduleRun %s already cancelled before task started; no-op.",
                    schedule_run_id,
                )
                publish_progress(schedule_run_id, status="cancelled")
                return {"status": "cancelled", "schedule_run_id": schedule_run_id}

            run.status = ScheduleRunStatus.RUNNING
            run.started_at = datetime.now(UTC)
            run.celery_task_id = task.request.id
            db.add(run)
            await db.commit()
            solver_label = "Greedy" if solver == SolverType.GREEDY else "CP-SAT"
            publish_progress(
                schedule_run_id, status="running", message=f"{solver_label} solve started"
            )

            schedule_input = await build_schedule_input_from_db(db)
            objective_value: float | None = None
            # Ruling 6: "OPTIMAL"/"FEASIBLE" for CP-SAT, None for greedy
            # (matches `ScheduleOutput.solver_status`; `solver_type` records
            # which solver ran).
            solver_status: str | None = None
            if solver == SolverType.GREEDY:
                # P9-T03 follow-up: the workspace "Recalculate schedule" path
                # (docs/OPEN_QUESTIONS.md #10 blocks exposing CP-SAT through a
                # user-facing action). Same lifecycle, same persistence.
                schedule_output = run_greedy_sgs(schedule_input)
            else:
                # Ruling 6: deterministic-time budget only, never wall-clock.
                effective_dt = (
                    deterministic_time
                    if deterministic_time is not None
                    else get_celery_settings().cp_sat_deterministic_time
                )
                if effective_dt is not None:
                    schedule_output, solve_info = run_cp_sat(
                        schedule_input, deterministic_time=effective_dt
                    )
                else:
                    schedule_output, solve_info = run_cp_sat(schedule_input)
                objective_value = solve_info.objective_value
                solver_status = solve_info.status_name
                # P6-T06: CP-SAT solve time is a reasonable, non-sensitive
                # aggregate performance number to surface (an operator tuning
                # `RPD_CELERY_CP_SAT_DETERMINISTIC_TIME` needs this) — never
                # tied to a named project/customer, just this run's own
                # status and wall-clock duration.
                logger.info(
                    "ScheduleRun %s: CP-SAT solve finished",
                    schedule_run_id,
                    extra={
                        "schedule_run_id": schedule_run_id,
                        "solver_status": solve_info.status_name,
                        "solve_wall_time_seconds": round(solve_info.wall_time_seconds, 2),
                    },
                )

            # Re-check for a cancel request that landed while the (blocking,
            # un-interruptible) solve was running — see module docstring's
            # cancellation semantics. Discard the computed output rather
            # than persist/activate a result the caller explicitly asked to
            # cancel.
            await db.refresh(run)
            if run.status == ScheduleRunStatus.CANCELLED:
                logger.info(
                    "ScheduleRun %s was cancelled mid-solve; discarding computed output.",
                    schedule_run_id,
                )
                publish_progress(schedule_run_id, status="cancelled")
                return {"status": "cancelled", "schedule_run_id": schedule_run_id}

            actor_uuid = uuid.UUID(triggered_by_user_id) if triggered_by_user_id else None
            recalc_uuid = uuid.UUID(recalc_project_id) if recalc_project_id else None
            previous_active_id = (
                await db.execute(select(ScheduleRun.id).where(ScheduleRun.is_active.is_(True)))
            ).scalar_one_or_none()
            previous_finish = (
                await _projected_finish(db, previous_active_id, recalc_uuid)
                if recalc_uuid is not None
                else None
            )
            await persist_schedule_output(
                db,
                schedule_input,
                schedule_output,
                solver_type=solver,
                trigger_reason=run.trigger_reason or "cp_sat_dispatch",
                triggered_by_user_id=actor_uuid,
                # Decision (docs/MEMORY.md P3-T06 entry): an admin CP-SAT
                # dispatch never auto-activates (`activate=False`). The
                # P9-T03 workspace recalculation passes `activate=True`.
                # `sync_live_workflow_steps` must equal `activate`; see
                # `services.schedule_persistence.persist_schedule_output`'s
                # "Sharp edge" note (it raises ValueError otherwise).
                activate=activate,
                sync_live_workflow_steps=activate,
                existing_run=run,
                objective_value=objective_value,
                solver_status=solver_status,
            )
            if activate and recalc_uuid is not None:
                new_finish = await _projected_finish(db, run.id, recalc_uuid)
                hub_id = (
                    await db.execute(select(Project.hub_id).where(Project.id == recalc_uuid))
                ).scalar_one_or_none()
                db.add(
                    AuditLogEntry(
                        actor_user_id=actor_uuid,
                        action="project.schedule_recalculated",
                        entity_type="Project",
                        entity_id=str(recalc_uuid),
                        hub_id=hub_id,
                        before_state={
                            "project_id": str(recalc_uuid),
                            "projected_end_week": previous_finish,
                        },
                        after_state={
                            "project_id": str(recalc_uuid),
                            "projected_end_week": new_finish,
                            "schedule_run_id": str(run.id),
                            "schedule_run_version": run.version,
                        },
                    )
                )
            await db.commit()
            publish_progress(schedule_run_id, status="completed", percent=100.0)
            return {
                "status": "completed",
                "schedule_run_id": schedule_run_id,
                "objective_value": objective_value,
                "solver_status": solver_status,
            }
    except Exception as exc:  # noqa: BLE001 - deliberately broad, see comment above
        # Best-effort: use a FRESH session (the one above, if any, may never
        # have been successfully created) to mark the row FAILED and publish
        # a "failed" event. Itself wrapped defensively — if Postgres/Redis
        # are genuinely unreachable, this cannot magically fix that (an
        # accepted, documented limit, see module docstring's "Known,
        # accepted gap" note), but it must never let a SECOND exception from
        # this cleanup path mask the original one.
        try:
            async with (
                _open_session_factory() as cleanup_session_factory,
                cleanup_session_factory() as cleanup_db,
            ):
                failed_run = await cleanup_db.get(ScheduleRun, run_uuid)
                if failed_run is not None and failed_run.status in (
                    ScheduleRunStatus.QUEUED,
                    ScheduleRunStatus.RUNNING,
                ):
                    failed_run.status = ScheduleRunStatus.FAILED
                    failed_run.error_message = str(exc)[:2000]
                    failed_run.completed_at = datetime.now(UTC)
                    cleanup_db.add(failed_run)
                    await cleanup_db.commit()
        except Exception:
            logger.exception(
                "ScheduleRun %s: failed to mark row FAILED after task error", schedule_run_id
            )
        try:
            # P3-T09 (security remediation, finding #7, Low — info
            # disclosure): the SSE `error` field is reachable by any
            # DASHBOARD/CAPACITY/GANTT-read role via
            # `GET /schedule-runs/{id}/progress`, a much broader audience
            # than `ScheduleRun.error_message` (Admin-only, via
            # `GET /schedule-runs`). Relay a generic message over SSE; the
            # full `str(exc)` is preserved above in `error_message` and in
            # the server logs (`logger.exception` calls in this module) —
            # never in the SSE payload.
            publish_progress(
                schedule_run_id,
                status="failed",
                error="Solver run failed — see server logs",
            )
        except Exception:
            logger.exception(
                "ScheduleRun %s: failed to publish 'failed' progress event", schedule_run_id
            )
        raise
