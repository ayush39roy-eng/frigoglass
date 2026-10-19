"""Priority board (docs/API_CONTRACT_P12.md §2; ADR 0018).

`GET /priority-board?hub_id=`: every project in the caller's scope whose
`priority` is set, grouped into the five `ProjectPriority` columns (P1, P2,
P3, P4, Q, always all five, in that order) and sorted inside a column by
weighted score descending (nulls last), then name, then id (determinism
only). Projects with `priority = null` are not shown.

**P14-T01 (workflow-auditor finding M4).** ADR 0018 puts "schedulable or
pipeline" projects on the board, so only schedulable statuses are listed:
Commercialized, On Hold, Cancelled and Draft (`NON_SCHEDULABLE_STATUSES`)
are excluded. Moving them cannot change the plan. Column `count` and weeks
follow. A `status_` filter naming one of those statuses gives empty columns.

**RBAC.** `MATRIX` READ (Portfolio Manager, Hub Planner, Executive Viewer,
Admin, Super Admin); Engineer and Auditor get 403. Hub-scoped through
`services.hub_scope.hub_scope_filter`; `hub_id` is ANDed with that scope and
never widens it, so an out-of-scope hub gives five empty columns (ADR 0020).

**P13 (docs/API_CONTRACT_P13.md §6).** Further optional filters, all ANDed
server-side with the scope, `hub_id` and `region` (§3 semantics): `q` (a
case-insensitive substring of name or `external_code`, at most 100
characters, matched literally as a bound parameter), `category`, `type`,
`status_` and `leader_engineer_id`. Each column's `count`, `design_weeks`
and `lab_weeks` follow the filtered set; the weeks are each card's remaining
design / lab load in the active run
(`services.capacity_priority.remaining_run_load_by_project`).

There is no write here: a drop calls the existing `POST
/projects/{id}/priority` (ADR 0015), which owns RBAC, the hard-gate 409,
audit, the recalculation and the coalesced follow-up run.
"""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import (
    NON_SCHEDULABLE_STATUSES,
    LabRegion,
    ProjectCategory,
    ProjectPriority,
    ProjectStatus,
    ProjectType,
)
from models.project import Project
from schemas.priority_board import (
    PriorityBoardCard,
    PriorityBoardColumn,
    PriorityBoardResponse,
)
from services.active_run import get_active_run
from services.capacity_priority import remaining_run_load_by_project
from services.capacity_supply import round2
from services.hub_scope import global_hub_filter, hub_scope_filter
from services.project_cards import build_project_cards

router = APIRouter(prefix="/priority-board", tags=["priority-board"])

_read = require_permission(Surface.MATRIX, Action.READ)

#: Column order, fixed by the contract.
COLUMN_ORDER: tuple[ProjectPriority, ...] = (
    ProjectPriority.P1,
    ProjectPriority.P2,
    ProjectPriority.P3,
    ProjectPriority.P4,
    ProjectPriority.Q,
)


def _escape_like(value: str) -> str:
    """Escape LIKE wildcards so `q` is matched literally (bound parameter,
    escape character `\\`)."""

    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


@router.get("", response_model=PriorityBoardResponse)
async def get_priority_board(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    q: Annotated[str | None, Query(max_length=100)] = None,
    category: ProjectCategory | None = None,
    type_: Annotated[ProjectType | None, Query(alias="type")] = None,
    status_: ProjectStatus | None = None,
    leader_engineer_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityBoardResponse:
    stmt = (
        select(Project)
        .options(selectinload(Project.hub))
        .where(
            Project.priority.is_not(None),
            Project.status.not_in(NON_SCHEDULABLE_STATUSES),
        )
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # ADR 0020 hub / ADR 0025 country, ANDed with the scope above.
    global_filter = global_hub_filter(Project.hub_id, hub_id, region)
    if global_filter is not None:
        stmt = stmt.where(global_filter)
    # P13 (contract §6): every predicate a SQLAlchemy expression with bound
    # parameters; nothing is interpolated into SQL.
    if category is not None:
        stmt = stmt.where(Project.category == category)
    if type_ is not None:
        stmt = stmt.where(Project.type == type_)
    if status_ is not None:
        stmt = stmt.where(Project.status == status_)
    if leader_engineer_id is not None:
        stmt = stmt.where(Project.leader_engineer_id == leader_engineer_id)
    term = q.strip() if q is not None else ""
    if term:
        pattern = f"%{_escape_like(term)}%"
        stmt = stmt.where(
            or_(
                Project.name.ilike(pattern, escape="\\"),
                Project.external_code.ilike(pattern, escape="\\"),
            )
        )
    projects = (await db.execute(stmt)).scalars().all()

    active_run = await get_active_run(db)
    cards = await build_project_cards(db, projects, active_run)
    remaining = await remaining_run_load_by_project(db, active_run, [p.id for p in projects])

    by_column: dict[ProjectPriority, list[PriorityBoardCard]] = {p: [] for p in COLUMN_ORDER}
    design_by_column: dict[ProjectPriority, float] = {p: 0.0 for p in COLUMN_ORDER}
    lab_by_column: dict[ProjectPriority, float] = {p: 0.0 for p in COLUMN_ORDER}
    for project in projects:
        assert project.priority is not None  # filtered above
        card = cards[project.id]
        design, lab = remaining.get(project.id, (0.0, 0.0))
        design_by_column[project.priority] += design
        lab_by_column[project.priority] += lab
        by_column[project.priority].append(
            PriorityBoardCard(
                project_id=project.id,
                name=project.name,
                hub_id=project.hub_id,
                hub=project.hub.name,
                category=project.category,
                status=project.status,
                score=card.score,
                band=card.band,
                hard_gated=card.hard_gated,
                is_vip=project.is_vip,
                projected_end_week=card.projected_end_week,
                within_year=card.within_year,
                health=card.health,
                tracking_status=card.tracking_status,
            )
        )

    columns: list[PriorityBoardColumn] = []
    for priority in COLUMN_ORDER:
        column_cards = sorted(
            by_column[priority],
            key=lambda c: (
                c.score is None,
                -(c.score or 0.0),
                c.name,
                str(c.project_id),
            ),
        )
        columns.append(
            PriorityBoardColumn(
                priority=priority,
                count=len(column_cards),
                cards=column_cards,
                design_weeks=round2(design_by_column[priority]),
                lab_weeks=round2(lab_by_column[priority]),
            )
        )
    return PriorityBoardResponse(
        run_id=active_run.id if active_run is not None else None, columns=columns
    )
