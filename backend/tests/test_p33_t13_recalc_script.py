"""P33-T13: `python -m scripts.p33_recalc_after_timing_clear` (ADR 0048 §3,
docs/API_CONTRACT_P33.md Part H).

After p33c it dispatches exactly ONE greedy run (`trigger_reason=
"timing_cleared"`, priority-move lifecycle) with one `schedule_run.dispatched`
audit row; a second invocation dispatches nothing; with nothing cleared it
does nothing; with a run in flight it answers `deferred` (one coalesced
follow-up, ADR 0023); a broker failure answers `dispatch_failed` and a later
invocation retries. P33-R01: a run that FAILS while executing exits 1 and a
later invocation retries; a completed one exits 0 and a second call answers
`already_dispatched`.

A dedicated Postgres per test (the script commits, and the inline greedy body
opens its own engine on its own loop, so it must see committed rows). No
broker: inline mode, `.delay` patched to raise; progress events are no-ops.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import scripts.p33_recalc_after_timing_clear as script
import services.run_dispatch as run_dispatch
import workers.schedule_tasks as schedule_tasks
from core.celery_config import SolverDispatchSettings
from models.audit import AuditLogEntry
from models.checkin import ScheduleRunFollowUp
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ScheduleRunStatus,
    SolverType,
)
from models.project import Project
from models.schedule import ScheduleRun
from scheduling.greedy import run_greedy_sgs as script_greedy
from services.project_steps import sync_project_steps
from services.schedule_persistence import create_queued_schedule_run
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_project
from workers.schedule_tasks import run_greedy_schedule


@pytest.fixture
def url(monkeypatch: pytest.MonkeyPatch) -> Iterator[str]:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        u = pg.get_connection_url()
        result = run_alembic(["upgrade", "head"], u)
        assert result.returncode == 0, result.stderr
        monkeypatch.setenv("RPD_DATABASE_URL", u)
        monkeypatch.setattr(
            run_dispatch,
            "get_solver_dispatch_settings",
            lambda: SolverDispatchSettings(greedy_inline=True),
        )

        def _no_broker(*_a: Any, **_k: Any) -> None:
            raise AssertionError("inline mode must not reach the broker")

        monkeypatch.setattr(run_greedy_schedule, "delay", _no_broker)
        for module in (run_dispatch, schedule_tasks, script):
            monkeypatch.setattr(module, "publish_progress", lambda *_a, **_k: None)
        yield u
        assert run_dispatch.wait_for_inline_runs(60)


async def _in_session(url: str, fn: Any) -> Any:
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            return await fn(db)
    finally:
        await engine.dispose()


async def _seed(url: str, *, cleared: bool) -> list[uuid.UUID]:
    """Two schedulable projects; with `cleared`, the p33c audit rows (and the
    stale flags it sets) for both, as the migration leaves them."""

    async def _write(db: AsyncSession) -> list[uuid.UUID]:
        hub = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
        leader = await make_engineer(
            db,
            hub,
            name="Leader",
            allowed_categories=[EngineerAllowedCategory.A, EngineerAllowedCategory.B],
        )
        ids = []
        for name in ("Was hand-timed 1", "Was hand-timed 2"):
            project = await make_project(
                db,
                hub,
                leader=leader,
                name=name,
                status=ProjectStatus.IN_QUEUE,
                category=ProjectCategory.A,
                priority=ProjectPriority.P2,
                schedule_stale=cleared,
                certification_testing_required=True,
            )
            await sync_project_steps(db, project, hub_is_oem=False)
            ids.append(project.id)
            if cleared:
                db.add(
                    AuditLogEntry(
                        actor_user_id=None,
                        action=script.CLEARED_ACTION,
                        entity_type="Project",
                        entity_id=str(project.id),
                        hub_id=hub.id,
                        before_state={"steps": {"PDD-E": {"start_not_before_week": 40}}},
                        after_state={"steps": {"PDD-E": {"start_not_before_week": None}}},
                    )
                )
        await db.commit()
        return ids

    ids: list[uuid.UUID] = await _in_session(url, _write)
    return ids


async def _invoke(url: str) -> script.RecalcResult:
    result: script.RecalcResult = await _in_session(url, script.recalc_after_timing_clear)
    assert await asyncio.to_thread(run_dispatch.wait_for_inline_runs, 60)
    return result


async def _runs(url: str) -> list[ScheduleRun]:
    async def _read(db: AsyncSession) -> list[ScheduleRun]:
        return list((await db.execute(select(ScheduleRun).order_by(ScheduleRun.version))).scalars())

    runs: list[ScheduleRun] = await _in_session(url, _read)
    return runs


async def _markers(url: str) -> list[AuditLogEntry]:
    async def _read(db: AsyncSession) -> list[AuditLogEntry]:
        return list(
            (
                await db.execute(
                    select(AuditLogEntry).where(AuditLogEntry.action == script.DISPATCHED_ACTION)
                )
            ).scalars()
        )

    markers: list[AuditLogEntry] = await _in_session(url, _read)
    return markers


async def _stale_count(url: str) -> int:
    async def _read(db: AsyncSession) -> int:
        return int(
            (
                await db.execute(
                    select(func.count()).select_from(Project).where(Project.schedule_stale)
                )
            ).scalar_one()
        )

    count: int = await _in_session(url, _read)
    return count


async def test_dispatches_exactly_one_run_and_a_second_invocation_none(url: str) -> None:
    ids = await _seed(url, cleared=True)
    first = await _invoke(url)
    assert (first.status, first.affected_projects) == ("queued", 2)
    assert first.schedule_run_id is not None and first.task_id is not None

    runs = await _runs(url)
    assert len(runs) == 1
    (run,) = runs
    assert (run.trigger_reason, run.solver_type, run.status, run.is_active) == (
        "timing_cleared",
        SolverType.GREEDY,
        ScheduleRunStatus.COMPLETED,
        True,
    )
    assert run.triggered_by_user_id is None and run.celery_task_id == first.task_id
    (marker,) = await _markers(url)
    assert marker.actor_user_id is None and marker.entity_id == str(run.id)
    assert marker.after_state is not None
    assert marker.after_state["trigger_reason"] == "timing_cleared"
    assert marker.after_state["recalc_status"] == "queued"
    assert marker.after_state["project_ids"] == sorted(str(i) for i in ids)
    assert await _stale_count(url) == 0  # the run read the cleared state

    second = await _invoke(url)
    assert (second.status, second.schedule_run_id) == ("already_dispatched", None)
    assert len(await _runs(url)) == 1
    assert len(await _markers(url)) == 1


async def test_nothing_cleared_does_nothing(url: str) -> None:
    await _seed(url, cleared=False)
    result = await _invoke(url)
    assert (result.status, result.affected_projects) == ("nothing_cleared", 0)
    assert await _runs(url) == []
    assert await _markers(url) == []


async def test_a_run_in_flight_defers_to_one_follow_up(url: str) -> None:
    await _seed(url, cleared=True)

    async def _queued(db: AsyncSession) -> uuid.UUID:
        run = await create_queued_schedule_run(
            db,
            solver_type=SolverType.GREEDY,
            trigger_reason="test_in_flight",
            triggered_by_user_id=None,
        )
        return run.id

    in_flight = await _in_session(url, _queued)
    result = await _invoke(url)
    assert result.status == "deferred" and result.schedule_run_id is None

    async def _flag(db: AsyncSession) -> bool:
        row = await db.get(ScheduleRunFollowUp, 1)
        assert row is not None
        return bool(row.pending)

    assert await _in_session(url, _flag) is True
    (marker,) = await _markers(url)
    assert marker.after_state is not None and marker.after_state["recalc_status"] == "deferred"
    # Idempotent: the deferred marker counts as dispatched.
    assert (await _invoke(url)).status == "already_dispatched"
    # The in-flight run ends -> exactly one follow-up run (ADR 0023, I24).
    run_dispatch.dispatch_greedy(
        str(in_flight), db=None, triggered_by_user_id=None, activate=True, recalc_project_id=None
    )
    assert await asyncio.to_thread(run_dispatch.wait_for_inline_runs, 60)
    follow_ups = [r for r in await _runs(url) if r.trigger_reason == "follow_up"]
    assert len(follow_ups) == 1 and follow_ups[0].status == ScheduleRunStatus.COMPLETED
    assert [r for r in await _runs(url) if r.trigger_reason == "timing_cleared"] == []
    assert await _in_session(url, _flag) is False


async def test_a_broker_failure_is_reported_and_a_later_invocation_retries(
    url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    await _seed(url, cleared=True)

    def _refuse(*_a: Any, **_k: Any) -> str:
        raise ConnectionError("broker down")

    monkeypatch.setattr(script, "dispatch_greedy", _refuse)
    failed = await _invoke(url)
    assert failed.status == "dispatch_failed"
    (run,) = await _runs(url)
    assert run.status == ScheduleRunStatus.FAILED and run.error_message == "DISPATCH_FAILED"
    assert await _markers(url) == []

    monkeypatch.setattr(script, "dispatch_greedy", run_dispatch.dispatch_greedy)
    retried = await _invoke(url)
    assert retried.status == "queued"
    ok = [r for r in await _runs(url) if r.status == ScheduleRunStatus.COMPLETED]
    assert len(ok) == 1 and ok[0].trigger_reason == "timing_cleared"
    assert (await _invoke(url)).status == "already_dispatched"


# --- P33-R01: the outcome of the run, not just its dispatch, decides the exit ---------


def _run_main(capsys: pytest.CaptureFixture[str]) -> tuple[int, str, str]:
    """`main()` as the operator runs it (its own `asyncio.run`, so in a thread)."""

    code = script.main(["--wait-seconds", "60"])
    out, err = capsys.readouterr()
    return code, out, err


async def test_a_run_that_fails_while_executing_exits_1_and_a_later_invocation_retries(
    url: str, monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    await _seed(url, cleared=True)

    def _explode(*_a: Any, **_k: Any) -> Any:
        raise RuntimeError("RPD_FIELD_ENCRYPTION_KEY is not set")

    monkeypatch.setattr(schedule_tasks, "run_greedy_sgs", _explode)
    code, out, err = await asyncio.to_thread(_run_main, capsys)
    assert code == 1
    assert out.startswith("status=run_failed affected_projects=2 ")
    assert "FAILED while executing" in err
    (failed,) = await _runs(url)
    assert (failed.trigger_reason, failed.status) == ("timing_cleared", ScheduleRunStatus.FAILED)
    assert failed.error_message != "DISPATCH_FAILED" and not failed.is_active
    # The dispatch itself was audited once, as before.
    (marker,) = await _markers(url)
    assert marker.after_state is not None
    assert marker.after_state["schedule_run_id"] == str(failed.id)
    assert await _stale_count(url) == 2

    # The failed run does not count as dispatched: the next call dispatches again.
    monkeypatch.setattr(schedule_tasks, "run_greedy_sgs", script_greedy)
    code, out, _err = await asyncio.to_thread(_run_main, capsys)
    assert code == 0 and out.startswith("status=queued affected_projects=2 ")
    runs = [r for r in await _runs(url) if r.trigger_reason == "timing_cleared"]
    assert [r.status for r in runs] == [ScheduleRunStatus.FAILED, ScheduleRunStatus.COMPLETED]
    assert runs[1].is_active
    assert len(await _markers(url)) == 2
    assert await _stale_count(url) == 0

    code, out, _err = await asyncio.to_thread(_run_main, capsys)
    assert code == 0 and out.startswith("status=already_dispatched ")
    assert len(await _runs(url)) == 2 and len(await _markers(url)) == 2


async def test_a_completed_run_exits_0_and_a_second_call_is_already_dispatched(
    url: str, capsys: pytest.CaptureFixture[str]
) -> None:
    await _seed(url, cleared=True)
    code, out, err = await asyncio.to_thread(_run_main, capsys)
    assert (code, err) == (0, "")
    assert out.startswith("status=queued affected_projects=2 ")
    (run,) = await _runs(url)
    assert run.status == ScheduleRunStatus.COMPLETED

    code, out, err = await asyncio.to_thread(_run_main, capsys)
    assert (code, err) == (0, "")
    assert out == "status=already_dispatched affected_projects=2 schedule_run_id=-\n"
    assert len(await _runs(url)) == 1 and len(await _markers(url)) == 1


async def test_a_run_still_in_flight_when_the_wait_ends_is_reported_not_retried(
    url: str,
) -> None:
    await _seed(url, cleared=True)

    async def _queued(db: AsyncSession) -> uuid.UUID:
        run = await create_queued_schedule_run(
            db,
            solver_type=SolverType.GREEDY,
            trigger_reason=script.TRIGGER_REASON,
            triggered_by_user_id=None,
        )
        return run.id

    run_id = await _in_session(url, _queued)
    engine = create_async_engine(url)
    try:
        factory = async_sessionmaker(engine, expire_on_commit=False)
        queued = script.RecalcResult(status="queued", affected_projects=2, schedule_run_id=run_id)
        outcome = await script.wait_for_outcome(factory, queued, 0.0)
    finally:
        await engine.dispose()
    assert outcome.status == "still_running" and script.EXIT_CODES[outcome.status] == 3
    # A queued timing_cleared run counts as dispatched.
    assert (await _invoke(url)).status == "already_dispatched"
