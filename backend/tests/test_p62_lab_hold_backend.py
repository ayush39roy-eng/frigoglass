"""P62-T04 (ADR 0071 "Lab hold weeks", R62-0 … R62-13, I64–I67;
`docs/API_CONTRACT_P62.md` §2–§7): the backend around the engine's room
weeks.

The shared test DB is migrated to head, so the template carries the p71a
defaults (PDD-J / PDD-L room weeks 1 for A+, A, B; 0 for C; C/PDD-J length 0).
The seeded kinds are the workbook's (J design, L elapsed), where a hold is
stored but not read; every test that needs Pr. Pr / Pilot as `lab` (as on
hosted) sets the kinds itself (`_lab_jl`), inside the test's rolled-back
transaction.

Covered:

1. the live builder: `StepTimingInput.lab_hold_weeks`, `LeadTime.lab_hold_weeks`,
   run rows storing `h`; a NULL-hold copy keeps the pre-P62 input;
2. the one service-side predicate: R62-2 (certification off skips PoC /
   Certification only), R62-1 (a figure splits over F / H only), I67;
3. readers count held weeks (I66): `/capacity/hub-load`, the utilisation
   matrix, `/planning/resource-load`, `/gantt` (step + project fields), the
   Priority board's remaining lab;
4. template read (`/workflow-settings`, category timelines) and write (the
   P33 apply with room weeks as a third change kind: errors, clamp, hold-only
   apply = stale + no run, R62-8 re-split, R62-12);
5. `PATCH /chambers/{id}` marks the plan stale;
6. the OpenAPI contract (fields T05 mirrors).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from types import SimpleNamespace
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from api.routers import workflow_templates as wt_router
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    SolverType,
    WorkflowStepKind,
)
from models.project import Project
from models.schedule import ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from scheduling import StepSchedule, row_lab_load_weeks, run_greedy_sgs
from services import priority_move
from services.lab_hold import held_weeks_from, room_week_range, run_row_lab_weeks
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from services.workflow_durations import live_step_effective_weeks, run_input_lead_and_override
from tests._plan_week import TEST_WEEK
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_chamber, make_engineer, make_hub
from tests.p12_helpers import act_as, client_for, stepped_project
from workers.schedule_tasks import run_greedy_schedule

APPLY = "/workflow-templates/apply"
PREVIEW = "/workflow-templates/apply-preview"
TIMELINE = "/workflow-templates/timeline-preview"
LAB_STEPS = ["PDD-F", "PDD-H", "PDD-J", "PDD-L"]


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    for limiter in (
        wt_router.APPLY_RATE_LIMIT,
        wt_router.APPLY_PREVIEW_RATE_LIMIT,
        wt_router.TIMELINE_PREVIEW_RATE_LIMIT,
    ):
        limiter.reset()
    yield
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


# --- helpers -------------------------------------------------------------------------------------
async def _lab_jl(db: AsyncSession) -> None:
    """Pr. Pr / Pilot as `lab` (the hosted kinds since 2026-11-22)."""

    await db.execute(
        update(WorkflowStepTemplate)
        .where(WorkflowStepTemplate.id.in_(["PDD-J", "PDD-L"]))
        .values(kind=WorkflowStepKind.LAB)
    )
    await db.flush()


async def _world(db: AsyncSession, *, max_concurrent: int = 4) -> SimpleNamespace:
    await _lab_jl(db)
    hub = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    lead = await make_engineer(db, hub, name="Lead", allowed_categories=["A+", "A", "B", "C"])
    chamber = await make_chamber(
        db, code="GR-CH9", lab_region=LabRegion.GREECE, max_concurrent=max_concurrent,
        allowed_stages=list(LAB_STEPS),
    )  # fmt: skip
    return SimpleNamespace(hub=hub, lead=lead, chamber=chamber)


async def _project(db: AsyncSession, w: SimpleNamespace, name: str, **kw: Any) -> Project:
    kw.setdefault("category", ProjectCategory.A_PLUS)
    kw.setdefault("status", ProjectStatus.IN_QUEUE)
    kw.setdefault("certification_testing_required", True)
    return await stepped_project(db, w.hub, name=name, leader=w.lead, **kw)


async def _rows(db: AsyncSession, project: Project) -> dict[str, ProjectWorkflowStep]:
    rows = (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(ProjectWorkflowStep.project_id == project.id)
        )
    ).scalars()
    return {r.step_template_id: r for r in rows}


async def _run(db: AsyncSession) -> Any:
    si = await build_schedule_input_from_db(db, current_week=TEST_WEEK)
    out = run_greedy_sgs(si)
    run = await persist_schedule_output(
        db, si, out, solver_type=SolverType.GREEDY, trigger_reason="test", activate=True
    )
    await db.flush()
    return si, out, run


async def _run_rows(db: AsyncSession, run_id: uuid.UUID, project: Project) -> dict[str, Any]:
    rows = (
        await db.execute(
            select(ScheduleRunProjectStep).where(
                ScheduleRunProjectStep.schedule_run_id == run_id,
                ScheduleRunProjectStep.project_id == project.id,
            )
        )
    ).scalars()
    return {r.step_template_id: r for r in rows}


async def _get(db: AsyncSession, path: str, role: RoleName = RoleName.ADMIN, **params: Any) -> Any:
    await act_as(db, role)
    async with client_for(db) as client:
        return await client.get(path, params=params)


async def _post(db: AsyncSession, path: str, body: dict[str, Any]) -> Any:
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        return await client.post(path, json=body)


async def _figure(db: AsyncSession, project: Project, **figures: Any) -> None:
    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        resp = await client.patch(f"/projects/{project.id}", json=figures)
        assert resp.status_code == 200, resp.text


async def _version(db: AsyncSession, code: str) -> int:
    from models.category import Category

    return int(
        (
            await db.execute(
                select(Category.template_version)
                .where(Category.code == code)
                .execution_options(populate_existing=True)
            )
        ).scalar_one()
    )


async def _change(db: AsyncSession, category: str, steps: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "workflow_id": "PDD",
        "category": category,
        "base_version": await _version(db, category),
        "steps": steps,
    }


async def _template(db: AsyncSession, category: str, step_id: str) -> WorkflowLeadTime:
    return (
        await db.execute(
            select(WorkflowLeadTime)
            .execution_options(populate_existing=True)
            .where(
                WorkflowLeadTime.workflow_id == "PDD",
                WorkflowLeadTime.category == category,
                WorkflowLeadTime.step_id == step_id,
            )
        )
    ).scalar_one()


async def _audits(db: AsyncSession, action: str) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == action)
                .order_by(AuditLogEntry.occurred_at)
            )
        ).scalars()
    )


# --- 0. the migrated template defaults (the shared DB) -------------------------------------------
async def test_template_carries_the_p71a_defaults(db_session: AsyncSession) -> None:
    for cat, hold in (("A+", 1), ("A", 1), ("B", 1), ("C", 0)):
        for sid in ("PDD-J", "PDD-L"):
            t = await _template(db_session, cat, sid)
            assert t.lab_hold_weeks == min(hold, t.weeks), (cat, sid)
    assert (await _template(db_session, "C", "PDD-J")).weeks == 0  # R62-11
    assert (await _template(db_session, "C", "PDD-J")).effort_weight_weeks == 1  # immutable
    for sid in ("PDD-F", "PDD-H"):
        assert (await _template(db_session, "B", sid)).lab_hold_weeks is None


# --- 1. the live builder and run rows ------------------------------------------------------------
async def test_builder_sends_hold_and_run_rows_store_h(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "A+ project")
    rows = await _rows(db_session, p)
    assert {s: rows[s].plan_lab_hold_weeks for s in LAB_STEPS} == {
        "PDD-F": None, "PDD-H": None, "PDD-J": 1, "PDD-L": 1,
    }  # fmt: skip
    si, _out, run = await _run(db_session)
    pin = next(x for x in si.projects if x.project_id == str(p.id))
    timing = {t.step_id: t for t in pin.step_timing}
    assert timing["PDD-J"].lab_hold_weeks == 1 and timing["PDD-L"].lab_hold_weeks == 1
    # partialRoom: lead = plan_weeks (= the table, so None), no override.
    assert timing["PDD-L"].lead_weeks is None and timing["PDD-L"].duration_override_weeks is None
    assert "PDD-F" not in timing
    lead = {(lt.category, lt.step_id): lt.lab_hold_weeks for lt in si.lead_times}
    assert lead[("A+", "PDD-L")] == 1 and lead[("A+", "PDD-F")] is None
    # Design-kind holds are never sent (stored but not read).
    assert lead[("A+", "PDD-E")] is None

    run_rows = await _run_rows(db_session, run.id, p)
    assert run_rows["PDD-L"].duration_weeks == 3
    assert run_rows["PDD-L"].lab_hold_weeks == 1
    assert run_rows["PDD-L"].assigned_chamber_id == w.chamber.id
    assert run_rows["PDD-J"].lab_hold_weeks == 1
    assert run_rows["PDD-F"].lab_hold_weeks is None  # full: NULL, read as duration
    assert run_rows["PDD-E"].lab_hold_weeks is None


async def test_null_hold_copy_is_the_pre_p62_input(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "Full room")
    await db_session.execute(
        update(ProjectWorkflowStep)
        .where(ProjectWorkflowStep.project_id == p.id)
        .values(plan_lab_hold_weeks=None)
    )
    si = await build_schedule_input_from_db(db_session, current_week=TEST_WEEK)
    pin = next(x for x in si.projects if x.project_id == str(p.id))
    assert all(t.lab_hold_weeks is None for t in pin.step_timing)


def test_run_input_mapping_for_partial_room() -> None:
    # Own lab figure, but J has room weeks: lead = plan_weeks, no override.
    assert run_input_lead_and_override(
        plan_weeks=1, effort_weight_weeks=1, table_weeks=1, own_effort=True, effort_weeks=3,
        kind="lab", lab_hold_weeks=1,
    ) == (None, None)  # fmt: skip
    # Without a hold: the pre-P62 own-effort mapping.
    assert run_input_lead_and_override(
        plan_weeks=1, effort_weight_weeks=1, table_weeks=1, own_effort=True, effort_weeks=3,
        kind="lab", lab_hold_weeks=None,
    ) == (None, 3)  # fmt: skip


# --- 2. the one predicate (R62-1, R62-2, I67) ----------------------------------------------------
def test_live_eff_partial_room_rules() -> None:
    kw: dict[str, Any] = dict(plan_weeks=3, kind="lab", own_effort=True, effort_weeks=None)
    # R62-2: certification off skips full-room lab steps only.
    assert live_step_effective_weeks(certification_testing_required=False, **kw) == 0
    assert (
        live_step_effective_weeks(certification_testing_required=False, lab_hold_weeks=1, **kw) == 3
    )
    # R62-1: a partialRoom step's length is its copy, not the figure.
    assert live_step_effective_weeks(
        certification_testing_required=True, lab_hold_weeks=1,
        **{**kw, "effort_weeks": 7},
    ) == 3  # fmt: skip
    # I67 / R62-11: a 0-length partialRoom step is skipped.
    assert (
        live_step_effective_weeks(
            certification_testing_required=True, lab_hold_weeks=0, **{**kw, "plan_weeks": 0}
        )
        == 0
    )
    # A hold on a non-lab step is not read.
    assert live_step_effective_weeks(
        plan_weeks=2, kind="design", certification_testing_required=True, own_effort=True,
        effort_weeks=5, lab_hold_weeks=1,
    ) == 5  # fmt: skip


async def test_certification_off_keeps_pr_pr_and_pilot(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "No cert", certification_testing_required=False)
    _si, _out, run = await _run(db_session)
    run_rows = await _run_rows(db_session, run.id, p)
    assert run_rows["PDD-F"].skipped and run_rows["PDD-H"].skipped
    assert not run_rows["PDD-J"].skipped and not run_rows["PDD-L"].skipped
    assert run_rows["PDD-L"].lab_hold_weeks == 1


async def test_lab_figure_splits_over_poc_and_certification_only(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "Own lab", category=ProjectCategory.B)
    await _figure(db_session, p, lab_effort_weeks=10)
    rows = await _rows(db_session, p)
    # B weights F 0, H 6, J 1, L 1; J / L are partialRoom: all 10 on H.
    assert {s: rows[s].effort_weeks for s in LAB_STEPS} == {
        "PDD-F": None, "PDD-H": 10, "PDD-J": None, "PDD-L": None,
    }  # fmt: skip

    # Contrast (I67): with every hold Full the split is the pre-P62 one.
    q = await _project(db_session, w, "Own lab full", category=ProjectCategory.B)
    await db_session.execute(
        update(ProjectWorkflowStep)
        .where(ProjectWorkflowStep.project_id == q.id)
        .values(plan_lab_hold_weeks=None)
    )
    await _figure(db_session, q, lab_effort_weeks=10)
    rows = await _rows(db_session, q)
    assert rows["PDD-J"].effort_weeks is not None and rows["PDD-L"].effort_weeks is not None
    assert sum(rows[s].effort_weeks or 0 for s in LAB_STEPS) == 10


# --- 3. readers count held weeks (I66) -----------------------------------------------------------
async def test_readers_count_held_weeks(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "A+ readers")
    _si, _out, run = await _run(db_session)
    run_rows = await _run_rows(db_session, run.id, p)
    # A+: F 6, H 6 (full), J 1 hold 1, L 3 hold 1 -> Σ h = 14 (lengths 16).
    expected = sum(
        run_row_lab_weeks(run_rows[s].duration_weeks, run_rows[s].lab_hold_weeks) for s in LAB_STEPS
    )
    assert expected == 14

    hub_load = await _get(db_session, "/capacity/hub-load")
    assert hub_load.status_code == 200, hub_load.text
    greece = next(r for r in hub_load.json()["rows"] if r["hub"] == "R&D-Greece")
    assert greece["lab_load_booked_weeks"] == 14

    gantt = await _get(db_session, "/gantt")
    assert gantt.status_code == 200, gantt.text
    row = next(r for r in gantt.json()["rows"] if r["project_id"] == str(p.id))
    assert row["lab_weeks"] == 14
    steps = {s["step_id"]: s for s in row["steps"]}
    pilot = steps["PDD-L"]
    assert pilot["duration_weeks"] == 3
    assert pilot["lab_hold_weeks"] == 1 and pilot["plan_lab_hold_weeks"] == 1
    assert pilot["room_start_week"] == pilot["room_end_week"] == pilot["planned_end_week"]
    assert pilot["planned_end_week"] - pilot["planned_start_week"] + 1 == 3
    assert pilot["assigned_chamber_code"] == "GR-CH9"
    poc = steps["PDD-F"]
    assert poc["lab_hold_weeks"] == 6 and poc["plan_lab_hold_weeks"] is None
    assert poc["room_start_week"] == poc["planned_start_week"]
    design = steps["PDD-E"]
    assert design["lab_hold_weeks"] is None and design["room_start_week"] is None

    matrix = await _get(db_session, "/capacity/utilization-matrix")
    assert matrix.status_code == 200, matrix.text
    ch = next(c for c in matrix.json()["chambers"] if c["code"] == "GR-CH9")
    weeks = {int(k): v for k, v in ch["week_counts"].items()}
    assert sum(weeks.values()) == 14
    # Pilot (3 weeks, 1 room week) occupies only its last week.
    assert weeks.get(pilot["planned_end_week"], 0) >= 1
    for wk in range(pilot["planned_start_week"], pilot["planned_end_week"]):
        assert wk not in weeks

    load = await _get(db_session, "/planning/resource-load", basis="year")
    assert load.status_code == 200, load.text
    chamber = next(c for c in load.json()["chambers"] if c["code"] == "GR-CH9")
    assert chamber["load_weeks"] == 14


def test_run_row_helpers_match_the_engine() -> None:
    def row(**kw: Any) -> StepSchedule:
        base: dict[str, Any] = dict(
            step_id="PDD-L", sequence_order=12, kind="lab", duration_weeks=3, start_week=40,
            end_week=42, assigned_engineer_id=None, assigned_chamber_id="c", skipped=False,
        )  # fmt: skip
        base.update(kw)
        return StepSchedule(**base)

    for hold in (None, 0, 1, 3):
        r = row(lab_hold_weeks=hold)
        assert run_row_lab_weeks(r.duration_weeks, r.lab_hold_weeks) == row_lab_load_weeks(r)
    assert held_weeks_from(40, 42, 1, 42) == 1
    assert held_weeks_from(40, 42, 1, 43) == 0
    assert held_weeks_from(40, 42, None, 41) == 2
    assert room_week_range(42, 1) == (42, 42)
    assert room_week_range(42, 0) == (None, None)
    assert room_week_range(None, 1) == (None, None)


async def test_priority_board_remaining_lab_counts_held_weeks(db_session: AsyncSession) -> None:
    from services.capacity_priority import remaining_run_load_by_project

    w = await _world(db_session)
    p = await _project(db_session, w, "Board")
    _si, _out, run = await _run(db_session)
    remaining = await remaining_run_load_by_project(db_session, run, [p.id])
    assert remaining[p.id][1] == 14


# --- 4. template read / write --------------------------------------------------------------------
async def test_settings_serve_hold_on_lab_rows_only(db_session: AsyncSession) -> None:
    resp = await _get(db_session, "/workflow-settings")
    assert resp.status_code == 200, resp.text
    by_key = {(lt["category"], lt["step_id"]): lt for lt in resp.json()["lead_times"]}
    # Seeded kinds: J design, L elapsed -> stored but served as null.
    assert by_key[("B", "PDD-J")]["lab_hold_weeks"] is None
    assert by_key[("B", "PDD-F")]["lab_hold_weeks"] is None

    await _lab_jl(db_session)
    resp = await _get(db_session, "/workflow-settings")
    by_key = {(lt["category"], lt["step_id"]): lt for lt in resp.json()["lead_times"]}
    assert by_key[("B", "PDD-J")]["lab_hold_weeks"] == 1
    assert by_key[("C", "PDD-L")]["lab_hold_weeks"] == 0
    assert by_key[("B", "PDD-E")]["lab_hold_weeks"] is None


async def test_category_timeline_room_fields(db_session: AsyncSession) -> None:
    await _lab_jl(db_session)
    resp = await _get(db_session, "/workflow-settings/category-timelines", workflow="PDD")
    assert resp.status_code == 200, resp.text
    aplus = next(c for c in resp.json() if c["category"] == "A+")
    steps = {s["code"]: s for s in aplus["steps"]}
    pilot = steps["PDD-L"]
    assert pilot["duration_weeks"] == 3 and pilot["lab_hold_weeks"] == 1
    assert pilot["room_weeks"] == 1
    assert pilot["room_start_week"] == pilot["start_week"] + 3 - 1
    assert steps["PDD-F"]["room_weeks"] == 6 and steps["PDD-F"]["lab_hold_weeks"] is None
    assert steps["PDD-E"]["room_weeks"] == 0 and steps["PDD-E"]["room_start_week"] is None
    assert aplus["lab_weeks"] == 6 + 6 + 1 + 1
    assert aplus["lab_length_weeks"] == 6 + 6 + 1 + 3


async def test_override_validation(db_session: AsyncSession) -> None:
    await _lab_jl(db_session)
    # Non-lab step: 422 LAB_HOLD_NOT_LAB.
    resp = await _post(db_session, TIMELINE, {
        "workflow_id": "PDD", "category": "B", "steps": [{"step_id": "PDD-E", "lab_hold_weeks": 1}],
    })  # fmt: skip
    assert resp.status_code == 422 and resp.json()["code"] == "LAB_HOLD_NOT_LAB", resp.text
    # "full" on a non-lab step is an accepted no-op.
    resp = await _post(db_session, TIMELINE, {
        "workflow_id": "PDD", "category": "B",
        "steps": [{"step_id": "PDD-E", "lab_hold_weeks": "full"}],
    })  # fmt: skip
    assert resp.status_code == 200, resp.text
    assert resp.json()["changed_step_ids"] == []
    # Out of range against the saved length (B/L = 1) ...
    resp = await _post(db_session, TIMELINE, {
        "workflow_id": "PDD", "category": "B", "steps": [{"step_id": "PDD-L", "lab_hold_weeks": 2}],
    })  # fmt: skip
    assert resp.status_code == 422 and resp.json()["code"] == "LAB_HOLD_OUT_OF_RANGE", resp.text
    resp = await _post(db_session, TIMELINE, {
        "workflow_id": "PDD", "category": "B",
        "steps": [{"step_id": "PDD-L", "lab_hold_weeks": -1}],
    })  # fmt: skip
    assert resp.status_code == 422 and resp.json()["code"] == "LAB_HOLD_OUT_OF_RANGE", resp.text
    # ... and against the override's own length.
    resp = await _post(db_session, TIMELINE, {
        "workflow_id": "PDD", "category": "B",
        "steps": [{"step_id": "PDD-L", "weeks": 3, "lab_hold_weeks": 2}],
    })  # fmt: skip
    assert resp.status_code == 200, resp.text
    pilot = next(s for s in resp.json()["steps"] if s["code"] == "PDD-L")
    assert (pilot["lab_hold_weeks"], pilot["room_weeks"]) == (2, 2)
    # A string other than "full" and a bool are schema errors.
    for bad in ("all", True):
        resp = await _post(db_session, TIMELINE, {
            "workflow_id": "PDD", "category": "B",
            "steps": [{"step_id": "PDD-L", "lab_hold_weeks": bad}],
        })  # fmt: skip
        assert resp.status_code == 422, resp.text
    # NO_CHANGE when the hold equals the saved value.
    resp = await _post(db_session, PREVIEW, {
        "changes": [await _change(db_session, "B", [{"step_id": "PDD-L", "lab_hold_weeks": 1}])]
    })  # fmt: skip
    assert resp.status_code == 422 and resp.json()["code"] == "NO_CHANGE", resp.text


async def test_hold_only_apply_is_stale_without_a_run(
    db_session: AsyncSession, dispatch: list[Any]
) -> None:
    w = await _world(db_session)
    plain = await _project(db_session, w, "01 Plain", category=ProjectCategory.B)
    own = await _project(db_session, w, "02 Own lab", category=ProjectCategory.B)
    await _figure(db_session, own, lab_effort_weeks=10)
    await db_session.execute(
        update(Project).where(Project.id.in_([plain.id, own.id])).values(schedule_stale=False)
    )
    change = await _change(db_session, "B", [{"step_id": "PDD-L", "lab_hold_weeks": "full"}])

    preview = await _post(db_session, PREVIEW, {"changes": [change]})
    assert preview.status_code == 200, preview.text
    auto = {p["name"]: p for p in preview.json()["automatic"]}
    assert preview.json()["counts"]["own_effort"] == 0
    plain_steps = {s["step_id"]: s for s in auto["01 Plain"]["steps"]}
    assert plain_steps["PDD-L"]["hold_before"] == 1 and plain_steps["PDD-L"]["hold_after"] is None
    assert plain_steps["PDD-L"]["flags"] == []
    own_steps = {s["step_id"]: s for s in auto["02 Own lab"]["steps"]}
    # R62-8: L leaves partialRoom -> the lab split (H 6 : L 1) is re-derived.
    assert "lab_split_rederived" in own_steps["PDD-L"]["flags"]
    assert own_steps["PDD-L"]["eff_after"] > 0
    assert own_steps["PDD-H"]["eff_before"] == 10 and own_steps["PDD-H"]["eff_after"] < 10

    body = {"changes": [change], "selection": {"mode": "none", "project_ids": []}}
    resp = await _post(db_session, APPLY, body)
    assert resp.status_code == 200, resp.text
    assert resp.json()["recalc_status"] == "not_needed"
    assert resp.json()["schedule_run_id"] is None
    assert dispatch == []
    assert (await _template(db_session, "B", "PDD-L")).lab_hold_weeks is None
    for p in (plain, own):
        await db_session.refresh(p)
        assert p.schedule_stale is True
        assert (await _rows(db_session, p))["PDD-L"].plan_lab_hold_weeks is None
    own_rows = await _rows(db_session, own)
    assert own_rows["PDD-L"].effort_weeks is not None
    assert own_rows["PDD-J"].effort_weeks is None  # J still partialRoom
    assert sum(own_rows[s].effort_weeks or 0 for s in LAB_STEPS) == 10

    rederived = [a for a in await _audits(db_session, "project.effort_rederived")
                 if a.entity_id == str(own.id)]  # fmt: skip
    assert (rederived[-1].after_state or {})["trigger"] == "lab_hold_change"
    applied = [a for a in await _audits(db_session, "project.template_applied")
               if a.entity_id == str(plain.id)]  # fmt: skip
    assert (applied[-1].after_state or {})["lab_hold_weeks"] == {"PDD-L": [1, None]}
    summary = (await _audits(db_session, "workflow_template.applied"))[-1].after_state or {}
    step = summary["changes"][0]["steps"][0]
    assert step == {"step_id": "PDD-L", "lab_hold_weeks": [1, None]}
    assert summary["recalc_status"] == "not_needed"


async def test_length_below_hold_clamps(db_session: AsyncSession, dispatch: list[Any]) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "01 Clamped", category=ProjectCategory.B)
    change = await _change(db_session, "B", [{"step_id": "PDD-L", "weeks": 0}])
    preview = await _post(db_session, PREVIEW, {"changes": [change]})
    assert preview.status_code == 200, preview.text
    step = preview.json()["automatic"][0]["steps"][0]
    assert step["step_id"] == "PDD-L"
    assert (step["hold_before"], step["hold_after"]) == (1, 0)
    assert "room_weeks_clamped" in step["flags"]
    timeline = preview.json()["categories"][0]["timeline"]
    pilot = next(s for s in timeline["steps"] if s["code"] == "PDD-L")
    assert pilot["lab_hold_weeks"] == 0

    resp = await _post(
        db_session, APPLY, {"changes": [change], "selection": {"mode": "none", "project_ids": []}}
    )
    assert resp.status_code == 200, resp.text
    t = await _template(db_session, "B", "PDD-L")
    assert (t.weeks, t.lab_hold_weeks) == (0, 0)


async def test_partial_room_length_reaches_own_effort_projects(
    db_session: AsyncSession, dispatch: list[Any]
) -> None:
    w = await _world(db_session)
    own = await _project(db_session, w, "01 Own lab", category=ProjectCategory.B)
    await _figure(db_session, own, lab_effort_weeks=10)
    change = await _change(db_session, "B", [{"step_id": "PDD-J", "weeks": 2}])
    preview = await _post(db_session, PREVIEW, {"changes": [change]})
    assert preview.status_code == 200, preview.text
    assert preview.json()["counts"]["own_effort"] == 0
    step = preview.json()["automatic"][0]["steps"][0]
    assert step["step_id"] == "PDD-J"
    assert step["flags"] == ["partial_room_length_applied"]
    assert (step["eff_before"], step["eff_after"]) == (1, 2)

    resp = await _post(
        db_session, APPLY, {"changes": [change], "selection": {"mode": "none", "project_ids": []}}
    )
    assert resp.status_code == 200, resp.text
    rows = await _rows(db_session, own)
    assert rows["PDD-J"].plan_weeks == 2 and rows["PDD-J"].plan_lab_hold_weeks == 1
    assert rows["PDD-H"].effort_weeks == 10  # the figure is untouched


async def test_registration_copies_holds_and_category_change_recopies(
    db_session: AsyncSession,
) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "Moves to C", category=ProjectCategory.B)
    assert (await _rows(db_session, p))["PDD-J"].plan_lab_hold_weeks == 1
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/projects/{p.id}", json={"category": "C"})
        assert resp.status_code == 200, resp.text
    rows = await _rows(db_session, p)
    assert (rows["PDD-J"].plan_weeks, rows["PDD-J"].plan_lab_hold_weeks) == (0, 0)
    assert (rows["PDD-L"].plan_weeks, rows["PDD-L"].plan_lab_hold_weeks) == (0, 0)


# --- 5. chamber PATCH marks the plan stale -------------------------------------------------------
async def test_chamber_patch_marks_plan_stale(db_session: AsyncSession) -> None:
    w = await _world(db_session)
    p = await _project(db_session, w, "Stale me", status=ProjectStatus.IN_DEVELOPMENT)
    await db_session.execute(update(Project).values(schedule_stale=False))
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        resp = await client.patch(f"/chambers/{w.chamber.id}", json={"code": "GR-CH9b"})
        assert resp.status_code == 200, resp.text
    await db_session.refresh(p)
    assert p.schedule_stale is False  # a label change is not a plan input
    async with client_for(db_session) as client:
        resp = await client.patch(
            f"/chambers/{w.chamber.id}", json={"allowed_stages": ["PDD-F", "PDD-H"]}
        )
        assert resp.status_code == 200, resp.text
    await db_session.refresh(p)
    assert p.schedule_stale is True


# --- 6. the OpenAPI contract (T05 mirrors these) -------------------------------------------------
def test_openapi_carries_the_p62_fields() -> None:
    schemas = app.openapi()["components"]["schemas"]

    def props(name: str) -> dict[str, Any]:
        return dict(schemas[name]["properties"])

    assert "lab_hold_weeks" in props("LeadTimeSetting")
    assert {"lab_hold_weeks", "room_weeks", "room_start_week"} <= set(props("TimelineStep"))
    assert "lab_length_weeks" in props("CategoryTimeline")
    assert {"hold_before", "hold_after"} <= set(props("ApplyPreviewStep"))
    assert {"lab_hold_weeks", "plan_lab_hold_weeks", "room_start_week", "room_end_week"} <= set(
        props("GanttStepRow")
    )
    override = props("TemplateStepOverride")["lab_hold_weeks"]
    assert "full" in str(override)
    flags = str(props("ApplyPreviewStep")["flags"]) + str(schemas.get("StepFlag", ""))
    for flag in ("room_weeks_clamped", "lab_split_rederived", "partial_room_length_applied"):
        assert flag in str(schemas) or flag in flags
