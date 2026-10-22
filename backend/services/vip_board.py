"""VIP board domain helpers (ADR 0027; docs/API_CONTRACT_P14.md §2).

- `vip_area_for_hub`: the one place a hub's VIP area is derived.
- `PILLARS`: the fixed pillar headline and impact lines served with the board.

`recompute_is_vip` ("linked to a highlighted item sets `is_vip`") was removed
by ADR 0040 (2026-10-22): a VIP board link is a plain reference and
`projects.is_vip` changes only through `PUT /projects/{id}/vip`.
"""

from __future__ import annotations

from dataclasses import dataclass

from models.hub import Hub
from models.vip import VipArea, VipPillar

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
