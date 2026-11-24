"""One-time effort-weight sync (ADR 0070; owner decision 2026-11-24, "Split
the figure").

Before ADR 0070 a template apply that set a step's length 0 -> N left its
`effort_weight_weeks` at 0 (R33-2, immutable), so projects with their own
effort figure for the step's kind never split any of it onto the step (OR-4
`own_effort_length_not_applied`), and the step stayed skipped. This catch-up
brings the saved data to the ADR 0070 rule, the same as if the apply had
run under it:

1. every template row with `weeks > 0` and `effort_weight_weeks = 0` gets
   weight = `weeks` (the DB trigger allows exactly this change, p70a);
2. every project of those categories that is not frozen, not Cancelled and
   not Commercialized, has its own effort for the step's kind (OR-1) and has
   not reached the step (R33-10) receives it
   (`services.template_apply.plan_effort_revive`): its copy `plan_weeks`
   becomes the template length and its effort is re-derived
   (`services.project_effort.rederive_project_effort`, audit
   `project.effort_rederived`, trigger `effort_weight_sync`). A re-split
   that would change a reached step's share is refused (`started_share`);
3. the changed projects are marked `schedule_stale`; no run is dispatched
   (recalculation is manual, ADR 0069).

Projects without their own effort for the kind are not touched (the apply
already decided their copy). A project that does not receive the revive
keeps its copy 0, so the held-back rule keeps the step out of every later
split of it (`services.project_effort.held_out`).

A dry run computes exactly the same lists without a lock or a write.
Idempotent: after an apply no row has `weeks > 0` with weight 0, so a second
call finds nothing.

Audit (apply only): one `workflow_template.effort_weights_synced` summary
(the revived rows, every project id received and skipped), one
`project.effort_weight_synced` per receiving project (copy before / after),
plus the re-derivation's own `project.effort_rederived`. No financial field
is read or written; effort figures are not financial.
"""

from __future__ import annotations

import uuid
from collections import defaultdict

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from models.audit import AuditLogEntry
from models.enums import ProjectStatus
from models.project import Project, workflow_id_for_hub
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime
from schemas.workflow_templates import (
    EffortWeightSyncCategory,
    EffortWeightSyncCounts,
    EffortWeightSyncProject,
    EffortWeightSyncResponse,
    EffortWeightSyncSkipped,
    EffortWeightSyncSkipReason,
    EffortWeightSyncStep,
)
from services.project_effort import (
    TRIGGER_EFFORT_WEIGHT_SYNC,
    effort_weights,
    rederive_project_effort,
    template_kinds,
)
from services.schedule_stale import mark_projects_stale
from services.template_apply import lock_projects, plan_effort_revive
from services.template_copy import load_predecessors, reached_step_ids
from services.template_editor import load_categories
from services.workflow_durations import own_effort_kinds

AUDIT_SUMMARY = "workflow_template.effort_weights_synced"
AUDIT_PROJECT = "project.effort_weight_synced"

_CLOSED: dict[ProjectStatus, EffortWeightSyncSkipReason] = {
    ProjectStatus.CANCELLED: "cancelled",
    ProjectStatus.COMMERCIALIZED: "commercialized",
}


def _skipped(
    p: Project, reason: EffortWeightSyncSkipReason, step_ids: list[str]
) -> EffortWeightSyncSkipped:
    return EffortWeightSyncSkipped(
        project_id=p.id, name=p.name, category=p.category or "", reason=reason, step_ids=step_ids
    )


async def _revive_rows(db: AsyncSession) -> list[WorkflowLeadTime]:
    return list(
        (
            await db.execute(
                select(WorkflowLeadTime)
                .where(WorkflowLeadTime.weeks > 0, WorkflowLeadTime.effort_weight_weeks == 0)
                .order_by(
                    WorkflowLeadTime.workflow_id,
                    WorkflowLeadTime.category,
                    WorkflowLeadTime.step_id,
                )
                .execution_options(populate_existing=True)
            )
        ).scalars()
    )


