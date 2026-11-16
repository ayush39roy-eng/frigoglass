"""One-off greedy run after migration `p42a_outcome_band_flags` (P42-T03,
ADR 0056 as ruled at P42-T01, R42-10; docs/API_CONTRACT_P42.md §10).

A migration never dispatches runs, and nothing auto-solves (ADR 0006). After
`alembic upgrade head`, run this once:

    RPD_DATABASE_URL=... python -m scripts.p42_band_rules_run

It dispatches exactly ONE greedy run with `trigger_reason="band_rules"`
(never CP-SAT) and writes one `schedule_run.dispatched` audit row (actor NULL
= system):

- no project's classification changes under R42-3 / R42-4 (no project in a
  schedulable status is P4 / Q, or P3 In Queue) → `nothing_to_do`, nothing is
  written: the stored rows' column defaults are already truthful;
- a `band_rules` run that is queued, running or completed, or a `deferred`
  marker, already exists → `already_dispatched`, nothing is written. A
  FAILED or CANCELLED `band_rules` run does not count, so a later invocation
  retries;
- another run is in flight → `deferred`: the ADR 0023 follow-up flag is set
  (the coalesced `follow_up` run applies the band rules), with the marker;
- otherwise → `queued`: one QUEUED greedy run through
  `services.run_dispatch.dispatch_greedy` (inline by default; with
  `RPD_GREEDY_INLINE=false` it goes to the solver worker). A broker failure
  answers `dispatch_failed` and a later invocation retries.

After `queued` the script waits (`--wait-seconds`) for the run: COMPLETED →
`queued` (exit 0); FAILED / CANCELLED → `run_failed` (exit 1); still going →
`still_running` (exit 3; check `/schedule-runs` before rerunning).

Exit codes: 0 success or nothing to do, 1 failure, 2 `RPD_DATABASE_URL`
missing, 3 still running.

The decision is taken under the dispatch advisory lock. Output is the status
and counts only; no project data is printed and no financial field is read.
The run's change list (`/schedule-runs/{run}/changes?against=<previous>`)
shows what moved; note it also carries the week roll since the previous run
(R42-10 confound).
"""

from __future__ import annotations

import argparse
import asyncio
import sys
import time
import uuid
from dataclasses import dataclass, replace
from typing import Any, Literal

from sqlalchemy import and_, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

import domain_constants as dc
from models.audit import AuditLogEntry
from models.enums import ProjectPriority, ProjectStatus, ScheduleRunStatus, SolverType
from models.project import Project
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

#: `ScheduleRun.trigger_reason` of the one run (R42-10).
TRIGGER_REASON = "band_rules"
#: The audit action this script writes once.
DISPATCHED_ACTION = "schedule_run.dispatched"

Status = Literal[
    "nothing_to_do",
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

_SCHEDULABLE = [ProjectStatus(s) for s in dc.SCHEDULABLE_STATUS_ORDER]
_NOT_SCHEDULED = [ProjectPriority(p) for p in sorted(dc.NOT_SCHEDULED_PRIORITIES)]


@dataclass(frozen=True)
class BandRulesResult:
    status: Status
    #: Projects whose classification changes (R42-3 / R42-4), live count.
    affected_projects: int
    schedule_run_id: uuid.UUID | None = None
    task_id: str | None = None


async def affected_project_count(db: AsyncSession) -> int:
    """Projects in a schedulable status that are P4 / Q, or P3 In Queue
    (R42-4: the ones whose `counts_toward_year` is false)."""

    stmt = (
        select(func.count())
        .select_from(Project)
        .where(
            Project.status.in_(_SCHEDULABLE),
            or_(
                Project.priority.in_(_NOT_SCHEDULED),
                and_(
                    Project.priority == ProjectPriority.P3,
                    Project.status == ProjectStatus(dc.QUEUED_STATUS),
                ),
            ),
        )
    )
    return int((await db.execute(stmt)).scalar_one())


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
    *, status: str, affected: int, run: ScheduleRun | None, baseline: uuid.UUID | None
) -> AuditLogEntry:
    after: dict[str, Any] = {
        "trigger_reason": TRIGGER_REASON,
        "recalc_status": status,
        "solver_type": SolverType.GREEDY.value,
        "schedule_run_id": str(run.id) if run is not None else None,
        "schedule_run_version": run.version if run is not None else None,
        "celery_task_id": run.celery_task_id if run is not None else None,
        "baseline_run_id": str(baseline) if baseline is not None else None,
        "affected_projects": affected,
        "reason": "ADR 0056",
    }
    return AuditLogEntry(
        actor_user_id=None,
        action=DISPATCHED_ACTION,
        entity_type="ScheduleRun",
        entity_id=str(run.id) if run is not None else TRIGGER_REASON,
        hub_id=None,
        before_state=None,
        after_state=after,
        notes="P42-T03 one-off greedy run after migration p42a_outcome_band_flags",
    )


async def dispatch_band_rules_run(db: AsyncSession) -> BandRulesResult:
    """The script's body on one session (tests call it directly)."""

    await db.execute(select(func.pg_advisory_xact_lock(DISPATCH_LOCK_KEY)))
    affected = await affected_project_count(db)
    if affected == 0:
        await db.rollback()
        return BandRulesResult(status="nothing_to_do", affected_projects=0)
    if await _already_dispatched(db):
        await db.rollback()
        return BandRulesResult(status="already_dispatched", affected_projects=affected)

    if await find_in_flight_run(db, trigger_reason=TRIGGER_REASON) is not None:
        db.add(_marker(status="deferred", affected=affected, run=None, baseline=None))
        await db.commit()
        return BandRulesResult(status="deferred", affected_projects=affected)

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
        return BandRulesResult(
            status="dispatch_failed", affected_projects=affected, schedule_run_id=run.id
        )
    run.celery_task_id = task_id
    db.add(run)
    db.add(_marker(status="queued", affected=affected, run=run, baseline=baseline))
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return BandRulesResult(
        status="queued", affected_projects=affected, schedule_run_id=run.id, task_id=task_id
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
    result: BandRulesResult,
    wait_seconds: float,
    *,
    poll_seconds: float = POLL_SECONDS,
) -> BandRulesResult:
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


async def _main(database_url: str, wait_seconds: float) -> BandRulesResult:
    engine = create_async_engine(database_url, hide_parameters=True)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as db:
            result = await dispatch_band_rules_run(db)
        return await wait_for_outcome(session_factory, result, wait_seconds)
    finally:
        await engine.dispose()


EXIT_CODES: dict[str, int] = {
    "nothing_to_do": 0,
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
        "The band_rules run FAILED while executing; the projects stay stale. Check the run's "
        "error in /schedule-runs, fix it and run this script again."
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
