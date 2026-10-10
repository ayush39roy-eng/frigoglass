"""Priority board (docs/API_CONTRACT_P12.md §2; ADR 0018).

`GET /priority-board?hub_id=`: every project in the caller's scope whose
`priority` is set, grouped into the five `ProjectPriority` columns (P1, P2,
P3, P4, Q, always all five, in that order) and sorted inside a column by
weighted score descending (nulls last), then name, then id (determinism
only). Projects with `priority = null` are not shown.

**RBAC.** `MATRIX` READ (Portfolio Manager, Hub Planner, Executive Viewer,
Admin, Super Admin); Engineer and Auditor get 403. Hub-scoped through
`services.hub_scope.hub_scope_filter`; `hub_id` is ANDed with that scope and
never widens it, so an out-of-scope hub gives five empty columns (ADR 0020).

There is no write here: a drop calls the existing `POST
/projects/{id}/priority` (ADR 0015), which owns RBAC, the hard-gate 409,
audit, the recalculation and the coalesced follow-up run.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from core.principal import Principal
from core.rbac import Action, Surface
from models.enums import ProjectPriority
from models.project import Project
from schemas.priority_board import (
    PriorityBoardCard,
    PriorityBoardColumn,
    PriorityBoardResponse,
)
from services.active_run import get_active_run
from services.hub_scope import hub_scope_filter
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


@router.get("", response_model=PriorityBoardResponse)
async def get_priority_board(
    hub_id: uuid.UUID | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> PriorityBoardResponse:
    stmt = (
        select(Project)
        .options(selectinload(Project.hub))
        .where(Project.priority.is_not(None))
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    if hub_id is not None:
        stmt = stmt.where(Project.hub_id == hub_id)
    projects = (await db.execute(stmt)).scalars().all()

    active_run = await get_active_run(db)
    cards = await build_project_cards(db, projects, active_run)

    by_column: dict[ProjectPriority, list[PriorityBoardCard]] = {p: [] for p in COLUMN_ORDER}
    for project in projects:
        assert project.priority is not None  # filtered above
        card = cards[project.id]
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
            PriorityBoardColumn(priority=priority, count=len(column_cards), cards=column_cards)
        )
    return PriorityBoardResponse(
        run_id=active_run.id if active_run is not None else None, columns=columns
    )