async def sync_effort_weights(
    db: AsyncSession, *, dry_run: bool, actor_user_id: uuid.UUID | None
) -> EffortWeightSyncResponse:
    """The catch-up (module docstring). With `dry_run=False` the caller holds
    the band-rank lock and commits; this takes the category rows `FOR NO KEY
    UPDATE` (as the apply) and then the categories' project rows `FOR
    UPDATE` in id order before evaluating. Raises `EffortSplitRejected` only
    if a re-derivation disagrees with its prediction (never expected)."""

    rows = await _revive_rows(db)
    if rows and not dry_run:
        await load_categories(db, sorted({r.category for r in rows}), lock=True)
        rows = await _revive_rows(db)
    kinds = await template_kinds(db)
    revive: dict[tuple[str, str], dict[str, int]] = defaultdict(dict)
    for r in rows:
        revive[(r.workflow_id, r.category)][r.step_id] = r.weeks
    categories = [
        EffortWeightSyncCategory(
            workflow_id=wf,
            category=cat,
            steps=[
                EffortWeightSyncStep(
                    step_id=r.step_id,
                    kind=kinds.get(r.step_id, "elapsed"),
                    weeks=r.weeks,
                    weight_before=0,
                    weight_after=r.weeks,
                )
                for r in rows
                if (r.workflow_id, r.category) == (wf, cat)
            ],
        )
        for wf, cat in sorted(revive)
    ]

    received: list[tuple[Project, list[ProjectWorkflowStep], dict[str, int], dict[str, int | None]]]
    received = []
    skipped: list[EffortWeightSyncSkipped] = []
    if revive:
        weights = {key: await effort_weights(db, *key) for key in revive}
        predecessors = {wf: await load_predecessors(db, wf) for wf in {k[0] for k in revive}}
        codes = sorted({k[1] for k in revive})
        project_ids = sorted(
            (await db.execute(select(Project.id).where(Project.category.in_(codes)))).scalars()
        )
        if not dry_run:
            await lock_projects(db, project_ids)
        projects = (
            (
                await db.execute(
                    select(Project)
                    .options(selectinload(Project.hub))
                    .where(Project.id.in_(project_ids))
                    .execution_options(populate_existing=True)
                )
            )
            .scalars()
            .all()
        )
        steps_by_project: dict[uuid.UUID, list[ProjectWorkflowStep]] = defaultdict(list)
        if project_ids:
            for s in (
                await db.execute(
                    select(ProjectWorkflowStep)
                    .where(ProjectWorkflowStep.project_id.in_(project_ids))
                    .order_by(ProjectWorkflowStep.project_id, ProjectWorkflowStep.sequence_order)
                    .execution_options(populate_existing=True)
                )
            ).scalars():
                steps_by_project[s.project_id].append(s)

        for p in sorted(projects, key=lambda x: (x.name, str(x.id))):
            key = (workflow_id_for_hub(p.hub.is_oem), p.category or "")
            if key not in revive:
                continue
            steps = steps_by_project.get(p.id, [])
            own = own_effort_kinds(((s.step_template_id, s.effort_weeks) for s in steps), kinds)
            relevant = sorted(sid for sid in revive[key] if kinds.get(sid, "elapsed") in own)
            if not relevant:
                continue  # no own effort for the kind: the apply decided its copy
            if p.frozen:
                skipped.append(_skipped(p, "frozen", relevant))
                continue
            if p.status in _CLOSED:
                skipped.append(_skipped(p, _CLOSED[p.status], relevant))
                continue
            reached = reached_step_ids(
                {s.step_template_id: s.status for s in steps}, predecessors[key[0]]
            )
            plan = plan_effort_revive(
                p,
                steps,
                kinds,
                reached,
                {**weights[key], **revive[key]},
                {sid: revive[key][sid] for sid in relevant},
            )
            by_reason: dict[str, list[str]] = defaultdict(list)
            for sid, reason in sorted(plan.not_applied.items()):
                by_reason[reason].append(sid)
            for reason, sids in sorted(by_reason.items()):
                skipped.append(_skipped(p, reason, sids))  # type: ignore[arg-type]
            if plan.effort_after is not None:
                received.append((p, steps, {sid: revive[key][sid] for sid in plan.step_ids},
                                 plan.effort_after))  # fmt: skip

    projects_out = []
    for p, steps, step_weeks, after in received:
        before = {s.step_template_id: s.effort_weeks for s in steps}
        diff = sorted(sid for sid in before if before[sid] != after.get(sid))
        projects_out.append(
            EffortWeightSyncProject(
                project_id=p.id,
                name=p.name,
                category=p.category or "",
                step_ids=sorted(step_weeks),
                effort_before={sid: before[sid] for sid in diff},
                effort_after={sid: after.get(sid) for sid in diff},
            )
        )
    project_ids_out = [p.id for p, *_ in received]
    response = EffortWeightSyncResponse(
        dry_run=dry_run,
        counts=EffortWeightSyncCounts(
            template_rows=len(rows),
            categories=len(categories),
            projects_rederived=len(received),
            projects_skipped=len({s.project_id for s in skipped}),
        ),
        categories=categories,
        projects=projects_out,
        skipped=skipped,
        project_ids=project_ids_out,
    )
    if dry_run or not rows:
        return response

    # --- apply: weights, copies, effort, stale, audit (one transaction) ---
    for r in rows:
        await db.execute(
            update(WorkflowLeadTime)
            .where(
                WorkflowLeadTime.workflow_id == r.workflow_id,
                WorkflowLeadTime.category == r.category,
                WorkflowLeadTime.step_id == r.step_id,
                WorkflowLeadTime.effort_weight_weeks == 0,
            )
            .values(effort_weight_weeks=r.weeks)
            .execution_options(synchronize_session=False)
        )
    await db.flush()
    for p, steps, step_weeks, _after in received:
        by_step = {s.step_template_id: s for s in steps}
        copy_before: dict[str, int] = {}
        copy_after: dict[str, int] = {}
        for sid, weeks in sorted(step_weeks.items()):
            row = by_step[sid]
            if row.plan_weeks != weeks:
                copy_before[sid], copy_after[sid] = row.plan_weeks, weeks
                row.plan_weeks = weeks
        db.add(
            AuditLogEntry(
                actor_user_id=actor_user_id,
                action=AUDIT_PROJECT,
                entity_type="Project",
                entity_id=str(p.id),
                hub_id=p.hub_id,
                before_state={"plan_weeks": copy_before},
                after_state={
                    "plan_weeks": copy_after,
                    "category": p.category,
                    "revived_step_ids": sorted(step_weeks),
                },
            )
        )
        await db.flush()
        await rederive_project_effort(
            db,
            p,
            trigger=TRIGGER_EFFORT_WEIGHT_SYNC,
            actor_user_id=actor_user_id,
            kinds=kinds,
            rows=steps,
        )
    await mark_projects_stale(db, project_ids_out)
    db.add(
        AuditLogEntry(
            actor_user_id=actor_user_id,
            action=AUDIT_SUMMARY,
            entity_type="WorkflowLeadTime",
            entity_id="effort_weight_sync",
            hub_id=None,
            before_state=None,
            after_state={
                "categories": [c.model_dump(mode="json") for c in categories],
                "rederived": [str(pid) for pid in project_ids_out],
                "skipped": [
                    {"project_id": str(s.project_id), "reason": s.reason, "step_ids": s.step_ids}
                    for s in skipped
                ],
            },
        )
    )
    await db.flush()
    return response
