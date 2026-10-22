"""P30-T02 (ADR 0041 with the workflow-auditor's R1-R14, docs/API_CONTRACT_P30.md):
per-project effort drives the schedule and the load, on the backend.

Small worlds on the shared savepoint-isolated DB (CURRENT_WEEK 31). Lead-time
table = the migration seed (DOMAIN_RULES "Lead times"):

    PDD / B design steps with lead > 0: A1 D1 E4 J1 K2 M1 (T = 10); lab H6
    PDD / C design: A1 D1 E2 J1 K1 (T = 6); lab H1
    OEM / B-OEM design: A1 B1 G2 J1 (T = 5); lab H6

Hand-derived splits (R2, exact rationals, ties: larger fraction, larger
lead, sequence order):

    B, x = 4   -> quotas .4 .4 1.6 .4 .8 .4 -> A1 E2 K1 (D J M = 0, skipped)
    B, x = 2.5 -> E = 3 -> .3 .3 1.2 .3 .6 .3 -> A1 E1 K1
    B, x = 1   -> .1 .1 .4 .1 .2 .1 -> E1
    C, x = 3   -> .5 .5 1 .5 .5 -> A1 D1 E1
    B-OEM, x = 4 -> .8 .8 1.6 .8 -> A1 B1 G1 J1
    B with E's lead edited to 8 (T = 14), x = 4 -> .29 .29 2.29 .29 .57 .29
              -> E2, then K (.57), then E (.29, lead 8) -> E3 K1
    B with J made elapsed (T = 9), x = 4 -> .44 .44 1.78 .89 .44 -> A1 E2 K1, J None
    B lab, x = 10 -> H10; x = 300 design -> E 120 > 104 -> rejected (R7)
"""

from __future__ import annotations

import uuid
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select

import domain_constants as dc
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    WorkflowStepStatus,
)
from models.hub import HubWorkCalendar
from models.project import Project
from models.workflow import ProjectWorkflowStep
from scheduling import (
    ServedDesignLoad,
    ServedLabLoad,
    check_i25_demand,
    check_i26_effort_split,
)
from seed import client_2026 as c26
from seed.seed_demo_data import client_2026_step_specs
from services import step_timing as step_timing_service
from services.demand_load import load_demand, load_live_project_rows
from services.priority_capacity_fill import compute_capacity_fill
from services.project_cards import build_project_cards
from services.schedule_persistence import build_schedule_input_from_db
from services.tracking import due_stages_for
from services.workflow_durations import lead_time_lookup
from tests.auth_helpers import clear_current_principal_override
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_schedule_run,
    registration_body,
)
from tests.p12_helpers import (
    act_as,
    add_outcome,
    client_for,
    live_step,
    plan_step,
    set_progress,
    stepped_project,
)
from workers.schedule_tasks import run_greedy_schedule

CW = dc.CURRENT_WEEK
PDD_DESIGN = ("PDD-A", "PDD-B", "PDD-D", "PDD-E", "PDD-I", "PDD-J", "PDD-K", "PDD-M")


@pytest.fixture(autouse=True)
def _cleanup():
    yield
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch):
    calls: list[tuple[tuple, dict]] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(step_timing_service, "publish_progress", lambda *a, **k: None)
    return calls


async def _world(db) -> SimpleNamespace:
    greece = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    seitek = await make_hub(
        db, name=HubName.OEM_SEITEK, lab_region=LabRegion.GREECE, is_oem=True, capacity_hub=greece
    )
    india = await make_hub(db, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    for hub, (wd, nat, med, cas, ann) in ((greece, (5, 12, 0, 0, 25)), (india, (6, 13, 7, 7, 20))):
        db.add(
            HubWorkCalendar(
                hub_id=hub.id,
                weekdays_per_week=wd,
                national_holiday_days=nat,
                medical_leave_days=med,
                casual_leave_days=cas,
                annual_leave_days=ann,
            )
        )
    cats = [
        EngineerAllowedCategory(c)
        for c in ("A+", "A", "B", "C", "A-OEM", "B-OEM", "C-OEM")
    ]
    gr = await make_engineer(db, greece, name="Lead GR", allowed_categories=cats)
    ind = await make_engineer(db, india, name="Lead IN", allowed_categories=cats)
    await db.flush()
    return SimpleNamespace(greece=greece, seitek=seitek, india=india, gr=gr, ind=ind)


async def _project(db, w, *, hub=None, leader=None, name="B4", **kw) -> Project:
    kw.setdefault("category", ProjectCategory.B)
    return await stepped_project(
        db, hub or w.greece, name=name, leader=leader or w.gr, **kw
    )


async def _effort(db, project: Project) -> dict[str, int | None]:
    rows = (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(ProjectWorkflowStep.project_id == project.id)
            .order_by(ProjectWorkflowStep.sequence_order)
        )
    ).scalars()
    return {r.step_template_id: r.effort_weeks for r in rows}


