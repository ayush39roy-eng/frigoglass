"""P5-T06 — `services.notifications.generate_schedule_change_notifications`:
the diff logic (delay introduced / project left out / conflict raised) and
recipient resolution (hub-scope-all, hub-scoped, Engineer-own-project,
role-ineligible, inactive-user exclusion, dedup across matching paths), plus
the wiring test confirming `services.schedule_persistence
.persist_schedule_output` actually calls this on `activate=True` and never
on `activate=False`.

Exercises the pure diff function directly with hand-built
`scheduling.types.ProjectScheduleOutcome`/`StepSchedule` dataclasses (no
greedy/CP-SAT solve needed — this task owns the diff/notification code, not
the scheduler) against a real, DB-persisted "previous run" baseline.
"""

from __future__ import annotations

import pytest
from sqlalchemy import select

from models.enums import (
    EngineerAllowedCategory,
    HubName,
    LabRegion,
    NotificationReason,
    RoleName,
    ScheduleRunStatus,
    SolverType,
)
from models.notification import Notification
from models.project import Project
from models.schedule import ScheduleRunProjectOutcome, ScheduleRunProjectStep
from scheduling.types import ProjectScheduleOutcome, StepSchedule
from services.notifications import generate_schedule_change_notifications
from services.schedule_persistence import build_schedule_input_from_db, persist_schedule_output
from tests.factories import (
    make_engineer,
    make_hub,
    make_project,
    make_schedule_run,
    make_user,
    make_workflow_step_template,
)


def _outcome(
    project: Project,
    *,
    left_out: bool = False,
    eng_conflict: bool = False,
    overlap: bool = False,
    end_week: int | None = 40,
    within_year: bool = True,
) -> ProjectScheduleOutcome:
    steps = ()
    if not left_out and end_week is not None:
        steps = (
            StepSchedule(
                step_id="PDD-A",
                sequence_order=1,
                kind="design",
                start_week=end_week - 1,
                end_week=end_week,
                duration_weeks=2,
                assigned_engineer_id=str(project.leader_engineer_id)
                if project.leader_engineer_id
                else None,
                assigned_chamber_id=None,
            ),
        )
    return ProjectScheduleOutcome(
        project_id=str(project.id),
        excluded=False,
        left_out=left_out,
        eng_conflict=eng_conflict,
        overlap=overlap,
        cat_not_allowed=False,
        spillover=False,
        within_year=within_year,
        no_leader=False,
        no_chamber_step_id=None,
        steps=steps,
        start_week=end_week - 1 if end_week is not None else None,
        end_week=end_week,
    )


async def _ensure_step_template(db_session):
    """Get-or-create `WorkflowStepTemplate("PDD-A")` — `ScheduleRunProjectStep
    .step_template_id` has a real FK to it, and more than one call site in
    this file needs a step row within the same test's savepoint.
    """

    from models.workflow import WorkflowStepTemplate

    existing = (
        await db_session.execute(
            select(WorkflowStepTemplate).where(WorkflowStepTemplate.id == "PDD-A")
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing
    return await make_workflow_step_template(db_session, step_id="PDD-A", sequence_order=1)


async def _make_previous_run_outcome(
    db_session,
    project: Project,
    *,
    left_out: bool = False,
    last_step_end_week: int | None = 35,
    eng_conflict: bool = False,
    overlap: bool = False,
):
    run = await make_schedule_run(db_session, is_active=False, status=ScheduleRunStatus.COMPLETED)
    db_session.add(
        ScheduleRunProjectOutcome(
            schedule_run_id=run.id,
            project_id=project.id,
            left_out=left_out,
            within_year=not left_out,
            last_step_end_week=last_step_end_week,
        )
    )
    if not left_out and last_step_end_week is not None:
        await _ensure_step_template(db_session)
        db_session.add(
            ScheduleRunProjectStep(
                schedule_run_id=run.id,
                project_id=project.id,
                step_template_id="PDD-A",
                sequence_order=1,
                duration_weeks=2,
                start_week=last_step_end_week - 1,
                end_week=last_step_end_week,
                eng_conflict=eng_conflict,
                chamber_overlap=overlap,
            )
        )
    await db_session.flush()
    return run


# ---------------------------------------------------------------------------
# No baseline
# ---------------------------------------------------------------------------


async def test_no_previous_run_generates_nothing(db_session):
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=None,
        project_outcomes=(_outcome(project),),
    )
    assert notifications == []


async def test_new_project_with_no_prior_row_generates_nothing(db_session):
    """A project absent from the previous run's outcomes (new to the
    portfolio) is skipped entirely — no baseline to regress from.
    """
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    previous_run = await make_schedule_run(db_session, is_active=False)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, left_out=True, end_week=None),),
    )
    assert notifications == []


