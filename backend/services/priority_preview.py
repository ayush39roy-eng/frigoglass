"""Priority move preview and confirm (P14-T01, ADR 0026, docs/API_CONTRACT_P14.md §1).

**Preview** (`preview_priority_move`) runs the greedy scheduler in-process
twice on one snapshot of the current inputs: once as they are (the
baseline) and once with only the target project's priority replaced. It
diffs the two with the ADR 0015 §4 comparison
(`services.run_changes.diff_outcomes`). It writes nothing: no priority, no
run row, no audit row.

**The baseline is recomputed, not the stored active run** (contract §1
amended 2026-10-19 after P14-T03 finding M2). Inputs drift after a run is
stored (a freeze, a progress edit, a settings change); diffing against the
stored run would blame all that drift on the move. Both sides come from
greedy on the same snapshot, so only the move's own effect is listed.
`baseline_run_id` (the active run) is returned for information only.

**Confirm** (`confirm_priority_move`, `POST /projects/{id}/priority` with a
`preview_token`) holds the dispatch advisory lock
(`run_dispatch.find_in_flight_run`, which also reaps abandoned runs), checks
the token against a freshly rebuilt snapshot (409 `PREVIEW_STALE`, nothing
written), then writes the priority, the stale flag and the
`project.priority_move` audit row, runs both greedy passes in-process,
persists the "after" pass with the worker's own code
(`services.schedule_apply.persist_solved_run`,
`trigger_reason="priority_move"`, immutable, I14), activates it and
commits, all before responding. Its change list compares the in-memory
baseline with the persisted run's stored outcomes (`services.run_changes`),
so it equals the preview. A genuine in-flight worker run answers `deferred`
exactly as ADR 0015/0023 (follow-up flag set under the same lock).

**Same inputs, same scheduler.** Both build the input with
`services.schedule_persistence.build_schedule_input_from_db` (the worker's
builder) and call `scheduling.greedy.run_greedy_sgs` unchanged. Greedy is
deterministic (I8) and the token pins the snapshot, so the applied run
equals the preview. CP-SAT is never run here (non-negotiable).

**Token.** sha256 over canonical JSON (sorted keys; projects, engineers and
chambers sorted by id) of the input with the target priority substituted,
plus the project id, the priority it moves from and the target. The base
input is that input with the "from" priority put back, so the token pins
both sides of the comparison. The active run id is not hashed (it is only
informational since M2), so a worker run activating in between does not
make a preview stale. The token is a one-way hash and is never logged.

**Time cap.** Both passes run as one job on a small dedicated thread pool,
awaited with `asyncio.wait_for`. Past `PREVIEW_TIME_CAP_SECONDS` the
request answers 503 `PREVIEW_TIMEOUT` (on the confirm nothing has been
committed, so nothing is written). A Python thread cannot be killed, so a
job that overran finishes in the background and its result is discarded;
the pool size bounds how many such jobs can run at once.
"""

from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import json
import logging
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from fastapi import status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import CodedHTTPException
from core.principal import Principal
from models.engineer import Engineer
from models.enums import NON_SCHEDULABLE_STATUSES, ProjectPriority, SolverType
from models.project import Project
from models.schedule import ScheduleRun
from scheduling.greedy import run_greedy_sgs
from scheduling.types import ScheduleInput, ScheduleOutput
from schemas.project import (
    PriorityMoveResponse,
    PriorityPreviewChange,
    PriorityPreviewMoved,
    PriorityPreviewResponse,
    PriorityPreviewSummary,
)
from schemas.schedule_run import ScheduleRunChangeRow
from services.active_run import get_active_run
from services.priority_move import (
    TRIGGER_REASON,
    add_priority_move_audit,
    apply_priority_change,
    ensure_priority_move_allowed,
)
from services.run_changes import (
    Compared,
    diff_outcomes,
    outcomes_from_output,
    stored_outcomes,
)
from services.run_dispatch import find_in_flight_run
from services.schedule_apply import persist_solved_run
from services.schedule_persistence import build_schedule_input_from_db
from workers.progress import publish_progress

logger = logging.getLogger(__name__)

#: Hard wall-clock cap on one in-process job (both greedy passes). ADR 0026:
#: the measured cost at ~250 projects must stay well under 10 s; this cap
#: only protects the request from a pathological input.
PREVIEW_TIME_CAP_SECONDS = 20.0

#: At most two jobs run at once per API process (preview or confirm);
#: further requests queue for a thread.
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="priority-preview")