def _nonnull(effort: dict[str, int | None]) -> dict[str, int | None]:
    return {k: v for k, v in effort.items() if v is not None}


async def _i26(db) -> tuple:
    rows, _ = await load_live_project_rows(db)
    return check_i26_effort_split(rows)


async def _rederive_audits(db, project: Project) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(
                    AuditLogEntry.action == "project.effort_rederived",
                    AuditLogEntry.entity_id == str(project.id),
                )
                .order_by(AuditLogEntry.occurred_at, AuditLogEntry.id)
            )
        )
        .scalars()
        .all()
    )


async def _triggers(db, project: Project) -> list[str]:
    """The `trigger` of each re-derivation audit row (one transaction in the
    tests, so `occurred_at` cannot order them)."""

    return [a.after_state["trigger"] for a in await _rederive_audits(db, project)]


async def _reload(db, project: Project) -> Project:
    return (
        await db.execute(
            select(Project)
            .execution_options(populate_existing=True)
            .where(Project.id == project.id)
        )
    ).scalar_one()


B4 = {
    "PDD-A": 1, "PDD-B": None, "PDD-D": 0, "PDD-E": 2, "PDD-I": None,
    "PDD-J": 0, "PDD-K": 1, "PDD-M": 0,
}  # fmt: skip


# --- R2 / R6: figure on create and PATCH ------------------------------------------------


async def test_create_and_patch_figure_derive_the_split_with_audit(db_session):
    w = await _world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.post(
            "/projects",
            json=registration_body(w.greece, w.gr, category="B", design_effort_weeks=4),
        )
        assert resp.status_code == 201, resp.text
        body = resp.json()
        assert body["design_effort_weeks"] == 4.0 and body["lab_effort_weeks"] is None
        assert body["capacity_flag"] is False and body["safety_certification_required"] is False
        project = await _reload(db_session, (await db_session.get(Project, uuid.UUID(body["id"]))))
        effort = await _effort(db_session, project)
        assert {k: effort[k] for k in B4} == B4
        assert _nonnull(effort) == {k: v for k, v in B4.items() if v is not None}
        assert await _i26(db_session) == ()
        (audit,) = await _rederive_audits(db_session, project)
        assert audit.after_state["trigger"] == "project_create"
        assert audit.after_state["design_split"]["target_weeks"] == 4
        assert audit.before_state["effort_weeks"]["PDD-E"] is None

        # PATCH 2.5 -> E = 3 -> A1 E1 K1.
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 2.5})
        assert resp.status_code == 200, resp.text
        assert resp.json()["design_effort_weeks"] == 2.5
        assert resp.json()["schedule_stale"] is True
        effort = await _effort(db_session, project)
        assert _nonnull(effort) == {
            "PDD-A": 1, "PDD-D": 0, "PDD-E": 1, "PDD-J": 0, "PDD-K": 1, "PDD-M": 0,
        }  # fmt: skip
        assert sorted(await _triggers(db_session, project)) == ["effort_figure", "project_create"]
        assert await _i26(db_session) == ()
        update = (
            await db_session.execute(
                select(AuditLogEntry).where(
                    AuditLogEntry.action == "project.update",
                    AuditLogEntry.entity_id == str(project.id),
                )
            )
        ).scalar_one()
        assert update.before_state["design_effort_weeks"] == "4.00"
        assert update.after_state["design_effort_weeks"] == "2.50"

        # Re-sending the same figure is a no-op for the split (no new audit row).
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 2.5})
        assert resp.status_code == 200
        assert len(await _rederive_audits(db_session, project)) == 2

        # Clearing the figure: the table applies again, no effort anywhere.
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": None})
        assert resp.status_code == 200
        assert _nonnull(await _effort(db_session, project)) == {}
        assert await _i26(db_session) == ()


