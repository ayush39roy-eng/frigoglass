"""P1 capacity fill, the read side (ADR 0036, P25-T01, docs/API_CONTRACT_P25.md).

Loads, in one pass and with a fixed number of queries whatever the number of
projects (no N+1), everything `services.priority_scoring.fill_p1_capacity`
needs for a set of hubs, and runs it once per hub:

- capacity `C` = the hub's remaining-year design capacity, computed exactly as
  `GET /capacity/hub-load` serves `design_capacity_remaining`
  (`services.capacity_supply.design_capacity` on the hub's calendar, Σ FTE of
  the hub's engineers, `domain_constants.CURRENT_WEEK`, rounded to 2 dp);
- each scored project's remaining design effort in the active run
  (`services.capacity_priority.remaining_run_load_by_project`, effort weeks,
  ADR 0032); a project not in the run counts 0;
- the live status (schedulable or not) and the stored `normalized_pct`.

**Reads only.** Nothing here writes `Project.priority` or a score. The fill
for a hub uses every project of that hub, whatever filter the request applied
to its rows, so the per-hub result is the same for every caller who may see
that hub (callers pass only hubs already inside the caller's scope).
No active run → no promotion anywhere.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Collection, Mapping
from dataclasses import dataclass, field
from decimal import Decimal
from types import EllipsisType

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from models.engineer import Engineer
from models.enums import NON_SCHEDULABLE_STATUSES, HubName, ProjectPriority
from models.hub import Hub, HubWorkCalendar
from models.priority import PriorityScore
from models.project import Project
from models.schedule import ScheduleRun
from services.active_run import get_active_run
from services.capacity_priority import remaining_run_load_by_project
from services.capacity_supply import design_capacity, fte_sum, round2
from services.priority_scoring import (
    FillProject,
    HubFill,
    capacity_fill_reason,
    fill_p1_capacity,
    to_weeks,
)


@dataclass(frozen=True)
class RowFill:
    """The four served row fields (ADR 0036 §5)."""

    suggested_band: ProjectPriority | None
    score_band: ProjectPriority | None
    capacity_fill: bool
    capacity_fill_reason: str | None


@dataclass(frozen=True)
class CapacityFill:
    run: ScheduleRun | None
    hubs: dict[uuid.UUID, HubFill] = field(default_factory=dict)
    hub_names: dict[uuid.UUID, HubName] = field(default_factory=dict)

    def for_row(
        self, project_id: uuid.UUID, hub_id: uuid.UUID, score_band: ProjectPriority | None
    ) -> RowFill:
        hub = self.hubs.get(hub_id)
        decision = hub.decisions.get(project_id) if hub is not None else None
        promoted = decision is not None and decision.outcome == "promoted"
        return RowFill(
            suggested_band=ProjectPriority.P1 if promoted else score_band,
            score_band=score_band,
            capacity_fill=promoted,
            capacity_fill_reason=(
                capacity_fill_reason(decision, hub.capacity_weeks)
                if hub is not None and decision is not None
                else None
            ),
        )


async def compute_capacity_fill(
    db: AsyncSession,
    hub_ids: Collection[uuid.UUID],
    *,
    active_run: ScheduleRun | None | EllipsisType = ...,
    normalized_override: Mapping[uuid.UUID, int | None] | None = None,
) -> CapacityFill:
    """The P1 capacity fill of every hub in `hub_ids` (callers pass in-scope
    hubs only). Query count is constant: hubs, projects + scores, engineers,
    calendars, the active run, and `remaining_run_load_by_project`'s own.

    P25-T03: a caller that already loaded the active run (the Priority board,
    the Workspace) passes it as `active_run` (`None` = there is none), so it
    is not read twice. Omitted, the loader reads it itself.

    P26-T01 (ADR 0037): `normalized_override` replaces the stored
    `normalized_pct` of the projects it names (None = unscored), so the
    rubric preview can show the suggested band a proposed rubric would give,
    through the very same walk. Projects it does not name keep their stored
    score."""

    ids = sorted(set(hub_ids), key=str)
    run = await get_active_run(db) if isinstance(active_run, EllipsisType) else active_run
    if not ids:
        return CapacityFill(run=run)

    hub_names = {
        h_id: name
        for h_id, name in (await db.execute(select(Hub.id, Hub.name).where(Hub.id.in_(ids)))).all()
    }
    fte_values: dict[uuid.UUID, list[object]] = defaultdict(list)
    for eng_hub_id, fte in (
        await db.execute(select(Engineer.hub_id, Engineer.fte).where(Engineer.hub_id.in_(ids)))
    ).all():
        fte_values[eng_hub_id].append(fte)
    calendars = {
        c.hub_id: c
        for c in (await db.execute(select(HubWorkCalendar).where(HubWorkCalendar.hub_id.in_(ids))))
        .scalars()
        .all()
    }
    capacity: dict[uuid.UUID, Decimal] = {}
    for h_id in hub_names:
        _year, remaining = design_capacity(
            calendars.get(h_id), fte_sum(fte_values.get(h_id, [])), dc.CURRENT_WEEK
        )
        capacity[h_id] = to_weeks(round2(remaining))

    if run is None:
        zero = Decimal("0.00")
        return CapacityFill(
            run=None,
            hubs={h: HubFill(capacity[h], zero, zero, {}) for h in hub_names},
            hub_names=hub_names,
        )

    stmt = (
        select(Project.id, Project.hub_id, Project.status, PriorityScore.normalized_pct)
        .join(PriorityScore, PriorityScore.project_id == Project.id)
        .where(Project.hub_id.in_(ids))
    )
    if normalized_override is None:
        stmt = stmt.where(PriorityScore.normalized_pct.is_not(None))
    scored = [
        (pid, h, st, normalized_override.get(pid, pct) if normalized_override is not None else pct)
        for pid, h, st, pct in (await db.execute(stmt)).all()
    ]
    scored = [row for row in scored if row[3] is not None]
    loads = await remaining_run_load_by_project(db, run, [pid for pid, *_ in scored])

    by_hub: dict[uuid.UUID, list[FillProject]] = defaultdict(list)
    for pid, p_hub_id, p_status, pct in scored:
        design_weeks = loads.get(pid, (0.0, 0.0))[0]
        by_hub[p_hub_id].append(
            FillProject(
                project_id=pid,
                normalized_pct=pct,
                schedulable=p_status not in NON_SCHEDULABLE_STATUSES,
                remaining_design_weeks=to_weeks(design_weeks),
            )
        )
    return CapacityFill(
        run=run,
        hubs={h: fill_p1_capacity(capacity[h], by_hub.get(h, [])) for h in hub_names},
        hub_names=hub_names,
    )