NO_ACTIVE_RUN_NOTE = (
    "There is no active schedule yet; the comparison is against a fresh calculation "
    "of the current plan."
)


# --- snapshot and token ----------------------------------------------------------------


def with_priority(
    schedule_input: ScheduleInput, project_id: uuid.UUID, priority: ProjectPriority
) -> ScheduleInput:
    """The input with exactly one project's priority replaced."""

    pid = str(project_id)
    return dataclasses.replace(
        schedule_input,
        projects=tuple(
            dataclasses.replace(p, priority=priority.value) if p.project_id == pid else p
            for p in schedule_input.projects
        ),
    )


def _canonical(schedule_input: ScheduleInput) -> dict[str, Any]:
    data = dataclasses.asdict(schedule_input)
    data["projects"] = sorted(data["projects"], key=lambda p: p["project_id"])
    data["engineers"] = sorted(data["engineers"], key=lambda e: e["engineer_id"])
    data["chambers"] = sorted(data["chambers"], key=lambda c: c["chamber_id"])
    return data


def snapshot_token(
    schedule_input: ScheduleInput,
    *,
    project_id: uuid.UUID,
    from_priority: ProjectPriority | None,
    target: ProjectPriority,
) -> str:
    """Deterministic sha256 hex of the canonical snapshot (module docstring).
    `schedule_input` already carries the target priority."""

    payload = {
        "input": _canonical(schedule_input),
        "project_id": str(project_id),
        "from_priority": from_priority.value if from_priority is not None else None,
        "target_priority": target.value,
    }
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


@dataclass(frozen=True)
class _Snapshot:
    #: The active run: informational only (M2), never a comparison side.
    active_run: ScheduleRun | None
    #: Current inputs as they are: the "before" side.
    base_input: ScheduleInput
    #: Current inputs with the target priority substituted: the "after" side.
    schedule_input: ScheduleInput
    token: str


async def _snapshot(db: AsyncSession, project: Project, target: ProjectPriority) -> _Snapshot:
    active_run = await get_active_run(db)
    base_input = await build_schedule_input_from_db(db)
    schedule_input = with_priority(base_input, project.id, target)
    token = snapshot_token(
        schedule_input, project_id=project.id, from_priority=project.priority, target=target
    )
    return _Snapshot(
        active_run=active_run, base_input=base_input, schedule_input=schedule_input, token=token
    )


def _greedy_pair(
    base_input: ScheduleInput, target_input: ScheduleInput
) -> tuple[ScheduleOutput, ScheduleOutput]:
    return run_greedy_sgs(base_input), run_greedy_sgs(target_input)


async def run_greedy_pair_capped(snap: _Snapshot) -> tuple[ScheduleOutput, ScheduleOutput]:
    """(baseline, with the move): both greedy passes as one job on the
    dedicated pool, capped together (module docstring)."""

    loop = asyncio.get_running_loop()
    try:
        return await asyncio.wait_for(
            loop.run_in_executor(_EXECUTOR, _greedy_pair, snap.base_input, snap.schedule_input),
            timeout=PREVIEW_TIME_CAP_SECONDS,
        )
    except TimeoutError as exc:
        raise CodedHTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            "PREVIEW_TIMEOUT",
            "Calculating the new timeline took too long. Please try again.",
        ) from exc


# --- change list -------------------------------------------------------------------------


def _to_change(row: ScheduleRunChangeRow) -> PriorityPreviewChange:
    return PriorityPreviewChange(
        project_id=row.project_id,
        name=row.project_name,
        hub=row.hub,
        priority=row.priority,
        end_week_before=row.before_projected_end_week,
        end_week_after=row.after_projected_end_week,
        within_year_before=row.before_within_year,
        within_year_after=row.after_within_year,
        left_out_before=row.before_left_out,
        left_out_after=row.after_left_out,
        blocked_before=row.before_blocked,
        blocked_after=row.after_blocked,
    )


def _pushed_out(c: PriorityPreviewChange) -> bool:
    return c.within_year_before and not c.within_year_after


def _order_key(c: PriorityPreviewChange) -> tuple[bool, bool, int, str, str]:
    # Contract §1: pushed out of the year first, then the largest delay
    # (null last), then name; id only to make equal names deterministic.
    delay = (
        c.end_week_after - c.end_week_before
        if c.end_week_after is not None and c.end_week_before is not None
        else None
    )
    return (not _pushed_out(c), delay is None, -(delay or 0), c.name, str(c.project_id))