async def test_figure_validation_and_r7_rejection(db_session):
    w = await _world(db_session)
    project = await _project(db_session, w)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        for bad in (-1, 10000, 4.555):
            resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": bad})
            assert resp.status_code == 422, (bad, resp.text)
        # R7: 300 puts PDD-E at 120 weeks -> rejected, nothing written.
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 300})
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == "EFFORT_SPLIT_REJECTED"
        assert resp.json()["detail"][0]["loc"][-1] == "design_effort_weeks"
    project = await _reload(db_session, project)
    assert project.design_effort_weeks is None
    assert _nonnull(await _effort(db_session, project)) == {}


@pytest.mark.parametrize("field", ["design_effort_weeks", "lab_effort_weeks"])
async def test_figures_are_strict_json_numbers_s30_l1(db_session, field):
    """P30-R01 (S30-L1): a string or a bool is a 422 on PATCH and POST (no
    coercion of `"4"` to 4.0 or `true` to 1.0); a JSON int or float passes."""

    w = await _world(db_session)
    project = await _project(db_session, w)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        for bad in ("4", True, False, "2.5"):
            resp = await client.patch(f"/projects/{project.id}", json={field: bad})
            assert resp.status_code == 422, (bad, resp.text)
            assert resp.json()["detail"][0]["loc"][-1] == field
            resp = await client.post(
                "/projects",
                json=registration_body(w.greece, w.gr, category="B", **{field: bad}),
            )
            assert resp.status_code == 422, (bad, resp.text)
        unchanged = await _reload(db_session, project)
        assert getattr(unchanged, field) is None
        for good, stored in ((4, 4.0), (2.5, 2.5)):
            resp = await client.patch(f"/projects/{project.id}", json={field: good})
            assert resp.status_code == 200, (good, resp.text)
            assert resp.json()[field] == stored
        resp = await client.post(
            "/projects", json=registration_body(w.greece, w.gr, category="B", **{field: 3})
        )
        assert resp.status_code == 201, resp.text
        assert resp.json()[field] == 3.0


async def test_lab_figure_applies_only_with_certification(db_session):
    w = await _world(db_session)
    project = await _project(db_session, w, certification_testing_required=False)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"lab_effort_weeks": 10})
        assert resp.status_code == 200
        assert _nonnull(await _effort(db_session, project)) == {}  # R7: cert off
        assert await _i26(db_session) == ()
        resp = await client.patch(
            f"/projects/{project.id}", json={"certification_testing_required": True}
        )
        assert resp.status_code == 200
    assert _nonnull(await _effort(db_session, project)) == {"PDD-H": 10}
    (audit,) = await _rederive_audits(db_session, project)
    assert audit.after_state["trigger"] == "project_fields"
    assert await _i26(db_session) == ()


async def test_category_change_and_hub_move_rederive(db_session):
    w = await _world(db_session)
    project = await _project(db_session, w, design_effort_weeks=Decimal("3"))
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"category": "C"})
        assert resp.status_code == 200, resp.text
        assert _nonnull(await _effort(db_session, project)) == {
            "PDD-A": 1, "PDD-D": 1, "PDD-E": 1, "PDD-J": 0, "PDD-K": 0,
        }  # fmt: skip
        # Workflow change PDD -> OEM (hub move to a member hub).
        resp = await client.patch(
            f"/projects/{project.id}",
            json={"hub_id": str(w.seitek.id), "category": "B-OEM", "design_effort_weeks": 4},
        )
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project)
    assert set(effort) == {f"OEM-{c}" for c in "ABCDEFGHIJKLMN"}
    assert _nonnull(effort) == {"OEM-A": 1, "OEM-B": 1, "OEM-G": 1, "OEM-J": 1}
    triggers = [a.after_state["trigger"] for a in await _rederive_audits(db_session, project)]
    assert sorted(triggers) == ["project_fields", "workflow_change"]
    assert await _i26(db_session) == ()


# --- R6: Workflow Settings edits ------------------------------------------------------


