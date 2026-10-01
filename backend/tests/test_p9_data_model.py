"""P9-T01 — DB-level checks for the 2026-09-27 data model on real Postgres 17
(shared session container, SAVEPOINT-per-test):

- the migration-seeded lead-time table reloads to exactly the DOMAIN_RULES.md
  table (literal copy in `test_domain_constants_lead_times.py`), and the seed
  script's upsert leaves it unchanged;
- the per-stage progress CHECK constraints reject every inconsistent state;
- the OEM-category-matches-hub trigger rejects a mismatch (as IntegrityError);
- `project_comments` cannot be hard-deleted;
- `services.workflow_durations` recomputes live durations from the table;
- HubWorkCalendar / Chamber downtime / ScheduleRun snapshot columns round-trip.
"""

from __future__ import annotations

import uuid
from typing import Any

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import DBAPIError, IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models import (
    Chamber,
    HubWorkCalendar,
    ProjectComment,
    ProjectWorkflowStep,
    ScheduleRun,
    Workflow,
    WorkflowLeadTime,
    WorkflowStepTemplate,
)
from models.enums import (
    HubName,
    LabRegion,
    ProjectCategory,
    ProjectStatus,
    RoleName,
    WorkflowStepKind,
    WorkflowStepStatus,
)
from models.project import category_allowed_for_hub, workflow_id_for_hub
from seed import seed_demo_data
from services.workflow_durations import (
    duration_for,
    lead_time_lookup,
    recompute_step_durations,
)
from tests.factories import make_hub, make_project, make_schedule_run, make_user
from tests.test_domain_constants_lead_times import DOMAIN_RULES_LEAD_TIMES

# --------------------------------------------------------------- seeded table


async def _reload_lead_times(db_session: AsyncSession) -> dict[tuple[str, str, str], int]:
    rows = (await db_session.execute(select(WorkflowLeadTime))).scalars().all()
    return {(r.workflow_id, r.category.value, r.step_id): r.weeks for r in rows}


def _domain_rules_literal() -> dict[tuple[str, str, str], int]:
    return {
        (wf, cat, f"{wf}-{letter}"): weeks
        for (wf, cat), row in DOMAIN_RULES_LEAD_TIMES.items()
        for letter, weeks in zip("ABCDEFGHIJKLMN", row, strict=True)
    }


async def test_migration_seeded_lead_time_table_equals_domain_rules_literal(
    db_session: AsyncSession,
) -> None:
    assert await _reload_lead_times(db_session) == _domain_rules_literal()


async def test_seed_script_upsert_reproduces_lead_time_table_byte_for_byte(
    db_session: AsyncSession,
) -> None:
    counts = await seed_demo_data.seed_workflows(db_session)
    assert counts == {"workflows": 2, "workflow_step_templates": 28, "workflow_lead_times": 98}
    assert await _reload_lead_times(db_session) == _domain_rules_literal()
    assert {w.id for w in (await db_session.execute(select(Workflow))).scalars()} == {"PDD", "OEM"}
    templates = (await db_session.execute(select(WorkflowStepTemplate))).scalars().all()
    assert len(templates) == 28
    by_id = {t.id: t for t in templates}
    assert by_id["PDD-C"].kind is WorkflowStepKind.ELAPSED
    assert by_id["PDD-C"].code == "BUS_CASE"
    assert by_id["PDD-C"].predecessor_ids == ["PDD-B"]
    assert by_id["OEM-A"].predecessor_ids == []
    assert by_id["OEM-H"].kind is WorkflowStepKind.LAB and by_id["OEM-H"].workflow_id == "OEM"


