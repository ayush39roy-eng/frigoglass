"""Batch read model for project cards (Priority board, ADR 0018; VIP
projects, ADR 0022). Every value comes from a stored row or from the one
shared function that already serves it elsewhere; nothing is recomputed:

- projected finish, within-year, expected finish: the active run's
  `ScheduleRunProjectOutcome` (I9, I16);
- health: `services.workspace.health_badge` over the active run's stored rows
  (I13). The Workspace's `unscheduled` (no outcome) is served as `null`;
- progress: `services.progress.project_progress_pct` over the live percents
  with effective durations and skipped steps weighted 0, exactly as the
  Workspace computes it (I12, ruling 3);
- score / band / hard gates: the cached `PriorityScore` the Matrix serves
  (`weighted_score`, `suggested_band`, `hard_gates`);
- tracking status: `services.tracking` (ADR 0021 §4).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.enums import ProjectPriority, WorkflowStepKind, WorkflowStepStatus
from models.priority import PriorityScore
from models.project import Project
from models.schedule import ScheduleRun, ScheduleRunProjectOutcome, ScheduleRunProjectStep
from models.workflow import ProjectWorkflowStep, WorkflowStepTemplate
from services.progress import project_progress_pct
from services.tracking import TrackingStatus, due_stages_for, status_from_due_stages
from services.workflow_durations import effective_duration_weeks
from services.workspace import engineer_ftes_for_rows, health_badge, is_step_skipped

CardHealth = Literal["on_track", "at_risk", "off_track", "left_out", "blocked"]


@dataclass(frozen=True)
class CurrentStage:
    step_id: str
    step_name: str
    status: WorkflowStepStatus


@dataclass(frozen=True)
class ProjectCard:
    project_id: uuid.UUID
    score: float | None
    band: ProjectPriority | None
    hard_gated: bool
    expected_end_week: int | None
    projected_end_week: int | None
    within_year: bool | None
    health: CardHealth | None
    progress_pct: int | None
    current_stage: CurrentStage | None
    tracking_status: TrackingStatus
    #: Every non-skipped step week range of the active run, for year
    #: membership (ADR 0022 §2). Empty when the project is not in the run.
    run_step_ranges: tuple[tuple[int, int], ...]
    in_active_run: bool


async def build_project_cards(
    db: AsyncSession, projects: Sequence[Project], active_run: ScheduleRun | None
) -> dict[uuid.UUID, ProjectCard]:
    ids = [p.id for p in projects]
    if not ids:
        return {}

    scores = {
        s.project_id: s
        for s in (
            await db.execute(select(PriorityScore).where(PriorityScore.project_id.in_(ids)))
        ).scalars()
    }
    templates = {
        t.id: t for t in (await db.execute(select(WorkflowStepTemplate))).scalars().all()
    }
    live_by_project: dict[uuid.UUID, list[ProjectWorkflowStep]] = defaultdict(list)
    for row in (
        await db.execute(
            select(ProjectWorkflowStep)
            .where(ProjectWorkflowStep.project_id.in_(ids))
            .order_by(ProjectWorkflowStep.sequence_order)
        )
    ).scalars():
        live_by_project[row.project_id].append(row)

    outcomes: dict[uuid.UUID, ScheduleRunProjectOutcome] = {}
    run_steps_by_project: dict[uuid.UUID, list[ScheduleRunProjectStep]] = defaultdict(list)
    if active_run is not None:
        outcomes = {
            o.project_id: o
            for o in (
                await db.execute(
                    select(ScheduleRunProjectOutcome).where(
                        ScheduleRunProjectOutcome.schedule_run_id == active_run.id,
                        ScheduleRunProjectOutcome.project_id.in_(ids),
                    )
                )
            ).scalars()
        }
        for step in (
            await db.execute(
                select(ScheduleRunProjectStep).where(
                    ScheduleRunProjectStep.schedule_run_id == active_run.id,
                    ScheduleRunProjectStep.project_id.in_(ids),
                )
            )
        ).scalars():
            run_steps_by_project[step.project_id].append(step)

    # ADR 0032: the health badge's planned span of a design row is stretched
    # by its engineer's FTE.
    fte_by_engineer = await engineer_ftes_for_rows(
        db, (s for steps in run_steps_by_project.values() for s in steps)
    )
    due = await due_stages_for(db, ids, active_run=active_run)
    run_week = active_run.current_week if active_run is not None else dc.CURRENT_WEEK

    cards: dict[uuid.UUID, ProjectCard] = {}
    for project in projects:
        score = scores.get(project.id)
        outcome = outcomes.get(project.id)
        run_steps = run_steps_by_project.get(project.id, [])
        run_by_step = {s.step_template_id: s for s in run_steps}
        live_rows = live_by_project.get(project.id, [])
        live_by_step = {r.step_template_id: r for r in live_rows}

        health: CardHealth | None = None
        if active_run is not None:
            badge = health_badge(
                outcome,
                run_steps,
                live_by_step,
                run_week,
                fte_by_engineer=fte_by_engineer,
                frozen=project.frozen,
            )
            health = None if badge == "unscheduled" else badge

        current: CurrentStage | None = None
        weighted: list[tuple[int, int]] = []
        for row in live_rows:
            template = templates.get(row.step_template_id)
            kind = template.kind if template is not None else WorkflowStepKind.DESIGN
            run_step = run_by_step.get(row.step_template_id)
            # Progress weights: the Workspace's exact formula (ruling 3).
            lead_skipped = is_step_skipped(
                row.duration_weeks, kind, project.certification_testing_required
            )
            weighted.append(
                (
                    row.percent_complete,
                    0
                    if lead_skipped
                    else effective_duration_weeks(row.duration_weeks, row.duration_override_weeks),
                )
            )
            skipped = run_step.skipped if run_step is not None else lead_skipped
            if current is None and not skipped and row.status != WorkflowStepStatus.DONE:
                current = CurrentStage(
                    step_id=row.step_template_id,
                    step_name=template.name if template is not None else row.step_template_id,
                    status=row.status,
                )
        progress = project_progress_pct(weighted) if live_rows else None

        cards[project.id] = ProjectCard(
            project_id=project.id,
            score=(
                float(score.weighted_score)
                if score is not None and score.weighted_score is not None
                else None
            ),
            band=score.suggested_band if score is not None else None,
            hard_gated=bool(score.hard_gates) if score is not None else False,
            expected_end_week=outcome.expected_end_week if outcome is not None else None,
            projected_end_week=outcome.projected_end_week if outcome is not None else None,
            within_year=outcome.within_year if outcome is not None else None,
            health=health,
            progress_pct=progress,
            current_stage=current,
            tracking_status=status_from_due_stages(due.get(project.id, [])),
            run_step_ranges=tuple(
                (s.start_week, s.end_week) for s in run_steps if not s.skipped
            ),
            in_active_run=outcome is not None,
        )
    return cards