async def test_lead_time_edit_rederives_and_never_clears_a_user_override(db_session):
    w = await _world(db_session)
    project = await _b4_project(db_session, w)
    row_e = await live_step(db_session, project, "PDD-E")
    row_e.duration_override_weeks = 6  # the user's figure
    await db_session.flush()
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        resp = await client.put(
            "/workflow-settings/lead-times",
            json={"lead_times": [
                {"workflow_id": "PDD", "category": "B", "step_id": "PDD-E", "weeks": 8}
            ]},
        )
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project)
    assert _nonnull(effort) == {
        "PDD-A": 0, "PDD-D": 0, "PDD-E": 3, "PDD-J": 0, "PDD-K": 1, "PDD-M": 0,
    }  # fmt: skip
    row_e = await live_step(db_session, project, "PDD-E")
    await db_session.refresh(row_e)
    assert row_e.duration_override_weeks == 6 and row_e.duration_weeks == 8
    assert "lead_time_edit" in await _triggers(db_session, project)
    assert await _i26(db_session) == ()


async def test_step_kind_edit_rederives(db_session):
    w = await _world(db_session)
    project = await _project(db_session, w)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 4})
    await act_as(db_session, RoleName.SUPER_ADMIN)
    async with client_for(db_session) as client:
        settings = (await client.get("/workflow-settings")).json()
        pdd = next(wf for wf in settings["workflows"] if wf["id"] == "PDD")
        steps = [
            {
                "step_id": s["step_id"],
                "kind": "elapsed" if s["step_id"] == "PDD-J" else s["kind"],
                "predecessor_ids": s["predecessor_ids"],
            }
            for s in pdd["steps"]
        ]
        resp = await client.put("/workflow-settings/steps/PDD", json={"steps": steps})
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project)
    assert effort["PDD-J"] is None
    assert _nonnull(effort) == {"PDD-A": 1, "PDD-D": 0, "PDD-E": 2, "PDD-K": 1, "PDD-M": 0}
    assert "step_kind_edit" in await _triggers(db_session, project)
    assert await _i26(db_session) == ()


# --- R6: frozen no-op, unfreeze, stage status (R3) --------------------------------------


async def test_frozen_project_is_a_noop_until_unfrozen(db_session):
    w = await _world(db_session)
    project = await _project(db_session, w, frozen=True, actual_start_week=20)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 4})
        assert resp.status_code == 200
        assert _nonnull(await _effort(db_session, project)) == {}
        assert await _rederive_audits(db_session, project) == []
        assert await _i26(db_session) == ()  # frozen projects are exempt
        # R7 is still checked while frozen.
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 300})
        assert resp.status_code == 422 and resp.json()["code"] == "EFFORT_SPLIT_REJECTED"
        resp = await client.post(
            f"/gantt/projects/{project.id}/freeze", json={"frozen": False}
        )
        assert resp.status_code == 200, resp.text
    effort = await _effort(db_session, project)
    assert {k: effort[k] for k in B4} == B4
    (audit,) = await _rederive_audits(db_session, project)
    assert audit.after_state["trigger"] == "unfreeze"
    assert await _i26(db_session) == ()


async def test_started_step_keeps_a_week_and_reset_rederives_r3(db_session):
    w = await _world(db_session)
    project = await _project(db_session, w)
    await set_progress(db_session, project, "PDD-A", WorkflowStepStatus.IN_PROGRESS, percent=50,
                       start=30)  # fmt: skip
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 1})
        assert resp.status_code == 200
        # E = 1 goes to E; A is started, so it is raised to 1 (Σ = E + 1).
        effort = await _effort(db_session, project)
        assert effort["PDD-A"] == 1 and effort["PDD-E"] == 1
        assert sum(v for k, v in effort.items() if k in PDD_DESIGN and v) == 2
        (audit,) = await _rederive_audits(db_session, project)
        assert audit.after_state["design_split"]["raised_step_ids"] == ["PDD-A"]
        assert await _i26(db_session) == ()
        # Back to Not Started: R3 no longer applies, A drops to 0 (stage_status).
        resp = await client.patch(
            f"/projects/{project.id}/stages/PDD-A",
            json={"status": "Not Started", "percent_complete": 0, "actual_start_week": None},
        )
        assert resp.status_code == 200, resp.text
    assert (await _effort(db_session, project))["PDD-A"] == 0
    assert sorted(await _triggers(db_session, project)) == ["effort_figure", "stage_status"]
    assert await _i26(db_session) == ()


# --- R4 / R5 call sites ---------------------------------------------------------------


async def _b4_project(db, w, **kw) -> Project:
    project = await _project(db, w, **kw)
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        assert (
            await client.patch(f"/projects/{project.id}", json={"design_effort_weeks": 4})
        ).status_code == 200
    return await _reload(db, project)


