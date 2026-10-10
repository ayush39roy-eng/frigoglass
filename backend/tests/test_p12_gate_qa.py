"""P12-T06 gate (qa-inspector): gaps found while verifying P11 + P12.

1. **Concurrency of the ADR 0023 hand-over (I24).** `test_p12_follow_up.py`
   calls `dispatch_follow_up_if_requested` sequentially. In production a
   worker finishing a run and a sweeper tick can both call it at once. Here
   six concurrent callers, each on its own connection, must create exactly
   one `follow_up` run.
2. **Concurrency of the P11 anti-flood rule.** Two priority moves at the same
   moment with nothing in flight give exactly one `queued` and one
   `deferred`, plus one QUEUED run.
3. **Finding QA-P12-1 (fixed by P12-R03).** A frozen project has no due
   stages: `GET /check-ins/due` never offers it (`POST /check-ins` always
   rejects it with `PROJECT_FROZEN`, remediation ruling 3) and its tracking
   status is `idle`, not `overdue` forever.
"""

from __future__ import annotations

import asyncio

from models.enums import HubName, ProjectPriority, RoleName, ScheduleRunStatus
from models.project import Project
from services import run_dispatch
from services.priority_move import apply_priority_change
from services.tracking import tracking_status_for
from tests.auth_helpers import make_principal
from tests.p12_helpers import act_as, client_for
from tests.test_p12_checkins import _codes, _entry, _world, dispatch  # noqa: F401 (fixture)
from tests.test_p12_follow_up import (  # noqa: F401 (fixtures)
    _finish,
    _flag,
    _in_session,
    _new_run,
    _reset,
    _runs,
    _seed_project,
    delays,
    postgres_url,
    real_db,
)

# --- 1. concurrent hand-over -----------------------------------------------------------


async def test_concurrent_hand_overs_dispatch_exactly_one_follow_up(real_db, delays):  # noqa: F811
    url = real_db
    await _reset(url)
    in_flight = await _new_run(url, ScheduleRunStatus.RUNNING)

    async def _defer(db):
        found = await run_dispatch.find_in_flight_run(db, trigger_reason="check_in")
        await db.commit()
        return found

    assert await _in_session(url, _defer) == in_flight
    assert (await _flag(url)).pending is True
    await _finish(url, in_flight, ScheduleRunStatus.COMPLETED)

    results = await asyncio.gather(
        *(_in_session(url, run_dispatch.dispatch_follow_up_if_requested) for _ in range(6))
    )
    dispatched = [r for r in results if r is not None]
    assert len(dispatched) == 1, results
    assert len(delays) == 1
    assert [r.id for r in await _runs(url, "follow_up")] == dispatched
    assert (await _flag(url)).pending is False


# --- 2. concurrent priority moves -------------------------------------------------------


async def test_concurrent_priority_moves_queue_exactly_one_run(real_db, delays):  # noqa: F811
    url = real_db
    await _reset(url)
    first, user_id = await _seed_project(url, HubName.RD_INDIA)
    second, _ = await _seed_project(url, HubName.PD_INDIA)
    principal = make_principal(RoleName.PORTFOLIO_MANAGER, user_id=user_id)

    async def _move(project_id, target):
        async def _do(db):
            project = await db.get(Project, project_id)
            return (await apply_priority_change(db, project, target, principal)).recalc_status

        return await _in_session(url, _do)

    answers = await asyncio.gather(
        _move(first, ProjectPriority.P1), _move(second, ProjectPriority.P2)
    )
    assert sorted(answers) == ["deferred", "queued"]
    assert len(delays) == 1
    assert len(await _runs(url, "priority_move")) == 1
    # The deferred move registered the one coalesced follow-up (ADR 0023).
    assert (await _flag(url)).pending is True


# --- 3. finding QA-P12-1: frozen projects in the check-in due list ----------------------


async def test_frozen_project_stage_is_never_offered_for_check_in(db_session, dispatch):  # noqa: F811
    w = await _world(db_session)
    await act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    w.far.frozen = True
    w.far.actual_start_week = 20
    await db_session.flush()
    async with client_for(db_session) as client:
        due = await client.get("/check-ins/due")
        post = await client.post("/check-ins", json={"entries": [_entry(w.far, "PDD-E")]})
    assert due.status_code == 200
    assert _codes(post) == [(0, "PROJECT_FROZEN")]  # the write rule (ruling 3) holds today
    offered = [
        s["step_id"]
        for p in due.json()["projects"]
        if p["project_id"] == str(w.far.id)
        for s in p["stages"]
        if s["can_check_in"]
    ]
    assert offered == []


async def test_frozen_project_is_idle_not_overdue(db_session):
    w = await _world(db_session)
    before = await tracking_status_for(db_session, [w.far.id])
    assert before[w.far.id] == "overdue"  # control: unfrozen, due since W28, no check-in
    w.far.frozen = True
    w.far.actual_start_week = 20
    await db_session.flush()
    after = await tracking_status_for(db_session, [w.far.id])
    assert after[w.far.id] == "idle"
