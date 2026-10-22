"""VIP board on the Dashboard (docs/API_CONTRACT_P14.md §2; ADR 0027).

**`GET /vip-board?hub_id=&region=`**, `DASHBOARD` READ. Areas Greece, India,
Romania (in that order; ADR 0027 amendment: the area is the hub's lab region,
OEM hubs count as Greece, so `region` filtering is `area == region`). An area
is returned only when at least one of its hubs is in the caller's scope AND
passes `hub_id` / `region` (ADR 0020 / 0025; both only ever narrow). Items
are portfolio content and are never hidden inside a returned area. Linked
projects are shown only when their hub is in that same narrowed set; the
rest are counted in `hidden_project_count`. Project facts come from the
active run (`services.project_cards`, the same source as the Priority board
and `GET /vip-projects`).

**Writes**, `MATRIX` WRITE, every one audited (`vip_item.create|update|
delete|link|unlink`). *(ADR 0040, 2026-10-22, supersedes the ADR 0027
amendment.)* Links are plain references: no write here sets or clears
`projects.is_vip` (only `PUT /projects/{id}/vip` does), so the responses'
`pinned_project_ids` / `unpinned_project_ids` are always empty:
- `POST /vip-items`, `PATCH /vip-items/{id}`, `DELETE /vip-items/{id}`;
- `PUT /vip-items/{id}/projects` replaces the item's links.

**Decisions beyond the contract** (recorded in docs/MEMORY.md, P14-T02):
- A hub-scoped writer may only touch items of areas containing one of their
  hubs (others: 404 on item paths, 403 on create).
- `PUT .../projects` replaces only the links the caller can see. Existing
  links to out-of-scope projects are kept, never silently dropped.
- An unknown or out-of-scope project id is 422 `VIP_PROJECT_NOT_FOUND`
  (indistinguishable on purpose); a project of another area is 422
  `VIP_PROJECT_AREA_MISMATCH`.
- A parent must be a top-level item of the same area and pillar, and an
  item with children cannot become a child: 422 `VIP_PARENT_INVALID`.
  Changing a parent's area or pillar moves its children with it.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from typing import Any

from fastapi import APIRouter, Depends, status
from sqlalchemy import delete, func, insert, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from api.db import get_db
from api.deps import require_permission
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from models.enums import LabRegion
from models.hub import Hub
from models.project import Project
from models.vip import VipArea, VipItem, VipStatusTag, vip_item_projects
from schemas.vip_board import (
    VipBoardArea,
    VipBoardItem,
    VipBoardProject,
    VipBoardResponse,
    VipBoardVipItem,
    VipItemCreateRequest,
    VipItemDeleteResponse,
    VipItemLinksRequest,
    VipItemLinksResponse,
    VipItemResponse,
    VipItemUpdateRequest,
    VipPillarRef,
)
from services.active_run import get_active_run
from services.hub_scope import hub_scope_filter, narrowed_hub_filter
from services.project_cards import build_project_cards
from services.vip_board import (
    AREA_LABELS,
    AREA_ORDER,
    PILLAR_RANK,
    PILLARS,
    vip_area_for_hub,
)

board_router = APIRouter(prefix="/vip-board", tags=["vip-board"])
items_router = APIRouter(prefix="/vip-items", tags=["vip-board"])

_read = require_permission(Surface.DASHBOARD, Action.READ)
_write = require_permission(Surface.MATRIX, Action.WRITE)


# --- shared helpers -----------------------------------------------------------


async def _hubs_and_visible(
    db: AsyncSession,
    principal: Principal,
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
) -> tuple[list[Hub], set[uuid.UUID]]:
    """All hubs, and the ids of those in scope AND the global filter."""

    hubs = list((await db.execute(select(Hub))).scalars().all())
    stmt = select(Hub.id)
    predicate = narrowed_hub_filter(principal, Hub.id, hub_id, region)
    if predicate is not None:
        stmt = stmt.where(predicate)
    visible = set((await db.execute(stmt)).scalars().all())
    return hubs, visible


def _visible_areas(hubs: list[Hub], visible: set[uuid.UUID]) -> set[VipArea]:
    return {vip_area_for_hub(h) for h in hubs if h.id in visible}


def _item_sort_key(item: VipItem) -> tuple[int, int, str, str]:
    return (PILLAR_RANK[item.pillar], item.sort_order, item.title, str(item.id))


def _item_state(item: VipItem, project_ids: list[uuid.UUID] | None = None) -> dict[str, Any]:
    state: dict[str, Any] = {
        "id": str(item.id),
        "area": item.area.value,
        "pillar": item.pillar.value,
        "title": item.title,
        "status_tag": item.status_tag.value if item.status_tag is not None else None,
        "status_note": item.status_note,
        "highlighted": item.highlighted,
        "parent_id": str(item.parent_id) if item.parent_id is not None else None,
        "sort_order": item.sort_order,
    }
    if project_ids is not None:
        state["project_ids"] = sorted(str(p) for p in project_ids)
    return state


def _audit(
    db: AsyncSession,
    principal: Principal,
    action: str,
    item_id: uuid.UUID,
    before: dict[str, Any] | None,
    after: dict[str, Any] | None,
) -> None:
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=action,
            entity_type="VipItem",
            entity_id=str(item_id),
            hub_id=None,
            before_state=before,
            after_state=after,
        )
    )


async def _linked_ids(db: AsyncSession, item_ids: list[uuid.UUID]) -> list[uuid.UUID]:
    if not item_ids:
        return []
    rows = await db.execute(
        select(vip_item_projects.c.project_id)
        .where(vip_item_projects.c.item_id.in_(item_ids))
        .distinct()
    )
    return list(rows.scalars().all())


async def _in_scope_ids(
    db: AsyncSession, principal: Principal, ids: list[uuid.UUID]
) -> list[uuid.UUID]:
    """The subset of project ids inside the caller's hub scope (P14-R01 S2).
    Writes use every id; only responses are filtered.
    """

    if not ids:
        return []
    scope = hub_scope_filter(principal, Project.hub_id)
    if scope is None:
        return list(ids)
    rows = await db.execute(select(Project.id).where(Project.id.in_(ids), scope))
    return list(rows.scalars().all())


async def _item_response(
    db: AsyncSession, item: VipItem, principal: Principal
) -> VipItemResponse:
    linked = await _in_scope_ids(db, principal, await _linked_ids(db, [item.id]))
    return VipItemResponse(
        id=item.id,
        area=item.area,
        pillar=item.pillar,
        title=item.title,
        status_tag=item.status_tag,
        status_note=item.status_note,
        highlighted=item.highlighted,
        parent_id=item.parent_id,
        sort_order=item.sort_order,
        project_ids=sorted(linked, key=str),
    )


async def _get_item_or_404(
    db: AsyncSession, item_id: uuid.UUID, principal: Principal
) -> VipItem:
    item = (
        await db.execute(
            select(VipItem).options(selectinload(VipItem.children)).where(VipItem.id == item_id)
        )
    ).scalar_one_or_none()
    if item is not None and not principal.hub_scope_all:
        hubs, visible = await _hubs_and_visible(db, principal)
        if item.area not in _visible_areas(hubs, visible):
            item = None
    if item is None:
        raise CodedHTTPException(status.HTTP_404_NOT_FOUND, "NOT_FOUND", "VIP item not found.")
    return item


async def _ensure_area_writable(db: AsyncSession, principal: Principal, area: VipArea) -> None:
    if principal.hub_scope_all:
        return
    hubs, visible = await _hubs_and_visible(db, principal)
    if area not in _visible_areas(hubs, visible):
        raise CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            "VIP_AREA_OUT_OF_SCOPE",
            "This VIP area has no hub in your scope.",
        )


async def _validate_parent(
    db: AsyncSession,
    parent_id: uuid.UUID,
    area: VipArea,
    pillar: Any,
    item: VipItem | None,
) -> None:
    parent = (
        await db.execute(select(VipItem).where(VipItem.id == parent_id))
    ).scalar_one_or_none()
    reason: str | None = None
    if parent is None:
        reason = "The parent item does not exist."
    elif item is not None and parent.id == item.id:
        reason = "An item cannot be its own parent."
    elif parent.parent_id is not None:
        reason = "Sub-items are one level only; the parent is itself a sub-item."
    elif parent.area != area or parent.pillar != pillar:
        reason = "A sub-item must be in its parent's area and pillar."
    elif item is not None and item.children:
        reason = "An item with sub-items cannot become a sub-item."
    if reason is not None:
        raise CodedHTTPException(HTTP_422, "VIP_PARENT_INVALID", reason)


def _clean_note(note: str | None) -> str | None:
    return note if note else None


# --- GET /vip-board -----------------------------------------------------------


@board_router.get("", response_model=VipBoardResponse)
async def get_vip_board(
    hub_id: uuid.UUID | None = None,
    region: LabRegion | None = None,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> VipBoardResponse:
    hubs, visible_hubs = await _hubs_and_visible(db, current_user, hub_id, region)
    areas = [a for a in AREA_ORDER if a in _visible_areas(hubs, visible_hubs)]
    active_run = await get_active_run(db)

    items: list[VipItem] = []
    if areas:
        items = list(
            (await db.execute(select(VipItem).where(VipItem.area.in_(areas)))).scalars().all()
        )
    item_ids = [i.id for i in items]

    links: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    project_hub: dict[uuid.UUID, uuid.UUID] = {}
    if item_ids:
        rows = await db.execute(
            select(vip_item_projects.c.item_id, Project.id, Project.hub_id)
            .join(Project, Project.id == vip_item_projects.c.project_id)
            .where(vip_item_projects.c.item_id.in_(item_ids))
        )
        for link_item_id, project_id, project_hub_id in rows.all():
            links[link_item_id].append(project_id)
            project_hub[project_id] = project_hub_id

    visible_ids = [pid for pid, hid in project_hub.items() if hid in visible_hubs]
    projects: dict[uuid.UUID, Project] = {}
    if visible_ids:
        stmt = (
            select(Project).options(selectinload(Project.hub)).where(Project.id.in_(visible_ids))
        )
        # Defence in depth: the same scope predicate, in SQL.
        scope = hub_scope_filter(current_user, Project.hub_id)
        if scope is not None:
            stmt = stmt.where(scope)
        projects = {p.id: p for p in (await db.execute(stmt)).scalars().all()}
    cards = await build_project_cards(db, list(projects.values()), active_run)

    # ADR 0040: pinned VIP projects per hub, same scope as the links above.
    pinned_by_hub: dict[uuid.UUID, int] = {}
    if visible_hubs:
        pin_stmt = (
            select(Project.hub_id, func.count())
            .where(Project.is_vip.is_(True), Project.hub_id.in_(list(visible_hubs)))
            .group_by(Project.hub_id)
        )
        pin_scope = hub_scope_filter(current_user, Project.hub_id)
        if pin_scope is not None:
            pin_stmt = pin_stmt.where(pin_scope)
        pinned_by_hub = {hid: n for hid, n in (await db.execute(pin_stmt)).all()}

    def project_row(project: Project) -> VipBoardProject:
        card = cards[project.id]
        return VipBoardProject(
            id=project.id,
            name=project.name,
            hub=project.hub.name,
            priority=project.priority,
            status=project.status,
            projected_end_week=card.projected_end_week,
            within_year=card.within_year,
            health=card.health,
        )

    def item_row(item: VipItem, children: list[VipBoardItem]) -> VipBoardItem:
        linked = links.get(item.id, [])
        shown = sorted(
            (projects[pid] for pid in linked if pid in projects),
            key=lambda p: (p.name, str(p.id)),
        )
        return VipBoardItem(
            id=item.id,
            pillar=item.pillar,
            title=item.title,
            status_tag=item.status_tag,
            status_note=item.status_note,
            highlighted=item.highlighted,
            sort_order=item.sort_order,
            children=children,
            projects=[project_row(p) for p in shown],
            hidden_project_count=len(linked) - len(shown),
        )

    children_of: dict[uuid.UUID, list[VipItem]] = defaultdict(list)
    for item in items:
        if item.parent_id is not None:
            children_of[item.parent_id].append(item)

    out_areas: list[VipBoardArea] = []
    for area in areas:
        area_items = [i for i in items if i.area == area]
        tops = sorted((i for i in area_items if i.parent_id is None), key=_item_sort_key)
        item_rows = [
            item_row(
                top,
                [item_row(c, []) for c in sorted(children_of[top.id], key=_item_sort_key)],
            )
            for top in tops
        ]
        vip_items = [
            VipBoardVipItem(id=i.id, title=i.title)
            for top in tops
            for i in [top, *sorted(children_of[top.id], key=_item_sort_key)]
            if i.highlighted
        ]
        area_project_ids = {
            pid for i in area_items for pid in links.get(i.id, []) if pid in projects
        }
        out_areas.append(
            VipBoardArea(
                area=area,
                label=AREA_LABELS[area],
                hubs=sorted(
                    (h.name for h in hubs if vip_area_for_hub(h) == area),
                    key=lambda n: n.value,
                ),
                item_count=len(area_items),
                highlighted_count=sum(1 for i in area_items if i.highlighted),
                high_risk_count=sum(
                    1 for i in area_items if i.status_tag == VipStatusTag.HIGH_RISK
                ),
                linked_project_count=len(area_project_ids),
                vip_project_count=sum(
                    pinned_by_hub.get(h.id, 0) for h in hubs if vip_area_for_hub(h) == area
                ),
                vip_items=vip_items,
                items=item_rows,
            )
        )

    return VipBoardResponse(
        run_id=active_run.id if active_run is not None else None,
        pillars=[
            VipPillarRef(
                key=p.key, number=p.number, label=p.label, headline=p.headline,
                impact=list(p.impact),
            )
            for p in PILLARS
        ],
        areas=out_areas,
    )


# --- writes -------------------------------------------------------------------


@items_router.post("", response_model=VipItemResponse, status_code=status.HTTP_201_CREATED)
async def create_vip_item(
    body: VipItemCreateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> VipItemResponse:
    await _ensure_area_writable(db, current_user, body.area)
    if body.parent_id is not None:
        await _validate_parent(db, body.parent_id, body.area, body.pillar, None)
    sort_order = body.sort_order
    if sort_order is None:
        parent_match = (
            VipItem.parent_id.is_(None)
            if body.parent_id is None
            else VipItem.parent_id == body.parent_id
        )
        current_max = await db.scalar(
            select(func.max(VipItem.sort_order)).where(
                VipItem.area == body.area, VipItem.pillar == body.pillar, parent_match
            )
        )
        sort_order = 0 if current_max is None else current_max + 1
    item = VipItem(
        area=body.area,
        pillar=body.pillar,
        title=body.title,
        status_tag=body.status_tag,
        status_note=_clean_note(body.status_note),
        highlighted=body.highlighted,
        parent_id=body.parent_id,
        sort_order=sort_order,
    )
    db.add(item)
    await db.flush()
    _audit(db, current_user, "vip_item.create", item.id, None, _item_state(item))
    await db.commit()
    return await _item_response(db, item, current_user)


@items_router.patch("/{item_id}", response_model=VipItemResponse)
async def update_vip_item(
    item_id: uuid.UUID,
    body: VipItemUpdateRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> VipItemResponse:
    item = await _get_item_or_404(db, item_id, current_user)
    fields = body.model_fields_set
    before = _item_state(item)

    area = body.area if "area" in fields and body.area is not None else item.area
    pillar = body.pillar if "pillar" in fields and body.pillar is not None else item.pillar
    parent_id = body.parent_id if "parent_id" in fields else item.parent_id

    if area != item.area:
        await _ensure_area_writable(db, current_user, area)
        # Links of the item and its children must all belong to the new area.
        linked = await _linked_ids(db, [item.id, *(c.id for c in item.children)])
        if linked:
            hubs_rows = await db.execute(
                select(Hub).join(Project, Project.hub_id == Hub.id).where(Project.id.in_(linked))
            )
            if any(vip_area_for_hub(h) != area for h in hubs_rows.scalars().all()):
                raise CodedHTTPException(
                    HTTP_422,
                    "VIP_PROJECT_AREA_MISMATCH",
                    "A linked project's hub lab region is not the new area. Unlink it first.",
                )
    if parent_id is not None and (
        "parent_id" in fields or area != item.area or pillar != item.pillar
    ):
        await _validate_parent(db, parent_id, area, pillar, item)

    item.area = area
    item.pillar = pillar
    item.parent_id = parent_id
    for child in item.children:
        child.area = area
        child.pillar = pillar
    if "title" in fields and body.title is not None:
        item.title = body.title
    if "status_tag" in fields:
        item.status_tag = body.status_tag
    if "status_note" in fields:
        item.status_note = _clean_note(body.status_note)
    if "highlighted" in fields and body.highlighted is not None:
        item.highlighted = body.highlighted
    if "sort_order" in fields and body.sort_order is not None:
        item.sort_order = body.sort_order

    after = _item_state(item)
    if after != before:
        _audit(db, current_user, "vip_item.update", item.id, before, after)
    await db.commit()
    return await _item_response(db, item, current_user)


@items_router.delete("/{item_id}", response_model=VipItemDeleteResponse)
async def delete_vip_item(
    item_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> VipItemDeleteResponse:
    item = await _get_item_or_404(db, item_id, current_user)
    ids = [item.id, *(c.id for c in item.children)]
    linked = await _linked_ids(db, ids)
    before = _item_state(item, linked)
    before["children"] = [
        _item_state(c) for c in sorted(item.children, key=_item_sort_key)
    ]
    # The DB cascades children and links (ON DELETE CASCADE).
    await db.execute(delete(VipItem).where(VipItem.id == item.id))
    for gone in [*item.children, item]:
        db.expunge(gone)
    _audit(db, current_user, "vip_item.delete", item_id, before, None)
    await db.commit()
    return VipItemDeleteResponse(
        id=item_id, deleted_item_count=len(ids), unpinned_project_ids=[]
    )


@items_router.put("/{item_id}/projects", response_model=VipItemLinksResponse)
async def set_vip_item_projects(
    item_id: uuid.UUID,
    body: VipItemLinksRequest,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_write),
) -> VipItemLinksResponse:
    item = await _get_item_or_404(db, item_id, current_user)
    requested = list(dict.fromkeys(body.project_ids))

    found: dict[uuid.UUID, Project] = {}
    if requested:
        stmt = (
            select(Project).options(selectinload(Project.hub)).where(Project.id.in_(requested))
        )
        scope = hub_scope_filter(current_user, Project.hub_id)
        if scope is not None:
            stmt = stmt.where(scope)
        found = {p.id: p for p in (await db.execute(stmt)).scalars().all()}
    missing = [pid for pid in requested if pid not in found]
    if missing:
        raise CodedHTTPException(
            HTTP_422,
            "VIP_PROJECT_NOT_FOUND",
            {"msg": "Unknown or out-of-scope project.", "project_ids": [str(p) for p in missing]},
        )
    mismatched = [p for p in found.values() if vip_area_for_hub(p.hub) != item.area]
    if mismatched:
        raise CodedHTTPException(
            HTTP_422,
            "VIP_PROJECT_AREA_MISMATCH",
            {
                "msg": f"Every linked project's hub lab region must be {item.area.value}.",
                "project_ids": sorted(str(p.id) for p in mismatched),
            },
        )

    current = set(await _linked_ids(db, [item.id]))
    # A scoped caller replaces only the links it can see.
    replaceable: set[uuid.UUID]
    if current and not current_user.hub_scope_all:
        visible_stmt = select(Project.id).where(Project.id.in_(current))
        scope = hub_scope_filter(current_user, Project.hub_id)
        if scope is not None:
            visible_stmt = visible_stmt.where(scope)
        replaceable = set((await db.execute(visible_stmt)).scalars().all())
    else:
        replaceable = current
    wanted = set(requested)
    added = sorted(wanted - current, key=str)
    removed = sorted(replaceable - wanted, key=str)

    if added:
        await db.execute(
            insert(vip_item_projects),
            [{"item_id": item.id, "project_id": pid} for pid in added],
        )
        _audit(
            db, current_user, "vip_item.link", item.id,
            {"project_ids": sorted(str(p) for p in current)},
            {"added_project_ids": [str(p) for p in added]},
        )
    if removed:
        await db.execute(
            delete(vip_item_projects).where(
                vip_item_projects.c.item_id == item.id,
                vip_item_projects.c.project_id.in_(removed),
            )
        )
        _audit(
            db, current_user, "vip_item.unlink", item.id,
            {"project_ids": sorted(str(p) for p in current)},
            {"removed_project_ids": [str(p) for p in removed]},
        )
    await db.commit()
    return VipItemLinksResponse(
        item=await _item_response(db, item, current_user),
        added_project_ids=await _in_scope_ids(db, current_user, added),
        removed_project_ids=await _in_scope_ids(db, current_user, removed),
        pinned_project_ids=[],
        unpinned_project_ids=[],
    )