async def test_step_timing_r4_precedence_reset_and_409(db_session, dispatch):
    w = await _world(db_session)
    project = await _b4_project(db_session, w, status=ProjectStatus.IN_QUEUE)
    await make_schedule_run(db_session, is_active=True)
    url = f"/projects/{project.id}/steps/{{}}/timing"
    async with client_for(db_session) as client:
        # D is effort-zeroed (skipped): a new user value is refused ...
        resp = await client.patch(url.format("PDD-D"), json={"duration_override_weeks": 2})
        assert resp.status_code == 409 and resp.json()["code"] == "STEP_SKIPPED"
        resp = await client.patch(url.format("PDD-D"), json={"start_not_before_week": 40})
        assert resp.status_code == 409 and resp.json()["code"] == "STEP_SKIPPED"
        # ... clearing is allowed (nothing to clear: unchanged).
        resp = await client.patch(url.format("PDD-D"), json={"duration_override_weeks": None})
        assert resp.status_code == 200 and resp.json()["recalc_status"] == "unchanged"
        assert resp.json()["effective_duration_weeks"] == 0
        # A user override wins over the effort (user ?? effort ?? lead).
        resp = await client.patch(url.format("PDD-E"), json={"duration_override_weeks": 6})
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert body["effective_duration_weeks"] == 6
        assert body["effort_weeks"] == 2 and body["lead_time_weeks"] == 4
        # Reset timing restores the EFFORT value, not the table.
        resp = await client.patch(
            url.format("PDD-E"),
            json={"duration_override_weeks": None, "start_not_before_week": None},
        )
        assert resp.status_code == 200
        assert resp.json()["effective_duration_weeks"] == 2
        assert resp.json()["duration_override_weeks"] is None
    # An EXISTING user override keeps a zeroed step (it is not skipped).
    row_d = await live_step(db_session, project, "PDD-D")
    row_d.duration_override_weeks = 2
    await db_session.flush()
    async with client_for(db_session) as client:
        resp = await client.patch(url.format("PDD-D"), json={"duration_override_weeks": 3})
        assert resp.status_code == 200, resp.text
        assert resp.json()["effective_duration_weeks"] == 3


async def test_solver_input_carries_the_merged_override(db_session):
    w = await _world(db_session)
    project = await _b4_project(db_session, w)
    row_e = await live_step(db_session, project, "PDD-E")
    row_e.duration_override_weeks = 6
    row_m = await live_step(db_session, project, "PDD-M")
    row_m.start_not_before_week = 45  # a floor alone on an effort-zeroed step
    await db_session.flush()
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [x for x in schedule_input.projects if x.project_id == str(project.id)]
    timing = {
        t.step_id: (t.duration_override_weeks, t.start_not_before_week) for t in p.step_timing
    }
    assert timing == {
        "PDD-A": (1, None),
        "PDD-D": (0, None),
        "PDD-E": (6, None),  # user wins
        "PDD-J": (0, None),
        "PDD-K": (1, None),
        "PDD-M": (0, 45),
    }


async def test_stage_patch_refuses_an_effort_zeroed_stage(db_session):
    w = await _world(db_session)
    project = await _b4_project(db_session, w, status=ProjectStatus.IN_DEVELOPMENT)
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}/stages/PDD-D",
            json={"status": "In Progress", "percent_complete": 10, "actual_start_week": 30},
        )
        assert resp.status_code == 422 and resp.json()["code"] == "STAGE_SKIPPED"
        ws = await client.get(f"/projects/{project.id}/workspace")
    assert ws.status_code == 200
    stages = {s["step_id"]: s for s in ws.json()["stages"]}
    assert stages["PDD-D"]["skipped"] is True and stages["PDD-D"]["duration_weeks"] == 0
    assert stages["PDD-D"]["effort_weeks"] == 0 and stages["PDD-D"]["lead_time_weeks"] == 1
    assert stages["PDD-E"]["duration_weeks"] == 2 and stages["PDD-E"]["skipped"] is False
    assert stages["PDD-E"]["remaining_weeks"] == 2
    assert stages["PDD-E"]["duration_override_weeks"] is None
    assert ws.json()["project"]["design_effort_weeks"] == 4.0


