"""Demand load (ADR 0041 I25, R9, R12; P30-T02): the design and lab weeks the
stored projects ask for, from live project and step rows, never from a run.

The arithmetic is the scheduler package's (`scheduling.demand`, pure):
`compute_demand_load` over `LiveProjectRow`s, with the same `eff(p, s)` the
scheduler uses (`user ?? effort ?? lead`, 0 when skipped). This module only
reads the rows:

- **Full-year demand** per capacity hub (ADR 0042: own + member hubs) = Σ eff
  over design-kind steps of every project with status ∉ {Cancelled, Draft}
  (On Hold and Commercialized included: client ruling 2026-10-22).
- **Remaining demand** = Σ rem over the same steps, for projects in a
  schedulable status (In Buyoff, Under Industrialization, In Development,
  In Queue): 0 for a Done or skipped stage, the derived remaining duration
  for In Progress / Blocked, eff for Not Started. Effort weeks, never a span,
  not windowed to W52.
- **Lab** the same per lab region (of the project's hub), × 1.0.

`load_demand` returns the totals (`DemandLoad`, exactly
`compute_demand_load` of every stored project) and each project's own
figures (`compute_demand_load` of that one project), so a breakdown (the
ADR 0042 `members`, the priority split, the P1 capacity fill) always sums to
the totals. Scope: every stored project is read, whatever the caller may
see; only aggregates leave a capacity endpoint (the ADR 0042 §8 rule), and
the callers filter the per-project figures by their own scope.

Lead times come from the lead-time table in force
(`workflow_lead_times[workflow][category][step]`), step kinds from Workflow
Settings, stage progress from the live rows.

**P33-T08 (ADR 0046 OR-3, contract P33 F4).** Each `LiveStepRow` carries the
live builder's own mapping (`services.workflow_durations.
run_input_lead_and_override`): `lead_weeks` = the template's immutable
`effort_weight_weeks` on a step whose kind follows the project's own effort
figure, else the project's copy `plan_weeks`; the override = the effort
share on an own-effort step, else none (P33-T13: the hand-set user
override is retired and always null since p33c, ADR 0048). So the
scheduler package evaluates exactly the `eff` the run is solved with
(R33-1), which equals DOMAIN_RULES §B: an own-effort kind loads `E + raised`
whatever the template says, every other step its `plan_weeks`. Demand moves
when a copy is written (I25 at commit); a template edit alone moves nothing.
The weights are also what `check_i26_effort_split` splits over (R33-2).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.enums import LabRegion, ProjectPriority, ProjectStatus
from models.hub import Hub
from models.project import Project, workflow_id_for_hub
from models.workflow import ProjectWorkflowStep, WorkflowLeadTime, WorkflowStepTemplate
from scheduling.demand import (
    FULL_YEAR_EXCLUDED_STATUSES,
    DemandLoad,
    LiveProjectRow,
    LiveStepRow,
    compute_demand_load,
)
from services.workflow_durations import own_effort_kinds, run_input_lead_and_override


@dataclass(frozen=True)
class ProjectDemand:
    """One project's own I25 figures and what a breakdown needs."""

    project_id: uuid.UUID
    hub_id: uuid.UUID
    capacity_hub_id: uuid.UUID
    lab_region: LabRegion
    status: ProjectStatus
    priority: ProjectPriority | None
    #: In the full-year scope (status ∉ {Cancelled, Draft}).
    in_full_year: bool
    design_full_year: int
    design_remaining: int
    lab_full_year: float
    lab_remaining: float


@dataclass(frozen=True)
class DemandSnapshot:
    """`compute_demand_load` of every stored project (`totals`, keyed by
    capacity hub NAME / lab region VALUE as the scheduler package keys them),
    plus the per-project figures and the rows they came from."""

    totals: DemandLoad
    projects: dict[uuid.UUID, ProjectDemand] = field(default_factory=dict)
    rows: tuple[LiveProjectRow, ...] = ()

    def design_full_year(self, capacity_hub_name: str) -> int:
        return int(self.totals.design_full_year.get(capacity_hub_name, 0))

    def design_remaining(self, capacity_hub_name: str) -> int:
        return int(self.totals.design_remaining.get(capacity_hub_name, 0))

    def lab_full_year(self, region: LabRegion) -> float:
        return float(self.totals.lab_full_year.get(region.value, 0.0))

    def lab_remaining(self, region: LabRegion) -> float:
        return float(self.totals.lab_remaining.get(region.value, 0.0))

    def by_hub(self) -> dict[uuid.UUID, list[ProjectDemand]]:
        out: dict[uuid.UUID, list[ProjectDemand]] = defaultdict(list)
        for d in self.projects.values():
            out[d.hub_id].append(d)
        return out


