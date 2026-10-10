"""P11-T01: `GET /schedule-runs/{run_id}/changes?against=` (ADR 0015 §4,
docs/API_CONTRACT_P11.md §3, I20).

- Diff correctness on the four stored fields only; unchanged projects never
  appear; `is_new` / `is_removed`; `delta_weeks` null when either side is.
- Sort: |delta_weeks| descending, null last, then project name.
- Scoping: a Hub Planner sees only their hub's rows; out-of-scope changes are
  counted in `hidden_count` and never named; an Engineer sees only their own
  assignments in the new run.
- Errors: 404 for a missing run on either side, 409 `RUN_NOT_COMPLETED`, 422
  without `against`; RBAC through `_read_any`.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient

from api.db import get_db
from api.main import app
from models.enums import HubName, LabRegion, ProjectPriority, RoleName, ScheduleRunStatus
from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import make_engineer, make_hub, make_project, make_schedule_run, make_user


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


def _outcome(run, project, *, end, within=True, left_out=False, blocked=False, **extra):
    return ScheduleRunProjectOutcome(
        schedule_run_id=run.id, project_id=project.id, projected_end_week=end,
        within_year=within, left_out=left_out, blocked=blocked,
        last_step_end_week=end, delay_weeks_applied=0, **extra,
    )


async def _world(db_session):
    """Baseline v1 → new v2 over Greece and India projects.

    | project | baseline            | new                  | expected              |
    |---------|---------------------|----------------------|-----------------------|
    | Alpha   | 40                  | 46                   | delta +6              |
    | Bravo   | 50                  | 40                   | delta −10             |
    | Charlie | 30 (India)          | 32                   | delta +2, India       |
    | Delta   | —                   | 44                   | is_new                |
    | Echo    | 45                  | —                    | is_removed            |
    | Foxtrot | 41                  | 41                   | unchanged, never shown|
    | Golf    | 47, within          | 47, blocked          | delta 0, blocked flip |
    | Hotel   | 60, not within      | null, left out       | delta null            |
    | India1  | 33 (India)          | 33 (India)           | unchanged             |
    The only non-compared field that differs (Foxtrot's
    `unconstrained_end_week`) must not make it appear.
    """

    greece = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    names = ["Alpha", "Bravo", "Delta", "Echo", "Foxtrot", "Golf", "Hotel"]
    p = {n: await make_project(db_session, greece, name=n) for n in names}
    p["Charlie"] = await make_project(
        db_session, india, name="Charlie", priority=ProjectPriority.P2
    )
    p["India1"] = await make_project(db_session, india, name="India1")
    base = await make_schedule_run(db_session, is_active=False)
    new = await make_schedule_run(db_session, is_active=True)
    db_session.add_all(
        [
            _outcome(base, p["Alpha"], end=40),
            _outcome(new, p["Alpha"], end=46),
            _outcome(base, p["Bravo"], end=50),
            _outcome(new, p["Bravo"], end=40),
            _outcome(base, p["Charlie"], end=30),
            _outcome(new, p["Charlie"], end=32),
            _outcome(new, p["Delta"], end=44),
            _outcome(base, p["Echo"], end=45),
            _outcome(base, p["Foxtrot"], end=41, unconstrained_end_week=30),
            _outcome(new, p["Foxtrot"], end=41, unconstrained_end_week=35),
            _outcome(base, p["Golf"], end=47),
            _outcome(new, p["Golf"], end=47, blocked=True),
            _outcome(base, p["Hotel"], end=60, within=False),
            _outcome(new, p["Hotel"], end=None, within=False, left_out=True),
            _outcome(base, p["India1"], end=33),
            _outcome(new, p["India1"], end=33),
        ]
    )
    await db_session.flush()
    return SimpleNamespace(greece=greece, india=india, p=p, base=base, new=new)


def _url(run, against) -> str:
    return f"/schedule-runs/{run.id}/changes?against={against.id}"


async def test_changes_diff_sort_and_flags(db_session):
    w = await _world(db_session)
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER))
    async with _client(db_session) as client:
        resp = await client.get(_url(w.new, w.base))
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["run_id"] == str(w.new.id) and body["run_version"] == w.new.version
    assert body["against_run_id"] == str(w.base.id)
    assert body["against_run_version"] == w.base.version
    assert body["hidden_count"] == 0

    names = [r["project_name"] for r in body["rows"]]
    # |delta| desc (10, 6, 2, 0), then null deltas by name.
    assert names == ["Bravo", "Alpha", "Charlie", "Golf", "Delta", "Echo", "Hotel"]
    assert "Foxtrot" not in names and "India1" not in names
    rows = {r["project_name"]: r for r in body["rows"]}

    assert rows["Alpha"]["delta_weeks"] == 6
    assert rows["Bravo"]["delta_weeks"] == -10
    assert rows["Bravo"]["before_projected_end_week"] == 50
    assert rows["Bravo"]["after_projected_end_week"] == 40
    charlie = rows["Charlie"]
    assert charlie["hub"] == "PD-India" and charlie["priority"] == "P2"
    assert charlie["project_id"] == str(w.p["Charlie"].id)

    golf = rows["Golf"]
    assert golf["delta_weeks"] == 0
    assert golf["before_blocked"] is False and golf["after_blocked"] is True

    hotel = rows["Hotel"]
    assert hotel["delta_weeks"] is None
    assert hotel["before_left_out"] is False and hotel["after_left_out"] is True
    assert hotel["after_projected_end_week"] is None

    delta = rows["Delta"]
    assert delta["is_new"] is True and delta["is_removed"] is False
    assert delta["before_projected_end_week"] is None and delta["delta_weeks"] is None
    assert delta["before_within_year"] is False and delta["after_within_year"] is True

    echo = rows["Echo"]
    assert echo["is_removed"] is True and echo["is_new"] is False
    assert echo["after_projected_end_week"] is None and echo["after_within_year"] is False

    # I20: every row equals the difference of the stored outcome fields.
    for r in body["rows"]:
        before_end, after_end = r["before_projected_end_week"], r["after_projected_end_week"]
        if before_end is not None and after_end is not None:
            assert r["delta_weeks"] == after_end - before_end
        assert any(
            r[f"before_{f}"] != r[f"after_{f}"]
            for f in ("projected_end_week", "within_year", "left_out", "blocked")
        ) or r["is_new"] or r["is_removed"]


async def test_changes_are_hub_scoped_with_hidden_count(db_session):
    w = await _world(db_session)
    override_current_principal(
        make_principal(RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[w.india.id])
    )
    async with _client(db_session) as client:
        resp = await client.get(_url(w.new, w.base))
    assert resp.status_code == 200
    body = resp.json()
    assert [r["project_name"] for r in body["rows"]] == ["Charlie"]
    # Alpha, Bravo, Delta, Echo, Golf, Hotel changed in Greece: counted, never named.
    assert body["hidden_count"] == 6
    text = resp.text
    for name in ("Alpha", "Bravo", "Delta", "Echo", "Golf", "Hotel"):
        assert name not in text
        assert str(w.p[name].id) not in text


async def test_changes_for_an_engineer_are_own_assignments_only(db_session):
    w = await _world(db_session)
    user = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False)
    engineer = await make_engineer(db_session, w.greece, name="Eng")
    engineer.user_id = user.id
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=w.new.id, project_id=w.p["Alpha"].id, step_template_id="PDD-A",
            sequence_order=1, duration_weeks=1, start_week=31, end_week=31,
            assigned_engineer_id=engineer.id,
        )
    )
    await db_session.flush()
    # hub_scope_all=True on an Engineer must not widen the view (P10-F01).
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=user.id, hub_scope_all=True)
    )
    async with _client(db_session) as client:
        resp = await client.get(_url(w.new, w.base))
    body = resp.json()
    assert [r["project_name"] for r in body["rows"]] == ["Alpha"]
    assert body["hidden_count"] == 6


async def test_changes_same_run_is_empty(db_session):
    w = await _world(db_session)
    override_current_principal(make_principal(RoleName.ADMIN))
    async with _client(db_session) as client:
        resp = await client.get(_url(w.new, w.new))
    assert resp.json()["rows"] == [] and resp.json()["hidden_count"] == 0


@pytest.mark.parametrize(
    "status", [ScheduleRunStatus.QUEUED, ScheduleRunStatus.RUNNING, ScheduleRunStatus.FAILED]
)
async def test_changes_409_when_run_not_completed(db_session, status):
    w = await _world(db_session)
    pending = await make_schedule_run(db_session, status=status)
    override_current_principal(make_principal(RoleName.ADMIN))
    async with _client(db_session) as client:
        resp = await client.get(_url(pending, w.base))
    assert resp.status_code == 409
    assert resp.json()["code"] == "RUN_NOT_COMPLETED"


async def test_changes_404_when_either_run_missing(db_session):
    w = await _world(db_session)
    override_current_principal(make_principal(RoleName.ADMIN))
    missing = uuid.uuid4()
    async with _client(db_session) as client:
        no_run = await client.get(f"/schedule-runs/{missing}/changes?against={w.base.id}")
        no_base = await client.get(f"/schedule-runs/{w.new.id}/changes?against={missing}")
        no_param = await client.get(f"/schedule-runs/{w.new.id}/changes")
    assert no_run.status_code == 404
    assert no_base.status_code == 404
    assert no_param.status_code == 422


async def test_changes_requires_a_read_surface(db_session):
    w = await _world(db_session)
    override_current_principal(make_principal(RoleName.AUDITOR))
    async with _client(db_session) as client:
        resp = await client.get(_url(w.new, w.base))
    assert resp.status_code == 403