async def test_gantt_cards_and_tracking_use_the_one_predicate(db_session):
    w = await _world(db_session)
    project = await _b4_project(db_session, w, status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(
        db_session, project, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=20, end=20
    )
    run = await make_schedule_run(db_session, is_active=True)
    # A stale run: D is not skipped in the run and its window covers CW.
    await plan_step(db_session, run, project, "PDD-A", 20, 20)
    await plan_step(db_session, run, project, "PDD-D", CW, CW)
    await plan_step(db_session, run, project, "PDD-E", CW + 1, CW + 2)
    await add_outcome(db_session, run, project)
    async with client_for(db_session) as client:
        body = (await client.get("/gantt", params={"project_id": str(project.id)})).json()
    steps = {s["step_id"]: s for s in body["rows"][0]["steps"]}
    assert steps["PDD-D"]["timing_editable"] == "none"  # effort-zeroed (R5)
    assert steps["PDD-E"]["timing_editable"] == "move_resize"
    assert steps["PDD-E"]["effort_weeks"] == 2 and steps["PDD-E"]["duration_override_weeks"] is None
    cards = await build_project_cards(db_session, [project], run)
    assert cards[project.id].current_stage is not None
    assert cards[project.id].current_stage.step_id == "PDD-E"  # D is skipped
    # Roll-up weights are eff (I12): A1 E2 H6 K1 L1 N1 = 12 weeks, A done
    # -> round(100 / 12) = 8 % (D, J, M weigh 0).
    assert cards[project.id].progress_pct == 8
    due = await due_stages_for(db_session, [project.id], active_run=run)
    assert "PDD-D" not in {d.step_id for d in due.get(project.id, [])}


# --- I25 / I19 / R12 --------------------------------------------------------------------


async def _demand_world(db):
    w = await _world(db)
    p = SimpleNamespace()
    # Greece own: B figure 4 (In Development, A Done) -> design 4, remaining 3.
    p.g1 = await _project(db, w, name="G1", status=ProjectStatus.IN_DEVELOPMENT)
    # OEM member: B-OEM, no figure -> table design 5, lab H 6 (cert on).
    p.s1 = await _project(
        db, w, hub=w.seitek, name="S1", category=ProjectCategory.B_OEM,
        status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    # On Hold counts in the full year only; Cancelled in neither.
    p.h1 = await _project(db, w, name="H1", status=ProjectStatus.ON_HOLD)
    p.x1 = await _project(db, w, name="X1", status=ProjectStatus.CANCELLED)
    # India: C with a stale user override on lead-0 PDD-B (never revived).
    p.i1 = await _project(
        db, w, hub=w.india, leader=w.ind, name="I1", category=ProjectCategory.C,
        status=ProjectStatus.IN_QUEUE,
    )  # fmt: skip
    row = await live_step(db, p.i1, "PDD-B")
    row.duration_override_weeks = 9
    await db.flush()
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        assert (
            await client.patch(f"/projects/{p.g1.id}", json={"design_effort_weeks": 4})
        ).status_code == 200
    await set_progress(db, p.g1, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=20, end=20)
    run = await make_schedule_run(db, is_active=True)
    await plan_step(db, run, p.g1, "PDD-E", CW, CW + 1, engineer=w.gr)
    await plan_step(db, run, p.s1, "OEM-A", CW, CW, engineer=w.gr)
    return w, p, run


async def test_hub_load_serves_demand_and_booked_i25_i19(db_session):
    w, p, run = await _demand_world(db_session)
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        body = (await client.get("/capacity/hub-load")).json()
        by_hub = {
            h: (await client.get("/capacity/hub-load", params={"hub_id": str(hid)})).json()
            for h, hid in (("R&D-Greece", w.greece.id), ("OEM-Seitek", w.seitek.id),
                           ("PD-India", w.india.id))
        }  # fmt: skip
    rows = {r["hub"]: r for r in body["rows"]}
    gr, ind = rows["R&D-Greece"], rows["PD-India"]
    # Full year: G1 4 + S1 5 + H1 10 (On Hold, table B) = 19; X1 Cancelled out.
    assert gr["design_load_weeks"] == 4 + 5 + 10
    # Remaining: G1 (A Done) 3 + S1 5; On Hold not counted.
    assert gr["design_load_remaining_weeks"] == 3 + 5
    assert gr["design_load_booked_weeks"] == 2 + 1
    assert ind["design_load_weeks"] == 6  # C table, PDD-B override never revives it
    # Lab (Greece region): S1 H6 + H1 H6 (G1's lab has no figure: H6 too) = 18.
    assert gr["lab_load_weeks"] == 18.0 and gr["lab_load_remaining_weeks"] == 12.0
    assert gr["lab_load_booked_weeks"] == 0.0
    # Members carry demand + booked and sum to the row (R12).
    members = {m["hub"]: m for m in gr["members"]}
    assert members["R&D-Greece"]["design_load_weeks"] == 14
    assert members["OEM-Seitek"]["design_load_weeks"] == 5
    assert members["R&D-Greece"]["project_count"] == 2  # G1, H1
    for field in ("design_load_weeks", "design_load_remaining_weeks", "design_load_booked_weeks"):
        assert sum(m[field] for m in gr["members"]) == gr[field]
    assert sum(gr["design_load_by_priority"].values()) == gr["design_load_weeks"]
    # I19 rev.: year pairs full-year demand, remaining pairs remaining demand.
    for row in (gr, ind, *body["areas"], body["totals"]):
        for load, cap, pct in (
            ("design_load_weeks", "design_capacity_year", "design_booked_pct_year"),
            ("design_load_remaining_weeks", "design_capacity_remaining",
             "design_booked_pct_remaining"),
            ("lab_load_weeks", "lab_capacity_year", "lab_booked_pct_year"),
            ("lab_load_remaining_weeks", "lab_capacity_remaining", "lab_booked_pct_remaining"),
        ):  # fmt: skip
            expected = None if row[cap] == 0 else round(row[load] / row[cap] * 100, 2)
            assert row[pct] == expected, (row.get("hub", row.get("area")), pct)
    assert gr["design_gap_remaining"] == round(
        gr["design_load_remaining_weeks"] - gr["design_capacity_remaining"], 2
    )
    # I25 against the scheduler package's own check, unfiltered ...
    live, _ = await load_live_project_rows(db_session)
    served_design = [
        ServedDesignLoad(r["hub"], r["design_load_weeks"], r["design_load_remaining_weeks"])
        for r in body["rows"]
    ]
    served_lab = [
        ServedLabLoad(r["lab_region"], r["load_weeks"], r["load_remaining_weeks"])
        for r in body["lab_regions"]
    ]
    assert check_i25_demand(live, served_design, served_lab) == ()
    # ... and per capacity hub: a filter selects the same aggregate row.
    assert by_hub["OEM-Seitek"]["rows"][0]["design_load_weeks"] == gr["design_load_weeks"]
    assert by_hub["R&D-Greece"]["rows"][0] == {**gr, "selected_member": "R&D-Greece"}
    assert by_hub["PD-India"]["rows"][0]["design_load_weeks"] == ind["design_load_weeks"]
    # A drift is caught.
    drifted = [ServedDesignLoad("R&D-Greece", gr["design_load_weeks"] + 1, 8)]
    assert check_i25_demand(live, drifted, served_lab)


async def test_capacity_fill_uses_remaining_demand(db_session):
    w, p, run = await _demand_world(db_session)
    await make_priority_score(db_session, p.g1, dims=[5] * 13, normalized_pct=100)  # P1 base
    fill = await compute_capacity_fill(db_session, [w.greece.id])
    hub = fill.hubs[w.greece.id]
    demand = await load_demand(db_session)
    assert float(hub.base_load_weeks) == demand.projects[p.g1.id].design_remaining == 3


async def test_seed_split_wiring_b_example():
    lead = lead_time_lookup(dc.LEAD_TIME_SEED)
    project = {
        "external_code": "T-1", "category": "B", "certification_testing_required": True,
        "design_effort_weeks": 4, "lab_effort_weeks": 10, "status": "In Queue",
    }  # fmt: skip
    specs = {s.step_id: s for s in client_2026_step_specs(project, "PDD", lead)}
    assert {k: specs[k].duration for k in B4} == {
        k: (v if v is not None else 0) for k, v in B4.items()
    }
    assert specs["PDD-H"].duration == 10 and specs["PDD-H"].effort == 10
    assert specs["PDD-B"].effort is None and specs["PDD-C"].duration == 0
    # Blank figure: the table (no effort written).
    blank = {**project, "design_effort_weeks": None, "lab_effort_weeks": None}
    specs = {s.step_id: s for s in client_2026_step_specs(blank, "PDD", lead)}
    assert specs["PDD-E"].duration == 4 and specs["PDD-E"].effort is None
    # R7 at import: rejected loudly.
    with pytest.raises(ValueError, match="T-1"):
        client_2026_step_specs({**project, "design_effort_weeks": 300}, "PDD", lead)
    # R3: the seed derives progress on effective durations, so a zeroed step
    # never becomes the current step.
    specs_list = client_2026_step_specs(
        {**project, "status": "In Development", "development_step": "PDD-D"}, "PDD", lead
    )
    k = c26.current_step_index(
        {"status": "In Development", "development_step": "PDD-D", "external_code": "T-1"},
        specs_list,
    )
    assert specs_list[k].step_id == "PDD-E"


async def test_unrelated_effort_readers_do_not_break_without_figures(db_session):
    """A project with no figure behaves exactly as before ADR 0041."""

    w = await _world(db_session)
    project = await _project(db_session, w, name="plain")
    schedule_input = await build_schedule_input_from_db(db_session)
    (p,) = [x for x in schedule_input.projects if x.project_id == str(project.id)]
    assert p.step_timing == ()
    demand = await load_demand(db_session)
    assert demand.projects[project.id].design_full_year == 10
    assert await _i26(db_session) == ()


def _json(value: Any) -> Any:  # pragma: no cover - debugging helper
    return value


# --- Extractor (ADR 0041 §1, §3, §4; DATA_RECONCILIATION §7.1) ---------------------------


def _xrow(**cells: object) -> tuple[object, ...]:
    import datetime as _dt

    from seed import extract_client_2026 as ex

    row: list[object] = [None] * (ex.COL_LAST + 1)
    defaults = {
        ex.COL_SNO: 7, ex.COL_REQUEST: _dt.datetime(2026, 3, 1), ex.COL_CATEGORY: "B",
        ex.COL_TYPE: "CO", ex.COL_PD_CODE: "TBD", ex.COL_RM_CODE: "N/A",
        ex.COL_NAME: "A project", ex.COL_HUB: "PD-India", ex.COL_STATUS: "In Que",
        ex.COL_LEADER: "Pawan",
    }  # fmt: skip
    for col, value in {**defaults, **{int(k[1:]): v for k, v in cells.items()}}.items():
        row[col] = value
    return tuple(row)


def test_extractor_selection_figures_types_and_dates():
    import datetime as _dt

    from seed import extract_client_2026 as ex

    rows = [
        # 2026, figures; cert set by lab weeks (col 18 "No").
        (6, _xrow(c16=4, c21=10, c18="No", c22=0, c17=3.5, c23=0, c24="YES", c3="Y")),
        # 2025 + flag Y: carry-over; blank / 0 figures are blanks; Mon'YY date.
        (7, _xrow(c1=_dt.datetime(2025, 5, 1), c3="Y", c16=0, c21=None, c45="Feb'26",
                  c10="OEM-SEITEK", c4="B")),  # fmt: skip
        # 2024 without the flag: dropped.
        (8, _xrow(c1=_dt.datetime(2024, 5, 1))),
        # Text numbers and the new types; '-' end date is null.
        (9, _xrow(c16="1.5", c21="abc", c5="SER", c45="-")),
        (10, _xrow(c5="AC", c18="Yes")),
    ]
    out = ex.extract(rows)["projects"]
    assert [p["excel_row"] for p in out] == [6, 7, 9, 10]
    a, b, c, d = out
    assert (a["design_effort_weeks"], a["lab_effort_weeks"]) == (4.0, 10.0)
    assert a["certification_testing_required"] is True and a["excel_certification"] == "No"
    assert (a["safety_lab_weeks"], a["actual_design_weeks"], a["actual_testing_weeks"]) == (
        0.0, 3.5, None,
    )  # fmt: skip
    assert a["safety_certification_required"] is True
    assert a["capacity_flag"] is True and a["request_year"] == 2026
    assert b["request_year"] == 2025 and b["capacity_flag"] is True
    assert (b["design_effort_weeks"], b["lab_effort_weeks"]) == (None, None)
    assert b["certification_testing_required"] is False
    assert b["hub"] == "OEM-Seitek" and b["category"] == "B-OEM"
    assert b["end_date"] == "2026-02-01" and b["target_end_week"] == 5
    assert c["design_effort_weeks"] == 1.5 and c["lab_effort_weeks"] is None
    assert c["type"] == "SER" and c["end_date"] is None
    assert d["type"] == "AC" and d["certification_testing_required"] is True
    assert c26.carry_over_and_reg_year(b) == (True, 2025)
    assert c26.carry_over_and_reg_year(a) == (False, 2026)
