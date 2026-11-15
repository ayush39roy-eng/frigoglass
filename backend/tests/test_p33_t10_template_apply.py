"""P33-T10: `POST /workflow-templates/apply-preview` (contract E2) and `POST
/workflow-templates/apply` (E3); DOMAIN_RULES "Category templates" §C; ADR
0046 owner ruling OR-4 > R33-10 / R33-11 / R33-12; I31, I32.

Small worlds on the shared savepoint-isolated DB (CURRENT_WEEK 31), PDD
hub, category B unless stated. The seeded B template:

    A1 B0 C0 D1 E4 F0 G0 H6 I0 J1 K2 L1 M1 N1
    kinds: A B C D E I J K M design; F H lab; G L N elapsed

The main change set is B: PDD-E weeks 4 -> 5 (design length), PDD-H gap
0 -> 2 (lab gap), PDD-L weeks 1 -> 3 (elapsed length). A design figure 4
splits A1 E2 K1 over B's weights (A1 D1 E4 J1 K2 M1).

The lock-wait race (a stage PATCH / check-in waits on an apply's row lock
and vice versa) needs committed data and two connections; it is in
`tests/test_p33_t10_apply_race.py`.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Iterator
from decimal import Decimal
from types import SimpleNamespace
from typing import Any

import pytest
from httpx import Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.main import app
from api.routers import workflow_templates as wt_router
from models.audit import AuditLogEntry
from models.category import Category
from models.checkin import ScheduleRunFollowUp
from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    ScheduleRunStatus,
    WorkflowStepStatus,
)
from models.project import Project
from models.schedule import ScheduleRun
from models.workflow import ProjectWorkflowStep, TemplateChange, WorkflowLeadTime
from services import priority_move
from services.rate_limit import TokenBucketLimiter
from services.workflow_durations import live_step_effective_weeks, own_effort_kinds
from tests.auth_helpers import clear_current_principal_override
from tests.factories import make_engineer, make_hub, make_schedule_run
from tests.p12_helpers import act_as, client_for, set_progress, stepped_project
from workers.schedule_tasks import run_greedy_schedule

APPLY = "/workflow-templates/apply"
PREVIEW = "/workflow-templates/apply-preview"

MAIN_STEPS = [
    {"step_id": "PDD-E", "weeks": 5},
    {"step_id": "PDD-H", "gap_weeks": 2},
    {"step_id": "PDD-L", "weeks": 3},
]
KINDS = {
    **{f"PDD-{c}": "design" for c in "ABCDEIJKM"},
    "PDD-F": "lab", "PDD-H": "lab",
    **{f"PDD-{c}": "elapsed" for c in "GLN"},
}  # fmt: skip
FINANCIAL_SECRET = "ACME Secret Customer 4711"


@pytest.fixture(autouse=True)
def _cleanup() -> Iterator[None]:
    for limiter in (wt_router.APPLY_RATE_LIMIT, wt_router.APPLY_PREVIEW_RATE_LIMIT):
        limiter.reset()
    yield
    for limiter in (wt_router.APPLY_RATE_LIMIT, wt_router.APPLY_PREVIEW_RATE_LIMIT):
        limiter.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


@pytest.fixture
def dispatch(monkeypatch: pytest.MonkeyPatch) -> SimpleNamespace:
    """Records `run_greedy_schedule.delay` calls (RPD_GREEDY_INLINE=false in
    tests) and SSE publishes."""

    calls: list[tuple[tuple[Any, ...], dict[str, Any]]] = []

    def _fake_delay(*args: Any, **kwargs: Any) -> SimpleNamespace:
        calls.append((args, kwargs))
        return SimpleNamespace(id=f"celery-task-{len(calls)}")

    monkeypatch.setattr(run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(priority_move, "publish_progress", lambda *a, **k: None)
    return SimpleNamespace(calls=calls)


def _change(
    steps: list[dict[str, Any]], *, category: str = "B", version: int = 1
) -> dict[str, Any]:
    return {"workflow_id": "PDD", "category": category, "base_version": version, "steps": steps}


def _apply_body(
    steps: list[dict[str, Any]] | None = None,
    *,
    mode: str = "none",
    ids: list[uuid.UUID] | None = None,
    version: int = 1,
    reason: str | None = None,
) -> dict[str, Any]:
    body: dict[str, Any] = {
        "changes": [_change(steps or MAIN_STEPS, version=version)],
        "selection": {"mode": mode, "project_ids": [str(i) for i in ids or []]},
    }
    if reason is not None:
        body["reason"] = reason
    return body


async def _world(db: AsyncSession) -> SimpleNamespace:
    greece = await make_hub(db, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    lead = await make_engineer(
        db, greece, name="Lead",
        allowed_categories=[EngineerAllowedCategory(c) for c in ("A+", "A", "B", "C")],
    )  # fmt: skip
    return SimpleNamespace(hub=greece, lead=lead)


async def _project(db: AsyncSession, w: SimpleNamespace, name: str, **kw: Any) -> Project:
    kw.setdefault("category", ProjectCategory.B)
    kw.setdefault("status", ProjectStatus.IN_QUEUE)
    return await stepped_project(db, w.hub, name=name, leader=w.lead, **kw)


async def _figure(db: AsyncSession, project: Project, **figures: Any) -> None:
    """A client effort figure through the PATCH (R2 split, R6)."""

    await act_as(db, RoleName.ADMIN)
    async with client_for(db) as client:
        resp = await client.patch(f"/projects/{project.id}", json=figures)
        assert resp.status_code == 200, resp.text


async def _rows(db: AsyncSession, project: Project) -> dict[str, ProjectWorkflowStep]:
    rows = (
        await db.execute(
            select(ProjectWorkflowStep)
            .execution_options(populate_existing=True)
            .where(ProjectWorkflowStep.project_id == project.id)
        )
    ).scalars()
    return {r.step_template_id: r for r in rows}


def _snapshot(rows: dict[str, ProjectWorkflowStep]) -> dict[str, tuple[Any, ...]]:
    """Every field an apply must never touch (effort, progress, timing)."""

    return {
        sid: (
            r.effort_weeks, r.status, r.percent_complete, r.actual_start_week, r.actual_end_week,
            r.remaining_weeks_override, r.blocked_reason, r.duration_weeks,
            r.duration_override_weeks, r.start_not_before_week, r.overlap_weeks,
        )
        for sid, r in rows.items()
    }  # fmt: skip


def _copies(rows: dict[str, ProjectWorkflowStep]) -> dict[str, tuple[int, int]]:
    return {sid: (r.plan_weeks, r.plan_gap_weeks) for sid, r in rows.items()}


def _eff(project: Project, rows: dict[str, ProjectWorkflowStep]) -> dict[str, int]:
    own = own_effort_kinds(((s, r.effort_weeks) for s, r in rows.items()), KINDS)
    return {
        sid: live_step_effective_weeks(
            plan_weeks=r.plan_weeks,
            kind=KINDS[sid],
            certification_testing_required=project.certification_testing_required,
            own_effort=KINDS[sid] in own,
            effort_weeks=r.effort_weeks,
        )
        for sid, r in rows.items()
    }


async def _template(db: AsyncSession, step_id: str, category: str = "B") -> tuple[int, int, int]:
    row = (
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
    return row.weeks, row.gap_weeks, row.effort_weight_weeks


async def _audits(db: AsyncSession, action: str) -> list[AuditLogEntry]:
    return list(
        (
            await db.execute(
                select(AuditLogEntry)
                .where(AuditLogEntry.action == action)
                .order_by(AuditLogEntry.entity_id)
            )
        ).scalars()
    )


async def _post(
    db: AsyncSession, path: str, body: dict[str, Any], role: RoleName = RoleName.ADMIN
) -> Response:
    await act_as(db, role)
    async with client_for(db) as client:
        return await client.post(path, json=body)


def _by_name(items: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {i["name"]: i for i in items}


async def _stage_world(db: AsyncSession) -> SimpleNamespace:
    """One project per row of DOMAIN_RULES §C."""

    w = await _world(db)
    w.auto = await _project(db, w, "01 Auto In Queue")
    w.held = await _project(db, w, "02 On Hold", status=ProjectStatus.ON_HOLD)
    w.draft = await _project(db, w, "03 Draft", status=ProjectStatus.DRAFT)
    w.frozen = await _project(
        db, w, "04 Frozen", status=ProjectStatus.IN_DEVELOPMENT, frozen=True,
        actual_start_week=20,
    )  # fmt: skip
    w.cancelled = await _project(db, w, "05 Cancelled", status=ProjectStatus.CANCELLED)
    w.commercialized = await _project(
        db, w, "06 Commercialized", status=ProjectStatus.COMMERCIALIZED
    )
    # E In Progress: E reached (and A, D behind it); H and L choosable.
    w.e_started = await _project(db, w, "07 E In Progress", status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(db, w.e_started, "PDD-A", WorkflowStepStatus.DONE, percent=100, start=20,
                       end=20)  # fmt: skip
    await set_progress(db, w.e_started, "PDD-D", WorkflowStepStatus.DONE, percent=100, start=21,
                       end=21)  # fmt: skip
    await set_progress(db, w.e_started, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=50,
                       start=28)  # fmt: skip
    # H Blocked: E, H reached; L choosable.
    w.h_blocked = await _project(db, w, "08 H Blocked", status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(db, w.h_blocked, "PDD-E", WorkflowStepStatus.DONE, percent=100, start=22,
                       end=25)  # fmt: skip
    await set_progress(db, w.h_blocked, "PDD-H", WorkflowStepStatus.BLOCKED, percent=20,
                       start=28, reason="waiting for a part")  # fmt: skip
    # L Done (and everything before it): every changed step reached.
    w.l_done = await _project(db, w, "09 L Done", status=ProjectStatus.UNDER_INDUSTRIALIZATION)
    await set_progress(db, w.l_done, "PDD-L", WorkflowStepStatus.DONE, percent=100, start=29,
                       end=30)  # fmt: skip
    return w


# --- E2: every row of DOMAIN_RULES §C ---------------------------------------------------------


async def test_preview_classifies_every_stage_rule_row(db_session: AsyncSession) -> None:
    await _stage_world(db_session)
    resp = await _post(db_session, PREVIEW, {"changes": [_change(MAIN_STEPS)]})
    assert resp.status_code == 200, resp.text
    body = resp.json()

    assert body["counts"] == {"automatic": 3, "choosable": 2, "own_effort": 0, "never": 6}
    auto = _by_name(body["automatic"])
    assert list(auto) == ["01 Auto In Queue", "02 On Hold", "03 Draft"]  # by name
    assert auto["01 Auto In Queue"]["steps"] == [
        {"step_id": "PDD-E", "eff_before": 4, "eff_after": 5, "gap_before": 0, "gap_after": 0,
         "flags": []},
        {"step_id": "PDD-H", "eff_before": 6, "eff_after": 6, "gap_before": 0, "gap_after": 2,
         "flags": []},
        {"step_id": "PDD-L", "eff_before": 1, "eff_after": 3, "gap_before": 0, "gap_after": 0,
         "flags": []},
    ]  # fmt: skip
    assert auto["02 On Hold"]["status"] == "On Hold"
    assert auto["01 Auto In Queue"]["hub"] == "R&D-Greece"

    choosable = _by_name(body["choosable"])
    assert list(choosable) == ["07 E In Progress", "08 H Blocked"]
    e_started = choosable["07 E In Progress"]
    assert [s["step_id"] for s in e_started["steps"]] == ["PDD-H", "PDD-L"]
    assert e_started["current_stage"] == {
        "step_id": "PDD-E",
        "name": "Design Detailing",
        "status": "In Progress",
    }
    h_blocked = choosable["08 H Blocked"]
    assert [s["step_id"] for s in h_blocked["steps"]] == ["PDD-L"]
    assert h_blocked["current_stage"]["status"] == "Blocked"

    never = {(n["name"], n["reason"]): n["step_ids"] for n in body["never"]}
    assert never == {
        ("04 Frozen", "frozen"): ["PDD-E", "PDD-H", "PDD-L"],
        ("05 Cancelled", "cancelled"): ["PDD-E", "PDD-H", "PDD-L"],
        ("06 Commercialized", "commercialized"): ["PDD-E", "PDD-H", "PDD-L"],
        ("07 E In Progress", "reached_stage"): ["PDD-E"],
        ("08 H Blocked", "reached_stage"): ["PDD-E", "PDD-H"],
        # L Done: L and every predecessor of it (E, H) are reached.
        ("09 L Done", "reached_stage"): ["PDD-E", "PDD-H", "PDD-L"],
    }
    # Previews write nothing.
    assert await _template(db_session, "PDD-E") == (4, 0, 4)
    assert (await db_session.execute(select(TemplateChange))).scalars().all() == []
    # Never served: financial fields, engineer names.
    text = json.dumps(body)
    for forbidden in ("customer", "tcogs", "selling_price", "gross_margin", "Lead"):
        assert forbidden not in text


async def test_not_started_step_behind_a_started_successor_is_reached(
    db_session: AsyncSession,
) -> None:
    """R33-10's successor clause, on stored statuses: under B, PDD-B is 0
    (skipped, stored Not Started). On a project whose D is In Progress, B is
    reached through its started successor, so reviving it (0 -> 2) is never
    applied there, while a fresh project gets it (flag `revived`)."""

    w = await _world(db_session)
    fresh = await _project(db_session, w, "Fresh")
    started = await _project(db_session, w, "D started", status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(db_session, started, "PDD-A", WorkflowStepStatus.DONE, percent=100,
                       start=25, end=25)  # fmt: skip
    await set_progress(db_session, started, "PDD-D", WorkflowStepStatus.IN_PROGRESS, percent=10,
                       start=30)  # fmt: skip
    resp = await _post(
        db_session, PREVIEW, {"changes": [_change([{"step_id": "PDD-B", "weeks": 2}])]}
    )
    body = resp.json()
    assert [p["name"] for p in body["automatic"]] == ["Fresh"]
    assert body["automatic"][0]["steps"] == [
        {"step_id": "PDD-B", "eff_before": 0, "eff_after": 2, "gap_before": 0, "gap_after": 0,
         "flags": ["revived"]},
    ]  # fmt: skip
    assert body["choosable"] == []
    assert body["never"] == [{"project_id": str(started.id), "name": "D started",
                              "hub": "R&D-Greece", "reason": "reached_stage",
                              "step_ids": ["PDD-B"]}]  # fmt: skip

    resp = await _post(
        db_session, APPLY, _apply_body([{"step_id": "PDD-B", "weeks": 2}], mode="all_not_reached")
    )
    assert resp.status_code == 200, resp.text
    assert (await _rows(db_session, fresh))["PDD-B"].plan_weeks == 2
    assert (await _rows(db_session, started))["PDD-B"].plan_weeks == 0


# --- E3: selection modes, writes (I31/I32), audit ---------------------------------------------


@pytest.mark.parametrize("mode", ["none", "selected", "all_not_reached"])
async def test_apply_by_selection_mode(
    db_session: AsyncSession, dispatch: SimpleNamespace, mode: str
) -> None:
    w = await _stage_world(db_session)
    other_choosable = w.h_blocked
    before = {
        p.id: (_snapshot(await _rows(db_session, p)), _copies(await _rows(db_session, p)))
        for p in (w.auto, w.held, w.draft, w.frozen, w.cancelled, w.commercialized,
                  w.e_started, w.h_blocked, w.l_done)
    }  # fmt: skip
    ids = [w.e_started.id] if mode == "selected" else None
    resp = await _post(db_session, APPLY, _apply_body(mode=mode, ids=ids, reason="Owner ask"))
    assert resp.status_code == 200, resp.text
    out = resp.json()

    receivers = {w.auto.id, w.held.id, w.draft.id}
    if mode == "selected":
        receivers.add(w.e_started.id)
    if mode == "all_not_reached":
        receivers |= {w.e_started.id, other_choosable.id}
    assert out["applied"] == {
        "automatic": 3,
        "selected": {"none": 0, "selected": 1, "all_not_reached": 2}[mode],
        "own_effort_not_applied": 0,
    }
    assert out["not_applied"] == []
    assert out["versions"] == [{"workflow_id": "PDD", "category": "B", "template_version": 2}]

    # The template (weights untouched) and its version.
    assert await _template(db_session, "PDD-E") == (5, 0, 4)
    assert await _template(db_session, "PDD-H") == (6, 2, 6)
    assert await _template(db_session, "PDD-L") == (3, 0, 1)
    category = (
        await db_session.execute(
            select(Category).where(Category.code == "B").execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert category.template_version == 2

    change = (await db_session.execute(select(TemplateChange))).scalar_one()
    assert str(change.id) == out["template_change_id"]
    assert change.reason == "Owner ask"
    assert change.selection == {"mode": mode, "project_ids": [str(i) for i in ids or []]}
    assert change.changes == [{
        "workflow_id": "PDD", "category": "B", "template_version": [1, 2],
        "steps": [{"step_id": "PDD-E", "weeks": [4, 5]}, {"step_id": "PDD-H", "gap_weeks": [0, 2]},
                  {"step_id": "PDD-L", "weeks": [1, 3]}],
    }]  # fmt: skip

    for project in (w.auto, w.held, w.draft, w.frozen, w.cancelled, w.commercialized,
                     w.e_started, w.h_blocked, w.l_done):  # fmt: skip
        rows = await _rows(db_session, project)
        snap_before, copies_before = before[project.id]
        # I31 (iii): no effort, progress or timing field written, ever.
        assert _snapshot(rows) == snap_before, project.name
        copies = _copies(rows)
        if project.id not in receivers:
            assert copies == copies_before, project.name
            assert all(r.template_change_id is None for r in rows.values())
            continue
        reached = {
            w.e_started.id: {"PDD-E"}, w.h_blocked.id: {"PDD-E", "PDD-H"},
        }.get(project.id, set())  # fmt: skip
        expected = dict(copies_before)
        for sid, new in (("PDD-E", (5, 0)), ("PDD-H", (6, 2)), ("PDD-L", (3, 0))):
            if sid not in reached:
                expected[sid] = new  # I31 (ii), I32 (i): the template's new value
        assert copies == expected, project.name
        for sid, r in rows.items():
            written = expected[sid] != copies_before[sid]
            assert (r.template_change_id is not None) == written, (project.name, sid)
        # I32 (ii): no own effort here, so eff = plan_weeks (lab: cert on).
        assert _eff(project, rows) == {sid: r.plan_weeks for sid, r in rows.items()}

    # Audit: one project.template_applied per changed project, naming the
    # change, with before/after per written field; one summary row.
    per_project = await _audits(db_session, "project.template_applied")
    assert {a.entity_id for a in per_project} == {str(i) for i in receivers}
    auto_audit = next(a for a in per_project if a.entity_id == str(w.auto.id))
    assert auto_audit.after_state is not None
    assert auto_audit.before_state == {"steps": {
        "PDD-E": {"plan_weeks": 4}, "PDD-H": {"plan_gap_weeks": 0}, "PDD-L": {"plan_weeks": 1},
    }}  # fmt: skip
    assert auto_audit.after_state["steps"] == {
        "PDD-E": {"plan_weeks": 5}, "PDD-H": {"plan_gap_weeks": 2}, "PDD-L": {"plan_weeks": 3},
    }  # fmt: skip
    assert auto_audit.after_state["template_change_id"] == out["template_change_id"]
    assert auto_audit.after_state["received_as"] == "automatic"
    (summary,) = await _audits(db_session, "workflow_template.applied")
    s = summary.after_state
    assert s is not None
    assert s["template_change_id"] == out["template_change_id"]
    assert s["selection_mode"] == mode
    assert set(s["automatic"]) == {str(w.auto.id), str(w.held.id), str(w.draft.id)}
    assert set(s["selected"]) == {str(i) for i in receivers} - set(s["automatic"])
    assert s["own_effort"] == [] and s["not_applied"] == []
    assert {(n["project_id"], n["reason"]) for n in s["never"]} == {
        (str(w.frozen.id), "frozen"), (str(w.cancelled.id), "cancelled"),
        (str(w.commercialized.id), "commercialized"), (str(w.e_started.id), "reached_stage"),
        (str(w.h_blocked.id), "reached_stage"), (str(w.l_done.id), "reached_stage"),
    }  # fmt: skip
    assert s["reason_length"] == len("Owner ask")

    # Stale on the changed projects only; exactly one run (I24).
    stale = dict(
        (await db_session.execute(
            select(Project.id, Project.schedule_stale).execution_options(populate_existing=True)
        )).all()
    )  # fmt: skip
    assert {pid for pid, flag in stale.items() if flag} == receivers
    assert out["recalc_status"] == "queued" and len(dispatch.calls) == 1
    runs = (await db_session.execute(select(ScheduleRun))).scalars().all()
    assert [(r.trigger_reason, str(r.id)) for r in runs] == [
        ("template_apply", out["schedule_run_id"])
    ]
    assert out["task_id"] == "celery-task-1"


async def test_selected_project_that_reached_the_stage_is_not_applied(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    """The race summary: ticked from a preview, the project then reaches the
    only changed step before the apply evaluates it (under the lock): it is
    reported in `not_applied`, not an error, and nothing is written to it."""

    w = await _world(db_session)
    project = await _project(db_session, w, "Started", status=ProjectStatus.IN_DEVELOPMENT)
    await set_progress(db_session, project, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=40,
                       start=29)  # fmt: skip
    gap_only = [{"step_id": "PDD-H", "gap_weeks": 2}]
    preview = await _post(db_session, PREVIEW, {"changes": [_change(gap_only)]})
    assert [p["name"] for p in preview.json()["choosable"]] == ["Started"]
    # Meanwhile H starts.
    await set_progress(db_session, project, "PDD-H", WorkflowStepStatus.IN_PROGRESS, percent=5,
                       start=31)  # fmt: skip
    copies = _copies(await _rows(db_session, project))
    resp = await _post(db_session, APPLY, _apply_body(gap_only, mode="selected", ids=[project.id]))
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["not_applied"] == [{"project_id": str(project.id), "reason": "reached_stage"}]
    assert out["applied"] == {"automatic": 0, "selected": 0, "own_effort_not_applied": 0}
    assert out["recalc_status"] == "not_needed" and dispatch.calls == []
    assert _copies(await _rows(db_session, project)) == copies
    (summary,) = await _audits(db_session, "workflow_template.applied")
    assert summary.after_state is not None
    assert summary.after_state["not_applied"] == [
        {"project_id": str(project.id), "reason": "reached_stage"}
    ]


async def test_selected_project_not_choosable_and_bad_ids(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _stage_world(db_session)
    other = await stepped_project(
        db_session, w.hub, name="Category A", leader=w.lead, category=ProjectCategory.A
    )
    resp = await _post(
        db_session, APPLY, _apply_body(mode="selected", ids=[w.frozen.id, other.id, w.auto.id])
    )
    assert resp.status_code == 200, resp.text
    assert sorted(resp.json()["not_applied"], key=lambda n: n["project_id"]) == sorted(
        [{"project_id": str(w.frozen.id), "reason": "not_choosable"},
         {"project_id": str(other.id), "reason": "not_choosable"}],
        key=lambda n: n["project_id"],
    )  # fmt: skip
    # An automatic project ticked is simply applied (automatic whatever the mode).
    assert resp.json()["applied"]["automatic"] == 3

    bogus = uuid.uuid4()
    resp = await _post(db_session, APPLY, _apply_body(mode="selected", ids=[bogus], version=2))
    assert resp.status_code == 422 and resp.json()["code"] == "BAD_PROJECT"


async def test_selected_out_of_scope_id_is_bad_project(db_session: AsyncSession) -> None:
    """Hub scoping: an id outside the caller's hubs reads exactly like a
    missing one (a hub-scoped Admin is unusual, but the rule is server-side)."""

    w = await _stage_world(db_session)
    india = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await act_as(db_session, RoleName.ADMIN, hub_ids=[india.id])
    async with client_for(db_session) as client:
        resp = await client.post(APPLY, json=_apply_body(mode="selected", ids=[w.e_started.id]))
        preview = await client.post(PREVIEW, json={"changes": [_change(MAIN_STEPS)]})
    assert resp.status_code == 422 and resp.json()["code"] == "BAD_PROJECT"
    assert preview.json()["counts"] == {"automatic": 0, "choosable": 0, "own_effort": 0,
                                        "never": 0}  # fmt: skip


@pytest.mark.parametrize(
    "selection",
    [
        {"mode": "selected", "project_ids": []},
        {"mode": "none", "project_ids": [str(uuid.uuid4())]},
        {"mode": "all_not_reached", "project_ids": [str(uuid.uuid4())]},
        {"mode": "everything", "project_ids": []},
        {"mode": "selected", "project_ids": ["not-a-uuid"]},
    ],
)
async def test_apply_selection_validation(
    db_session: AsyncSession, selection: dict[str, Any]
) -> None:
    body = {"changes": [_change(MAIN_STEPS)], "selection": selection}
    resp = await _post(db_session, APPLY, body)
    assert resp.status_code == 422, resp.text


# --- OR-4: own effort -------------------------------------------------------------------------


async def test_own_effort_length_not_applied_gap_and_elapsed_applied(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _world(db_session)
    own = await _project(db_session, w, "Own design figure")
    await _figure(db_session, own, design_effort_weeks=4)
    plain = await _project(db_session, w, "No figure")
    own_rows_before = await _rows(db_session, own)
    effort_before = {sid: r.effort_weeks for sid, r in own_rows_before.items()}
    assert {k: v for k, v in effort_before.items() if v} == {"PDD-A": 1, "PDD-E": 2, "PDD-K": 1}

    resp = await _post(db_session, PREVIEW, {"changes": [_change(MAIN_STEPS)]})
    body = resp.json()
    auto = _by_name(body["automatic"])
    assert auto["Own design figure"]["steps"] == [
        {"step_id": "PDD-E", "eff_before": 2, "eff_after": 2, "gap_before": 0, "gap_after": 0,
         "flags": ["own_effort_length_not_applied"]},
        {"step_id": "PDD-H", "eff_before": 6, "eff_after": 6, "gap_before": 0, "gap_after": 2,
         "flags": []},
        {"step_id": "PDD-L", "eff_before": 1, "eff_after": 3, "gap_before": 0, "gap_after": 0,
         "flags": []},
    ]  # fmt: skip
    assert auto["No figure"]["steps"][0]["eff_after"] == 5

    rederived_before = len(await _audits(db_session, "project.effort_rederived"))
    resp = await _post(db_session, APPLY, _apply_body())
    assert resp.status_code == 200, resp.text
    own_rows = await _rows(db_session, own)
    # Design length not applied (OR-4); the lab gap and the elapsed length are.
    assert _copies(own_rows)["PDD-E"] == (4, 0)
    assert own_rows["PDD-E"].template_change_id is None
    assert _copies(own_rows)["PDD-H"] == (6, 2)
    assert _copies(own_rows)["PDD-L"] == (3, 0)
    # No effort written, nothing re-derived (R33-2); I32 (iii).
    assert {sid: r.effort_weeks for sid, r in own_rows.items()} == effort_before
    assert _eff(own, own_rows)["PDD-E"] == 2
    assert _copies(await _rows(db_session, plain))["PDD-E"] == (5, 0)
    assert len(await _audits(db_session, "project.effort_rederived")) == rederived_before


async def test_project_with_only_own_effort_lengths_is_listed_in_own_effort(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _world(db_session)
    own = await _project(db_session, w, "Own only", status=ProjectStatus.IN_DEVELOPMENT)
    await _figure(db_session, own, design_effort_weeks=4)
    await set_progress(db_session, own, "PDD-A", WorkflowStepStatus.IN_PROGRESS, percent=10,
                       start=30)  # fmt: skip
    plain = await _project(db_session, w, "Plain")
    steps = [{"step_id": "PDD-E", "weeks": 5}, {"step_id": "PDD-K", "weeks": 3}]
    body = (await _post(db_session, PREVIEW, {"changes": [_change(steps)]})).json()
    assert body["counts"] == {"automatic": 1, "choosable": 0, "own_effort": 1, "never": 0}
    assert body["own_effort"] == [{
        "project_id": str(own.id), "name": "Own only", "hub": "R&D-Greece",
        "status": "In Development", "step_ids": ["PDD-E", "PDD-K"], "kinds": ["design"],
        "reason": "own_effort_length_not_applied",
    }]  # fmt: skip
    copies = _copies(await _rows(db_session, own))
    out = (await _post(db_session, APPLY, _apply_body(steps, mode="all_not_reached"))).json()
    assert out["applied"] == {"automatic": 1, "selected": 0, "own_effort_not_applied": 1}
    assert _copies(await _rows(db_session, own)) == copies
    assert _copies(await _rows(db_session, plain))["PDD-K"] == (3, 0)
    assert {a.entity_id for a in await _audits(db_session, "project.template_applied")} == {
        str(plain.id)
    }


async def test_r33_12_apply_on_a_started_project_writes_no_effort(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    """R33-12: E In Progress, an apply changing K writes no `effort_weeks`
    (own-effort project: K not applied; plain project: K's copy changes,
    its effort stays null)."""

    w = await _world(db_session)
    own = await _project(db_session, w, "Own, E started", status=ProjectStatus.IN_DEVELOPMENT)
    await _figure(db_session, own, design_effort_weeks=4)
    plain = await _project(db_session, w, "Plain, E started", status=ProjectStatus.IN_DEVELOPMENT)
    for p in (own, plain):
        await set_progress(db_session, p, "PDD-E", WorkflowStepStatus.IN_PROGRESS, percent=50,
                           start=28)  # fmt: skip
    effort = {p.id: {s: r.effort_weeks for s, r in (await _rows(db_session, p)).items()}
              for p in (own, plain)}  # fmt: skip
    out = (
        await _post(
            db_session,
            APPLY,
            _apply_body([{"step_id": "PDD-K", "weeks": 3}], mode="all_not_reached"),
        )
    ).json()
    assert out["applied"]["selected"] == 1 and out["applied"]["own_effort_not_applied"] == 1
    for p in (own, plain):
        assert {s: r.effort_weeks for s, r in (await _rows(db_session, p)).items()} == effort[p.id]
    assert (await _rows(db_session, plain))["PDD-K"].plan_weeks == 3
    assert (await _rows(db_session, own))["PDD-K"].plan_weeks == 2


# --- R33-11 flags -----------------------------------------------------------------------------


async def test_step_flags(db_session: AsyncSession, dispatch: SimpleNamespace) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "Plain")
    await _project(db_session, w, "Cert off", certification_testing_required=False)
    body = (
        await _post(
            db_session,
            PREVIEW,
            {"changes": [_change([
                {"step_id": "PDD-E", "weeks": 0},  # skipped_now (+ its gap ignored)
                {"step_id": "PDD-B", "weeks": 2},  # revived
                {"step_id": "PDD-C", "gap_weeks": 1},  # gap on a skipped step
                {"step_id": "PDD-H", "weeks": 7},  # lab length; cert off -> no effect
            ])]},
        )
    ).json()  # fmt: skip
    steps = {p["name"]: {s["step_id"]: s for s in p["steps"]} for p in body["automatic"]}
    p = steps["Plain"]
    assert p["PDD-E"]["flags"] == ["skipped_now"] and (p["PDD-E"]["eff_after"] == 0)
    assert p["PDD-B"]["flags"] == ["revived"] and p["PDD-B"]["eff_after"] == 2
    assert p["PDD-C"]["flags"] == ["gap_ignored_skipped"]
    assert (p["PDD-C"]["gap_before"], p["PDD-C"]["gap_after"]) == (0, 1)
    assert p["PDD-H"]["flags"] == [] and (p["PDD-H"]["eff_before"], p["PDD-H"]["eff_after"]) == (
        6,
        7,
    )
    c = steps["Cert off"]
    assert c["PDD-H"]["flags"] == ["cert_off_no_effect"]
    assert (c["PDD-H"]["eff_before"], c["PDD-H"]["eff_after"]) == (0, 0)


# --- 409 / versions / dispatch lifecycle ------------------------------------------------------


async def test_stale_base_version_is_409_with_current_versions(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "P")
    first = await _post(db_session, APPLY, _apply_body())
    assert first.status_code == 200
    for path, body in (
        (APPLY, _apply_body([{"step_id": "PDD-E", "weeks": 6}])),
        (PREVIEW, {"changes": [_change([{"step_id": "PDD-E", "weeks": 6}])]}),
    ):
        resp = await _post(db_session, path, body)
        assert resp.status_code == 409, resp.text
        assert resp.json()["code"] == "TEMPLATE_CHANGED"
        assert resp.json()["detail"]["versions"] == [
            {"workflow_id": "PDD", "category": "B", "template_version": 2}
        ]
    # The template is the first apply's.
    assert await _template(db_session, "PDD-E") == (5, 0, 4)
    resp = await _post(
        db_session, APPLY, _apply_body([{"step_id": "PDD-E", "weeks": 6}], version=2)
    )
    assert resp.status_code == 200
    assert resp.json()["versions"][0]["template_version"] == 3


async def test_deferred_with_one_coalesced_follow_up_when_a_run_is_in_flight(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _world(db_session)
    await _project(db_session, w, "P")
    await make_schedule_run(db_session, status=ScheduleRunStatus.RUNNING)
    runs_before = len((await db_session.execute(select(ScheduleRun))).scalars().all())
    out = (await _post(db_session, APPLY, _apply_body())).json()
    assert out["recalc_status"] == "deferred"
    assert out["schedule_run_id"] is None and out["task_id"] is None
    assert dispatch.calls == []
    assert len((await db_session.execute(select(ScheduleRun))).scalars().all()) == runs_before
    follow_up = (
        await db_session.execute(
            select(ScheduleRunFollowUp).execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert follow_up.pending is True and follow_up.last_trigger_reason == "template_apply"


async def test_not_needed_when_only_non_schedulable_projects_change(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _world(db_session)
    held = await _project(db_session, w, "Held", status=ProjectStatus.ON_HOLD)
    out = (await _post(db_session, APPLY, _apply_body())).json()
    assert out["recalc_status"] == "not_needed" and dispatch.calls == []
    assert out["applied"]["automatic"] == 1
    # The copy is written and demand moves at commit; the project is stale.
    assert _copies(await _rows(db_session, held))["PDD-E"] == (5, 0)
    await db_session.refresh(held)
    assert held.schedule_stale is True


async def test_no_project_at_all_writes_template_and_summary_only(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    out = (await _post(db_session, APPLY, _apply_body())).json()
    assert out["recalc_status"] == "not_needed"
    assert out["applied"] == {"automatic": 0, "selected": 0, "own_effort_not_applied": 0}
    assert len(await _audits(db_session, "workflow_template.applied")) == 1
    assert await _audits(db_session, "project.template_applied") == []


# --- validation, RBAC, rate limit, no financial field ------------------------------------------


@pytest.mark.parametrize(
    "steps,code",
    [
        ([{"step_id": "PDD-E", "weeks": 4}], "NO_CHANGE"),
        ([{"step_id": "PDD-E", "weeks": 4, "gap_weeks": 0}], "NO_CHANGE"),
        ([{"step_id": "PDD-A", "gap_weeks": -1}], "FIRST_STEP_GAP"),
        ([{"step_id": "OEM-E", "weeks": 1}], "BAD_STEP"),
        ([{"step_id": "PDD-E", "weeks": 5}, {"step_id": "PDD-E", "gap_weeks": 1}], "BAD_STEP"),
    ],
)
async def test_change_set_validation_codes(
    db_session: AsyncSession, steps: list[dict[str, Any]], code: Any
) -> None:
    for path in (PREVIEW, APPLY):
        body = _apply_body(steps) if path == APPLY else {"changes": [_change(steps)]}
        resp = await _post(db_session, path, body)
        assert resp.status_code == 422, resp.text
        assert resp.json()["code"] == code


async def test_change_set_shape_validation(db_session: AsyncSession) -> None:
    dup = {"changes": [_change(MAIN_STEPS), _change(MAIN_STEPS)]}
    too_many = {"changes": [_change(MAIN_STEPS, category=c) for c in ["B"] * 21]}
    wrong_wf = {"changes": [{**_change(MAIN_STEPS), "category": "B-OEM"}]}
    empty_steps = {"changes": [_change([])]}
    bodies: list[dict[str, Any]] = [dup, too_many, wrong_wf, empty_steps, {"changes": []}]
    for body in bodies:
        resp = await _post(db_session, PREVIEW, body)
        assert resp.status_code == 422, (body, resp.text)


@pytest.mark.parametrize(
    "role,code",
    [
        (RoleName.ADMIN, 200),
        (RoleName.SUPER_ADMIN, 200),
        (RoleName.PORTFOLIO_MANAGER, 403),
        (RoleName.HUB_PLANNER, 403),
        (RoleName.ENGINEER, 403),
        (RoleName.EXECUTIVE_VIEWER, 403),
        (RoleName.AUDITOR, 403),
    ],
)
async def test_apply_and_preview_rbac(
    db_session: AsyncSession, dispatch: SimpleNamespace, role: RoleName, code: Any
) -> None:
    preview = await _post(db_session, PREVIEW, {"changes": [_change(MAIN_STEPS)]}, role)
    apply = await _post(db_session, APPLY, _apply_body(), role)
    assert preview.status_code == code, preview.text
    assert apply.status_code == code, apply.text
    if code == 403:
        assert await _template(db_session, "PDD-E") == (4, 0, 4)


async def test_apply_is_rate_limited(
    db_session: AsyncSession, dispatch: SimpleNamespace, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        wt_router, "APPLY_RATE_LIMIT", TokenBucketLimiter(capacity=1, refill_per_second=1e-6)
    )
    await act_as(db_session, RoleName.ADMIN)
    async with client_for(db_session) as client:
        first = await client.post(APPLY, json=_apply_body())
        second = await client.post(APPLY, json=_apply_body(version=2))
    assert first.status_code == 200
    assert second.status_code == 429 and second.json()["code"] == "RATE_LIMITED"
    assert "Retry-After" in second.headers
    assert await _template(db_session, "PDD-E") == (5, 0, 4)


async def test_no_financial_field_in_responses_or_audit(
    db_session: AsyncSession, dispatch: SimpleNamespace
) -> None:
    w = await _world(db_session)
    project = await _project(
        db_session, w, "Secretive", customer_name=FINANCIAL_SECRET,
        tcogs_eur=Decimal("123.45"), selling_price_eur=Decimal("999.99"),
        gross_margin_pct=Decimal("42.42"),
    )  # fmt: skip
    started = await _project(db_session, w, "Started", status=ProjectStatus.IN_DEVELOPMENT,
                             customer_name=FINANCIAL_SECRET)  # fmt: skip
    await set_progress(db_session, started, "PDD-A", WorkflowStepStatus.IN_PROGRESS, percent=5,
                       start=30)  # fmt: skip
    preview = await _post(db_session, PREVIEW, {"changes": [_change(MAIN_STEPS)]})
    apply = await _post(db_session, APPLY, _apply_body(mode="all_not_reached"))
    assert project.id and apply.status_code == 200
    audits = (await db_session.execute(select(AuditLogEntry))).scalars().all()
    blob = json.dumps(
        [preview.json(), apply.json()]
        + [[a.before_state, a.after_state] for a in audits
           if a.action in {"workflow_template.applied", "project.template_applied"}],
        default=str,
    )  # fmt: skip
    for secret in (FINANCIAL_SECRET, "123.45", "999.99", "42.42", "tcogs", "selling_price",
                   "gross_margin", "customer"):  # fmt: skip
        assert secret not in blob