async def test_excluded_project_never_fires(db_session, hub, _pm_recipient):
    """A project outside the four schedulable statuses (`excluded=True`,
    e.g. Commercialized/On Hold/Draft) never fires a notification, even if
    it regressed from a real prior baseline — `excluded` and `left_out` are
    deliberately distinct per `scheduling.types.ProjectScheduleOutcome`'s own
    docstring, and only a genuinely-scheduled regression is notification-
    worthy.
    """
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, left_out=False)
    new_run = await make_schedule_run(db_session, is_active=True)

    excluded_outcome = ProjectScheduleOutcome(
        project_id=str(project.id),
        excluded=True,
        left_out=False,
        eng_conflict=False,
        overlap=False,
        cat_not_allowed=False,
        spillover=False,
        within_year=False,
        no_leader=False,
        no_chamber_step_id=None,
        steps=(),
        start_week=None,
        end_week=None,
    )
    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(excluded_outcome,),
    )
    assert notifications == []


# ---------------------------------------------------------------------------
# Diff conditions
# ---------------------------------------------------------------------------


@pytest.fixture
async def _pm_recipient(db_session, hub):
    """A hub_scope_all, notification-eligible user (Portfolio Manager) —
    always in scope for every event below.
    """
    return await make_user(db_session, RoleName.PORTFOLIO_MANAGER, hub_scope_all=True)


@pytest.fixture
async def hub(db_session):
    return await make_hub(db_session, name=HubName.RD_GREECE, lab_region=LabRegion.GREECE)


async def test_delay_introduced_detected(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    assert len(notifications) == 1
    n = notifications[0]
    assert n.reason == NotificationReason.DELAY_INTRODUCED
    assert n.project_id == project.id
    assert n.hub_id == hub.id
    assert "week 35 to week 40" in n.message
    assert "$" not in n.message  # no financial content, ever


async def test_no_delay_when_end_week_unchanged_or_earlier(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=40)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    assert notifications == []

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=38),),
    )
    assert notifications == []


async def test_delay_introduced_on_within_year_regression_with_unchanged_end_week(
    db_session, hub, _pm_recipient
):
    """The scenario workflow-auditor live-reproduced as producing zero
    notifications (P5-T10 remediation): a planner records a `delay_weeks`
    increase via `PUT /projects/{id}`, which per ADR 0004 / `greedy.py`'s
    `completion_week = end_week + project.delay_weeks` never moves `end_week`
    itself but CAN flip `within_year` from `True` to `False` (a genuine
    SPILLOVER regression). `end_week` is identical between the two runs
    (40 -> 40) — only `within_year` regresses — and this must still fire
    exactly one `DELAY_INTRODUCED` notification, reusing the already-
    persisted `within_year` field rather than `end_week` movement.
    """
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=40)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40, within_year=False),),
    )
    assert len(notifications) == 1
    n = notifications[0]
    assert n.reason == NotificationReason.DELAY_INTRODUCED
    assert n.project_id == project.id
    assert "spill over" in n.message
    assert "$" not in n.message  # no financial content, ever


async def test_no_delay_when_within_year_stays_true_and_end_week_unchanged(
    db_session, hub, _pm_recipient
):
    """Sanity counterpart to the regression test above: if neither `end_week`
    nor `within_year` regressed, nothing fires — confirms the new
    `within_year` condition doesn't fire spuriously on every unchanged run.
    """
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=40)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40, within_year=True),),
    )
    assert notifications == []


async def test_delay_introduced_prefers_end_week_message_when_both_regress(
    db_session, hub, _pm_recipient
):
    """When `end_week` genuinely moved AND `within_year` also flipped, only
    ONE `DELAY_INTRODUCED` notification fires (not two), and it uses the
    more concrete "moved from week X to week Y" message rather than the
    within-year-only phrasing.
    """
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40, within_year=False),),
    )
    assert len(notifications) == 1
    n = notifications[0]
    assert n.reason == NotificationReason.DELAY_INTRODUCED
    assert "week 35 to week 40" in n.message


async def test_project_left_out_detected(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, left_out=False)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, left_out=True, end_week=None, within_year=False),),
    )
    assert len(notifications) == 1
    assert notifications[0].reason == NotificationReason.PROJECT_LEFT_OUT


