"""One-off recalculation after migration `p33c_clear_step_timing` (P33-T13,
ADR 0048 §3 "Recalculation"; docs/API_CONTRACT_P33.md Part H).

A migration never dispatches runs. Run this once after `alembic upgrade`:

    RPD_DATABASE_URL=... python -m scripts.p33_recalc_after_timing_clear

It dispatches exactly ONE greedy run with `trigger_reason="timing_cleared"`
and the priority-move lifecycle, and writes one `schedule_run.dispatched`
audit row (actor NULL = system):

- no `project.step_timing_cleared` audit row exists (p33c cleared nothing)
  → `nothing_cleared`, nothing is written;
- a `timing_cleared` run that is queued, running or completed, or a
  `deferred` marker, already exists → `already_dispatched`, nothing is
  written (so a second invocation dispatches nothing). A FAILED (or
  cancelled) `timing_cleared` run does not count: whether the broker refused
  it, it was reaped, or it failed while executing, a later invocation
  retries (P33-R01);
- another run is in flight → `deferred`: the ADR 0023 follow-up flag is set
  (the coalesced `follow_up` run reads the cleared state), with the marker
  row;
- otherwise → `queued`: one QUEUED greedy run, enqueued through
  `services.run_dispatch.dispatch_greedy` (inline by default: the script
  then waits for it to finish; with `RPD_GREEDY_INLINE=false` it goes to the
  solver worker). A broker failure answers `dispatch_failed` (the run row is
  FAILED and audited, the projects stay stale) and a later invocation
  retries.

After a `queued` dispatch the script waits (`--wait-seconds`, both inline and
worker mode) for the run's outcome (P33-R01):

- COMPLETED → `queued`, exit 0;
- FAILED / CANCELLED → `run_failed`, exit 1 (the projects stay stale; fix the
  cause, e.g. a missing `RPD_FIELD_ENCRYPTION_KEY`, and run the script again:
  it dispatches a new run);
- still queued / running when the wait ends → `still_running`, exit 3 (do
  NOT rerun blindly: a rerun answers `already_dispatched` while that run is
  in flight; check `/schedule-runs` and rerun only if it ends FAILED).

Exit codes: 0 success or nothing to do, 1 failure (`dispatch_failed`,
`run_failed`), 2 `RPD_DATABASE_URL` missing, 3 `still_running`.

The decision is taken under the dispatch advisory lock, so two concurrent
invocations cannot both dispatch. Output is the status and counts only; no
project data is printed, and no financial field is read. The run's change
list (`/schedule-runs/{run}/changes`) shows what moved.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
import uuid
from dataclasses import dataclass
from typing import Any, Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from models.audit import AuditLogEntry
from models.enums import ScheduleRunStatus, SolverType
from models.schedule import ScheduleRun
from services.active_run import get_active_run
from services.run_dispatch import (
    DISPATCH_LOCK_KEY,
    dispatch_greedy,
    enqueue_or_fail,
    find_in_flight_run,
    wait_for_inline_runs,
)
from services.schedule_persistence import create_queued_schedule_run
from workers.progress import publish_progress_best_effort as publish_progress

#: `ScheduleRun.trigger_reason` of the one run (contract P33 Part H).
TRIGGER_REASON = "timing_cleared"
#: The audit action p33c writes per affected project.
CLEARED_ACTION = "project.step_timing_cleared"
#: The audit action this script writes once (contract P33 Part H).
DISPATCHED_ACTION = "schedule_run.dispatched"

Status = Literal[
    "nothing_cleared",
    "already_dispatched",
    "queued",
    "deferred",
    "dispatch_failed",
    "run_failed",
    "still_running",
]

#: A `timing_cleared` run in one of these states counts as dispatched; a
#: FAILED or CANCELLED one does not, so a later invocation retries (P33-R01).
_DISPATCHED_STATES = (
    ScheduleRunStatus.QUEUED,
    ScheduleRunStatus.RUNNING,
    ScheduleRunStatus.COMPLETED,
)
_TERMINAL_STATES = (
    ScheduleRunStatus.COMPLETED,
    ScheduleRunStatus.FAILED,
    ScheduleRunStatus.CANCELLED,
)
#: Seconds between two reads of the run row while waiting for its outcome.
POLL_SECONDS = 2.0


@dataclass(frozen=True)
class RecalcResult:
    status: Status
    affected_projects: int
    schedule_run_id: uuid.UUID | None = None
    task_id: str | None = None


async def _affected_project_ids(db: AsyncSession) -> list[str]:
    rows = (
        await db.execute(
            select(AuditLogEntry.entity_id).where(AuditLogEntry.action == CLEARED_ACTION).distinct()
        )
    ).scalars()
    return sorted(rows)


async def _already_dispatched(db: AsyncSession) -> bool:
    run_id = (
        await db.execute(
            select(ScheduleRun.id)
            .where(
                ScheduleRun.trigger_reason == TRIGGER_REASON,
                ScheduleRun.status.in_(_DISPATCHED_STATES),
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if run_id is not None:
        return True
    marker = (
        await db.execute(
            select(AuditLogEntry.id)
            .where(
                AuditLogEntry.action == DISPATCHED_ACTION,
                AuditLogEntry.after_state["trigger_reason"].astext == TRIGGER_REASON,
                AuditLogEntry.after_state["recalc_status"].astext == "deferred",
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    return marker is not None


def _marker(
    *, status: str, project_ids: list[str], run: ScheduleRun | None, baseline: uuid.UUID | None
) -> AuditLogEntry:
    after: dict[str, Any] = {
        "trigger_reason": TRIGGER_REASON,
        "recalc_status": status,
        "solver_type": SolverType.GREEDY.value,
        "schedule_run_id": str(run.id) if run is not None else None,
        "schedule_run_version": run.version if run is not None else None,
        "celery_task_id": run.celery_task_id if run is not None else None,
        "baseline_run_id": str(baseline) if baseline is not None else None,
        "project_ids": project_ids,
        "reason": "ADR 0048",
    }
    return AuditLogEntry(
        actor_user_id=None,
        action=DISPATCHED_ACTION,
        entity_type="ScheduleRun",
        entity_id=str(run.id) if run is not None else TRIGGER_REASON,
        hub_id=None,
        before_state=None,
        after_state=after,
        notes="P33-T13 one-off recalculation after migration p33c_clear_step_timing",
    )


async def recalc_after_timing_clear(db: AsyncSession) -> RecalcResult:
    """The script's body on one session (tests call it directly)."""

    # The dispatch advisory lock (transaction-scoped, re-entrant in this
    # session) serialises the idempotency check with any other dispatch.
    await db.execute(select(func.pg_advisory_xact_lock(DISPATCH_LOCK_KEY)))
    project_ids = await _affected_project_ids(db)
    if not project_ids:
        await db.rollback()
        return RecalcResult(status="nothing_cleared", affected_projects=0)
    if await _already_dispatched(db):
        await db.rollback()
        return RecalcResult(status="already_dispatched", affected_projects=len(project_ids))

    if await find_in_flight_run(db, trigger_reason=TRIGGER_REASON) is not None:
        # ADR 0023: the follow-up flag is now set; the coalesced run reads
        # the cleared state. The marker commits with the flag.
        db.add(_marker(status="deferred", project_ids=project_ids, run=None, baseline=None))
        await db.commit()
        return RecalcResult(status="deferred", affected_projects=len(project_ids))

    active = await get_active_run(db)
    baseline = active.id if active is not None else None
    # Commits the QUEUED row (and releases the lock) before the solver reads it.
    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.GREEDY,
        trigger_reason=TRIGGER_REASON,
        triggered_by_user_id=None,
    )
    task_id = await enqueue_or_fail(
        db,
        run,
        lambda: dispatch_greedy(
            str(run.id),
            db=db,
            triggered_by_user_id=None,
            activate=True,
            recalc_project_id=None,
        ),
        actor_user_id=None,
    )
    if task_id is None:
        return RecalcResult(
            status="dispatch_failed", affected_projects=len(project_ids), schedule_run_id=run.id
        )
    run.celery_task_id = task_id
    db.add(run)
    db.add(_marker(status="queued", project_ids=project_ids, run=run, baseline=baseline))
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return RecalcResult(
        status="queued",
        affected_projects=len(project_ids),
        schedule_run_id=run.id,
        task_id=task_id,
    )


