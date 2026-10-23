"""VIP projects (docs/API_CONTRACT_P12.md §6; ADR 0022; DOMAIN_RULES "VIP
projects").

**`GET /vip-projects?year=plan|next&hub_id=&limit=15`**, `DASHBOARD` READ,
hub-scoped (`hub_id` is ANDed with the caller's scope and never widens it;
an out-of-scope hub gives no hubs). Per hub, at most `limit` (10..15)
projects:
1. pinned in-year projects (`projects.is_vip`) first, all of them, even
   past `limit` (the hub is then flagged `over_limit`; a pin is never
   dropped);
2. then automatic fill up to `limit` from the remaining in-year projects.
Both groups are ordered by priority (P1 → P4, then Q, then none), weighted
score descending (nulls last), name (then id, for determinism only).

**Year membership.** `plan` = weeks 1..52, `next` = weeks 53..78. A project
is in a year when any of its non-skipped step ranges in the active run
overlaps that range. A project with nothing placed in the active run (not in
the run yet, or in it with no placed step) belongs to `plan`.

**Decision beyond the contract:** candidates are projects with a schedulable
status. Draft, On Hold, Commercialized and Cancelled projects are out of the
plan, so they are in no year and never listed, pinned or not.

Hubs are listed in name order, only those with at least one in-year project.

**`PUT /projects/{project_id}/vip`**: the priority move's permission exactly
(hub-scoped lookup, 404 out of scope; Registration WRITE or an Admin-level
project grant, 403 otherwise). An unchanged value writes nothing; a change
writes `project.vip_pin` / `project.vip_unpin`.

*(ADR 0040, 2026-10-22; supersedes ADR 0022 §4.)* This is the ONLY way
`projects.is_vip` changes (a VIP board link no longer sets it). A pin is a
scheduling input (sort key 2, after `frozen`, before priority): a change
sets `schedule_stale` and follows the committed-priority-change path
exactly (`services.priority_move.decide_auto_recalc` +
`dispatch_auto_recalc`, `trigger_reason="vip_pin"`): `not_needed` for a
non-schedulable status, `deferred` (ADR 0023 follow-up flag) while a run is
in flight, else a QUEUED greedy run enqueued on the solver worker with
`activate=True`. The outcome is in the same `X-Schedule-Recalc` /
`X-Schedule-Run-Id` / `X-Schedule-Baseline-Run-Id` headers as the PATCH
priority path; the JSON body is unchanged. Nothing solves in-process.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Literal

from fastapi import APIRouter, Depends, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

import domain_constants as dc
from api.db import get_db
from api.deps import get_current_principal, require_permission
from api.query_params import DashboardCategoryListQuery, DashboardTypeListQuery
from api.routers.projects import _get_project_or_404
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import NON_SCHEDULABLE_STATUSES, LabRegion, ProjectPriority
from models.project import Project
from schemas.vip import (
    VipCurrentStage,
    VipHub,
    VipPinRequest,
    VipPinResponse,
    VipProject,
    VipProjectsResponse,
    VipYear,
)
from services.active_run import get_active_run
from services.category_type_filter import category_type_filter
from services.hub_scope import global_hub_filter, hub_scope_filter
from services.priority_move import decide_auto_recalc, dispatch_auto_recalc
from services.project_access import authorize_project_action
from services.project_cards import ProjectCard, build_project_cards

router = APIRouter(prefix="/vip-projects", tags=["vip-projects"])
pin_router = APIRouter(prefix="/projects", tags=["vip-projects"])

_read = require_permission(Surface.DASHBOARD, Action.READ)

#: ADR 0040: `ScheduleRun.trigger_reason` of a run started by a VIP pin change.
VIP_PIN_TRIGGER_REASON = "vip_pin"

VIP_LIMIT_MIN = 10
VIP_LIMIT_MAX = 15
VIP_LIMIT_DEFAULT = 15

YEAR_RANGES: dict[str, tuple[int, int]] = {
    "plan": (1, dc.WITHIN_YEAR_WEEK),
    "next": (dc.WITHIN_YEAR_WEEK + 1, dc.HORIZON_WEEKS),
}

_PRIORITY_RANK = {
    ProjectPriority.P1: 0,
    ProjectPriority.P2: 1,
    ProjectPriority.P3: 2,
    ProjectPriority.P4: 3,
    ProjectPriority.Q: 4,
}


def in_year(card: ProjectCard, year: str) -> bool:
    """ADR 0022 §2 (see module docstring)."""

    if not card.run_step_ranges:
        return year == "plan"
    lo, hi = YEAR_RANGES[year]
    return any(start <= hi and end >= lo for start, end in card.run_step_ranges)


def rank_key(project: Project, card: ProjectCard) -> tuple[int, bool, float, str, str]:
    return (
        _PRIORITY_RANK.get(project.priority, 5) if project.priority is not None else 5,
        card.score is None,
        -(card.score or 0.0),
        project.name,
        str(project.id),
    )


def select_vip(
    projects: list[Project], cards: dict[uuid.UUID, ProjectCard], limit: int
) -> tuple[list[tuple[Project, Literal["pinned", "auto"]]], int]:
    """`([(project, selection)] in rank order, pinned_count)` for one hub."""

    ordered = sorted(projects, key=lambda p: rank_key(p, cards[p.id]))
    pinned = [p for p in ordered if p.is_vip]
    chosen: list[tuple[Project, Literal["pinned", "auto"]]] = [(p, "pinned") for p in pinned]
    room = max(0, limit - len(pinned))
    chosen.extend((p, "auto") for p in [p for p in ordered if not p.is_vip][:room])
    return chosen, len(pinned)


@router.get("", response_model=VipProjectsResponse)
async def get_vip_projects(
    year: VipYear = "plan",
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    limit: int = Query(default=VIP_LIMIT_DEFAULT, ge=VIP_LIMIT_MIN, le=VIP_LIMIT_MAX),
    category: DashboardCategoryListQuery = None,
    type_: DashboardTypeListQuery = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> VipProjectsResponse:
    stmt = (
        select(Project)
        .options(selectinload(Project.hub))
        .where(Project.status.not_in(list(NON_SCHEDULABLE_STATUSES)))
    )
    hub_filter = hub_scope_filter(current_user, Project.hub_id)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    # ADR 0020 hub / ADR 0025 country, ANDed with the scope above.
    global_filter = global_hub_filter(Project.hub_id, hub_id, region)
    if global_filter is not None:
        stmt = stmt.where(global_filter)
    # P31: the Dashboard's category / type selection, ANDed with the above.
    # The per-hub ranking and fill then run over the selected projects only.
    cat_type = category_type_filter(category, type_)
    if cat_type is not None:
        stmt = stmt.where(cat_type)
    projects = list((await db.execute(stmt)).scalars().all())

    active_run = await get_active_run(db)
    cards = await build_project_cards(db, projects, active_run)

    by_hub: dict[uuid.UUID, list[Project]] = defaultdict(list)
    for project in projects:
        if in_year(cards[project.id], year):
            by_hub[project.hub_id].append(project)

    hubs: list[VipHub] = []
    for hub_projects in sorted(by_hub.values(), key=lambda ps: ps[0].hub.name.value):
        chosen, pinned_count = select_vip(hub_projects, cards, limit)
        rows: list[VipProject] = []
        for rank, (project, selection) in enumerate(chosen, start=1):
            card = cards[project.id]
            current = card.current_stage
            rows.append(
                VipProject(
                    rank=rank,
                    selection=selection,
                    project_id=project.id,
                    name=project.name,
                    category=project.category,
                    priority=project.priority,
                    score=card.score,
                    expected_end_week=card.expected_end_week,
                    projected_end_week=card.projected_end_week,
                    within_year=card.within_year,
                    health=card.health,
                    progress_pct=card.progress_pct,
                    current_stage=(
                        VipCurrentStage(
                            step_id=current.step_id,
                            step_name=current.step_name,
                            status=current.status,
                        )
                        if current is not None
                        else None
                    ),
                    tracking_status=card.tracking_status,
                )
            )
        first = hub_projects[0]
        hubs.append(
            VipHub(
                hub_id=first.hub_id,
                hub=first.hub.name,
                pinned_count=pinned_count,
                over_limit=pinned_count > limit,
                projects=rows,
            )
        )

    lo, hi = YEAR_RANGES[year]
    return VipProjectsResponse(
        run_id=active_run.id if active_run is not None else None,
        year=year,
        week_range=[lo, hi],
        limit=limit,
        hubs=hubs,
    )


@pin_router.put("/{project_id}/vip", response_model=VipPinResponse)
async def set_project_vip(
    project_id: uuid.UUID,
    body: VipPinRequest,
    response: Response,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(get_current_principal),
) -> VipPinResponse:
    project = await _get_project_or_404(db, project_id, current_user)
    await authorize_project_action(
        db, current_user, project,
        surface=Surface.PROJECT_REGISTRATION, action=Action.WRITE, min_grant_role="admin",
    )
    if project.is_vip == body.is_vip:
        return VipPinResponse(project_id=project.id, is_vip=project.is_vip)

    before = project.is_vip
    project.is_vip = body.is_vip
    # ADR 0040: a pin is a scheduling input, same lifecycle as a priority move.
    project.schedule_stale = True
    recalc, baseline_id = await decide_auto_recalc(
        db, project, trigger_reason=VIP_PIN_TRIGGER_REASON
    )
    db.add(
        AuditLogEntry(
            actor_user_id=current_user.user_id,
            action="project.vip_pin" if body.is_vip else "project.vip_unpin",
            entity_type="Project",
            entity_id=str(project.id),
            hub_id=project.hub_id,
            before_state={"project_id": str(project.id), "is_vip": before},
            after_state={
                "project_id": str(project.id),
                "is_vip": body.is_vip,
                "recalc_status": recalc,
                "baseline_run_id": str(baseline_id) if baseline_id is not None else None,
            },
        )
    )
    outcome = await dispatch_auto_recalc(
        db, project, current_user,
        recalc=recalc, baseline_id=baseline_id, trigger_reason=VIP_PIN_TRIGGER_REASON,
    )
    for name, value in outcome.response_headers().items():
        response.headers[name] = value
    return VipPinResponse(project_id=project_id, is_vip=body.is_vip)
