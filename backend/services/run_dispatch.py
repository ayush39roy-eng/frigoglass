"""Single-flight check shared by every solver dispatch path.

A run counts as "in flight" while it is `QUEUED` or `RUNNING` and was created
within `CelerySettings.task_time_limit_seconds + 120` seconds. Past that
window a stuck row is the sweeper's job (`workers/schedule_run_sweeper.py`,
same window), so a crashed worker cannot block every later dispatch.

Callers decide what an in-flight run means for them:
- Workspace "Recalculate schedule" and the admin CP-SAT dispatch refuse with
  409 `RUN_IN_PROGRESS`;
- a priority move (ADR 0015) still saves the priority and answers
  `deferred`, without starting a second run.

Extracted in P11-T01 from the identical inline queries in
`api/routers/workspace.py::recalculate` and
`api/routers/schedule_runs.py::dispatch_cp_sat_run`.

**Serialised (P11-T01).** The check first takes a transaction-scoped
Postgres advisory lock (`pg_advisory_xact_lock`, one fixed key). Two
concurrent dispatchers therefore cannot both see "nothing in flight" and both
queue a run: the second waits until the first transaction ends, and by then
the first one's `QUEUED` row is committed (`create_queued_schedule_run`
commits immediately) and visible. The lock is released by the caller's next
commit or rollback; every caller commits or raises right after the check.

**Coalesced follow-up run (ADR 0023, P12-T03).** An auto-trigger
(`priority_move`, `step_timing`, `check_in`) that finds a run in flight
answers `deferred` and, in the same locked transaction, sets the one durable
flag in `schedule_run_follow_ups`. When a run ends (completed, failed,
cancelled) the worker calls `dispatch_follow_up_if_requested`, and so does
every sweeper tick: under the same lock it clears the flag and queues exactly
one greedy run (`trigger_reason="follow_up"`, `activate=True`). Any number of
`deferred` answers during one run collapse into that one run, and an
auto-trigger that queues a run itself clears the flag (its run reads every
input saved so far). Bound: one run in flight plus one pending (I24).

Why it is race-free: the requester checks "in flight" and sets the flag
inside one transaction holding the lock; the finisher commits the run's
terminal status *before* taking the lock to read the flag. Either the
requester ran first (the flag is set before the finisher reads it) or the
finisher did (the run was already terminal, so the requester saw nothing in
flight and queued its own run).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from core.celery_config import get_celery_settings
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp
from models.enums import ScheduleRunStatus, SolverType
from models.schedule import ScheduleRun
from services.schedule_persistence import create_queued_schedule_run
from workers.progress import publish_progress

#: Seconds added to the Celery hard time limit before a queued/running row
#: stops counting as in flight.
IN_FLIGHT_GRACE_SECONDS = 120

#: Fixed advisory-lock key for "decide whether to dispatch a solver run".
#: Spells "RPDRUN" in ASCII hex, the same convention as
#: `api/routers/users.py::SUPER_ADMIN_MEMBERSHIP_LOCK` ("RPDSA"), and distinct
#: from it.
DISPATCH_LOCK_KEY = 0x52504452554E

#: ADR 0023: the single row of `schedule_run_follow_ups`.
FOLLOW_UP_ROW_ID = 1
#: `ScheduleRun.trigger_reason` of the coalesced follow-up run.
FOLLOW_UP_TRIGGER_REASON = "follow_up"


def in_flight_window() -> timedelta:
    return timedelta(
        seconds=get_celery_settings().task_time_limit_seconds + IN_FLIGHT_GRACE_SECONDS
    )


logger = logging.getLogger(__name__)

#: ADR 0026 §4: `ScheduleRun.error_message` of a reaped run.
ABANDONED_ERROR = "ABANDONED"
#: Audit action written once per reaped run.
ABANDONED_AUDIT_ACTION = "schedule_run.abandoned"


async def reap_abandoned_runs(db: AsyncSession) -> list[uuid.UUID]:
    """ADR 0026 §4 (P14-T01): mark every `QUEUED`/`RUNNING` run created
    before the in-flight window as `FAILED` with error `ABANDONED`, with one
    `schedule_run.abandoned` audit row each (actor null: the system did it).

    Called by `find_in_flight_run` with the dispatch lock held, so it runs
    wherever dispatch is decided, not only when the beat sweeper happens to
    be deployed (the owner's dev stack runs no worker at all). It only
    flushes: the rows commit with the caller's transaction, and a caller
    that rolls back (a 409) leaves them for the next decision. Such a row is
    already outside the in-flight check, so it never blocks anything and
    never becomes active; reaping just makes that visible. The sweeper keeps
    its own tick for deployments with a worker.
    """

    cutoff = datetime.now(UTC) - in_flight_window()
    stale = (
        (
            await db.execute(
                select(ScheduleRun)
                .where(
                    ScheduleRun.status.in_(
                        [ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING]
                    ),
                    ScheduleRun.created_at <= cutoff,
                )
                .order_by(ScheduleRun.version)
            )
        )
        .scalars()
        .all()
    )
    now = datetime.now(UTC)
    for run in stale:
        previous = run.status.value
        run.status = ScheduleRunStatus.FAILED
        run.error_message = ABANDONED_ERROR
        run.completed_at = now
        db.add(run)
        db.add(
            AuditLogEntry(
                actor_user_id=None,
                action=ABANDONED_AUDIT_ACTION,
                entity_type="ScheduleRun",
                entity_id=str(run.id),
                hub_id=None,
                before_state={"status": previous},
                after_state={
                    "status": ScheduleRunStatus.FAILED.value,
                    "error": ABANDONED_ERROR,
                    "schedule_run_version": run.version,
                    "trigger_reason": run.trigger_reason,
                },
            )
        )
    if stale:
        await db.flush()
    return [run.id for run in stale]



#: P14-T01 (M3): `ScheduleRun.error_message` when the broker refused the message.
DISPATCH_FAILED_ERROR = "DISPATCH_FAILED"
DISPATCH_FAILED_AUDIT_ACTION = "schedule_run.dispatch_failed"


async def enqueue_or_fail(
    db: AsyncSession,
    run: ScheduleRun,
    send: Callable[[], Any],
    *,
    actor_user_id: uuid.UUID | None,
) -> str | None:
    """Enqueue the Celery message for an already-committed QUEUED `run`.

    `send()` is the `.delay(...)` call; its result's id is returned. P14-T01
    (M3): if the broker refuses (Redis down, misconfigured), the QUEUED row
    would otherwise sit there until reaped and the request would 500 after
    its inputs were already committed. Instead the row is marked `FAILED`
    with error `DISPATCH_FAILED`, one `schedule_run.dispatch_failed` audit
    row is written, it is committed, and `None` is returned so the caller
    can answer a defined status. Only the exception *type* is logged: a
    broker error message can carry the broker URL.
    """

    try:
        return str(send().id)
    except Exception as exc:  # noqa: BLE001 - any broker failure, see docstring
        logger.warning(
            "ScheduleRun %s: could not enqueue the solver message (%s)",
            run.id,
            type(exc).__name__,
        )
    run.status = ScheduleRunStatus.FAILED
    run.error_message = DISPATCH_FAILED_ERROR
    run.completed_at = datetime.now(UTC)
    db.add(run)
    db.add(
        AuditLogEntry(
            actor_user_id=actor_user_id,
            action=DISPATCH_FAILED_AUDIT_ACTION,
            entity_type="ScheduleRun",
            entity_id=str(run.id),
            hub_id=None,
            before_state={"status": ScheduleRunStatus.QUEUED.value},
            after_state={
                "status": ScheduleRunStatus.FAILED.value,
                "error": DISPATCH_FAILED_ERROR,
                "schedule_run_version": run.version,
                "trigger_reason": run.trigger_reason,
            },
        )
    )
    await db.commit()
    return None


async def find_in_flight_run(
    db: AsyncSession,
    *,
    request_follow_up: bool = True,
    trigger_reason: str | None = None,
) -> uuid.UUID | None:
    """The id of one queued or running run inside the window, or `None`.
    Takes the dispatch advisory lock first (see module docstring).

    **ADR 0023 (P12).** `request_follow_up=True` (the default) is the
    auto-trigger behaviour (`priority_move`, `step_timing`, `check_in`):
    - a run in flight → the durable follow-up flag is set in this same
      transaction (the caller answers `deferred` and commits);
    - nothing in flight → the caller is about to queue a run that reads every
      input saved so far, so a pending flag is cleared in this transaction
      (it commits with the QUEUED row, or rolls back with it).
    The explicit Workspace Recalculate, the admin CP-SAT dispatch and the
    follow-up dispatcher itself pass `request_follow_up=False`: they never
    touch the flag (ADR 0023 §4).
    """

    await db.execute(select(func.pg_advisory_xact_lock(DISPATCH_LOCK_KEY)))
    # ADR 0026 §4: rows past the window are reaped where dispatch is decided.
    await reap_abandoned_runs(db)
    cutoff = datetime.now(UTC) - in_flight_window()
    in_flight = (
        await db.execute(
            select(ScheduleRun.id)
            .where(
                ScheduleRun.status.in_([ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING]),
                ScheduleRun.created_at > cutoff,
            )
            .limit(1)
        )
    ).scalar_one_or_none()
    if request_follow_up:
        if in_flight is not None:
            await _set_follow_up(db, trigger_reason)
        else:
            await _take_follow_up(db)
    return in_flight


async def _set_follow_up(db: AsyncSession, trigger_reason: str | None) -> None:
    """Set the single follow-up flag (upsert, so a missing seed row cannot
    lose a request). Only called with the dispatch lock held.
    """

    stmt = pg_insert(ScheduleRunFollowUp).values(
        id=FOLLOW_UP_ROW_ID,
        pending=True,
        requested_at=func.now(),
        last_trigger_reason=trigger_reason,
        request_count=1,
    )
    stmt = stmt.on_conflict_do_update(
        index_elements=[ScheduleRunFollowUp.id],
        set_={
            "pending": True,
            "requested_at": func.coalesce(ScheduleRunFollowUp.requested_at, func.now()),
            "last_trigger_reason": trigger_reason,
            "request_count": ScheduleRunFollowUp.request_count + 1,
        },
    )
    await db.execute(stmt)


async def _take_follow_up(db: AsyncSession) -> bool:
    """Clear the flag; `True` when it was set. Only called with the dispatch
    lock held, so exactly one caller can ever see `True` for one request.
    """

    row = (
        await db.execute(
            update(ScheduleRunFollowUp)
            .where(
                ScheduleRunFollowUp.id == FOLLOW_UP_ROW_ID,
                ScheduleRunFollowUp.pending.is_(True),
            )
            .values(pending=False, requested_at=None, request_count=0)
            .returning(ScheduleRunFollowUp.request_count)
            .execution_options(synchronize_session=False)
        )
    ).first()
    return row is not None


async def follow_up_pending(db: AsyncSession) -> bool:
    """Read-only: is a follow-up run currently requested?"""

    return bool(
        (
            await db.execute(
                select(ScheduleRunFollowUp.pending).where(
                    ScheduleRunFollowUp.id == FOLLOW_UP_ROW_ID
                )
            )
        ).scalar_one_or_none()
    )


async def dispatch_follow_up_if_requested(db: AsyncSession) -> uuid.UUID | None:
    """ADR 0023 §2: called when a run has ended (its terminal status is
    already committed) and by the sweeper. Under the dispatch lock:
    - another run still in flight → do nothing; the flag stays set and that
      run's end dispatches it (at most one in flight);
    - flag not set → do nothing;
    - else clear it and queue exactly one greedy run, `activate=True`,
      `trigger_reason="follow_up"`, with one `schedule_run.follow_up_dispatched`
      audit row. Returns the new run's id.

    Always ends its transaction (commit or rollback), which releases the lock.
    """

    # Imported here: `workers.schedule_tasks` calls this module at the end of
    # every run, so a module-level import would be circular.
    from workers.schedule_tasks import run_greedy_schedule

    if await find_in_flight_run(db, request_follow_up=False) is not None:
        await db.rollback()
        return None
    if not await _take_follow_up(db):
        await db.rollback()
        return None
    # Commits the cleared flag and the QUEUED row together (releasing the
    # lock): the next request after this point sees this run in flight.
    run = await create_queued_schedule_run(
        db,
        solver_type=SolverType.GREEDY,
        trigger_reason=FOLLOW_UP_TRIGGER_REASON,
        triggered_by_user_id=None,
    )
    task_id = await enqueue_or_fail(
        db,
        run,
        lambda: run_greedy_schedule.delay(
            str(run.id), triggered_by_user_id=None, activate=True, recalc_project_id=None
        ),
        actor_user_id=None,
    )
    if task_id is None:
        # M3: keep the request alive for the next sweeper tick or run end.
        await db.execute(select(func.pg_advisory_xact_lock(DISPATCH_LOCK_KEY)))
        await _set_follow_up(db, FOLLOW_UP_TRIGGER_REASON)
        await db.commit()
        return None
    run.celery_task_id = task_id
    db.add(run)
    db.add(
        AuditLogEntry(
            actor_user_id=None,
            action="schedule_run.follow_up_dispatched",
            entity_type="ScheduleRun",
            entity_id=str(run.id),
            hub_id=None,
            before_state=None,
            after_state={
                "schedule_run_id": str(run.id),
                "schedule_run_version": run.version,
                "celery_task_id": run.celery_task_id,
                "trigger_reason": FOLLOW_UP_TRIGGER_REASON,
            },
        )
    )
    await db.commit()
    publish_progress(str(run.id), status="queued")
    return run.id