async def _run_status(
    session_factory: async_sessionmaker[AsyncSession], run_id: uuid.UUID
) -> ScheduleRunStatus | None:
    async with session_factory() as db:
        status: ScheduleRunStatus | None = (
            await db.execute(select(ScheduleRun.status).where(ScheduleRun.id == run_id))
        ).scalar_one_or_none()
        return status


async def wait_for_outcome(
    session_factory: async_sessionmaker[AsyncSession],
    result: RecalcResult,
    wait_seconds: float,
    *,
    poll_seconds: float = POLL_SECONDS,
) -> RecalcResult:
    """P33-R01: a `queued` result is only a success once its run COMPLETED.

    Waits for the inline greedy body (when inline) and then reads the run row
    until it is terminal or `wait_seconds` ends; other results pass through.
    """

    if result.status != "queued" or result.schedule_run_id is None:
        return result
    deadline = time.monotonic() + wait_seconds
    # Inline greedy (the default) runs in this process: wait for it (and any
    # follow-up it dispatches) so the process does not exit under it.
    await asyncio.to_thread(wait_for_inline_runs, wait_seconds)
    while True:
        status = await _run_status(session_factory, result.schedule_run_id)
        if status is None or status in _TERMINAL_STATES:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return RecalcResult(
                status="still_running",
                affected_projects=result.affected_projects,
                schedule_run_id=result.schedule_run_id,
                task_id=result.task_id,
            )
        await asyncio.sleep(min(poll_seconds, remaining))
    if status == ScheduleRunStatus.COMPLETED:
        return result
    return RecalcResult(
        status="run_failed",
        affected_projects=result.affected_projects,
        schedule_run_id=result.schedule_run_id,
        task_id=result.task_id,
    )


