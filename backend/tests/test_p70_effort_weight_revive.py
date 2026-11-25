"""ADR 0070 (owner decision 2026-11-24, "Split the figure"): a template step
revived from 0 to N weeks takes part in the own-effort split with weight N.

- the template apply sets `effort_weight_weeks = N` (0 -> N only), writes the
  copy on every received pair (own effort included) and re-derives the
  receiving own-effort projects (audit `project.effort_rederived`, trigger
  `template_revive`);
- reached steps, frozen / closed projects and re-splits that would change a
  reached step's share are never touched (`own_effort_length_not_applied`
  as before); the held-back rule keeps them out of later re-derivations;
- the live run input gives an own-effort step without a share `eff = 0`
  whatever its weight;
- `POST /workflow-templates/sync-effort-weights` (Super Admin): the
  one-time catch-up, dry run vs apply, idempotent, marks stale, never
  dispatches;
- the apply and the sync take the band-rank lock first (run 307 deadlock):
  503 `BAND_RANK_BUSY` while another session holds it.

Seeded B template (PDD): A1 B0 C0 D1 E4 F0 G0 H6 I0 J1 K2 L1 M1 N1, weights
= weeks. Kinds (this test DB): A B D E I J K M design; F H lab; C G L N elapsed.
"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

import services.band_rank as band_rank_service
from api.db import get_db
from api.main import app
from api.routers import workflow_templates as wt_router
from models.audit import AuditLogEntry
from models.enums import ProjectStatus, RoleName, WorkflowStepStatus
from models.project import Project
from models.schedule import ScheduleRun
from models.workflow import WorkflowLeadTime
from services import priority_move
from services.project_effort import TRIGGER_STAGE_STATUS, rederive_project_effort
from services.workflow_durations import run_input_lead_and_override
from tests.auth_helpers import clear_current_principal_override
from tests.p12_helpers import act_as, client_for, set_progress
from tests.test_p33_t10_template_apply import (
    _apply_body,
    _audits,
    _eff,
    _figure,
    _project,
    _rows,
    _template,
    _world,
)
from tests.test_p36_band_rank_api import _band_lock_held_elsewhere
from workers.schedule_tasks import run_greedy_schedule

APPLY = "/workflow-templates/apply"
PREVIEW = "/workflow-templates/apply-preview"
SYNC = "/workflow-templates/sync-effort-weights"
REVIVE_F = [{"step_id": "PDD-F", "weeks": 3}]
_LIMITERS = (
    wt_router.APPLY_RATE_LIMIT,
    wt_router.APPLY_PREVIEW_RATE_LIMIT,
    wt_router.SYNC_EFFORT_WEIGHTS_RATE_LIMIT,
)


@pytest.fixture(autouse=True)
def _cleanup():
    for limiter in _LIMITERS:
        limiter.reset()
    yield
    for limiter in _LIMITERS:
        limiter.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    calls: list[Any] = []

    def _fake_delay(*args: Any, **kwargs: Any) -> SimpleNamespace:
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return calls


async def _post(db: AsyncSession, path: str, body: dict[str, Any], role: RoleName) -> Any:
    await act_as(db, role)
    async with client_for(db) as client:
        return await client.post(path, json=body)


def _effort(rows: dict[str, Any], *step_ids: str) -> dict[str, int | None]:
    return {sid: rows[sid].effort_weeks for sid in step_ids}


async def _lab_project(db: AsyncSession, w: SimpleNamespace, name: str, **kw: Any) -> Project:
    """A B project with a lab figure of 6 (all on H while F has weight 0)."""

    project = await _project(db, w, name, **kw)
    await _figure(db, project, lab_effort_weeks=6)
    rows = await _rows(db, project)
    assert _effort(rows, "PDD-F", "PDD-H") == {"PDD-F": None, "PDD-H": 6}
    return project


# --- the apply ----------------------------------------------------------------------------------


async def test_revive_gives_own_effort_project_a_share(db_session: AsyncSession, dispatch) -> None:
    w = await _world(db_session)
    own = await _lab_project(db_session, w, "01 Own lab")
    plain = await _project(db_session, w, "02 No figure")

    preview = await _post(db_session, PREVIEW, {"changes": [_apply_body(REVIVE_F)["changes"][0]]},
                          RoleName.ADMIN)  # fmt: skip
    assert preview.status_code == 200, preview.text
    body = preview.json()
    assert body["counts"]["own_effort"] == 0
    auto = {p["name"]: p for p in body["automatic"]}
    # F revived (0 -> 2 of the 6, weights F 3 : H 6), H re-split 6 -> 4.
    assert auto["01 Own lab"]["steps"] == [
        {"step_id": "PDD-F", "eff_before": 0, "eff_after": 2, "gap_before": 0, "gap_after": 0,
         "hold_before": None, "hold_after": None, "flags": ["revived"]},
        {"step_id": "PDD-H", "eff_before": 6, "eff_after": 4, "gap_before": 0, "gap_after": 0,
         "hold_before": None, "hold_after": None, "flags": []},
    ]  # fmt: skip
    assert auto["02 No figure"]["steps"][0]["eff_after"] == 3

    resp = await _post(db_session, APPLY, _apply_body(REVIVE_F, mode="none"), RoleName.ADMIN)
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"] == {"automatic": 2, "selected": 0, "own_effort_not_applied": 0}

    assert await _template(db_session, "PDD-F") == (3, 0, 3)  # weight revived
    assert await _template(db_session, "PDD-H") == (6, 0, 6)  # other weights untouched
    rows = await _rows(db_session, own)
    assert _effort(rows, "PDD-F", "PDD-H") == {"PDD-F": 2, "PDD-H": 4}
    assert rows["PDD-F"].plan_weeks == 3
    eff = _eff(own, rows)
    assert eff["PDD-F"] == 2 and eff["PDD-F"] + eff["PDD-H"] == 6  # total = the figure
    # Unchanged behaviour without a figure: the copy, no effort.
    plain_rows = await _rows(db_session, plain)
    assert plain_rows["PDD-F"].plan_weeks == 3 and plain_rows["PDD-F"].effort_weeks is None
    assert _eff(plain, plain_rows)["PDD-F"] == 3

    rederived = [
        a for a in await _audits(db_session, "project.effort_rederived")
        if a.entity_id == str(own.id) and a.after_state["trigger"] == "template_revive"
    ]  # fmt: skip
    assert len(rederived) == 1
    assert rederived[0].after_state["effort_weeks"]["PDD-F"] == 2
    summary = (await _audits(db_session, "workflow_template.applied"))[-1]
    assert summary.after_state["effort_weights_revived"] == {"B": {"PDD-F": 3}}
    assert summary.after_state["effort_rederived"] == [str(own.id)]
    assert summary.after_state["changes"][0]["steps"] == [
        {"step_id": "PDD-F", "weeks": [0, 3], "effort_weight_weeks": [0, 3]}
    ]
    stale = (
        await db_session.execute(select(Project.schedule_stale).where(Project.id == own.id))
    ).scalar_one()
    assert stale is True


async def test_reached_step_is_never_revived_and_stays_held_back(
    db_session: AsyncSession, dispatch
) -> None:
    w = await _world(db_session)
    reached = await _lab_project(db_session, w, "01 H started", status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(db_session, reached, "PDD-H", WorkflowStepStatus.IN_PROGRESS, percent=30,
                       start=29)  # fmt: skip
    before = _effort(await _rows(db_session, reached), *(f"PDD-{c}" for c in "ABDEFHIJKM"))

    resp = await _post(db_session, APPLY, _apply_body(REVIVE_F, mode="all_not_reached"),
                       RoleName.ADMIN)  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert await _template(db_session, "PDD-F") == (3, 0, 3)
    rows = await _rows(db_session, reached)
    assert rows["PDD-F"].plan_weeks == 0
    assert _effort(rows, *before) == before
    assert _eff(reached, rows)["PDD-F"] == 0

    # A later R6 re-derivation (a stage crossing Not Started) keeps F out:
    # the copy is 0, so the held-back rule applies; H keeps its 6.
    project = await db_session.get(Project, reached.id)
    assert project is not None
    await rederive_project_effort(
        db_session, project, trigger=TRIGGER_STAGE_STATUS, actor_user_id=None
    )
    rows = await _rows(db_session, reached)
    assert _effort(rows, "PDD-F", "PDD-H") == {"PDD-F": None, "PDD-H": 6}
    # And the live run input agrees: F (weight 3, no share) has eff 0.
    assert run_input_lead_and_override(
        plan_weeks=0, effort_weight_weeks=3, table_weeks=3, own_effort=True, effort_weeks=None
    ) == (0, None)


async def test_resplit_that_would_change_a_reached_share_is_refused(
    db_session: AsyncSession, dispatch
) -> None:
    """Design figure 4 splits A1 E2 K1 over B's weights (A1 D1 E4 J1 K2 M1;
    D, J, M 0). Reviving I (0 -> 2) would re-split to A1 E1 I1 K1, cutting E
    (In Progress) from 2 to 1: refused, nothing written."""

    w = await _world(db_session)
    p = await _project(db_session, w, "01 E started", status=ProjectStatus.IN_DEVELOPMENT)
    await _figure(db_session, p, design_effort_weeks=4)
    await set_progress(db_session, p, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=10,
                       start=30)  # fmt: skip
    design = [f"PDD-{c}" for c in "ABDEIJKM"]
    before = _effort(await _rows(db_session, p), *design)
    assert (before["PDD-A"], before["PDD-E"], before["PDD-K"]) == (1, 2, 1), before

    steps = [{"step_id": "PDD-I", "weeks": 2}]
    preview = await _post(db_session, PREVIEW, {"changes": _apply_body(steps)["changes"]},
                          RoleName.ADMIN)  # fmt: skip
    assert preview.status_code == 200, preview.text
    own = preview.json()["own_effort"]
    assert [(o["name"], o["step_ids"]) for o in own] == [("01 E started", ["PDD-I"])]

    resp = await _post(db_session, APPLY, _apply_body(steps, mode="all_not_reached"),
                       RoleName.ADMIN)  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"]["own_effort_not_applied"] == 1
    assert await _template(db_session, "PDD-I") == (2, 0, 2)
    rows = await _rows(db_session, p)
    assert _effort(rows, *design) == before
    assert rows["PDD-I"].plan_weeks == 0


async def test_non_revive_length_keeps_weights_and_own_effort_flag(
    db_session: AsyncSession, dispatch
) -> None:
    """H 6 -> 4 is not a revive (weight 6 stays): own effort not applied."""

    w = await _world(db_session)
    p = await _lab_project(db_session, w, "01 Own lab")
    steps = [{"step_id": "PDD-H", "weeks": 4}]
    resp = await _post(db_session, APPLY, _apply_body(steps, mode="none"), RoleName.ADMIN)
    assert resp.status_code == 200, resp.text
    assert resp.json()["applied"]["own_effort_not_applied"] == 1
    assert await _template(db_session, "PDD-H") == (4, 0, 6)
    assert _effort(await _rows(db_session, p), "PDD-F", "PDD-H") == {"PDD-F": None, "PDD-H": 6}


def test_run_input_mapping_unchanged_for_pre_adr_states() -> None:
    """The run-input mapping is unchanged where an own-effort step has a
    share or no weight (the pre-ADR-0070 states)."""

    assert run_input_lead_and_override(
        plan_weeks=6, effort_weight_weeks=6, table_weeks=6, own_effort=True, effort_weeks=4
    ) == (None, 4)
    assert run_input_lead_and_override(
        plan_weeks=0, effort_weight_weeks=0, table_weeks=0, own_effort=True, effort_weeks=None
    ) == (None, None)
    assert run_input_lead_and_override(
        plan_weeks=3, effort_weight_weeks=0, table_weeks=3, own_effort=False, effort_weeks=None
    ) == (None, None)


async def test_db_trigger_allows_only_the_revive_shape(db_session: AsyncSession) -> None:
    from sqlalchemy.exc import DBAPIError

    key = (
        WorkflowLeadTime.workflow_id == "PDD",
        WorkflowLeadTime.category == "B",
    )
    # Weight 6 -> 4 on H: still immutable.
    with pytest.raises(DBAPIError):
        async with db_session.begin_nested():
            await db_session.execute(
                update(WorkflowLeadTime)
                .where(*key, WorkflowLeadTime.step_id == "PDD-H")
                .values(effort_weight_weeks=4)
            )
    # F with weeks 0: a weight without a length is refused.
    with pytest.raises(DBAPIError):
        async with db_session.begin_nested():
            await db_session.execute(
                update(WorkflowLeadTime)
                .where(*key, WorkflowLeadTime.step_id == "PDD-F")
                .values(effort_weight_weeks=3)
            )
    # 0 -> N together with weeks N: allowed.
    await db_session.execute(
        update(WorkflowLeadTime)
        .where(*key, WorkflowLeadTime.step_id == "PDD-F")
        .values(weeks=3, effort_weight_weeks=3)
    )
    assert await _template(db_session, "PDD-F") == (3, 0, 3)


# --- the one-time sync --------------------------------------------------------------------------


async def _pre_adr_state(db: AsyncSession) -> None:
    """What the 2026-11-24 apply left: F weeks 3, weight still 0."""

    await db.execute(
        update(WorkflowLeadTime)
        .where(
            WorkflowLeadTime.workflow_id == "PDD",
            WorkflowLeadTime.category == "B",
            WorkflowLeadTime.step_id == "PDD-F",
        )
        .values(weeks=3)
    )


async def test_sync_dry_run_then_apply_is_idempotent(db_session: AsyncSession, dispatch) -> None:
    w = await _world(db_session)
    fresh = await _lab_project(db_session, w, "01 Own lab")
    started = await _lab_project(db_session, w, "02 H started", status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(db_session, started, "PDD-H", WorkflowStepStatus.IN_PROGRESS, percent=30,
                       start=29)  # fmt: skip
    frozen = await _lab_project(db_session, w, "03 Frozen", status=ProjectStatus.IN_DEVELOPMENT)
    frozen.frozen = True
    frozen.actual_start_week = 20
    plain = await _project(db_session, w, "04 No figure")
    await _pre_adr_state(db_session)
    ids = SimpleNamespace(fresh=fresh.id, started=started.id, frozen=frozen.id, plain=plain.id)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    # Committed to the outer transaction: the dry run rolls its session back.
    await db_session.commit()
    runs = (await db_session.execute(select(func.count(ScheduleRun.id)))).scalar_one()
    audits = (await db_session.execute(select(func.count(AuditLogEntry.id)))).scalar_one()

    async with client_for(db_session) as client:
        dry = await client.post(SYNC, json={"dry_run": True})
    assert dry.status_code == 200, dry.text
    body = dry.json()
    assert body["dry_run"] is True
    assert body["counts"] == {
        "template_rows": 1, "categories": 1, "projects_rederived": 1, "projects_skipped": 2,
    }  # fmt: skip
    assert body["categories"] == [{
        "workflow_id": "PDD", "category": "B",
        "steps": [{"step_id": "PDD-F", "kind": "lab", "weeks": 3, "weight_before": 0,
                   "weight_after": 3}],
    }]  # fmt: skip
    assert body["projects"] == [{
        "project_id": str(ids.fresh), "name": "01 Own lab", "category": "B",
        "step_ids": ["PDD-F"],
        "effort_before": {"PDD-F": None, "PDD-H": 6},
        "effort_after": {"PDD-F": 2, "PDD-H": 4},
    }]  # fmt: skip
    assert {(s["name"], s["reason"]) for s in body["skipped"]} == {
        ("02 H started", "reached_stage"),
        ("03 Frozen", "frozen"),
    }
    assert body["project_ids"] == [str(ids.fresh)]
    # The dry run wrote nothing.
    assert await _template(db_session, "PDD-F") == (3, 0, 0)
    assert (await db_session.execute(select(func.count(AuditLogEntry.id)))).scalar_one() == audits

    async with client_for(db_session) as client:
        applied = await client.post(SYNC, json={"dry_run": False})
    assert applied.status_code == 200, applied.text
    assert applied.json()["projects"] == body["projects"]
    assert applied.json()["dry_run"] is False
    assert await _template(db_session, "PDD-F") == (3, 0, 3)
    fresh_project = await db_session.get(Project, ids.fresh)
    assert fresh_project is not None
    rows = await _rows(db_session, fresh_project)
    assert _effort(rows, "PDD-F", "PDD-H") == {"PDD-F": 2, "PDD-H": 4}
    assert rows["PDD-F"].plan_weeks == 3
    assert _eff(fresh_project, rows)["PDD-F"] == 2
    await db_session.refresh(fresh_project)
    assert fresh_project.schedule_stale is True
    for pid, f_effort in ((ids.started, None), (ids.frozen, None)):
        p = await db_session.get(Project, pid)
        assert p is not None
        assert (await _rows(db_session, p))["PDD-F"].effort_weeks is f_effort
    plain_project = await db_session.get(Project, ids.plain)
    assert plain_project is not None
    plain_rows = await _rows(db_session, plain_project)
    assert plain_rows["PDD-F"].plan_weeks == 0 and plain_rows["PDD-F"].effort_weeks is None
    # Audit: summary, the copy, the re-derivation. No run dispatched.
    summary = await _audits(db_session, "workflow_template.effort_weights_synced")
    assert len(summary) == 1 and summary[0].after_state["rederived"] == [str(ids.fresh)]
    copy = await _audits(db_session, "project.effort_weight_synced")
    assert [(a.entity_id, a.after_state["plan_weeks"]) for a in copy] == [
        (str(ids.fresh), {"PDD-F": 3})
    ]
    rederived = [
        a for a in await _audits(db_session, "project.effort_rederived")
        if a.after_state.get("trigger") == "effort_weight_sync"
    ]  # fmt: skip
    assert [a.entity_id for a in rederived] == [str(ids.fresh)]
    assert dispatch == []
    assert (await db_session.execute(select(func.count(ScheduleRun.id)))).scalar_one() == runs

    # Idempotent: nothing left to sync.
    async with client_for(db_session) as client:
        again = await client.post(SYNC, json={"dry_run": False})
    assert again.status_code == 200, again.text
    assert again.json()["counts"] == {
        "template_rows": 0, "categories": 0, "projects_rederived": 0, "projects_skipped": 0,
    }  # fmt: skip
    assert again.json()["projects"] == [] and again.json()["project_ids"] == []
    assert len(await _audits(db_session, "workflow_template.effort_weights_synced")) == 1


@pytest.mark.parametrize("role", [RoleName.ADMIN, RoleName.PORTFOLIO_MANAGER, RoleName.HUB_PLANNER])
async def test_sync_is_super_admin_only(db_session: AsyncSession, role: RoleName) -> None:
    await _pre_adr_state(db_session)
    for dry_run in (True, False):
        resp = await _post(db_session, SYNC, {"dry_run": dry_run}, role)
        assert resp.status_code == 403, resp.text
    assert await _template(db_session, "PDD-F") == (3, 0, 0)


async def test_sync_body_is_strict(db_session: AsyncSession) -> None:
    for body in ({}, {"dry_run": "false"}, {"dry_run": False, "extra": 1}):
        resp = await _post(db_session, SYNC, body, RoleName.SUPER_ADMIN)
        assert resp.status_code == 422, resp.text


# --- band-rank lock first (run 307 deadlock) -----------------------------------------------------


async def test_apply_and_sync_take_the_band_rank_lock_first(
    db_session: AsyncSession, database_url: str, dispatch, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(band_rank_service, "BAND_RANK_LOCK_TIMEOUT", "200ms")
    w = await _world(db_session)
    await _lab_project(db_session, w, "01 Own lab")
    await _pre_adr_state(db_session)
    await act_as(db_session, RoleName.SUPER_ADMIN)
    await db_session.commit()
    steps = [{"step_id": "PDD-H", "gap_weeks": 1}]
    async with _band_lock_held_elsewhere(database_url):
        async with client_for(db_session) as client:
            apply = await client.post(APPLY, json=_apply_body(steps, mode="none"))
            sync = await client.post(SYNC, json={"dry_run": False})
    for resp in (apply, sync):
        assert resp.status_code == 503, resp.text
        assert resp.json()["code"] == "BAND_RANK_BUSY"
    # Nothing written by either.
    assert await _template(db_session, "PDD-H") == (6, 0, 6)
    assert await _template(db_session, "PDD-F") == (3, 0, 0)
    # With the lock free, the apply goes through.
    async with client_for(db_session) as client:
        ok = await client.post(APPLY, json=_apply_body(steps, mode="none"))
    assert ok.status_code == 200, ok.text
    assert uuid.UUID(ok.json()["template_change_id"])
