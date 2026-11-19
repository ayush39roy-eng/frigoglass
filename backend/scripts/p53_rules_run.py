"""One greedy run under the P53 scheduling rules, after migration
`p53a_week_line` (P53-T03, ADR 0063 as ruled at R53-7; docs/API_CONTRACT_P53.md §3).

A migration never dispatches runs and nothing auto-solves (ADR 0006). The
orchestrator tells the owner FIRST (the headline counts move: queued P3 now
counted; most former LEFT_OUT become spillover with a finish year). Then,
after `alembic upgrade head`, run this once:

    RPD_DATABASE_URL=... python -m scripts.p53_rules_run

It ADDS one run; it rewrites nothing. Stored runs stay history (I62) and are
labelled "computed under the earlier rules". It dispatches exactly ONE greedy
run with `trigger_reason="p53_rules"`, system actor, `activate=True`, never
CP-SAT, and sets no `schedule_stale` (no project input changed). One
`schedule_run.dispatched` audit row (actor NULL = system):

- the active run is already a P53 run, or a `p53_rules` run that is queued,
  running or completed (or a `deferred` marker) exists → `already_dispatched`,
  nothing is written. A FAILED / CANCELLED one does not count, so a later
  invocation retries;
- another run is in flight → `deferred`: the ADR 0023 follow-up flag is set
  (the coalesced `follow_up` run is itself a P53 run), with the marker;
- otherwise → `queued`.

After `queued` the script waits (`--wait-seconds`): COMPLETED → `queued`
(exit 0); FAILED / CANCELLED → `run_failed` (exit 1); still going →
`still_running` (exit 3). Exit 2: `RPD_DATABASE_URL` missing. Output is the
status and ids only: no project data, no financial field.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
import uuid
from dataclasses import dataclass, replace
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

#: `ScheduleRun.trigger_reason` of the one run (R53-7).
TRIGGER_REASON = "p53_rules"
DISPATCHED_ACTION = "schedule_run.dispatched"

Status = Literal[
    "already_dispatched",
    "queued",
    "deferred",
    "dispatch_failed",
    "run_failed",
    "still_running",
]

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
POLL_SECONDS = 2.0


@dataclass(frozen=True)
class P53RulesResult:
    status: Status
    schedule_run_id: uuid.UUID | None = None
    task_id: str | None = None


async def _already_dispatched(db: AsyncSession) -> bool:
    active = await get_active_run(db)
    if active is not None and active.rules_epoch is not None:
        return True
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


def _marker(*, status: str, run: ScheduleRun | None, baseline: uuid.UUID | None) -> AuditLogEntry:
    after: dict[str, Any] = {
        "trigger_reason": TRIGGER_REASON,
        "recalc_status": status,
        "solver_type": SolverType.GREEDY.value,
        "schedule_run_id": str(run.id) if run is not None else None,
        "schedule_run_version": run.version if run is not None else None,
        "celery_task_id": run.celery_task_id if run is not None else None,
        "baseline_run_id": str(baseline) if baseline is not None else None,
        "reason": "ADR 0063",
    }
    return AuditLogEntry(
        actor_user_id=None,
        action=DISPATCHED_ACTION,
        entity_type="ScheduleRun",
        entity_id=str(run.id) if run is not None else TRIGGER_REASON,
        hub_id=None,
        before_state=None,
        after_state=after,
        notes="P53-T03 one greedy run under the P53 rules after migration p53a_week_line",
    )


async def dispatch_p53_rules_run(db: AsyncSession) -> P53RulesResult:
    """The script's body on one session (tests call it directly)."""

    await db.execute(select(func.pg_advisory_xact_lock(DISPATCH_LOCK_KEY)))
    if await _already_dispatched(db):
        await db.rollback()
        return P53RulesResult(status="already_dispatched")
    if await find_in_flight_run(db, trigger_reason=TRIGGER_REASON) is not None:
        db.add(_marker(status="deferred", run=None, baseline=None))
        await db.commit()
        return P53RulesResult(status="deferred")

    active = await get_active_run(db)
    baseline = active.id if active is not None else None
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
        return P53RulesResult(status="dispatch_failed", schedule_run_id=run.id)
    run.celery_task_id = task_id
    db.add(run)
    db.add(_marker(status="queued", run=run, baseline=baseline))
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return P53RulesResult(status="queued", schedule_run_id=run.id, task_id=task_id)


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
    result: P53RulesResult,
    wait_seconds: float,
    *,
    poll_seconds: float = POLL_SECONDS,
) -> P53RulesResult:
    """A `queued` result is only a success once its run COMPLETED."""

    if result.status != "queued" or result.schedule_run_id is None:
        return result
    deadline = time.monotonic() + wait_seconds
    await asyncio.to_thread(wait_for_inline_runs, wait_seconds)
    while True:
        status = await _run_status(session_factory, result.schedule_run_id)
        if status is None or status in _TERMINAL_STATES:
            break
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return replace(result, status="still_running")
        await asyncio.sleep(min(poll_seconds, remaining))
    if status == ScheduleRunStatus.COMPLETED:
        return result
    return replace(result, status="run_failed")


async def _main(database_url: str, wait_seconds: float) -> P53RulesResult:
    engine = create_async_engine(database_url, hide_parameters=True)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as db:
            result = await dispatch_p53_rules_run(db)
        return await wait_for_outcome(session_factory, result, wait_seconds)
    finally:
        await engine.dispose()


EXIT_CODES: dict[str, int] = {
    "already_dispatched": 0,
    "queued": 0,
    "deferred": 0,
    "dispatch_failed": 1,
    "run_failed": 1,
    "still_running": 3,
}

_MESSAGES: dict[str, str] = {
    "dispatch_failed": "The run could not be enqueued (broker refused it). Fix the broker "
    "and run this script again.",
    "run_failed": "The p53_rules run FAILED. Check its error in /schedule-runs, fix it and "
    "run this script again.",
    "still_running": "The run had not finished when the wait ended. Do not rerun yet: "
    "check /schedule-runs and rerun only if it ends FAILED.",
}


def main(argv: list[str] | None = None) -> int:
    import os

    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("--wait-seconds", type=float, default=600.0)
    args = parser.parse_args(argv)
    database_url = os.environ.get("RPD_DATABASE_URL")
    if not database_url:
        print("RPD_DATABASE_URL is not set.", file=sys.stderr)
        return 2
    result = asyncio.run(_main(database_url, args.wait_seconds))
    print(f"status={result.status} schedule_run_id={result.schedule_run_id or '-'}")
    message = _MESSAGES.get(result.status)
    if message is not None:
        print(message, file=sys.stderr)
    return EXIT_CODES[result.status]


if __name__ == "__main__":
    raise SystemExit(main())