def _changes_and_summary(
    rows: list[ScheduleRunChangeRow],
) -> tuple[list[PriorityPreviewChange], PriorityPreviewSummary]:
    changes = sorted((_to_change(r) for r in rows), key=_order_key)
    pairs = [
        (c.end_week_before, c.end_week_after)
        for c in changes
        if c.end_week_before is not None and c.end_week_after is not None
    ]
    summary = PriorityPreviewSummary(
        affected=len(changes),
        delayed=sum(1 for b, a in pairs if a > b),
        earlier=sum(1 for b, a in pairs if a < b),
        pushed_out_of_year=sum(1 for c in changes if _pushed_out(c)),
        pulled_into_year=sum(
            1 for c in changes if not c.within_year_before and c.within_year_after
        ),
    )
    return changes, summary


def _empty_summary() -> PriorityPreviewSummary:
    return PriorityPreviewSummary(
        affected=0, delayed=0, earlier=0, pushed_out_of_year=0, pulled_into_year=0
    )


def _moved(
    project_id: uuid.UUID,
    before: dict[uuid.UUID, Compared],
    after: dict[uuid.UUID, Compared],
) -> PriorityPreviewMoved:
    b = before.get(project_id)
    a = after.get(project_id)
    return PriorityPreviewMoved(
        end_week_before=b.projected_end_week if b is not None else None,
        end_week_after=a.projected_end_week if a is not None else None,
        within_year_before=b.within_year if b is not None else None,
        within_year_after=a.within_year if a is not None else None,
        left_out_before=b.left_out if b is not None else None,
        left_out_after=a.left_out if a is not None else None,
    )


async def _diff(
    db: AsyncSession,
    principal: Principal,
    project: Project,
    before: dict[uuid.UUID, Compared],
    after: dict[uuid.UUID, Compared],
    after_output: ScheduleOutput,
) -> tuple[list[PriorityPreviewChange], PriorityPreviewSummary, int]:
    async def _own() -> set[uuid.UUID]:
        # Engineer self-scope (P10-F01): their assignments in the "after"
        # schedule, as `compute_run_changes` uses the new run's.
        engineer_id = (
            await db.execute(select(Engineer.id).where(Engineer.user_id == principal.user_id))
        ).scalar_one_or_none()
        if engineer_id is None:
            return set()
        eid = str(engineer_id)
        return {
            uuid.UUID(o.project_id)
            for o in after_output.project_outcomes
            if any(s.assigned_engineer_id == eid for s in o.steps)
        }

    rows, hidden = await diff_outcomes(
        db, principal, before, after, own_project_ids=_own,
        exclude_project_ids=frozenset({project.id}),
    )
    changes, summary = _changes_and_summary(rows)
    return changes, summary, hidden


# --- preview -----------------------------------------------------------------------------


async def preview_priority_move(
    db: AsyncSession, project: Project, target: ProjectPriority, principal: Principal
) -> PriorityPreviewResponse:
    """ADR 0026 §1. The caller has resolved the project through the
    hub-scoped lookup and authorised it exactly as the move. Writes nothing.
    """

    common: dict[str, Any] = {
        "project_id": project.id,
        "from_priority": project.priority,
        "to_priority": target,
    }
    if target == project.priority:
        return PriorityPreviewResponse(
            result="unchanged", baseline_run_id=None, preview_token=None, moved=None,
            summary=_empty_summary(), changes=[], hidden_count=0, elapsed_ms=None, **common,
        )
    await ensure_priority_move_allowed(db, project, target)

    started = time.perf_counter()
    snap = await _snapshot(db, project, target)
    active_id = snap.active_run.id if snap.active_run is not None else None
    if project.status in NON_SCHEDULABLE_STATUSES:
        return PriorityPreviewResponse(
            result="not_needed", baseline_run_id=active_id, preview_token=snap.token,
            moved=None, summary=_empty_summary(), changes=[], hidden_count=0,
            elapsed_ms=None, **common,
        )

    base_output, output = await run_greedy_pair_capped(snap)
    before = outcomes_from_output(base_output)
    after = outcomes_from_output(output)
    changes, summary, hidden = await _diff(db, principal, project, before, after, output)
    elapsed_ms = round((time.perf_counter() - started) * 1000)
    logger.info(
        "priority preview computed",
        extra={"project_id": str(project.id), "elapsed_ms": elapsed_ms,
               "affected": summary.affected, "hidden_count": hidden},
    )
    return PriorityPreviewResponse(
        result="preview", baseline_run_id=active_id, preview_token=snap.token,
        moved=_moved(project.id, before, after), summary=summary, changes=changes,
        hidden_count=hidden, elapsed_ms=elapsed_ms,
        note=NO_ACTIVE_RUN_NOTE if active_id is None else None, **common,
    )