def _live_step_row(
    s: ProjectWorkflowStep,
    *,
    kind: str,
    own_kinds: frozenset[str],
    table_weeks: int,
    weight_weeks: int,
) -> LiveStepRow:
    """One live row in the run input's terms (OR-3 / F4, see the module
    docstring): `lead_weeks` is the scheduler's `lead_weeks ?? table`."""

    lead_weeks, _override = run_input_lead_and_override(
        plan_weeks=s.plan_weeks,
        effort_weight_weeks=weight_weeks,
        table_weeks=table_weeks,
        own_effort=kind in own_kinds,
        effort_weeks=s.effort_weeks,
        excluded=s.excluded,
        kind=kind,
        lab_hold_weeks=s.plan_lab_hold_weeks,
    )
    return LiveStepRow(
        step_id=s.step_template_id,
        sequence_order=s.sequence_order,
        kind=kind,
        lead_weeks=table_weeks if lead_weeks is None else lead_weeks,
        # The scheduler package merges `user ?? effort`, which is the builder's
        # override on every step: a non-null effort makes its kind own effort
        # (OR-1), so a step of another kind has no effort to merge. There is
        # no user figure any more (ADR 0048, p33c: always null).
        user_override_weeks=None,
        effort_weeks=s.effort_weeks,
        status=s.status.value,
        percent_complete=s.percent_complete,
        remaining_weeks_override=s.remaining_weeks_override,
        # R35-1 (P35): `eff = 0` first, in `scheduling.demand` too (I25/I33).
        excluded=s.excluded,
        # ADR 0071: the copy's room weeks (I25 lab half `min(hold, ·)`).
        lab_hold_weeks=s.plan_lab_hold_weeks,
    )


async def load_live_project_rows(
    db: AsyncSession, project_ids: list[uuid.UUID] | None = None
) -> tuple[list[LiveProjectRow], dict[str, tuple[Project, Hub, Hub]]]:
    """Every stored project (or the given ones) as a `LiveProjectRow`, with
    `(project, hub, capacity hub)` by project id string. Constant query
    count: hubs, projects, steps, templates, lead times."""

    hubs = {h.id: h for h in (await db.execute(select(Hub))).scalars().all()}
    stmt = select(Project).order_by(Project.id)
    if project_ids is not None:
        if not project_ids:
            return [], {}
        stmt = stmt.where(Project.id.in_(project_ids))
    projects = list((await db.execute(stmt)).scalars().all())
    if not projects:
        return [], {}
    kinds = {
        t_id: kind.value
        for t_id, kind in (
            await db.execute(select(WorkflowStepTemplate.id, WorkflowStepTemplate.kind))
        ).all()
    }
    lead_rows = (await db.execute(select(WorkflowLeadTime))).scalars().all()
    lead = {(lt.workflow_id, lt.category, lt.step_id): int(lt.weeks) for lt in lead_rows}
    weight = {
        (lt.workflow_id, lt.category, lt.step_id): int(lt.effort_weight_weeks) for lt in lead_rows
    }
    steps: dict[uuid.UUID, list[ProjectWorkflowStep]] = defaultdict(list)
    step_stmt = select(ProjectWorkflowStep).order_by(
        ProjectWorkflowStep.project_id, ProjectWorkflowStep.sequence_order
    )
    if project_ids is not None:
        step_stmt = step_stmt.where(ProjectWorkflowStep.project_id.in_(project_ids))
    for s in (await db.execute(step_stmt)).scalars():
        steps[s.project_id].append(s)

    rows: list[LiveProjectRow] = []
    meta: dict[str, tuple[Project, Hub, Hub]] = {}
    for p in projects:
        hub = hubs[p.hub_id]
        cap = hubs.get(hub.capacity_hub_id or hub.id, hub)
        workflow_id = workflow_id_for_hub(hub.is_oem)
        category = p.category
        own_kinds = own_effort_kinds(
            ((s.step_template_id, s.effort_weeks) for s in steps.get(p.id, [])), kinds
        )
        rows.append(
            LiveProjectRow(
                project_id=str(p.id),
                hub=hub.name.value,
                capacity_hub=cap.name.value,
                status=p.status.value,
                frozen=p.frozen,
                certification_testing_required=p.certification_testing_required,
                design_effort_weeks=p.design_effort_weeks,
                lab_effort_weeks=p.lab_effort_weeks,
                # P42 (R42-6, I25 remaining): the stored band, so a non-frozen
                # P4/Q project leaves remaining demand.
                priority=p.priority.value if p.priority is not None else None,
                steps=tuple(
                    _live_step_row(
                        s,
                        kind=kinds.get(s.step_template_id, "elapsed"),
                        own_kinds=own_kinds,
                        table_weeks=lead.get((workflow_id, category or "", s.step_template_id), 0),
                        weight_weeks=weight.get(
                            (workflow_id, category or "", s.step_template_id), 0
                        ),
                    )
                    for s in steps.get(p.id, [])
                ),
            )
        )
        meta[str(p.id)] = (p, hub, cap)
    return rows, meta


async def load_demand(
    db: AsyncSession, project_ids: list[uuid.UUID] | None = None
) -> DemandSnapshot:
    """I25 over every stored project (or the given ones; a subset gives the
    subset's figures, used by the P1 capacity fill)."""

    rows, meta = await load_live_project_rows(db, project_ids)
    totals = compute_demand_load(rows)
    per_project: dict[uuid.UUID, ProjectDemand] = {}
    for row in rows:
        p, hub, cap = meta[row.project_id]
        own = compute_demand_load([row])
        region = hub.lab_region.value
        per_project[p.id] = ProjectDemand(
            project_id=p.id,
            hub_id=hub.id,
            capacity_hub_id=cap.id,
            lab_region=hub.lab_region,
            status=p.status,
            priority=p.priority,
            in_full_year=p.status.value not in FULL_YEAR_EXCLUDED_STATUSES,
            design_full_year=int(own.design_full_year.get(row.capacity_hub, 0)),
            design_remaining=int(own.design_remaining.get(row.capacity_hub, 0)),
            lab_full_year=float(own.lab_full_year.get(region, 0.0)),
            lab_remaining=float(own.lab_remaining.get(region, 0.0)),
        )
    return DemandSnapshot(totals=totals, projects=per_project, rows=tuple(rows))
