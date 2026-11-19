"""P42-T03: migration `p42a_outcome_band_flags` and the R42-10 rollout script
`python -m scripts.p42_band_rules_run`.

Own throwaway Postgres per test (real DDL; the script commits, and the inline
greedy body opens its own engine, so it must see committed rows). No broker:
inline greedy, `.delay` patched to raise; progress events are no-ops.

- Up: both columns exist, NOT NULL, defaults true / false (truthful for old
  runs, I14); every project whose classification changes (schedulable status
  and P4 / Q, or P3 In Queue) is marked stale, with one
  `project.schedule_stale` audit row each when it was not stale already;
  nothing else is touched. Down drops the columns; up again works.
- Script: one greedy run with `trigger_reason="band_rules"` (never CP-SAT),
  one `schedule_run.dispatched` marker; the run stores the flags; a second
  invocation answers `already_dispatched`; with nothing to reclassify it
  answers `nothing_to_do`; no URL → exit 2.
"""

from __future__ import annotations

import asyncio
import uuid
from collections.abc import Iterator
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from testcontainers.postgres import PostgresContainer

import scripts.p42_band_rules_run as script
import services.run_dispatch as run_dispatch
import workers.schedule_tasks as schedule_tasks
from core.celery_config import SolverDispatchSettings
from models.audit import AuditLogEntry
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
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome
from services.project_steps import sync_project_steps
from tests.conftest import run_alembic
from tests.factories import make_engineer, make_hub, make_project
from workers.schedule_tasks import run_greedy_schedule

_BEFORE = "p38a_engineer_deactivation"
_REV = "p42a_outcome_band_flags"


async def _in_session(url: str, fn: Any) -> Any:
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as db:
            return await fn(db)
    finally:
        await engine.dispose()


#: (name, priority, status, already stale) → changes classification?
_PROJECTS: tuple[tuple[str, ProjectPriority, ProjectStatus, bool, bool], ...] = (
    ("P4 queue", ProjectPriority.P4, ProjectStatus.IN_QUEUE, False, True),
    ("Q dev", ProjectPriority.Q, ProjectStatus.IN_DEVELOPMENT, False, True),
    ("P3 queue", ProjectPriority.P3, ProjectStatus.IN_QUEUE, False, True),
    ("P4 already stale", ProjectPriority.P4, ProjectStatus.IN_QUEUE, True, True),
    ("P3 dev", ProjectPriority.P3, ProjectStatus.IN_DEVELOPMENT, False, False),
    ("P2 queue", ProjectPriority.P2, ProjectStatus.IN_QUEUE, False, False),
    ("P4 on hold", ProjectPriority.P4, ProjectStatus.ON_HOLD, False, False),
    ("P4 commercialized", ProjectPriority.P4, ProjectStatus.COMMERCIALIZED, False, False),
)


async def _seed(db: AsyncSession, specs: Any = _PROJECTS) -> dict[str, uuid.UUID]:
    hub = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader = await make_engineer(
        db, hub, name="Leader", allowed_categories=[EngineerAllowedCategory.A]
    )
    ids: dict[str, uuid.UUID] = {}
    for name, prio, status, stale, _changes in specs:
        project = await make_project(
            db,
            hub,
            leader=leader,
            name=name,
            priority=prio,
            status=status,
            category=ProjectCategory.A,
            schedule_stale=stale,
            certification_testing_required=False,
        )
        await sync_project_steps(db, project, hub_is_oem=False)
        ids[name] = project.id
    await db.commit()
    return ids


async def _stale(db: AsyncSession) -> dict[uuid.UUID, bool]:
    rows = (await db.execute(text("SELECT id, schedule_stale FROM projects"))).all()
    return {r[0]: bool(r[1]) for r in rows}


