"""Seed the curated VIP board from the client's three slides (ADR 0027;
docs/API_CONTRACT_P14.md §2, seed table verbatim).

Idempotent:
- an item is matched by area + pillar + title (+ parent for sub-items) and is
  inserted only when missing. Existing rows are never modified, so edits made
  in the app survive a re-run;
- links are only ever added, never removed;
- a link names an existing project title exactly, within the item's area
  (`services.vip_board.vip_area_for_hub`). An absent project is skipped and
  reported. "BEE star labelling" is the one prefix match, R&D-India only.

Slide → area (ADR 0027 amendment, OQ #39): "OEM" → Greece, "Europe" →
Romania, "India" → India. *(ADR 0040, 2026-10-22.)* Links are plain
references and never set or clear `projects.is_vip`: the seed sets no VIP.
The current number of manual pins is reported (`is_vip_pins`), untouched.

Run: `uv run python -m seed.seed_vip_board` (needs `RPD_DATABASE_URL`).
`seed_demo_data` also calls `seed_vip_board` for the client 2026 dataset.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from sqlalchemy import func, insert, select  # noqa: E402
from sqlalchemy.ext.asyncio import (  # noqa: E402
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import selectinload  # noqa: E402

from models.enums import HubName  # noqa: E402
from models.project import Project  # noqa: E402
from models.vip import VipArea, VipItem, VipPillar, VipStatusTag, vip_item_projects  # noqa: E402
from services.vip_board import vip_area_for_hub  # noqa: E402

BEE_PREFIX = "BEE star labelling"
BEE_HUB = HubName.RD_INDIA


@dataclass(frozen=True)
class SeedItem:
    title: str
    highlighted: bool = False
    status_tag: VipStatusTag | None = None
    status_note: str | None = None
    links: tuple[str, ...] = ()
    #: Link every project of `BEE_HUB` whose name starts with this.
    link_prefix: str | None = None
    children: tuple[SeedItem, ...] = field(default_factory=tuple)


_I = VipPillar.INNOVATION
_M = VipPillar.MARKET_EXPANSION
_P = VipPillar.PERFORMANCE
_S = VipStatusTag

VIP_BOARD_SEED: dict[VipArea, dict[VipPillar, tuple[SeedItem, ...]]] = {
    # The "OEM" slide (OEM hubs count as Greece; ADR 0027 amendment).
    VipArea.GREECE: {
        _I: (
            SeedItem("Family Fridge for Commercial Appliances", highlighted=True),
            SeedItem(
                "Monster Range:",
                children=(
                    SeedItem("Twin Reach R600a"),
                    SeedItem("Slim Counter Top R600a with GMC"),
                    SeedItem("Mini Cube R600a with GMC"),
                ),
            ),
        ),
        _M: (
            SeedItem(
                "Super-8 CC Kazakhstan TCCC EC 26 (Coke)", highlighted=True,
                links=("S8 for Kazakhstan",),
            ),
            SeedItem(
                "Super-16 for Kazakhstan", highlighted=True,
                links=("S16 (DD sliding) for Kazakhstan",),
            ),
            SeedItem("ERX 3.0 B rating development"),
            SeedItem(
                "Beat Box 3D Logo",
                links=("BEATBOX 3D LOGO FLEX60", "BEATBOX 3D LOGO PREMIUM SLIM 130"),
            ),
        ),
        _P: (
            SeedItem("IC2-40 Coke Certification", highlighted=True),
            SeedItem(
                "FLEX-290 @ K1 & K2 EEI<20", highlighted=True,
                links=(
                    "FLEX-290 @ K2 for HEINEKEN - Feasibility to define cost & CAPEX for "
                    "EEI<15 & EEI<20",
                ),
            ),
            SeedItem(
                "FLEX-400 B rating K2 & K1 (EEI<20)", highlighted=True,
                links=(
                    "FLEX-400 @ K2 for HEINEKEN - Feasibility to define cost & CAPEX for "
                    "EEI<15 & EEI<20",
                ),
            ),
            SeedItem("IC2-150 with FDEx3"),
            SeedItem(
                "Drawer Improvement for Commercial Appliances",
                links=("DRAWER MODELS IMPROVEMENTS",),
            ),
        ),
    },
    # The "Europe" slide (every linked project is PD-Romania).
    VipArea.ROMANIA: {
        _I: (
            SeedItem(
                "IC3-450 [R290] B & A", highlighted=True, status_tag=_S.ON_TRACK,
                links=("IC3-450 B rating",),
            ),
            SeedItem("IC3-900 [R290] B & A"),
            SeedItem(
                "UNBOUND Smart Vending Range Development:",
                children=(
                    SeedItem("Omnisense 750 (NU)"),
                    SeedItem("Shekel – 750 (Shekel)", links=("Shekel 750",)),
                    SeedItem("Plus-750 [R290] OV (Vision)"),
                ),
            ),
            SeedItem(
                "Coffee Combo (OMS 750 + Coffee m/c)", highlighted=True,
                status_tag=_S.HIGH_RISK, status_note="to meet Brau timelines",
                links=("Coffee and vending cooler combo",),
            ),
        ),
        _M: (
            SeedItem("MAX 1200 A", status_tag=_S.COMMERCIALIZED),
            SeedItem("MAX 750 A", status_tag=_S.COMMERCIALIZED),
            SeedItem(
                "Beatbox 3D logo Max 450", status_tag=_S.COMMERCIALIZED,
                links=("Beatbox Max 450 3D logo",),
            ),
            SeedItem(
                "Heineken 3D logo Max 450", highlighted=True,
                links=("3D Heineken logo on Max 450 B",),
            ),
            SeedItem(
                "Sollatek Planogram Camera to Plus-450", highlighted=True,
                status_tag=_S.ON_TRACK, links=("Sollatek Planogram Camera to Plus-450",),
            ),
        ),
        _P: (
            SeedItem("RM Savings x 10 projects"),
            SeedItem(
                "CRA: Cyber Resilience Act", highlighted=True,
                status_tag=_S.UNDER_INVESTIGATION,
            ),
            SeedItem("3D Logo development (CC, Pepsi, Hell, HNKN, CC)"),
            SeedItem(
                "IC3 Options – RGB LED, Padlock, Door blocker", highlighted=True,
                status_tag=_S.TBD, links=("RGB Neon LED IC3",),
            ),
            SeedItem(
                "Huayi VSC – NMS series compressor",
                links=("Huaiy NMS070 (700/800/900/1000/750/1200 B)",),
            ),
            SeedItem("IoT Controller FDEx2 → FDEx3", status_tag=_S.DELAYED),
            SeedItem("Field Issues Investigations"),
        ),
    },
    # The "India" slide.
    VipArea.INDIA: {
        _I: (
            SeedItem(
                "India aesthetics upgrade – Frameless-look with edge-light (option)",
                highlighted=True, status_tag=_S.DELAYED, status_note="Tooling delayed",
            ),
            SeedItem("Reliance aesthetics upgrade proposal", highlighted=True),
            SeedItem("TCCC 2028 energy and HNKN 2027 EC targets"),
        ),
        _M: (
            SeedItem("Bar 250 R290 development", highlighted=True, status_tag=_S.ON_TRACK),
            SeedItem(
                "CT 50L R600a development", highlighted=True,
                status_tag=_S.AWAITING_APPROVAL, status_note="HO Approval awaited",
            ),
            SeedItem(
                "S-1000 FFD for India and Africa region", highlighted=True,
                status_tag=_S.DELAYED,
            ),
            SeedItem("S-200 R600a for India", highlighted=True, status_tag=_S.DELAYED),
            SeedItem("BSL Migration to R290 | New models | Taxi Canopy"),
            SeedItem("India plant Expansion: 250K → 325K annual volume"),
            SeedItem(
                "S-250 move-in Indonesia", highlighted=True, status_tag=_S.COMMERCIALIZED
            ),
            SeedItem("SEA SFC-500 (move-in) & SFC-700", status_tag=_S.IMPLEMENTED),
        ),
        _P: (
            SeedItem("BIS License IND (ISI Marking)", status_tag=_S.HIGH_RISK),
            SeedItem("BIS QCO – Component level", status_tag=_S.HIGH_RISK),
            SeedItem(
                "BEE 5-star labelling, report submission by 01st Jan 2027",
                highlighted=True, status_tag=_S.HIGH_RISK, link_prefix=BEE_PREFIX,
            ),
            SeedItem("79 x Raw-material saving projects"),
            SeedItem("Lab accreditation: ISO 17025 (ACCAB & NABL) + Scope addition"),
        ),
    },
}


def seed_item_count() -> int:
    return sum(
        1 + len(item.children)
        for pillars in VIP_BOARD_SEED.values()
        for items in pillars.values()
        for item in items
    )


async def _find_or_create(
    session: AsyncSession,
    area: VipArea,
    pillar: VipPillar,
    spec: SeedItem,
    sort_order: int,
    parent_id: uuid.UUID | None,
) -> tuple[VipItem, bool]:
    parent_match = VipItem.parent_id.is_(None) if parent_id is None else (
        VipItem.parent_id == parent_id
    )
    existing = (
        await session.execute(
            select(VipItem)
            .where(
                VipItem.area == area,
                VipItem.pillar == pillar,
                VipItem.title == spec.title,
                parent_match,
            )
            .order_by(VipItem.created_at, VipItem.id)
            .limit(1)
        )
    ).scalar_one_or_none()
    if existing is not None:
        return existing, False
    item = VipItem(
        area=area,
        pillar=pillar,
        title=spec.title,
        status_tag=spec.status_tag,
        status_note=spec.status_note,
        highlighted=spec.highlighted,
        parent_id=parent_id,
        sort_order=sort_order,
    )
    session.add(item)
    await session.flush()
    return item, True


async def seed_vip_board(session: AsyncSession) -> dict[str, Any]:
    """Insert missing items and links; return a link report. Does not commit."""

    projects = list(
        (await session.execute(select(Project).options(selectinload(Project.hub))))
        .scalars()
        .all()
    )
    by_area_name: dict[tuple[VipArea, str], list[Project]] = {}
    any_area_names: set[str] = set()
    for project in projects:
        by_area_name.setdefault((vip_area_for_hub(project.hub), project.name), []).append(project)
        any_area_names.add(project.name)

    created = 0
    links_added = 0
    resolved: list[dict[str, Any]] = []
    unresolved: list[dict[str, Any]] = []
    linked_project_ids: set[uuid.UUID] = set()

    async def link(item: VipItem, spec: SeedItem, area: VipArea) -> None:
        nonlocal links_added
        targets: list[Project] = []
        for name in spec.links:
            matches = by_area_name.get((area, name), [])
            if matches:
                targets.extend(matches)
                resolved.append({"item": spec.title, "link": name, "matched": len(matches)})
            else:
                reason = "absent" if name not in any_area_names else "outside area"
                unresolved.append({"item": spec.title, "link": name, "reason": reason})
        if spec.link_prefix is not None:
            matches = sorted(
                (
                    p for p in projects
                    if p.hub.name == BEE_HUB and p.name.startswith(spec.link_prefix)
                ),
                key=lambda p: p.name,
            )
            targets.extend(matches)
            entry = {
                "item": spec.title,
                "link": f"{BEE_HUB.value} name starts {spec.link_prefix!r}",
                "matched": len(matches),
            }
            (resolved if matches else unresolved).append(
                entry if matches else {**entry, "reason": "absent"}
            )
        if not targets:
            return
        existing: set[uuid.UUID] = set(
            (
                await session.execute(
                    select(vip_item_projects.c.project_id).where(
                        vip_item_projects.c.item_id == item.id
                    )
                )
            ).scalars()
        )
        new = sorted({p.id for p in targets} - existing, key=str)
        if new:
            await session.execute(
                insert(vip_item_projects),
                [{"item_id": item.id, "project_id": pid} for pid in new],
            )
            links_added += len(new)
        linked_project_ids.update(p.id for p in targets)

    for area, pillars in VIP_BOARD_SEED.items():
        for pillar, specs in pillars.items():
            for order, spec in enumerate(specs, start=1):
                item, was_created = await _find_or_create(
                    session, area, pillar, spec, order, None
                )
                created += was_created
                await link(item, spec, area)
                for child_order, child_spec in enumerate(spec.children, start=1):
                    child, child_created = await _find_or_create(
                        session, area, pillar, child_spec, child_order, item.id
                    )
                    created += child_created
                    await link(child, child_spec, area)

    await session.flush()

    # ADR 0040: reported only; a link never changes `is_vip`.
    pins = await session.scalar(
        select(func.count()).select_from(Project).where(Project.is_vip.is_(True))
    ) or 0
    return {
        "items_in_seed": seed_item_count(),
        "items_created": created,
        "links_added": links_added,
        "linked_projects": len(linked_project_ids),
        "resolved": resolved,
        "unresolved": unresolved,
        "is_vip_pins": pins,
    }


async def run() -> dict[str, Any]:
    url = os.environ.get("RPD_DATABASE_URL")
    if not url:
        raise RuntimeError("RPD_DATABASE_URL is not set (async postgresql+asyncpg:// DSN).")
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            report = await seed_vip_board(session)
            await session.commit()
            return report
    finally:
        await engine.dispose()


def main() -> None:
    print(json.dumps(asyncio.run(run()), indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
