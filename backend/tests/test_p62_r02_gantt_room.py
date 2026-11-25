"""P62-R02 (workflow-auditor gate FAIL at P62-T07): the Gantt's served room
weeks of a full-hold lab row (run row `lab_hold_weeks` NULL) are the row's
whole booked span, `services.lab_hold.run_row_held_weeks`, the helper the
utilisation matrix counts, not `duration_weeks` back from the end.

The booked span differs from `duration_weeks` on an In Progress tail (the
remaining weeks only), a Done actual span and a pin window; the run rows here
are set to such spans directly after a real run.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Iterator

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from models.enums import ProjectStatus
from models.schedule import ScheduleRunProjectStep
from tests.auth_helpers import clear_current_principal_override
from tests.test_p62_lab_hold_backend import LAB_STEPS, _get, _project, _run, _world


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


async def _set_row(
    db: AsyncSession, run_id: object, project_id: object, step_id: str, **values: object
) -> None:
    await db.execute(
        update(ScheduleRunProjectStep)
        .where(
            ScheduleRunProjectStep.schedule_run_id == run_id,
            ScheduleRunProjectStep.project_id == project_id,
            ScheduleRunProjectStep.step_template_id == step_id,
        )
        .values(**values)
    )


async def test_full_hold_room_weeks_follow_the_booked_span(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "Spans", status=ProjectStatus.IN_DEVELOPMENT)
    _si, _out, run = await _run(db_session)
    # Done Pilot: actual span 22..30 (9 weeks) with duration 3, full hold.
    await _set_row(db_session, run.id, p.id, "PDD-L", start_week=22, end_week=30,
                   duration_weeks=3, lab_hold_weeks=None, skipped=False,
                   assigned_chamber_id=w.chamber.id)  # fmt: skip
    # In Progress PoC: the remaining tail 31..32 (2 weeks) of a 6-week step.
    await _set_row(db_session, run.id, p.id, "PDD-F", start_week=31, end_week=32,
                   duration_weeks=6, lab_hold_weeks=None, skipped=False,
                   assigned_chamber_id=w.chamber.id)  # fmt: skip
    # Pr. Pr with a partial hold over a pin window 40..44: last 1 week.
    await _set_row(db_session, run.id, p.id, "PDD-J", start_week=40, end_week=44,
                   duration_weeks=1, lab_hold_weeks=1, skipped=False,
                   assigned_chamber_id=w.chamber.id)  # fmt: skip
    await db_session.flush()

    gantt = await _get(db_session, "/gantt")
    assert gantt.status_code == 200, gantt.text
    row = next(r for r in gantt.json()["rows"] if r["project_id"] == str(p.id))
    steps = {s["step_id"]: s for s in row["steps"]}

    pilot = steps["PDD-L"]
    assert pilot["duration_weeks"] == 3
    assert (pilot["room_start_week"], pilot["room_end_week"]) == (22, 30)
    assert pilot["lab_hold_weeks"] == 9
    poc = steps["PDD-F"]
    assert poc["duration_weeks"] == 6
    assert (poc["room_start_week"], poc["room_end_week"]) == (31, 32)
    assert poc["lab_hold_weeks"] == 2
    pr_pr = steps["PDD-J"]
    assert (pr_pr["room_start_week"], pr_pr["room_end_week"]) == (44, 44)
    assert pr_pr["lab_hold_weeks"] == 1

    # The Gantt's room weeks are exactly the utilisation matrix's weeks.
    served: Counter[int] = Counter()
    for sid in LAB_STEPS:
        s = steps[sid]
        if s["room_start_week"] is not None:
            assert s["lab_hold_weeks"] == s["room_end_week"] - s["room_start_week"] + 1
            served.update(range(s["room_start_week"], s["room_end_week"] + 1))
        else:
            assert s["lab_hold_weeks"] in (0, None)
    matrix = await _get(db_session, "/capacity/utilization-matrix")
    assert matrix.status_code == 200, matrix.text
    ch = next(c for c in matrix.json()["chambers"] if c["code"] == "GR-CH9")
    counted = Counter({int(k): v for k, v in ch["week_counts"].items() if v})
    assert served == counted