def test_p42a_up_down_up_marks_reclassified_projects_stale() -> None:
    with PostgresContainer("postgres:17", driver="asyncpg") as pg:
        url = pg.get_connection_url()
        assert run_alembic(["upgrade", "head"], url).returncode == 0
        ids: dict[str, uuid.UUID] = asyncio.run(_in_session(url, _seed))

        # Back to p38a: the columns go; reset every stale flag but one.
        r = run_alembic(["downgrade", _BEFORE], url)
        assert r.returncode == 0, r.stderr

        async def reset(db: AsyncSession) -> None:
            await db.execute(text("UPDATE projects SET schedule_stale = false"))
            await db.execute(
                text("UPDATE projects SET schedule_stale = true WHERE id = :id"),
                {"id": ids["P4 already stale"]},
            )
            cols = (
                await db.execute(
                    text(
                        "SELECT column_name FROM information_schema.columns "
                        "WHERE table_name = 'schedule_run_project_outcomes' "
                        "AND column_name IN ('counts_toward_year', 'not_scheduled_priority')"
                    )
                )
            ).all()
            assert cols == []
            await db.commit()

        asyncio.run(_in_session(url, reset))
        r = run_alembic(["upgrade", _REV], url)
        assert r.returncode == 0, r.stderr

        async def check(db: AsyncSession) -> None:
            stale = await _stale(db)
            for name, _p, _s, _already, changes in _PROJECTS:
                assert stale[ids[name]] is changes, name
            audits = (
                (
                    await db.execute(
                        select(AuditLogEntry).where(
                            AuditLogEntry.action == "project.schedule_stale"
                        )
                    )
                )
                .scalars()
                .all()
            )
            # One per reclassified project that was not stale already.
            assert sorted(a.entity_id for a in audits) == sorted(
                str(ids[n]) for n in ("P4 queue", "Q dev", "P3 queue")
            )
            for a in audits:
                assert a.actor_user_id is None
                assert a.after_state is not None
                assert a.after_state["reason"] == "ADR 0056"
                assert a.before_state == {"schedule_stale": False}
            cols = {
                r[0]: (r[1], r[2])
                for r in (
                    await db.execute(
                        text(
                            "SELECT column_name, is_nullable, column_default "
                            "FROM information_schema.columns "
                            "WHERE table_name = 'schedule_run_project_outcomes' "
                            "AND column_name IN ('counts_toward_year', 'not_scheduled_priority')"
                        )
                    )
                ).all()
            }
            assert cols == {
                "counts_toward_year": ("NO", "true"),
                "not_scheduled_priority": ("NO", "false"),
            }

        asyncio.run(_in_session(url, check))


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


async def _invoke(url: str) -> script.BandRulesResult:
    result: script.BandRulesResult = await _in_session(url, script.dispatch_band_rules_run)
    assert await asyncio.to_thread(run_dispatch.wait_for_inline_runs, 60)
    return result


async def _band_runs(db: AsyncSession) -> list[ScheduleRun]:
    return list(
        (
            await db.execute(
                select(ScheduleRun).where(ScheduleRun.trigger_reason == script.TRIGGER_REASON)
            )
        )
        .scalars()
        .all()
    )


def test_script_dispatches_one_greedy_band_rules_run(url: str) -> None:
    ids: dict[str, uuid.UUID] = asyncio.run(_in_session(url, _seed))
    first = asyncio.run(_invoke(url))
    assert first.status == "queued"
    assert first.affected_projects == 4  # P4 queue, Q dev, P3 queue, P4 already stale

    async def check(db: AsyncSession) -> None:
        (run,) = await _band_runs(db)
        assert run.solver_type == SolverType.GREEDY
        assert run.status == ScheduleRunStatus.COMPLETED
        assert run.is_active
        outcomes = {
            o.project_id: o
            for o in (
                await db.execute(
                    select(ScheduleRunProjectOutcome).where(
                        ScheduleRunProjectOutcome.schedule_run_id == run.id
                    )
                )
            ).scalars()
        }
        assert outcomes[ids["P4 queue"]].not_scheduled_priority is True
        assert outcomes[ids["Q dev"]].not_scheduled_priority is True
        # P53 (R53-2): a queued P3 counts in a P53 run.
        assert outcomes[ids["P3 queue"]].counts_toward_year is True
        assert outcomes[ids["P3 queue"]].not_scheduled_priority is False
        assert outcomes[ids["P2 queue"]].counts_toward_year is True
        assert outcomes[ids["P4 on hold"]].counts_toward_year is True
        assert outcomes[ids["P4 commercialized"]].within_year is True
        markers = (
            (
                await db.execute(
                    select(AuditLogEntry).where(AuditLogEntry.action == script.DISPATCHED_ACTION)
                )
            )
            .scalars()
            .all()
        )
        assert len(markers) == 1
        marker = markers[0].after_state
        assert marker is not None
        assert marker["trigger_reason"] == "band_rules"
        assert marker["recalc_status"] == "queued"
        # The run clears every stale flag of the projects in it.
        assert not any((await _stale(db)).values())

    asyncio.run(_in_session(url, check))
    second = asyncio.run(_invoke(url))
    assert second.status == "already_dispatched"

    async def one_run(db: AsyncSession) -> None:
        assert len(await _band_runs(db)) == 1

    asyncio.run(_in_session(url, one_run))


def test_script_nothing_to_do(url: str) -> None:
    specs = tuple(s for s in _PROJECTS if not s[4])
    asyncio.run(_in_session(url, lambda db: _seed(db, specs)))
    result = asyncio.run(_invoke(url))
    assert result.status == "nothing_to_do"
    assert result.affected_projects == 0

    async def none(db: AsyncSession) -> None:
        assert await _band_runs(db) == []

    asyncio.run(_in_session(url, none))


def test_script_without_database_url_exits_2(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("RPD_DATABASE_URL", raising=False)
    assert script.main([]) == 2
