"""VIP board domain helpers (ADR 0027; docs/API_CONTRACT_P14.md §2).

- `vip_area_for_hub`: the one place a hub's VIP area is derived.
- `PILLARS`: the fixed pillar headline and impact lines served with the board.
- `recompute_is_vip`: `projects.is_vip` = "linked to any highlighted VIP
  item" (ADR 0027 amendment: yellow highlight = VIP), for the given
  projects, with a `project.vip_pin` / `project.vip_unpin` audit row per
  actual change (ADR 0022 §4 action names). Never recalculates.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models.audit import AuditLogEntry
from models.hub import Hub
from models.project import Project
from models.vip import VipArea, VipItem, VipPillar, vip_item_projects

#: Response order of the areas (contract §2, amended).
AREA_ORDER: tuple[VipArea, ...] = (VipArea.GREECE, VipArea.INDIA, VipArea.ROMANIA)
AREA_LABELS: dict[VipArea, str] = {
    VipArea.GREECE: "Greece",
    VipArea.INDIA: "India",
    VipArea.ROMANIA: "Romania",
}


def vip_area_for_hub(hub: Hub) -> VipArea:
    """ADR 0027 amendment (OQ #39): the area is the hub's lab region, the
    same grouping as the ADR 0025 country filter. OEM hubs count as Greece
    (their lab region since P13; stated explicitly so the rule holds even on
    a DB that predates `p13a_oem_lab_region`).
    """

    if hub.is_oem:
        return VipArea.GREECE
    return VipArea(hub.lab_region.value)


@dataclass(frozen=True)
class PillarInfo:
    key: VipPillar
    number: str
    label: str
    headline: str
    impact: tuple[str, ...]


#: ADR 0027 Context table, verbatim (including the client's lower-case
#: "value" and "compliance").
PILLARS: tuple[PillarInfo, ...] = (
    PillarInfo(
        VipPillar.INNOVATION, "01", "Innovation",
        "Refresh product aesthetics to strengthen differentiation",
        ("Differentiation", "Fresh Looks", "value"),
    ),
    PillarInfo(
        VipPillar.MARKET_EXPANSION, "02", "Market Expansion",
        "Launch platforms and scale regional demand",
        ("New Product", "New customer", "Plant Capacity"),
    ),
    PillarInfo(
        VipPillar.PERFORMANCE, "03", "Performance",
        "Deliver RM savings, compliance and continuity",
        ("Savings", "compliance", "reliable delivery"),
    ),
)
PILLAR_RANK: dict[VipPillar, int] = {p.key: i for i, p in enumerate(PILLARS)}


async def recompute_is_vip(
    db: AsyncSession,
    project_ids: Iterable[uuid.UUID],
    actor_user_id: uuid.UUID | None,
    *,
    audit: bool = True,
) -> dict[str, list[uuid.UUID]]:
    """Set `is_vip` = "linked to any highlighted VIP item" on `project_ids`. Flushes the
    session first so pending link changes count. Returns the ids actually
    pinned and unpinned. `audit=False` is for the seed only (seeds and data
    migrations write no audit rows, by convention since P9-T01).
    """

    ids = sorted(set(project_ids))
    changed: dict[str, list[uuid.UUID]] = {"pinned": [], "unpinned": []}
    if not ids:
        return changed
    await db.flush()
    linked: set[uuid.UUID] = set(
        (
            await db.execute(
                select(vip_item_projects.c.project_id)
                .join(VipItem, VipItem.id == vip_item_projects.c.item_id)
                .where(
                    vip_item_projects.c.project_id.in_(ids),
                    VipItem.highlighted.is_(True),
                )
                .distinct()
            )
        ).scalars()
    )
    projects = (await db.execute(select(Project).where(Project.id.in_(ids)))).scalars().all()
    for project in sorted(projects, key=lambda p: str(p.id)):
        target = project.id in linked
        if project.is_vip == target:
            continue
        project.is_vip = target
        changed["pinned" if target else "unpinned"].append(project.id)
        if audit:
            db.add(
                AuditLogEntry(
                    actor_user_id=actor_user_id,
                    action="project.vip_pin" if target else "project.vip_unpin",
                    entity_type="Project",
                    entity_id=str(project.id),
                    hub_id=project.hub_id,
                    before_state={"project_id": str(project.id), "is_vip": not target},
                    after_state={"project_id": str(project.id), "is_vip": target},
                    notes="vip_board",
                )
            )
    return changed
