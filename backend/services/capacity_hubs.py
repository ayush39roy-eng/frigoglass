"""Capacity hubs (ADR 0042, P29-T01): the one place that groups hubs into the
hubs whose engineers, work calendar and design supply serve them.

`hubs.capacity_hub_id` points a *member* hub (OEM-HCK, OEM-Seitek) at its
capacity hub (R&D-Greece); every other hub is its own capacity hub. The
capacity surfaces (`GET /capacity/hub-load`, `GET /planning/capacity-summary`,
`GET /priorities/capacity-fill`, the engineer heatmap, the Capacity Planning
roster) serve the capacity hubs only, the Greece row with a `members`
breakdown. Every other surface (registration, Dashboard Hub × Type, filters,
the country filter, RBAC) keeps the six hubs, and row-level hub scoping is
unchanged (`services.hub_scope`).

Rules implemented here, all read-only:

- **Supply** is per capacity hub over the engineers whose hub resolves to it
  and whose `counts_in_capacity` is true (`counted_fte_by_capacity_hub`).
- **Load / project sets** are per capacity hub: a project of a member hub
  counts under its capacity hub (`CapacityHubMap.resolve`).
- **Scope** (ADR 0042 §8): a capacity hub row is visible when the capacity hub
  itself or any of its members is in the caller's (filtered) scope; the
  `members` breakdown lists only the members in scope (`scoped_capacity_rows`).
  The global `hub_id` filter on a member hub selects its capacity hub's row
  with that member highlighted (`CapacityRowScope.selected_member`).
- **Engineer lists** on a capacity surface resolve a `hub_id` filter to the
  capacity hub (`CapacityHubMap.resolve`), ANDed with the unchanged row scope.
  P30-R01 (S30-I1): the scope check runs on the REQUESTED hub first, so an
  out-of-scope member hub gives an empty list (ADR 0020 §3), never the
  caller's own capacity hub's engineers (`engineer_hub_filter`).
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Collection, Iterable
from dataclasses import dataclass, field

from sqlalchemy import ColumnElement, false, select
from sqlalchemy.ext.asyncio import AsyncSession

from core.principal import Principal
from models.engineer import Engineer
from models.enums import HubName, LabRegion
from models.hub import Hub
from services.capacity_supply import fte_sum
from services.hub_scope import is_hub_in_scope, narrowed_hub_filter


@dataclass(frozen=True)
class CapacityHubMap:
    """Every hub, with the member → capacity-hub resolution (ADR 0042 §1)."""

    hubs: dict[uuid.UUID, Hub]
    #: hub id → its capacity hub id (itself when it has none).
    capacity_of: dict[uuid.UUID, uuid.UUID]
    #: capacity hub id → (own id, then member ids by hub name).
    members_of: dict[uuid.UUID, tuple[uuid.UUID, ...]]

    def resolve(self, hub_id: uuid.UUID | None) -> uuid.UUID | None:
        """The capacity hub of `hub_id`; an unknown id is returned as is (so a
        filter on it stays an always-empty filter, never a widened one)."""

        if hub_id is None:
            return None
        return self.capacity_of.get(hub_id, hub_id)

    def is_capacity_hub(self, hub_id: uuid.UUID) -> bool:
        hub = self.hubs.get(hub_id)
        return hub is not None and hub.capacity_hub_id is None

    def name(self, hub_id: uuid.UUID) -> HubName:
        return self.hubs[hub_id].name

    def capacity_hub_ids(self) -> list[uuid.UUID]:
        """Every capacity hub, by hub name."""

        return sorted(self.members_of, key=lambda h: self.hubs[h].name.value)

    def resolve_many(self, hub_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
        return {self.capacity_of.get(h, h) for h in hub_ids}

    def hubs_resolving_to(self, capacity_hub_ids: Collection[uuid.UUID]) -> list[uuid.UUID]:
        """Every hub (own + members) whose capacity hub is in the set."""

        wanted = set(capacity_hub_ids)
        return [h for h, c in self.capacity_of.items() if c in wanted]


def engineer_hub_filter(
    principal: Principal,
    cmap: CapacityHubMap,
    hub_id: uuid.UUID | None,
    region: LabRegion | None = None,
) -> ColumnElement[bool] | None:
    """The `Engineer.hub_id` predicate of an engineer list under the global
    `hub_id` / `region` filters (ADR 0020, ADR 0025, ADR 0042).

    P30-R01 (S30-I1): the RBAC check applies to the hub the caller ASKED for,
    before any member → capacity-hub resolution. A `hub_id` outside the
    caller's scope is an always-false predicate (empty rows, zero totals, no
    403), even when it resolves to a capacity hub the caller does see. Only
    an in-scope member hub (OEM-HCK) then resolves to its capacity hub, ANDed
    with the unchanged row scope (`narrowed_hub_filter`). `None` = no
    predicate (unrestricted caller, no filter).
    """

    if hub_id is not None and not is_hub_in_scope(principal, hub_id):
        return false()
    return narrowed_hub_filter(principal, Engineer.hub_id, cmap.resolve(hub_id), region)


async def load_capacity_hub_map(db: AsyncSession) -> CapacityHubMap:
    hubs = {h.id: h for h in (await db.execute(select(Hub))).scalars().all()}
    capacity_of = {h.id: (h.capacity_hub_id or h.id) for h in hubs.values()}
    members: dict[uuid.UUID, list[uuid.UUID]] = defaultdict(list)
    for h in sorted(hubs.values(), key=lambda x: x.name.value):
        if h.capacity_hub_id is not None and h.capacity_hub_id in hubs:
            members[h.capacity_hub_id].append(h.id)
    members_of: dict[uuid.UUID, tuple[uuid.UUID, ...]] = {}
    for h in hubs.values():
        if h.capacity_hub_id is None:
            members_of[h.id] = (h.id, *members.get(h.id, []))
    return CapacityHubMap(hubs=hubs, capacity_of=capacity_of, members_of=members_of)


@dataclass(frozen=True)
class CapacityRowScope:
    """One capacity-hub row of a scoped, filtered capacity read."""

    capacity_hub_id: uuid.UUID
    #: Own hub first (when in scope), then the in-scope members by name.
    member_ids: tuple[uuid.UUID, ...]
    #: The request's `hub_id` when it resolves to this row (own or member).
    selected_member: uuid.UUID | None = None
    #: Every hub of the row (own + members), scope ignored, for the aggregate
    #: figures (ADR 0042 §8: the aggregate is visible to any member's scope).
    all_member_ids: tuple[uuid.UUID, ...] = field(default=())


async def visible_hub_ids(
    db: AsyncSession,
    principal: Principal,
    hub_id: uuid.UUID | None,
    region: LabRegion | None,
) -> list[uuid.UUID]:
    """The hubs the caller sees for this request: RBAC scope AND the global
    `hub_id` / `region` filter (`services.hub_scope.narrowed_hub_filter`,
    never widening)."""

    stmt = select(Hub.id)
    hub_filter = narrowed_hub_filter(principal, Hub.id, hub_id, region)
    if hub_filter is not None:
        stmt = stmt.where(hub_filter)
    return list((await db.execute(stmt)).scalars().all())


def scoped_capacity_rows(
    cmap: CapacityHubMap,
    filtered: Collection[uuid.UUID],
    scoped: Collection[uuid.UUID],
    hub_id: uuid.UUID | None = None,
) -> list[CapacityRowScope]:
    """The capacity-hub rows of a read, ordered by capacity hub name
    (ADR 0042 §4, §8).

    - `filtered`: the hubs visible for this request (RBAC scope AND the global
      `hub_id` / `region` filter). A capacity hub has a row when any of its
      hubs (own or member) is in it, so filtering on OEM-HCK gives the Greece
      row.
    - `scoped`: the hubs visible without the `hub_id` filter (RBAC scope AND
      `region`). The row's `member_ids` are the row's hubs in it: the members
      breakdown never shows a hub outside the caller's scope, and the hub
      filter selects a row without hiding its other in-scope members.
    - `selected_member`: the filtered hub when it is one of the row's hubs.
    """

    filtered_set = set(filtered)
    scoped_set = set(scoped) | filtered_set
    rows: list[CapacityRowScope] = []
    for capacity_id in cmap.capacity_hub_ids():
        all_members = cmap.members_of[capacity_id]
        if not any(m in filtered_set for m in all_members):
            continue
        in_scope = tuple(m for m in all_members if m in scoped_set)
        selected = hub_id if hub_id is not None and hub_id in all_members else None
        rows.append(
            CapacityRowScope(
                capacity_hub_id=capacity_id,
                member_ids=in_scope,
                selected_member=selected,
                all_member_ids=all_members,
            )
        )
    return rows


async def capacity_rows_for_request(
    db: AsyncSession,
    principal: Principal,
    hub_id: uuid.UUID | None,
    region: LabRegion | None,
) -> tuple[CapacityHubMap, list[CapacityRowScope]]:
    """`load_capacity_hub_map` + `scoped_capacity_rows` for one request."""

    cmap = await load_capacity_hub_map(db)
    filtered = await visible_hub_ids(db, principal, hub_id, region)
    scoped = filtered if hub_id is None else await visible_hub_ids(db, principal, None, region)
    return cmap, scoped_capacity_rows(cmap, filtered, scoped, hub_id)


async def counted_fte_by_capacity_hub(
    db: AsyncSession, cmap: CapacityHubMap
) -> tuple[dict[uuid.UUID, float], dict[uuid.UUID, int], dict[uuid.UUID, int]]:
    """`(Σ fte, counted engineer count, not-counted engineer count)` per
    capacity hub, over the engineers whose hub resolves to it (ADR 0042 §2/§5:
    only `counts_in_capacity` engineers are supply)."""

    fte_values: dict[uuid.UUID, list[object]] = defaultdict(list)
    counted: dict[uuid.UUID, int] = defaultdict(int)
    not_counted: dict[uuid.UUID, int] = defaultdict(int)
    rows = (
        await db.execute(select(Engineer.hub_id, Engineer.fte, Engineer.counts_in_capacity))
    ).all()
    for eng_hub_id, fte, counts in rows:
        capacity_id = cmap.capacity_of.get(eng_hub_id, eng_hub_id)
        if counts:
            fte_values[capacity_id].append(fte)
            counted[capacity_id] += 1
        else:
            not_counted[capacity_id] += 1
    return {k: fte_sum(v) for k, v in fte_values.items()}, dict(counted), dict(not_counted)