async def test_lead_time_weeks_must_be_non_negative(db_session: AsyncSession) -> None:
    db_session.add(
        WorkflowLeadTime(workflow_id="PDD", category=ProjectCategory.A, step_id="PDD-A", weeks=-1)
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_sequence_order_is_unique_per_workflow_not_globally(db_session: AsyncSession) -> None:
    """PDD-A and OEM-A both have sequence_order 1 (migration seeded them)."""
    rows = (
        (
            await db_session.execute(
                select(WorkflowStepTemplate.workflow_id).where(
                    WorkflowStepTemplate.sequence_order == 1
                )
            )
        )
        .scalars()
        .all()
    )
    assert sorted(rows) == ["OEM", "PDD"]
    db_session.add(
        WorkflowStepTemplate(
            id="PDD-Z",
            workflow_id="PDD",
            code="X",
            name="dup",
            kind=WorkflowStepKind.DESIGN,
            sequence_order=1,
            predecessor_ids=[],
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_super_admin_role_row_seeded_by_migration(db_session: AsyncSession) -> None:
    from models import Role

    names = {r.name for r in (await db_session.execute(select(Role))).scalars()}
    assert RoleName.SUPER_ADMIN.value in names


# ------------------------------------------------------ progress CHECK rules


async def _step(db_session: AsyncSession, **overrides: Any) -> ProjectWorkflowStep:
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    values: dict[str, Any] = dict(
        project_id=project.id,
        step_template_id="PDD-A",
        sequence_order=1,
        duration_weeks=1,
        status=WorkflowStepStatus.NOT_STARTED,
        percent_complete=0,
    )
    values.update(overrides)
    step = ProjectWorkflowStep(**values)
    db_session.add(step)
    return step


@pytest.mark.parametrize(
    "overrides",
    [
        # Done ⇒ percent 100, both actuals, end >= start
        dict(status=WorkflowStepStatus.DONE, percent_complete=90, actual_start_week=1,
             actual_end_week=2),
        dict(status=WorkflowStepStatus.DONE, percent_complete=100, actual_start_week=None,
             actual_end_week=2),
        dict(status=WorkflowStepStatus.DONE, percent_complete=100, actual_start_week=5,
             actual_end_week=2),
        # Not Started ⇒ percent 0, no actuals
        dict(status=WorkflowStepStatus.NOT_STARTED, percent_complete=10),
        dict(status=WorkflowStepStatus.NOT_STARTED, actual_start_week=3),
        # In Progress / Blocked ⇒ actual_start set, actual_end null
        dict(status=WorkflowStepStatus.IN_PROGRESS, actual_start_week=None),
        dict(status=WorkflowStepStatus.IN_PROGRESS, actual_start_week=3, actual_end_week=4),
        dict(status=WorkflowStepStatus.BLOCKED, actual_start_week=None, blocked_reason="x"),
        # Blocked ⇒ non-empty reason; otherwise reason null
        dict(status=WorkflowStepStatus.BLOCKED, actual_start_week=3, blocked_reason=None),
        dict(status=WorkflowStepStatus.BLOCKED, actual_start_week=3, blocked_reason="   "),
        dict(status=WorkflowStepStatus.IN_PROGRESS, actual_start_week=3, blocked_reason="stale"),
        # ranges
        dict(percent_complete=101),
        dict(remaining_weeks_override=-1),
        dict(duration_weeks=-1),
    ],
)  # fmt: skip
async def test_progress_check_constraints_reject_inconsistent_rows(
    db_session: AsyncSession, overrides: dict[str, Any]
) -> None:
    await _step(db_session, **overrides)
    with pytest.raises(IntegrityError):
        await db_session.flush()


@pytest.mark.parametrize(
    "overrides",
    [
        dict(),
        dict(status=WorkflowStepStatus.DONE, percent_complete=100, actual_start_week=2,
             actual_end_week=2),
        dict(status=WorkflowStepStatus.IN_PROGRESS, actual_start_week=3, percent_complete=40,
             remaining_weeks_override=0),
        dict(status=WorkflowStepStatus.BLOCKED, actual_start_week=3, blocked_reason="supplier"),
        dict(duration_weeks=0),  # a skipped step
    ],
)  # fmt: skip
async def test_progress_check_constraints_accept_consistent_rows(
    db_session: AsyncSession, overrides: dict[str, Any]
) -> None:
    step = await _step(db_session, **overrides)
    await db_session.flush()
    assert step.id is not None


# ---------------------------------------------------- OEM category ⇄ hub rule


def test_category_allowed_for_hub_pure_rule() -> None:
    assert category_allowed_for_hub(True, ProjectCategory.A_OEM)
    assert category_allowed_for_hub(False, ProjectCategory.A_PLUS)
    assert not category_allowed_for_hub(True, ProjectCategory.A)
    assert not category_allowed_for_hub(False, ProjectCategory.C_OEM)
    assert category_allowed_for_hub(True, None) and category_allowed_for_hub(False, None)
    assert workflow_id_for_hub(True) == "OEM" and workflow_id_for_hub(False) == "PDD"


async def test_trigger_rejects_non_oem_category_on_oem_hub(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True)
    with pytest.raises(IntegrityError, match="must carry an OEM category"):
        await make_project(db_session, hub, category=ProjectCategory.B)


async def test_trigger_rejects_oem_category_on_non_oem_hub(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    with pytest.raises(IntegrityError, match="OEM"):
        await make_project(db_session, hub, category=ProjectCategory.B_OEM)


async def test_trigger_accepts_matching_categories_and_null_for_drafts(
    db_session: AsyncSession,
) -> None:
    oem_hub = await make_hub(
        db_session, name=HubName.OEM_SELTEK, lab_region=LabRegion.INDIA, is_oem=True
    )
    p = await make_project(db_session, oem_hub, category=ProjectCategory.C_OEM)
    draft = await make_project(db_session, oem_hub, category=None, status=ProjectStatus.DRAFT)
    assert p.category is ProjectCategory.C_OEM and draft.category is None
    # ... and the UPDATE path fires too.
    p.category = ProjectCategory.A
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_cancelled_status_round_trips(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    p = await make_project(db_session, hub, status=ProjectStatus.CANCELLED)
    row = (
        await db_session.execute(text("SELECT status FROM projects WHERE id = :id"), {"id": p.id})
    ).one()
    assert row.status == "Cancelled"


# ---------------------------------------------------- comments never deleted


async def test_project_comments_cannot_be_hard_deleted(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    project = await make_project(db_session, hub)
    author = await make_user(db_session, RoleName.HUB_PLANNER)
    comment = ProjectComment(
        project_id=project.id, body_md="hello", author_user_id=author.id, mentioned_user_ids=[]
    )
    db_session.add(comment)
    await db_session.flush()
    with pytest.raises(DBAPIError, match="never hard-deleted"):
        await db_session.execute(
            text("DELETE FROM project_comments WHERE id = :id"), {"id": comment.id}
        )


# -------------------------------------------------- duration recompute helper


async def test_recompute_step_durations_from_lead_time_table(db_session: AsyncSession) -> None:
    """A B-category PDD project seeded with wrong durations gets the DOMAIN_RULES
    row `1 0 0 1 4 0 0 6 0 1 2 1 1 1`; an OEM-hub C-OEM project gets
    `0 0 0 0 0 0 2 2 0 0 0 0 0 0`."""
    pdd_hub = await make_hub(db_session)
    oem_hub = await make_hub(
        db_session, name=HubName.OEM_HCK, lab_region=LabRegion.INDIA, is_oem=True
    )
    pdd = await make_project(db_session, pdd_hub, category=ProjectCategory.B)
    oem = await make_project(db_session, oem_hub, category=ProjectCategory.C_OEM)
    for project, wf in ((pdd, "PDD"), (oem, "OEM")):
        for seq, letter in enumerate("ABCDEFGHIJKLMN", start=1):
            db_session.add(
                ProjectWorkflowStep(
                    project_id=project.id,
                    step_template_id=f"{wf}-{letter}",
                    sequence_order=seq,
                    duration_weeks=99,
                )
            )
    await db_session.flush()

    updated = await recompute_step_durations(db_session, [pdd.id, oem.id])
    assert updated == 28

    async def durations(project_id: uuid.UUID) -> tuple[int, ...]:
        rows = (
            (
                await db_session.execute(
                    select(ProjectWorkflowStep.duration_weeks)
                    .where(ProjectWorkflowStep.project_id == project_id)
                    .order_by(ProjectWorkflowStep.sequence_order)
                )
            )
            .scalars()
            .all()
        )
        return tuple(rows)

    assert await durations(pdd.id) == DOMAIN_RULES_LEAD_TIMES[("PDD", "B")]
    assert await durations(oem.id) == DOMAIN_RULES_LEAD_TIMES[("OEM", "C-OEM")]

    # The pure-Python form agrees with the SQL form.
    lookup = lead_time_lookup(dc.LEAD_TIME_SEED)
    assert (
        tuple(duration_for(lookup, "PDD", "B", f"PDD-{x}") for x in "ABCDEFGHIJKLMN")
        == DOMAIN_RULES_LEAD_TIMES[("PDD", "B")]
    )
    assert duration_for(lookup, "PDD", None, "PDD-A") == 0


# ------------------------------------------------- new columns round-trip


async def test_hub_work_calendar_one_per_hub_and_non_negative(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    db_session.add(
        HubWorkCalendar(
            hub_id=hub.id,
            weekdays_per_week=6,
            national_holiday_days=13,
            medical_leave_days=7,
            casual_leave_days=7,
            annual_leave_days=20,
        )
    )
    await db_session.flush()
    db_session.add(HubWorkCalendar(hub_id=hub.id, weekdays_per_week=5))
    with pytest.raises(IntegrityError):  # unique(hub_id)
        await db_session.flush()


async def test_hub_work_calendar_rejects_bad_weekdays(db_session: AsyncSession) -> None:
    hub = await make_hub(db_session)
    db_session.add(HubWorkCalendar(hub_id=hub.id, weekdays_per_week=8))
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_chamber_downtime_columns_default_and_reject_negative(
    db_session: AsyncSession,
) -> None:
    chamber = Chamber(
        code="T-CH1",
        lab_region=LabRegion.GREECE,
        max_concurrent=1,
        platforms=1,
        efficiency=0.7,
        allowed_stages=["PDD-F"],
    )
    db_session.add(chamber)
    await db_session.flush()
    await db_session.refresh(chamber)
    assert (float(chamber.maintenance_weeks), float(chamber.breakdown_weeks),
            float(chamber.calibration_weeks)) == (2.0, 0.0, 1.0)  # fmt: skip
    chamber.breakdown_weeks = -1
    with pytest.raises(IntegrityError):
        await db_session.flush()


async def test_schedule_run_snapshot_and_new_outcome_columns_round_trip(
    db_session: AsyncSession,
) -> None:
    from models import ScheduleRunProjectOutcome, ScheduleRunProjectStep

    hub = await make_hub(db_session)
    project = await make_project(db_session, hub, target_end_week=40)
    run = await make_schedule_run(db_session, workflow_snapshot={"workflows": [], "lead_times": []})
    db_session.add(
        ScheduleRunProjectStep(
            schedule_run_id=run.id,
            project_id=project.id,
            step_template_id="PDD-C",
            sequence_order=3,
            duration_weeks=0,
            start_week=31,
            end_week=31,
            skipped=True,
        )
    )
    db_session.add(
        ScheduleRunProjectOutcome(
            schedule_run_id=run.id,
            project_id=project.id,
            within_year=True,
            last_step_end_week=45,
            unconstrained_end_week=44,
            expected_end_week=40,
            projected_end_week=45,
            blocked=False,
            progress_pct=0,
            data_error=None,
        )
    )
    await db_session.flush()
    reloaded = await db_session.get(ScheduleRun, run.id)
    assert reloaded is not None
    assert reloaded.workflow_snapshot == {"workflows": [], "lead_times": []}
    assert project.certification_testing_required is True and project.schedule_stale is False