# --- confirm -----------------------------------------------------------------------------


def _stale() -> CodedHTTPException:
    return CodedHTTPException(
        status.HTTP_409_CONFLICT,
        "PREVIEW_STALE",
        "Something changed since this preview was calculated. Please review the new preview.",
    )


def _plain_response(move: Any) -> PriorityMoveResponse:
    return PriorityMoveResponse(
        project_id=move.project_id,
        priority_before=move.priority_before,
        priority_after=move.priority_after,
        recalc_status=move.recalc_status,
        schedule_run_id=move.schedule_run_id,
        baseline_run_id=move.baseline_run_id,
        task_id=move.task_id,
    )


async def confirm_priority_move(
    db: AsyncSession,
    project: Project,
    target: ProjectPriority,
    principal: Principal,
    preview_token: str,
) -> PriorityMoveResponse:
    """ADR 0026 §2–§3 (module docstring). The caller has resolved and
    authorised the project exactly as the ADR 0015 move.
    """

    before_priority = project.priority
    if target == before_priority:
        return _plain_response(await apply_priority_change(db, project, target, principal))
    await ensure_priority_move_allowed(db, project, target)

    if project.status in NON_SCHEDULABLE_STATUSES:
        snap = await _snapshot(db, project, target)
        if snap.token != preview_token:
            raise _stale()
        # No run either way; ADR 0015's `not_needed` path writes the move.
        return _plain_response(await apply_priority_change(db, project, target, principal))

    # Dispatch lock (held until commit/rollback), abandoned-run reaping, and
    # the ADR 0023 follow-up flag when a worker run is genuinely in flight.
    in_flight = await find_in_flight_run(db, trigger_reason=TRIGGER_REASON)
    snap = await _snapshot(db, project, target)
    if snap.token != preview_token:
        # Nothing is committed: raising straight away ends the handler, and the
        # request session's rollback releases the lock and drops any
        # follow-up flag set above (P14-R01 S1: nothing else runs under the
        # lock on this path). An explicit rollback here would also expire the
        # caller's loaded objects, so it is deliberately not done.
        raise _stale()

    project.priority = target
    project.schedule_stale = True

    if in_flight is not None:
        add_priority_move_audit(
            db, project, before_priority, target, principal, recalc="deferred", baseline_id=None
        )
        await db.commit()
        return PriorityMoveResponse(
            project_id=project.id, priority_before=before_priority, priority_after=target,
            recalc_status="deferred", schedule_run_id=None, baseline_run_id=None, task_id=None,
        )

    started_at = datetime.now(UTC)
    # Over the cap: 503, and the uncommitted move is rolled back with the
    # request session.
    base_output, output = await run_greedy_pair_capped(snap)

    active = snap.active_run
    run = await persist_solved_run(
        db,
        snap.schedule_input,
        output,
        solver=SolverType.GREEDY,
        trigger_reason=TRIGGER_REASON,
        actor_user_id=principal.user_id,
        activate=True,
        recalc_project_id=project.id,
    )
    run.started_at = started_at
    run.completed_at = datetime.now(UTC)
    db.add(run)
    add_priority_move_audit(
        db, project, before_priority, target, principal, recalc="applied",
        baseline_id=active.id if active is not None else None, schedule_run_id=run.id,
    )
    await db.flush()

    # M2: the "before" side is the in-memory baseline, the "after" side the
    # persisted run's stored outcomes, compared by `services.run_changes`.
    before = outcomes_from_output(base_output)
    after = await stored_outcomes(db, run.id)
    changes, summary, hidden = await _diff(db, principal, project, before, after, output)
    moved = _moved(project.id, before, after)

    await db.commit()
    try:
        publish_progress(str(run.id), status="completed", percent=100.0)
    except Exception:  # noqa: BLE001 - SSE is a courtesy; the run is committed
        logger.warning("priority move: could not publish run completion", exc_info=True)

    return PriorityMoveResponse(
        project_id=project.id,
        priority_before=before_priority,
        priority_after=target,
        recalc_status="applied",
        schedule_run_id=run.id,
        baseline_run_id=active.id if active is not None else None,
        task_id=None,
        moved=moved,
        summary=summary,
        changes=changes,
        hidden_count=hidden,
    )
