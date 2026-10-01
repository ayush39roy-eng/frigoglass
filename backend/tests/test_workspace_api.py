"""P9-T03: Project Workspace (docs/API_CONTRACT_P9.md §7; DOMAIN_RULES
"Per-stage progress capture"; ADR 0006; I12, I13).

Read model (stages from live rows + active run, health badge from the run
only, duration-weighted progress), stage PATCH consistency rules with 422
field errors, `schedule_stale` + audit on every edit, hub scoping and
Engineer own-assignment scoping (negative tests), OQ#8 name withholding,
financial-field withholding for roles without Registration READ, comments
(15-minute author lock, soft delete, sanitised Markdown), the activity feed,
and the recalculate dispatch. Files (MinIO) live in
`tests/test_workspace_files.py`.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select, update

import api.routers.workspace as workspace_router
from api.db import get_db
from api.main import app
from models.audit import AuditLogEntry
from models.enums import (
    HubName,
    LabRegion,
    NotificationReason,
    RoleName,
    ScheduleRunStatus,
    SolverType,
    WorkflowStepStatus,
)
from models.notification import Notification
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep
from models.workspace import ProjectComment
from services.project_steps import sync_project_steps
from services.workspace import (
    event_summary,
    health_badge,
    project_progress_pct,
    stage_overrun,
)
from tests.auth_helpers import (
    clear_current_principal_override,
    make_principal,
    override_current_principal,
)
from tests.factories import (
    make_engineer,
    make_hub,
    make_priority_score,
    make_project,
    make_schedule_run,
    make_user,
)

PDD_A_DURATIONS = [1, 4, 4, 1, 6, 4, 2, 6, 2, 1, 2, 3, 1, 1]  # PDD / category A


@pytest.fixture(autouse=True)
def _cleanup():
    workspace_router.COMMENT_RATE_LIMIT.reset()
    yield
    workspace_router.COMMENT_RATE_LIMIT.reset()
    clear_current_principal_override()
    app.dependency_overrides.pop(get_db, None)


def _client(db_session) -> AsyncClient:
    async def _override_get_db():
        yield db_session

    app.dependency_overrides[get_db] = _override_get_db
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def _act_as(db_session, *roles, hub_ids=None, full_name="Test User"):
    engineer_only = roles == (RoleName.ENGINEER,)
    scoped = hub_ids is not None or engineer_only
    user = await make_user(
        db_session, *roles, full_name=full_name, hub_scope_all=not scoped, hub_ids=hub_ids or []
    )
    principal = make_principal(
        *roles, user_id=user.id, email=user.email, hub_scope_all=not scoped,
        hub_ids=hub_ids or [],
    )
    principal = type(principal)(**{**principal.__dict__, "full_name": full_name})
    override_current_principal(principal)
    return user


async def _world(db_session, *, stale=False, with_run=True, outcome_kwargs=None):
    """A PDD project (category A, 14 stage rows) in R&D-Greece, a leader, and
    optionally an active run with one row per step (each step booked for its
    lead-time duration starting week 31, in sequence).
    """

    hub = await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)
    leader_user = await make_user(db_session, RoleName.ENGINEER, full_name="Lena Leader",
                                  hub_scope_all=False)
    leader = await make_engineer(db_session, hub, name="Lena Leader")
    leader.user_id = leader_user.id
    project = await make_project(
        db_session, hub, leader=leader, name="Workspace P", schedule_stale=stale,
        customer_name="Secret Customer", tcogs_eur=123.45,
    )
    await sync_project_steps(db_session, project, False)
    run = None
    if with_run:
        run = await make_schedule_run(db_session, is_active=True)
        week = 31
        rows = (
            await db_session.execute(
                select(ProjectWorkflowStep)
                .where(ProjectWorkflowStep.project_id == project.id)
                .order_by(ProjectWorkflowStep.sequence_order)
            )
        ).scalars().all()
        for row in rows:
            dur = row.duration_weeks
            db_session.add(
                ScheduleRunProjectStep(
                    schedule_run_id=run.id, project_id=project.id,
                    step_template_id=row.step_template_id, sequence_order=row.sequence_order,
                    duration_weeks=dur, start_week=week, end_week=week + max(dur, 1) - 1,
                    assigned_engineer_id=leader.id if row.step_template_id == "PDD-A" else None,
                )
            )
            week += max(dur, 1)
        db_session.add(
            ScheduleRunProjectOutcome(
                schedule_run_id=run.id, project_id=project.id,
                **({"within_year": True, "last_step_end_week": 50, "delay_weeks_applied": 0,
                    "expected_end_week": 48, "projected_end_week": 50,
                    "unconstrained_end_week": 44, "progress_pct": 0} | (outcome_kwargs or {})),
            )
        )
    await db_session.flush()
    return SimpleNamespace(hub=hub, leader=leader, leader_user=leader_user, project=project,
                           run=run)


# --- Pure helpers ---------------------------------------------------------------------


def test_project_progress_pct_is_duration_weighted():
    # 100 % of a 6-week step and 0 % of a 1-week step → 86 %, not the 50 % mean.
    assert project_progress_pct([(100, 6), (0, 1)]) == 86
    assert project_progress_pct([(50, 0), (100, 0)]) is None
    assert project_progress_pct([]) is None


def test_stage_overrun_rules():
    run_step = ScheduleRunProjectStep(start_week=31, end_week=40, duration_weeks=6, skipped=False)
    assert stage_overrun(run_step, None) == 4
    live_done = ProjectWorkflowStep(status=WorkflowStepStatus.DONE, actual_end_week=33)
    assert stage_overrun(run_step, live_done) == 0
    skipped = ScheduleRunProjectStep(start_week=31, end_week=31, duration_weeks=0, skipped=True)
    assert stage_overrun(skipped, None) is None
    assert stage_overrun(None, None) is None


def test_health_badge_table():
    ok = ScheduleRunProjectOutcome(left_out=False, last_step_end_week=50, delay_weeks_applied=0)
    step = ScheduleRunProjectStep(step_template_id="PDD-A", start_week=31, end_week=31,
                                  duration_weeks=1, skipped=False)
    assert health_badge(None, [], {}, 31) == "unscheduled"
    assert health_badge(ScheduleRunProjectOutcome(left_out=True), [], {}, 31) == "left_out"
    assert health_badge(ScheduleRunProjectOutcome(left_out=False, last_step_end_week=None),
                        [], {}, 31) == "unscheduled"
    late = ScheduleRunProjectOutcome(left_out=False, last_step_end_week=50, delay_weeks_applied=3)
    assert health_badge(late, [step], {}, 31) == "off_track"
    assert health_badge(ok, [step], {}, 31) == "on_track"
    long_step = ScheduleRunProjectStep(step_template_id="PDD-E", start_week=31, end_week=38,
                                       duration_weeks=6, skipped=False)
    assert health_badge(ok, [long_step], {}, 31) == "at_risk"
    overdue = ScheduleRunProjectStep(step_template_id="PDD-A", start_week=20, end_week=20,
                                     duration_weeks=1, skipped=False)
    assert health_badge(ok, [overdue], {}, 31) == "at_risk"
    done = ProjectWorkflowStep(status=WorkflowStepStatus.DONE, actual_end_week=20)
    assert health_badge(ok, [overdue], {"PDD-A": done}, 31) == "on_track"


def test_event_summaries():
    def entry(action, before=None, after=None):
        return AuditLogEntry(action=action, before_state=before, after_state=after)

    assert event_summary(entry("project.update", {"priority": "P3"}, {"priority": "P1"})) == (
        "Priority changed P3 → P1"
    )
    assert event_summary(entry("project.update", {"customer_name": "<redacted>"},
                               {"customer_name": "<redacted>"})) == "Project details updated"
    assert event_summary(
        entry("project_stage.update", {"status": "In Progress"},
              {"step_id": "PDD-F", "status": "Done"})
    ) == "PDD-F marked Done"
    assert event_summary(
        entry("project.schedule_recalculated", {"projected_end_week": 44},
              {"projected_end_week": 49})
    ) == "Schedule recalculated — finish moved week 44 → week 49"
    assert event_summary(
        entry("project_file.upload", None, {"display_name": "cert.pdf", "version": 2})
    ) == "cert.pdf uploaded (v2)"
    assert event_summary(entry("something.else")) == "something: else"


# --- Read model -----------------------------------------------------------------------


async def test_workspace_read_model(db_session):
    w = await _world(db_session)
    await make_priority_score(db_session, w.project, dims=[3] * 13, normalized_pct=60)
    await _act_as(db_session, RoleName.PORTFOLIO_MANAGER)
    async with _client(db_session) as client:
        resp = await client.get(f"/projects/{w.project.id}/workspace")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["health"] == "on_track"
    assert body["progress_pct"] == 0
    assert body["schedule"] == {
        "has_active_run": True, "run_version": w.run.version, "expected_end_week": 48,
        "projected_end_week": 50, "unconstrained_end_week": 44, "slip_weeks": 2,
        "within_year": True, "left_out": False, "schedule_stale": False,
    }
    stages = body["stages"]
    assert [s["step_id"] for s in stages] == [f"PDD-{c}" for c in "ABCDEFGHIJKLMN"]
    assert [s["duration_weeks"] for s in stages] == PDD_A_DURATIONS
    a = stages[0]
    assert a["planned_start_week"] == 31 and a["planned_end_week"] == 31
    assert a["remaining_weeks"] == 1 and a["overrun_weeks"] == 0
    assert a["assigned_engineer_name"] is None  # OQ#8: not the caller
    assert stages[2]["kind"] == "elapsed"
    assert body["project"]["hub"] == "R&D-Greece"
    assert body["project"]["leader_engineer_name"] is None  # OQ#8
    assert body["project"]["customer_name"] == "Secret Customer"  # PM reads Registration
    assert body["priority_score"]["normalized_pct"] == 60
    assert body["files"] == [] and isinstance(body["activity"], list)


async def test_workspace_names_shown_only_to_self(db_session):
    w = await _world(db_session)
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=w.leader_user.id, hub_scope_all=False)
    )
    async with _client(db_session) as client:
        resp = await client.get(f"/projects/{w.project.id}/workspace")
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["project"]["leader_engineer_name"] == "Lena Leader"
    assert body["stages"][0]["assigned_engineer_name"] == "Lena Leader"
    # Engineer has no Project Registration READ: financials withheld.
    assert body["project"]["customer_name"] is None
    assert body["project"]["tcogs_eur"] is None


async def test_workspace_financials_withheld_for_executive_viewer(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.EXECUTIVE_VIEWER)
    async with _client(db_session) as client:
        body = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    for name in ("customer_name", "tcogs_eur", "selling_price_eur", "gross_margin_pct"):
        assert body["project"][name] is None


@pytest.mark.parametrize(
    "outcome_kwargs,expected",
    [
        ({"left_out": True, "last_step_end_week": None, "projected_end_week": None}, "left_out"),
        ({"last_step_end_week": 50, "delay_weeks_applied": 5}, "off_track"),
    ],
)
async def test_workspace_health_variants(db_session, outcome_kwargs, expected):
    w = await _world(db_session, outcome_kwargs=outcome_kwargs)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    assert body["health"] == expected


async def test_workspace_without_run_is_unscheduled(db_session):
    w = await _world(db_session, with_run=False)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    assert body["health"] == "unscheduled"
    assert body["schedule"]["has_active_run"] is False
    assert body["stages"][0]["planned_start_week"] is None
    assert body["stages"][1]["skipped"] is False and body["stages"][1]["remaining_weeks"] == 4


# --- Scoping (P3-T03 pattern) ---------------------------------------------------------


async def test_hub_planner_out_of_hub_gets_404_everywhere(db_session):
    w = await _world(db_session)
    other = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[other.id])
    pid = w.project.id
    async with _client(db_session) as client:
        calls = [
            await client.get(f"/projects/{pid}/workspace"),
            await client.get(f"/projects/{pid}/activity"),
            await client.get(f"/projects/{pid}/files"),
            await client.patch(f"/projects/{pid}/stages/PDD-A", json={"percent_complete": 0}),
            await client.post(f"/projects/{pid}/comments", json={"body_md": "x"}),
            await client.post(f"/projects/{pid}/recalculate"),
            await client.get(f"/projects/{pid}/files/{uuid.uuid4()}/download"),
        ]
    assert [r.status_code for r in calls] == [404] * len(calls)


async def test_hub_planner_in_hub_can_read_and_write(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        read = await client.get(f"/projects/{w.project.id}/workspace")
        write = await client.post(f"/projects/{w.project.id}/comments", json={"body_md": "hi"})
    assert read.status_code == 200 and write.status_code == 201


async def test_engineer_sees_only_own_assignments_and_cannot_write(db_session):
    w = await _world(db_session)
    other_project = await make_project(db_session, w.hub, name="Not mine")
    stranger = await make_user(db_session, RoleName.ENGINEER, hub_scope_all=False)
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=w.leader_user.id, hub_scope_all=False)
    )
    async with _client(db_session) as client:
        own = await client.get(f"/projects/{w.project.id}/workspace")
        not_mine = await client.get(f"/projects/{other_project.id}/workspace")
        write = await client.patch(
            f"/projects/{w.project.id}/stages/PDD-A", json={"percent_complete": 10}
        )
    assert own.status_code == 200
    assert not_mine.status_code == 404
    assert write.status_code == 403
    # An Engineer with no linked engineer record sees nothing.
    override_current_principal(
        make_principal(RoleName.ENGINEER, user_id=stranger.id, hub_scope_all=False)
    )
    async with _client(db_session) as client:
        assert (await client.get(f"/projects/{w.project.id}/workspace")).status_code == 404


async def test_auditor_has_no_workspace_access(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.AUDITOR)
    async with _client(db_session) as client:
        assert (await client.get(f"/projects/{w.project.id}/workspace")).status_code == 403


# --- Stage PATCH ----------------------------------------------------------------------


async def test_stage_patch_done_marks_stale_and_audits(db_session):
    w = await _world(db_session)
    actor = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        started = await client.patch(
            f"/projects/{w.project.id}/stages/PDD-E",
            json={"status": "In Progress", "actual_start_week": 30, "percent_complete": 50},
        )
        done = await client.patch(
            f"/projects/{w.project.id}/stages/PDD-E",
            json={"status": "Done", "actual_end_week": 34},
        )
    assert started.status_code == 200, started.text
    stage = next(s for s in started.json()["stages"] if s["step_id"] == "PDD-E")
    assert stage["remaining_weeks"] == 3  # ceil(6 × 0.5)
    # Stale now → progress computed live, duration-weighted: 50 % of 6 of 38 weeks.
    assert started.json()["progress_pct"] == round(50 * 6 / 38)
    assert started.json()["schedule"]["schedule_stale"] is True
    assert done.status_code == 200, done.text
    stage = next(s for s in done.json()["stages"] if s["step_id"] == "PDD-E")
    assert stage["status"] == "Done" and stage["percent_complete"] == 100
    assert stage["actual_start_week"] == 30 and stage["actual_end_week"] == 34
    assert done.json()["progress_pct"] == round(100 * 6 / 38)
    audits = (
        await db_session.execute(
            select(AuditLogEntry)
            .where(AuditLogEntry.action == "project_stage.update")
            .order_by(AuditLogEntry.occurred_at)
        )
    ).scalars().all()
    assert len(audits) == 2
    assert audits[-1].actor_user_id == actor.id
    assert audits[-1].after_state["project_id"] == str(w.project.id)
    assert audits[-1].after_state["status"] == "Done"
    assert audits[-1].hub_id == w.hub.id
    activity = done.json()["activity"]
    assert any(item["kind"] == "event" and item["summary"] == "PDD-E marked Done"
               for item in activity)


async def test_stage_patch_blocked_and_back(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    url = f"/projects/{w.project.id}/stages/PDD-F"
    async with _client(db_session) as client:
        blocked = await client.patch(
            url, json={"status": "Blocked", "actual_start_week": 31, "blocked_reason": "Parts"}
        )
        resumed = await client.patch(url, json={"status": "In Progress"})
        reset = await client.patch(url, json={"status": "Not Started"})
    assert blocked.status_code == 200, blocked.text
    assert resumed.status_code == 200, resumed.text
    stage = next(s for s in resumed.json()["stages"] if s["step_id"] == "PDD-F")
    assert stage["blocked_reason"] is None and stage["actual_start_week"] == 31
    assert reset.status_code == 200
    stage = next(s for s in reset.json()["stages"] if s["step_id"] == "PDD-F")
    assert stage["actual_start_week"] is None and stage["percent_complete"] == 0


@pytest.mark.parametrize(
    "body,fields",
    [
        ({"status": "Done", "actual_start_week": 30}, {"actual_end_week"}),
        ({"status": "Done", "actual_start_week": 30, "actual_end_week": 34,
          "percent_complete": 90}, {"percent_complete"}),
        ({"status": "Done", "actual_start_week": 34, "actual_end_week": 30},
         {"actual_end_week"}),
        ({"status": "Blocked", "actual_start_week": 30}, {"blocked_reason"}),
        ({"status": "Blocked", "actual_start_week": 30, "blocked_reason": "   "},
         {"blocked_reason"}),
        ({"status": "In Progress"}, {"actual_start_week"}),
        ({"status": "In Progress", "actual_start_week": 30, "actual_end_week": 31},
         {"actual_end_week"}),
        ({"percent_complete": 10}, {"percent_complete"}),
        ({"blocked_reason": "why"}, {"blocked_reason"}),
        ({"status": None}, {"status"}),
    ],
)
async def test_stage_patch_consistency_errors(db_session, body, fields):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(f"/projects/{w.project.id}/stages/PDD-E", json=body)
    assert resp.status_code == 422, resp.text
    payload = resp.json()
    assert payload["code"] == "STAGE_INCONSISTENT"
    assert {e["loc"][1] for e in payload["detail"]} == fields
    project = w.project
    await db_session.refresh(project)
    assert project.schedule_stale is False


async def test_stage_patch_skipped_unknown_and_schema_errors(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, category="B")
    await sync_project_steps(db_session, project, False)
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        skipped = await client.patch(
            f"/projects/{project.id}/stages/PDD-B", json={"percent_complete": 0}
        )
        unknown = await client.patch(
            f"/projects/{project.id}/stages/OEM-A", json={"percent_complete": 0}
        )
        out_of_range = await client.patch(
            f"/projects/{project.id}/stages/PDD-A", json={"percent_complete": 101}
        )
        extra = await client.patch(f"/projects/{project.id}/stages/PDD-A", json={"frozen": True})
    assert skipped.status_code == 422 and skipped.json()["code"] == "STAGE_SKIPPED"
    assert unknown.status_code == 404
    assert out_of_range.status_code == 422
    assert extra.status_code == 422


async def test_stage_patch_creates_missing_rows(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)  # factory: no stage rows
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{project.id}/stages/PDD-A",
            json={"status": "In Progress", "actual_start_week": 31},
        )
    assert resp.status_code == 200, resp.text
    assert len(resp.json()["stages"]) == 14


# --- Comments -------------------------------------------------------------------------


async def test_comment_lifecycle(db_session):
    w = await _world(db_session)
    author = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id],
                           full_name="Ann Author")
    url = f"/projects/{w.project.id}/comments"
    raw = "**Late** <script>alert(1)</script> [x](javascript:alert(1))"
    async with _client(db_session) as client:
        created = await client.post(url, json={"body_md": raw})
        cid = created.json()["id"]
        edited = await client.patch(f"{url}/{cid}", json={"body_md": "_edited_"})
        too_long = await client.post(url, json={"body_md": "x" * 10001})
        at_cap = await client.post(url, json={"body_md": "x" * 10000})
    assert created.status_code == 201, created.text
    c = created.json()
    # P9-R02 (S-02): raw Markdown only; no server-rendered HTML field.
    assert c["body_md"] == raw
    assert "body_html_sanitized" not in c
    assert c["author_name"] == "Ann Author"  # the caller's own name
    assert c["author_user_id"] == str(author.id)
    assert c["can_edit"] is True
    assert c["mentioned_user_ids"] == []
    assert edited.status_code == 200
    assert edited.json()["body_md"] == "_edited_"
    assert edited.json()["edited_at"] is not None
    assert too_long.status_code == 422
    assert at_cap.status_code == 201

    # Another planner sees the comment, but not the author's name (OQ#8), and cannot edit.
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    async with _client(db_session) as client:
        ws = (await client.get(f"/projects/{w.project.id}/workspace")).json()
        foreign_edit = await client.patch(f"{url}/{cid}", json={"body_md": "hijack"})
        foreign_delete = await client.delete(f"{url}/{cid}")
    item = next(i for i in ws["activity"] if i["kind"] == "comment")
    assert item["comment"]["author_name"] is None
    assert item["comment"]["can_edit"] is False
    assert foreign_edit.status_code == 403 and foreign_edit.json()["code"] == "NOT_AUTHOR"
    assert foreign_delete.status_code == 403

    audits = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action.like("project_comment.%"))
        )
    ).scalars().all()
    assert {a.action for a in audits} == {"project_comment.create", "project_comment.update"}
    for a in audits:
        assert "Late" not in str(a.after_state) and "edited" not in str(a.after_state)


async def test_comment_edit_lock_after_15_minutes(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    url = f"/projects/{w.project.id}/comments"
    async with _client(db_session) as client:
        cid = (await client.post(url, json={"body_md": "first"})).json()["id"]
    await db_session.execute(
        update(ProjectComment)
        .where(ProjectComment.id == uuid.UUID(cid))
        .values(created_at=datetime.now(UTC) - timedelta(minutes=16))
    )
    async with _client(db_session) as client:
        resp = await client.patch(f"{url}/{cid}", json={"body_md": "late edit"})
        ws = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    assert resp.status_code == 403 and resp.json()["code"] == "EDIT_LOCKED"
    item = next(i for i in ws["activity"] if i["kind"] == "comment")
    assert item["comment"]["can_edit"] is False


async def test_comment_soft_delete_by_author_and_admin(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    url = f"/projects/{w.project.id}/comments"
    async with _client(db_session) as client:
        mine = (await client.post(url, json={"body_md": "mine"})).json()["id"]
        theirs = (await client.post(url, json={"body_md": "theirs"})).json()["id"]
        own_delete = await client.delete(f"{url}/{mine}")
        again = await client.delete(f"{url}/{mine}")
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        admin_delete = await client.delete(f"{url}/{theirs}")
        ws = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    assert own_delete.status_code == 204
    assert again.status_code == 404
    assert admin_delete.status_code == 204
    assert not [i for i in ws["activity"] if i["kind"] == "comment"]
    rows = (
        await db_session.execute(
            select(ProjectComment).where(ProjectComment.project_id == w.project.id)
        )
    ).scalars().all()
    assert len(rows) == 2 and all(r.soft_deleted_at is not None for r in rows)


# --- Activity feed --------------------------------------------------------------------


async def test_activity_feed_merges_and_pages(db_session):
    w = await _world(db_session)
    user = await _act_as(db_session, RoleName.ADMIN)
    base = datetime(2026, 9, 1, tzinfo=UTC)
    for i in range(3):
        db_session.add(
            AuditLogEntry(
                actor_user_id=user.id, action="project.update", entity_type="Project",
                entity_id=str(w.project.id), occurred_at=base + timedelta(hours=2 * i),
                before_state={"priority": f"P{4 - i}"}, after_state={"priority": f"P{3 - i}"},
            )
        )
        db_session.add(
            ProjectComment(
                project_id=w.project.id, body_md=f"c{i}", author_user_id=user.id,
                created_at=base + timedelta(hours=2 * i + 1),
            )
        )
    # An unrelated project's event is never included.
    db_session.add(
        AuditLogEntry(action="project.update", entity_type="Project", entity_id=str(uuid.uuid4()),
                      occurred_at=base + timedelta(days=1))
    )
    await db_session.flush()
    async with _client(db_session) as client:
        page1 = (await client.get(f"/projects/{w.project.id}/activity", params={"limit": 3})).json()
        before = page1[-1]["occurred_at"] if page1[-1]["kind"] == "event" else (
            page1[-1]["comment"]["created_at"]
        )
        page2 = (
            await client.get(
                f"/projects/{w.project.id}/activity", params={"limit": 3, "before": before}
            )
        ).json()
        bad = await client.get(f"/projects/{w.project.id}/activity", params={"limit": 0})
    kinds = [i["kind"] for i in page1] + [i["kind"] for i in page2]
    assert kinds == ["comment", "event", "comment", "event", "comment", "event"]
    assert page1[0]["comment"]["body_md"] == "c2"
    assert page1[1]["summary"] == "Priority changed P2 → P1"
    assert page1[1]["actor_name"] == "Test User"  # the caller is the actor
    assert page2[-1]["summary"] == "Priority changed P4 → P3"
    assert bad.status_code == 422


# --- Recalculate ----------------------------------------------------------------------


async def test_recalculate_dispatches_greedy_activating_run(db_session, monkeypatch):
    w = await _world(db_session, stale=True)
    user = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    calls: list[tuple] = []

    def _fake_delay(*args, **kwargs):
        calls.append((args, kwargs))
        return SimpleNamespace(id="celery-task-123")

    published: list[tuple] = []
    monkeypatch.setattr(workspace_router.run_greedy_schedule, "delay", _fake_delay)
    monkeypatch.setattr(
        workspace_router, "publish_progress", lambda *a, **k: published.append((a, k))
    )
    async with _client(db_session) as client:
        resp = await client.post(f"/projects/{w.project.id}/recalculate")
        again = await client.post(f"/projects/{w.project.id}/recalculate")
    assert resp.status_code == 202, resp.text
    body = resp.json()
    assert body["task_id"] == "celery-task-123"
    (args, kwargs), = calls
    assert args == (body["schedule_run_id"],)
    assert kwargs["activate"] is True
    assert kwargs["recalc_project_id"] == str(w.project.id)
    assert kwargs["triggered_by_user_id"] == str(user.id)
    run = await db_session.get(ScheduleRun, uuid.UUID(body["schedule_run_id"]))
    assert run.status == ScheduleRunStatus.QUEUED
    # OQ #10: the user-facing recalculation never dispatches CP-SAT.
    assert run.solver_type == SolverType.GREEDY
    assert run.trigger_reason == "workspace_recalc"
    assert run.is_active is False
    assert run.celery_task_id == "celery-task-123"
    assert run.workflow_snapshot is not None
    assert published == [((body["schedule_run_id"],), {"status": "queued"})]
    assert again.status_code == 409 and again.json()["code"] == "RUN_IN_PROGRESS"
    audit = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project.recalculate_requested")
        )
    ).scalar_one()
    assert audit.entity_id == str(w.project.id)



# --- Blocked-stage notifications (P9-T03 follow-up) -------------------------------------


async def test_blocked_transition_notifies_planners_and_pms_without_names(db_session):
    w = await _world(db_session)
    other_hub = await make_hub(db_session, name=HubName.PD_INDIA, lab_region=LabRegion.INDIA)
    planner_here = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                                   hub_ids=[w.hub.id])
    planner_elsewhere = await make_user(db_session, RoleName.HUB_PLANNER, hub_scope_all=False,
                                        hub_ids=[other_hub.id])
    pm = await make_user(db_session, RoleName.PORTFOLIO_MANAGER)
    await make_user(db_session, RoleName.PORTFOLIO_MANAGER, is_active=False)
    viewer = await make_user(db_session, RoleName.EXECUTIVE_VIEWER)
    actor = await _act_as(db_session, RoleName.HUB_PLANNER, hub_ids=[w.hub.id])
    url = f"/projects/{w.project.id}/stages/PDD-F"
    reason = "Waiting for the compressor samples from Lena's supplier"
    async with _client(db_session) as client:
        blocked = await client.patch(
            url, json={"status": "Blocked", "actual_start_week": 31, "blocked_reason": reason}
        )
        # Editing the reason of an already-Blocked stage is not a new transition.
        again = await client.patch(url, json={"blocked_reason": "still waiting"})
    assert blocked.status_code == 200, blocked.text
    assert again.status_code == 200
    rows = (
        await db_session.execute(
            select(Notification).where(Notification.reason == NotificationReason.STAGE_BLOCKED)
        )
    ).scalars().all()
    assert {n.recipient_user_id for n in rows} == {planner_here.id, pm.id}
    assert planner_elsewhere.id not in {n.recipient_user_id for n in rows}
    assert viewer.id not in {n.recipient_user_id for n in rows}
    assert actor.id not in {n.recipient_user_id for n in rows}
    n = rows[0]
    assert n.schedule_run_id is None and n.project_id == w.project.id and n.hub_id == w.hub.id
    assert n.message == (
        'Project "Workspace P" (R&D-Greece): stage PDD-F Proof of Concept is blocked — ' + reason
    )
    # No engineer or actor name was added by the server (the reason text is the planner's own).
    assert "Lena Leader" not in n.message and "Test User" not in n.message

    # The recipient sees it through the existing API with a null schedule_run_id.
    override_current_principal(make_principal(RoleName.PORTFOLIO_MANAGER, user_id=pm.id))
    async with _client(db_session) as client:
        listed = (await client.get("/notifications")).json()
    item = next(i for i in listed["items"] if i["reason"] == "stage_blocked")
    assert item["schedule_run_id"] is None

    # The audit rows keep the reason's length only.
    audits = (
        await db_session.execute(
            select(AuditLogEntry).where(AuditLogEntry.action == "project_stage.update")
        )
    ).scalars().all()
    for a in audits:
        assert "blocked_reason" not in (a.after_state or {})
        assert reason not in str(a.after_state) and "still waiting" not in str(a.after_state)
    assert max(a.after_state["blocked_reason_length"] for a in audits) == len(reason)


async def test_blocked_message_truncates_long_reason():
    from services.notifications import stage_blocked_message

    msg = stage_blocked_message(project_name="P", hub_name="H", step_id="PDD-F",
                                step_name="Proof of Concept", reason="x" * 2000)
    assert len(msg) <= 500 and msg.endswith("…")


# --- P9-R02 remediation ----------------------------------------------------------------


async def test_stage_patch_on_frozen_project_is_409(db_session):
    w = await _world(db_session)
    w.project.frozen = True
    w.project.actual_start_week = 31
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        resp = await client.patch(
            f"/projects/{w.project.id}/stages/PDD-A",
            json={"status": "In Progress", "actual_start_week": 31},
        )
    assert resp.status_code == 409
    assert resp.json()["code"] == "PROJECT_FROZEN"
    await db_session.refresh(w.project)
    assert w.project.schedule_stale is False


async def test_frozen_project_progress_uses_the_one_formula(db_session):
    """Ruling 3: stored progress on a frozen project still counts, duration-weighted,
    regardless of what an older run stored (here 0)."""

    w = await _world(db_session)
    row = (
        await db_session.execute(
            select(ProjectWorkflowStep).where(
                ProjectWorkflowStep.project_id == w.project.id,
                ProjectWorkflowStep.step_template_id == "PDD-E",
            )
        )
    ).scalar_one()
    row.status = WorkflowStepStatus.DONE
    row.percent_complete = 100
    row.actual_start_week = 20
    row.actual_end_week = 25
    w.project.frozen = True
    w.project.actual_start_week = 20
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    assert body["progress_pct"] == round(100 * 6 / 38)


async def test_progress_weights_skipped_lab_steps_zero(db_session):
    w = await _world(db_session)
    w.project.certification_testing_required = False  # PDD-F / PDD-H skipped
    await db_session.execute(
        update(ProjectWorkflowStep)
        .where(
            ProjectWorkflowStep.project_id == w.project.id,
            ProjectWorkflowStep.step_template_id == "PDD-A",
        )
        .values(status=WorkflowStepStatus.DONE, percent_complete=100,
                actual_start_week=30, actual_end_week=30)
    )
    await db_session.flush()
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    # Σ duration without the two 4- and 6-week lab steps: 38 − 10 = 28.
    assert body["progress_pct"] == round(100 * 1 / 28)


async def test_blocked_health_badge(db_session):
    w = await _world(db_session, outcome_kwargs={"blocked": True, "projected_end_week": None})
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        body = (await client.get(f"/projects/{w.project.id}/workspace")).json()
    assert body["health"] == "blocked"
    left_out_and_blocked = ScheduleRunProjectOutcome(left_out=True, blocked=True)
    assert health_badge(left_out_and_blocked, [], {}, 31) == "left_out"
    late_but_blocked = ScheduleRunProjectOutcome(
        left_out=False, blocked=True, last_step_end_week=60, delay_weeks_applied=0
    )
    assert health_badge(late_but_blocked, [], {}, 31) == "blocked"


async def test_comment_creation_is_rate_limited_per_user(db_session):
    w = await _world(db_session)
    await _act_as(db_session, RoleName.ADMIN)
    url = f"/projects/{w.project.id}/comments"
    async with _client(db_session) as client:
        codes = [(await client.post(url, json={"body_md": f"c{i}"})).status_code
                 for i in range(11)]
        limited = await client.post(url, json={"body_md": "one more"})
    assert codes[:10] == [201] * 10
    assert codes[10] == 429
    assert limited.json()["code"] == "RATE_LIMITED"
    assert int(limited.headers["Retry-After"]) >= 1
    # Another user has their own bucket.
    await _act_as(db_session, RoleName.ADMIN)
    async with _client(db_session) as client:
        assert (await client.post(url, json={"body_md": "other"})).status_code == 201