async def test_left_out_suppresses_delay_introduced_for_same_project(
    db_session, hub, _pm_recipient
):
    """A project that just became LEFT_OUT gets only the LEFT_OUT reason —
    never a redundant DELAY_INTRODUCED alongside it.
    """
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(
        db_session, project, left_out=False, last_step_end_week=35
    )
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, left_out=True, end_week=None, within_year=False),),
    )
    reasons = {n.reason for n in notifications}
    assert reasons == {NotificationReason.PROJECT_LEFT_OUT}


async def test_already_left_out_stays_silent(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, left_out=True)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, left_out=True, end_week=None, within_year=False),),
    )
    assert notifications == []


async def test_conflict_raised_detected(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub, frozen=True)
    # `last_step_end_week` matches `_outcome(...)`'s default `end_week=40`
    # deliberately, so DELAY_INTRODUCED does not also fire — isolating this
    # test to the conflict signal only.
    previous_run = await _make_previous_run_outcome(
        db_session, project, eng_conflict=False, overlap=False, last_step_end_week=40
    )
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, eng_conflict=True),),
    )
    assert len(notifications) == 1
    assert notifications[0].reason == NotificationReason.CONFLICT_RAISED


async def test_conflict_already_present_stays_silent(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub, frozen=True)
    previous_run = await _make_previous_run_outcome(
        db_session, project, overlap=True, last_step_end_week=40
    )
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, overlap=True),),
    )
    assert notifications == []


async def test_multiple_reasons_fire_independently_for_the_same_project(
    db_session, hub, _pm_recipient
):
    project = await make_project(db_session, hub, frozen=True)
    previous_run = await _make_previous_run_outcome(
        db_session, project, last_step_end_week=35, eng_conflict=False
    )
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40, eng_conflict=True),),
    )
    reasons = {n.reason for n in notifications}
    assert reasons == {NotificationReason.DELAY_INTRODUCED, NotificationReason.CONFLICT_RAISED}


# ---------------------------------------------------------------------------
# Recipient resolution
# ---------------------------------------------------------------------------


async def test_hub_scope_all_user_is_recipient(db_session, hub, _pm_recipient):
    project = await make_project(db_session, hub)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    assert {n.recipient_user_id for n in notifications} == {_pm_recipient.id}


async def test_hub_scoped_user_matches_own_hub_only(db_session, hub):
    other_hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    project = await make_project(db_session, hub)
    matching_planner = await make_user(
        db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[hub.id]
    )
    other_hub_planner = await make_user(
        db_session, RoleName.HUB_PLANNER, hub_scope_all=False, hub_ids=[other_hub.id]
    )
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    recipients = {n.recipient_user_id for n in notifications}
    assert matching_planner.id in recipients
    assert other_hub_planner.id not in recipients


async def test_auditor_is_never_a_recipient(db_session, hub):
    """Auditor grants READ on none of DASHBOARD/CAPACITY/GANTT — never
    eligible, regardless of hub scope.
    """
    project = await make_project(db_session, hub)
    await make_user(db_session, RoleName.AUDITOR, hub_scope_all=True)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    assert notifications == []


async def test_inactive_user_is_never_a_recipient(db_session, hub):
    project = await make_project(db_session, hub)
    await make_user(db_session, RoleName.PORTFOLIO_MANAGER, hub_scope_all=True, is_active=False)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    assert notifications == []


async def test_engineer_is_recipient_only_for_own_led_project(db_session, hub):
    other_hub = await make_hub(db_session, name=HubName.PD_ROMANIA, lab_region=LabRegion.ROMANIA)
    own_engineer = await make_engineer(
        db_session, hub, name="Own Engineer", allowed_categories=[EngineerAllowedCategory.A]
    )
    other_engineer = await make_engineer(
        db_session, other_hub, name="Other Engineer", allowed_categories=[EngineerAllowedCategory.A]
    )
    own_user = await make_user(
        db_session, RoleName.ENGINEER, full_name="Own Engineer User", hub_scope_all=False
    )
    own_engineer.user_id = own_user.id
    db_session.add(own_engineer)
    await db_session.flush()

    own_project = await make_project(db_session, hub, leader=own_engineer, name="Own Project")
    other_project = await make_project(
        db_session, other_hub, leader=other_engineer, name="Other Project"
    )

    previous_run = await _make_previous_run_outcome(
        db_session, own_project, last_step_end_week=35
    )
    await _make_previous_run_outcome(
        db_session,
        other_project,
        last_step_end_week=35,
    )
    new_run = await make_schedule_run(db_session, is_active=True)

    # Re-fetch the previous run for other_project's outcome too — same
    # ScheduleRun as own_project's so both diff against a single baseline.
    # (Two separate `_make_previous_run_outcome` calls above created two
    # different ScheduleRun rows; only own_project's is used below,
    # deliberately, to isolate "does the Engineer see their own project's
    # event" from "do they leak a different hub's project's event" with a
    # single generation call per project.)
    notifications_own = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(own_project, end_week=40),),
    )
    assert {n.recipient_user_id for n in notifications_own} == {own_user.id}

    other_previous_run = await _make_previous_run_outcome(
        db_session, other_project, last_step_end_week=35
    )
    notifications_other = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=other_previous_run.id,
        project_outcomes=(_outcome(other_project, end_week=40),),
    )
    assert own_user.id not in {n.recipient_user_id for n in notifications_other}


