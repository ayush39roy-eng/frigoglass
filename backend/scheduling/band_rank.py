"""Rank within a priority band — the one pure rank-arithmetic module (ADR 0050,
P36, R36-5 / R36-6 / R36-8).

Every write path and every preview input in the backend goes through these
functions, so the "after" input of a preview, the persisted run's input
snapshot and the DB state after commit are equal (I37d):

- a re-rank (`POST /projects/{id}/band-rank[/preview]`): `place`;
- a project entering a band (priority move, registration, Draft submit,
  un-hold / reactivation, P35 batch, seed, factories): `append_last`
  (several at once: `append_all_last`, ascending `project_id`);
- a project leaving a band (non-schedulable status, priority cleared):
  `remove`;
- the full lifecycle (R36-8 `reconcile_band_rank` core): `transition`;
- the same three on a `ScheduleInput`'s projects for previews and What-if
  (`move_band_inputs`, `place_inputs`).

A "band order" is the band's ranked project ids in rank order (rank 1 first).
Ranks are always derived from the order (`ranks`, dense 1..n), never
incremented in place, so every result is dense.

Band membership (I37b): status in the four schedulable statuses and priority
set. Pure: no DB, no I/O, deterministic (no set iteration reaches the
output).
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import replace

import domain_constants as dc
from scheduling.types import ProjectInput

__all__ = [
    "BandRankError",
    "append_all_last",
    "append_last",
    "band_of",
    "band_orders_from_inputs",
    "is_band_member",
    "move_band_inputs",
    "order_by_rank",
    "place",
    "place_inputs",
    "ranks",
    "remove",
    "transition",
]


class BandRankError(ValueError):
    """A rank write the rules forbid. `code` is the stable reason:

    - `NOT_SAME_BAND`: the anchor is not a ranked member of the band (the API
      maps this to 422 `NOT_SAME_BAND`, R36-8);
    - `SELF_ANCHOR`: the anchor is the moved project itself;
    - `BOTH_ANCHORS`: both `before` and `after` were given (exactly one, or
      neither = last, R36-8);
    - `NOT_IN_BAND`: the project to remove / re-rank in place is not a
      member (raised only where membership is required);
    - `ALREADY_IN_BAND`: `append_last` of a project already in the band;
    - `DUPLICATE_ID`: the band order lists an id twice;
    - `NOT_A_MEMBER`: the project is not schedulable or has no priority.
    """

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


# --- Membership ----------------------------------------------------------------


def is_band_member(status: str, priority: str | None) -> bool:
    """I37b: a project belongs to a band iff its status is one of the four
    schedulable statuses and its priority is set."""

    return status in dc.SCHEDULABLE_STATUS_ORDER and priority is not None


def band_of(status: str, priority: str | None) -> str | None:
    """The band a project with this status / priority belongs to, or None."""

    return priority if is_band_member(status, priority) else None


# --- Band-order arithmetic -------------------------------------------------------


def _checked(band_order: Sequence[str]) -> list[str]:
    seen: set[str] = set()
    for pid in band_order:
        if pid in seen:
            raise BandRankError("DUPLICATE_ID", f"{pid!r} appears twice in the band order")
        seen.add(pid)
    return list(band_order)


def order_by_rank(ranked: Iterable[tuple[str, int]]) -> list[str]:
    """The band order from `(project_id, band_rank)` pairs: rank ascending,
    `project_id` ascending on a tie (repairs a non-dense or duplicated rank
    deterministically). Unranked members are the caller's to append."""

    return _checked([pid for pid, _ in sorted(ranked, key=lambda t: (t[1], t[0]))])


def ranks(band_order: Sequence[str]) -> dict[str, int]:
    """Dense ranks 1..n for a band order (`{project_id: band_rank}`)."""

    return {pid: i for i, pid in enumerate(_checked(band_order), start=1)}


def place(
    band_order: Sequence[str],
    project_id: str,
    *,
    before: str | None = None,
    after: str | None = None,
) -> list[str]:
    """Re-rank (ADR 0050 §4 as ruled, R36-8): the band order with
    `project_id` immediately before `before`, or immediately after `after`,
    or last when neither is given. Every other member keeps its relative
    order (I37c), so a drop on a filtered board is well-defined whichever
    cards were hidden.

    `project_id` may already be in the band (a re-rank) or not (it enters
    the band at that position). An anchor must be a member of `band_order`
    and not `project_id` itself; at most one anchor. When the result equals
    `band_order` the write is a no-op (`unchanged`: no write, audit or run)."""

    order = _checked(band_order)
    if before is not None and after is not None:
        raise BandRankError("BOTH_ANCHORS", "give before or after, not both")
    anchor = before if before is not None else after
    if anchor is not None:
        if anchor == project_id:
            raise BandRankError("SELF_ANCHOR", f"{project_id!r} cannot be placed next to itself")
        if anchor not in order:
            raise BandRankError("NOT_SAME_BAND", f"{anchor!r} is not a ranked member of the band")
    rest = [pid for pid in order if pid != project_id]
    if anchor is None:
        return [*rest, project_id]
    i = rest.index(anchor) + (0 if before is not None else 1)
    return [*rest[:i], project_id, *rest[i:]]


def append_last(band_order: Sequence[str], project_id: str) -> list[str]:
    """A project entering the band goes last (`max + 1`, R36-8). Raises
    `ALREADY_IN_BAND` if it is already a member (a member keeps its rank;
    use `place` to move it)."""

    order = _checked(band_order)
    if project_id in order:
        raise BandRankError("ALREADY_IN_BAND", f"{project_id!r} is already in the band")
    return [*order, project_id]