async def _main(database_url: str, wait_seconds: float) -> RecalcResult:
    engine = create_async_engine(database_url, hide_parameters=True)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as db:
            result = await recalc_after_timing_clear(db)
        return await wait_for_outcome(session_factory, result, wait_seconds)
    finally:
        await engine.dispose()


#: Exit code per final status (see the module docstring).
EXIT_CODES: dict[str, int] = {
    "nothing_cleared": 0,
    "already_dispatched": 0,
    "queued": 0,
    "deferred": 0,
    "dispatch_failed": 1,
    "run_failed": 1,
    "still_running": 3,
}

_MESSAGES: dict[str, str] = {
    "dispatch_failed": (
        "The run could not be enqueued (broker refused it); the projects stay stale. "
        "Fix the broker and run this script again."
    ),
    "run_failed": (
        "The timing_cleared run FAILED while executing; the projects stay stale. "
        "Check the run's error in /schedule-runs (e.g. RPD_FIELD_ENCRYPTION_KEY and the "
        "other secrets must be set in this environment), fix it and run this script again."
    ),
    "still_running": (
        "The run had not finished when the wait ended. Do not rerun yet: check the run in "
        "/schedule-runs and rerun this script only if it ends FAILED."
    ),
}


def main(argv: list[str] | None = None) -> int:
    import os

    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument(
        "--wait-seconds",
        type=float,
        default=600.0,
        help="How long to wait for the greedy run to finish (default 600).",
    )
    args = parser.parse_args(argv)
    database_url = os.environ.get("RPD_DATABASE_URL")
    if not database_url:
        print("RPD_DATABASE_URL is not set.", file=sys.stderr)
        return 2
    result = asyncio.run(_main(database_url, args.wait_seconds))
    print(
        f"status={result.status} affected_projects={result.affected_projects} "
        f"schedule_run_id={result.schedule_run_id or '-'}"
    )
    message = _MESSAGES.get(result.status)
    if message is not None:
        print(message, file=sys.stderr)
    return EXIT_CODES[result.status]


if __name__ == "__main__":
    raise SystemExit(main())