async def test_dedup_when_user_matches_hub_scope_and_engineer_path(db_session, hub):
    """A user who is BOTH Hub-Planner-scoped to the project's hub AND the
    Engineer leading that same project gets exactly one Notification row,
    not two.
    """
    engineer = await make_engineer(db_session, hub, name="Dual Role Engineer")
    user = await make_user(
        db_session,
        RoleName.ENGINEER,
        RoleName.HUB_PLANNER,
        full_name="Dual Role User",
        hub_scope_all=False,
        hub_ids=[hub.id],
    )
    engineer.user_id = user.id
    db_session.add(engineer)
    await db_session.flush()

    project = await make_project(db_session, hub, leader=engineer)
    previous_run = await _make_previous_run_outcome(db_session, project, last_step_end_week=35)
    new_run = await make_schedule_run(db_session, is_active=True)

    notifications = await generate_schedule_change_notifications(
        db_session,
        new_run=new_run,
        previous_active_run_id=previous_run.id,
        project_outcomes=(_outcome(project, end_week=40),),
    )
    assert [n.recipient_user_id for n in notifications] == [user.id]


# ---------------------------------------------------------------------------
# Wiring: persist_schedule_output only generates on activate=True
# ---------------------------------------------------------------------------


async def test_persist_schedule_output_generates_notifications_only_when_activated(
    db_session, hub, _pm_recipient
):
    engineer = await make_engineer(db_session, hub)
    await make_workflow_step_template(db_session, step_id="PDD-A", sequence_order=1)
    project = await make_project(db_session, hub, leader=engineer)

    schedule_input = await build_schedule_input_from_db(db_session)

    from scheduling.types import ScheduleOutput

    baseline_output = ScheduleOutput(
        project_outcomes=(_outcome(project, end_week=35),),
        scheduling_order=(str(project.id),),
    )
    first_run = await persist_schedule_output(
        db_session,
        schedule_input,
        baseline_output,
        solver_type=SolverType.GREEDY,
        trigger_reason="test_baseline",
        activate=True,
    )
    await db_session.flush()

    baseline_notifications = (
        (
            await db_session.execute(
                select(Notification).where(Notification.schedule_run_id == first_run.id)
            )
        )
        .scalars()
        .all()
    )
    assert baseline_notifications == []  # no prior baseline yet — correct, nothing to diff

    worse_output = ScheduleOutput(
        project_outcomes=(_outcome(project, end_week=45),),
        scheduling_order=(str(project.id),),
    )
    second_run = await persist_schedule_output(
        db_session,
        schedule_input,
        worse_output,
        solver_type=SolverType.GREEDY,
        trigger_reason="test_worse",
        activate=True,
    )
    await db_session.flush()

    delayed_notifications = (
        (
            await db_session.execute(
                select(Notification).where(Notification.schedule_run_id == second_run.id)
            )
        )
        .scalars()
        .all()
    )
    assert len(delayed_notifications) == 1
    assert delayed_notifications[0].reason == NotificationReason.DELAY_INTRODUCED
    assert delayed_notifications[0].previous_schedule_run_id == first_run.id

    # activate=False (e.g. a completed-but-not-activated CP-SAT run) must
    # never generate notifications, even though the diff would otherwise
    # fire.
    even_worse_output = ScheduleOutput(
        project_outcomes=(_outcome(project, end_week=50),),
        scheduling_order=(str(project.id),),
    )
    third_run = await persist_schedule_output(
        db_session,
        schedule_input,
        even_worse_output,
        solver_type=SolverType.CP_SAT,
        trigger_reason="test_not_activated",
        activate=False,
        sync_live_workflow_steps=False,
    )
    await db_session.flush()

    not_activated_notifications = (
        (
            await db_session.execute(
                select(Notification).where(Notification.schedule_run_id == third_run.id)
            )
        )
        .scalars()
        .all()
    )
    assert not_activated_notifications == []