def append_all_last(band_order: Sequence[str], project_ids: Iterable[str]) -> list[str]:
    """Several projects entering one band at once (P35 register batch, seed):
    appended in ascending `project_id`, the band renumbered once (R36-8)."""

    order = _checked(band_order)
    for pid in sorted(set(project_ids)):
        order = append_last(order, pid)
    return order


def remove(band_order: Sequence[str], project_id: str) -> list[str]:
    """A project leaving the band (non-schedulable status or priority
    cleared): the rest renumbered 1..n in their existing order. Raises
    `NOT_IN_BAND` if it is not a member."""

    order = _checked(band_order)
    if project_id not in order:
        raise BandRankError("NOT_IN_BAND", f"{project_id!r} is not in the band")
    return [pid for pid in order if pid != project_id]


def transition(
    band_orders: Mapping[str, Sequence[str]],
    project_id: str,
    *,
    band_before: str | None,
    band_after: str | None,
) -> dict[str, list[str]]:
    """The R36-8 lifecycle on band orders (the pure core of the backend's
    `reconcile_band_rank`). `band_before` / `band_after` are `band_of(...)`
    before and after the write (None = in no band).

    - same band (incl. both None): nothing changes, the rank is kept
      (hub / category / leader / frozen / VIP / schedulable->schedulable
      status, R36-3) -> `{}`;
    - left a band: removed there, that band renumbered;
    - entered a band: appended last there.

    Returns only the bands whose order changed: `{band: new_order}`
    (`ranks(new_order)` gives the values to write). A band absent from
    `band_orders` is empty."""

    if band_before == band_after:
        return {}
    out: dict[str, list[str]] = {}
    if band_before is not None:
        out[band_before] = remove(band_orders.get(band_before, ()), project_id)
    if band_after is not None:
        out[band_after] = append_last(band_orders.get(band_after, ()), project_id)
    return out


# --- On ScheduleInput projects (previews, What-if) ---------------------------------


def band_orders_from_inputs(projects: Iterable[ProjectInput]) -> dict[str, list[str]]:
    """Per band, the *ranked* members' ids in rank order (`order_by_rank`).
    Unranked members (What-if added / re-banded, imported rows) are not part
    of any band order: they sort behind it by key 3a anyway."""

    pairs: dict[str, list[tuple[str, int]]] = {}
    for p in projects:
        band = band_of(p.status, p.priority)
        if band is not None and p.band_rank is not None:
            pairs.setdefault(band, []).append((p.project_id, p.band_rank))
    return {band: order_by_rank(pairs[band]) for band in sorted(pairs)}


def _apply_orders(
    projects: Sequence[ProjectInput],
    new_orders: Mapping[str, Sequence[str]],
    overrides: Mapping[str, ProjectInput],
) -> tuple[ProjectInput, ...]:
    new_rank: dict[str, int] = {}
    for band in sorted(new_orders):
        new_rank.update(ranks(new_orders[band]))
    out: list[ProjectInput] = []
    for p in projects:
        q = overrides.get(p.project_id, p)
        if q.project_id in new_rank and q.band_rank != new_rank[q.project_id]:
            q = replace(q, band_rank=new_rank[q.project_id])
        out.append(q)
    return tuple(out)


def _find(projects: Sequence[ProjectInput], project_id: str) -> ProjectInput:
    for p in projects:
        if p.project_id == project_id:
            return p
    raise KeyError(project_id)


def move_band_inputs(
    projects: Sequence[ProjectInput],
    project_id: str,
    *,
    priority: str | None,
    status: str | None = None,
) -> tuple[ProjectInput, ...]:
    """The projects after a priority (and/or status) change of `project_id`,
    with the R36-8 rank lifecycle applied (`transition`): the moved project
    is last in its new band (or unranked if it left every band), the band it
    left renumbered, everything else untouched. Same band: only the
    priority / status fields change. The input order of `projects` is kept.
    For the priority-move preview's "after" input (R36-6). Raises `KeyError`
    for an unknown id."""

    old = _find(projects, project_id)
    new_status = old.status if status is None else status
    moved = replace(old, priority=priority, status=new_status)
    band_before = band_of(old.status, old.priority) if old.band_rank is not None else None
    band_after = band_of(new_status, priority)
    if band_before == band_after and (band_after is None or old.band_rank is not None):
        return tuple(moved if p.project_id == project_id else p for p in projects)
    if band_after is None:
        moved = replace(moved, band_rank=None)
    orders = transition(
        band_orders_from_inputs(projects),
        project_id,
        band_before=band_before,
        band_after=band_after,
    )
    return _apply_orders(projects, orders, {project_id: moved})


def place_inputs(
    projects: Sequence[ProjectInput],
    project_id: str,
    *,
    before: str | None = None,
    after: str | None = None,
) -> tuple[ProjectInput, ...]:
    """The projects after a re-rank of `project_id` inside its band (`place`
    on the band's ranked order, then dense 1..n). The project must be a band
    member (`NOT_A_MEMBER` otherwise); anchors as in `place`. The input order
    of `projects` is kept. For the re-rank preview's "after" input. Raises
    `KeyError` for an unknown id."""

    p = _find(projects, project_id)
    band = band_of(p.status, p.priority)
    if band is None:
        raise BandRankError("NOT_A_MEMBER", f"{project_id!r} is not in a priority band")
    order = band_orders_from_inputs(projects).get(band, [])
    return _apply_orders(projects, {band: place(order, project_id, before=before, after=after)}, {})
