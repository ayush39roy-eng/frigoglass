"""Rank within a priority band: the DB side (ADR 0050, P36-T03, R36-1 / R36-6 /
R36-8).

Every rank arithmetic step is `scheduling.band_rank` (the pure module owned
by the scheduler); this module only reads the band orders from the DB, takes
the lock and writes the results back. Nothing here computes a rank by hand.

- `lock_band_ranks`: the transaction-scoped advisory lock every
  rank-writing transaction takes FIRST, before the dispatch lock
  (`services.run_dispatch`) and before any row `FOR UPDATE` (R36-8), so two
  writers of one band serialise without deadlock.
- `reconcile_band_rank(db, project, status_before=, priority_before=)`: the
  one lifecycle function (R36-8) every write path calls after it has set the
  project's new status / priority and BEFORE anything flushes: entering a
  band -> last there; leaving it -> NULL and the old band renumbered; any
  other change (hub, category, leader, frozen, VIP, schedulable ->
  schedulable status, R36-3) keeps the rank. Uses
  `scheduling.band_rank.transition`.
- `plan_batch_band_ranks`: the P35 register batch, all projects that
  enter one band appended (status enterers in ascending id, P59-B priority
  movers after them in current rank, name, id) and the band renumbered
  once; leavers removed.
- `place_in_band`: the re-rank write (`scheduling.band_rank.place`).
- `assign_default_band_ranks`: the R36-1 backfill rule in Python (status
  ordinal, live `categories.rank`, id; uncategorised last by id), for the
  seed and the test factories (R36-1(f)); the migration `p36a` runs the same
  rule in SQL.

The membership CHECK (`ck_projects_band_rank_membership`) is immediate, so
the moved project's `band_rank` is set on the ORM object together with its
status / priority (one UPDATE), and the band reads run under `no_autoflush`.
The unique `(priority, band_rank)` constraint is deferred to commit, so the
neighbours can be renumbered row by row.

Only the moved / entering project is the caller's to mark `schedule_stale`:
the neighbours' order-preserving renumbering is not an input change for them
and is not audited per row (R36-8).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

from fastapi import status as http_status
from sqlalchemy import func, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import CodedHTTPException
from models.category import Category
from models.enums import ProjectPriority, ProjectStatus
from models.project import Project
from scheduling import band_rank as br
from schemas.project import ProjectRead

#: Fixed advisory-lock key for "write band ranks" ("RPDBR" in ASCII hex, the
#: `run_dispatch.DISPATCH_LOCK_KEY` convention; distinct from every other key).
BAND_RANK_LOCK_KEY = 0x5250444252

#: The four band statuses (`domain_constants.SCHEDULABLE_STATUS_ORDER`).
BAND_STATUSES: frozenset[ProjectStatus] = frozenset(
    ProjectStatus(name) for name in dc.SCHEDULABLE_STATUS_ORDER
)


#: P36-R01 (security M-1): how long a writer waits for the band-rank lock
#: before giving up with 503 `BAND_RANK_BUSY`. Applied with a transaction-
#: local `lock_timeout` around the lock call only, so the dispatch lock and
#: the row `FOR UPDATE` that follow keep the session's own setting.
BAND_RANK_LOCK_TIMEOUT = "5s"
#: Postgres `lock_not_available` (raised when `lock_timeout` expires).
_LOCK_NOT_AVAILABLE = "55P03"
#: Seconds the 503 asks the client to wait before retrying.
BAND_RANK_BUSY_RETRY_AFTER = 5


def _sqlstate(exc: DBAPIError) -> str | None:
    orig = exc.orig
    return getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)


def band_rank_busy() -> CodedHTTPException:
    """503 `BAND_RANK_BUSY` (API_CONTRACT_P36 §5): the lock was not granted
    within `BAND_RANK_LOCK_TIMEOUT`; nothing was written."""

    return CodedHTTPException(
        http_status.HTTP_503_SERVICE_UNAVAILABLE,
        "BAND_RANK_BUSY",
        "Another priority change is being saved. Please try again in a moment.",
        headers={"Retry-After": str(BAND_RANK_BUSY_RETRY_AFTER)},
    )


async def lock_band_ranks(db: AsyncSession) -> None:
    """Take the band-rank advisory lock (held until commit / rollback).
    Re-entrant within a transaction.

    P36-R01 (security M-1): callers take it only AFTER the project lookup,
    authorisation and rate limit (plain SELECTs before it, R36-8 order kept:
    band lock -> dispatch lock -> row `FOR UPDATE`), and the wait is bounded
    by a transaction-local `lock_timeout` (`BAND_RANK_LOCK_TIMEOUT`), restored
    straight after the lock is granted. A timeout rolls the transaction back
    and raises 503 `BAND_RANK_BUSY`."""

    previous: str = (
        await db.execute(select(func.current_setting("lock_timeout")))
    ).scalar_one()
    await db.execute(select(func.set_config("lock_timeout", BAND_RANK_LOCK_TIMEOUT, True)))
    try:
        await db.execute(select(func.pg_advisory_xact_lock(BAND_RANK_LOCK_KEY)))
    except DBAPIError as exc:
        if _sqlstate(exc) != _LOCK_NOT_AVAILABLE:
            raise
        await db.rollback()
        raise band_rank_busy() from None
    await db.execute(select(func.set_config("lock_timeout", previous, True)))


def _value(enum_or_none: ProjectStatus | ProjectPriority | None) -> str | None:
    return enum_or_none.value if enum_or_none is not None else None


def band_of_project(status: ProjectStatus | None, priority: ProjectPriority | None) -> str | None:
    """The band a project with this status / priority belongs to (I37b)."""

    if status is None:
        return None
    return br.band_of(status.value, _value(priority))


async def band_sizes(db: AsyncSession) -> dict[ProjectPriority, int]:
    """ADR 0064 R1: the number of ranked projects per priority band, over the
    FULL band (every hub), so it is the `n` of the full-band `band_rank`
    numbering (dense 1..n, the same `n` the `to_rank` body is checked
    against). One grouped count per request, never per row. Deliberately not
    hub-scoped: a scoped size would contradict the full-band rank (W36-1)."""

    with db.no_autoflush:
        rows = (
            await db.execute(
                select(Project.priority, func.count())
                .where(Project.band_rank.is_not(None))
                .group_by(Project.priority)
            )
        ).all()
    return {priority: int(count) for priority, count in rows if priority is not None}


def with_band_size[R: ProjectRead](read: R, sizes: Mapping[ProjectPriority, int]) -> R:
    """`read` with its read-only `band_size` filled from `band_sizes` (ADR
    0064 R1): the size of the project's band, or null when `band_rank` is
    null (not a band member)."""

    size = (
        sizes.get(read.priority, 0)
        if read.band_rank is not None and read.priority is not None
        else None
    )
    return read.model_copy(update={"band_size": size})


async def band_order(db: AsyncSession, band: str) -> list[str]:
    """The band's ranked project ids (as strings) in rank order, read from the
    DB as committed / flushed so far (no autoflush)."""

    with db.no_autoflush:
        rows = (
            await db.execute(
                select(Project.id, Project.band_rank).where(
                    Project.priority == ProjectPriority(band),
                    Project.band_rank.is_not(None),
                )
            )
        ).all()
    return br.order_by_rank((str(pid), int(rank)) for pid, rank in rows if rank is not None)


async def _write_orders(
    db: AsyncSession,
    new_orders: Mapping[str, Sequence[str]],
    *,
    moved: Project | None = None,
    current: Mapping[str, Mapping[str, int]] | None = None,
) -> None:
    """Write `ranks(order)` for every band in `new_orders`. The moved project
    gets its rank on the ORM object (same UPDATE as its status / priority);
    every other row whose rank changed is updated by primary key (session
    objects synchronised). `current` = the ranks as read, to skip no-ops."""

    pending: list[tuple[str, int]] = []
    for band in sorted(new_orders):
        old_ranks = (current or {}).get(band, {})
        for pid, rank in br.ranks(new_orders[band]).items():
            if moved is not None and pid == str(moved.id):
                # First, so any autoflush below writes a consistent row.
                moved.band_rank = rank
            elif old_ranks.get(pid) != rank:
                pending.append((pid, rank))
    await _update_ranks(db, pending)


async def _update_ranks(db: AsyncSession, pending: Sequence[tuple[str, int]]) -> None:
    """Neighbour renumbering by primary key (session objects synchronised).
    The deferred unique constraint allows transient duplicates."""

    for pid, rank in pending:
        await db.execute(
            update(Project)
            .where(Project.id == uuid.UUID(pid))
            .values(band_rank=rank)
            .execution_options(synchronize_session="fetch")
        )


async def reconcile_band_rank(
    db: AsyncSession,
    project: Project,
    *,
    status_before: ProjectStatus,
    priority_before: ProjectPriority | None,
) -> bool:
    """R36-8: apply the rank lifecycle to `project`, whose new status /
    priority are already set on the object (not yet flushed). Returns True
    when the project entered or left a band (its `band_rank` changed).

    The caller holds `lock_band_ranks`. Flushes at the end, so a second call
    in the same transaction (PATCH: status, then the priority move) reads
    the result of the first."""

    band_before = band_of_project(status_before, priority_before)
    if project.band_rank is None:
        # Not ranked in the DB (a non-member, or a brand-new row): it enters.
        band_before = None
    band_after = band_of_project(project.status, project.priority)
    if band_before == band_after and (band_after is None or project.band_rank is not None):
        return False
    orders: dict[str, list[str]] = {}
    for band in {band_before, band_after} - {None}:
        assert band is not None
        orders[band] = await band_order(db, band)
    pid = str(project.id)
    if band_after is not None and pid in orders.get(band_after, []):
        # Defensive: already ranked there in the DB (cannot happen while the
        # in-memory rank matches the DB); keep it.
        return False
    changed = br.transition(orders, pid, band_before=band_before, band_after=band_after)
    if band_after is None:
        project.band_rank = None
    current = {band: br.ranks(order) for band, order in orders.items()}
    await _write_orders(db, changed, moved=project, current=current)
    await db.flush()
    return True


async def plan_batch_band_ranks(
    db: AsyncSession,
    transitions: Sequence[tuple[Project, ProjectStatus, ProjectPriority | None]],
) -> dict[uuid.UUID, int | None]:
    """The P35 register batch (R36-8): `transitions` = `(project,
    new_status, new_priority)` for every row whose status or priority the
    batch sets (unchanged values passed as the stored ones), read BEFORE any
    of them is written. Leavers are removed from their band; per band, the
    entering projects are appended last and the band renumbered ONCE.

    Order of the projects entering one band: first those whose priority is
    unchanged (a status change, e.g. un-hold), in ascending `project_id`
    (`append_all_last`, as before P59); then those moved there by a priority
    change (P59-B bulk priority), in their current `band_rank` (unranked
    last), then name, then id, so a bulk move keeps their relative order.

    Writes the renumbered neighbours now (by primary key; the deferred unique
    constraint allows the transient overlap) and returns the new
    `band_rank` of every project that enters or leaves a band, for the
    caller to set together with its status / priority (the membership CHECK
    is immediate). Projects that keep their band are absent. The caller holds
    `lock_band_ranks`."""

    leaving: dict[str, list[str]] = {}
    entering: dict[str, list[tuple[tuple[Any, ...], str]]] = {}
    moved: dict[str, uuid.UUID] = {}
    for project, new_status, new_priority in transitions:
        before = band_of_project(project.status, project.priority)
        if project.band_rank is None:
            before = None
        after = band_of_project(new_status, new_priority)
        if before == after and (after is None or project.band_rank is not None):
            continue
        pid = str(project.id)
        moved[pid] = project.id
        if before is not None:
            leaving.setdefault(before, []).append(pid)
        if after is not None:
            key: tuple[Any, ...] = (
                (0, pid)
                if new_priority == project.priority
                else (
                    1,
                    project.band_rank is None,
                    project.band_rank or 0,
                    project.name,
                    pid,
                )
            )
            entering.setdefault(after, []).append((key, pid))
    if not moved:
        return {}
    result: dict[uuid.UUID, int | None] = dict.fromkeys(moved.values())
    pending: list[tuple[str, int]] = []
    for band in sorted(set(leaving) | set(entering)):
        order = await band_order(db, band)
        current = br.ranks(order)
        new_order = order
        for pid in leaving.get(band, []):
            new_order = br.remove(new_order, pid)
        for _key, pid in sorted(entering.get(band, [])):
            new_order = br.append_last(new_order, pid)
        for pid, rank in br.ranks(new_order).items():
            if pid in moved:
                result[moved[pid]] = rank
            elif current.get(pid) != rank:
                pending.append((pid, rank))
    await _update_ranks(db, pending)
    return result


async def place_in_band(
    db: AsyncSession,
    project: Project,
    *,
    before: uuid.UUID | None,
    after: uuid.UUID | None,
) -> tuple[list[str], list[str]]:
    """The re-rank write (ADR 0050 §4 as ruled): `project` placed directly
    before / after the anchor in its band (`scheduling.band_rank.place`),
    the band renumbered 1..n. Returns `(order_before, order_after)`; equal
    means a no-op and nothing is written. Raises `BandRankError`. The caller
    holds `lock_band_ranks` and has checked membership."""

    band = band_of_project(project.status, project.priority)
    if band is None or project.band_rank is None:
        raise br.BandRankError("NOT_A_MEMBER", "the project is not ranked in a band")
    order = await band_order(db, band)
    new_order = br.place(
        order,
        str(project.id),
        before=str(before) if before is not None else None,
        after=str(after) if after is not None else None,
    )
    if new_order != order:
        await _write_orders(db, {band: new_order}, moved=project, current={band: br.ranks(order)})
        await db.flush()
    return order, new_order


# --- the R36-1 default order (migration backfill rule) -------------------------------


async def default_band_orders(
    db: AsyncSession, bands: Iterable[str] | None = None
) -> dict[str, list[str]]:
    """Per band, every member's id in the R36-1 backfill order: categorised
    members by (status ordinal, live `categories.rank`, id), then members with
    no category by id. Exactly the `p36a` SQL."""

    stmt = (
        select(Project.id, Project.priority, Project.status, Category.rank)
        .outerjoin(Category, Category.code == Project.category)
        .where(Project.priority.is_not(None), Project.status.in_(BAND_STATUSES))
    )
    wanted = set(bands) if bands is not None else None
    with db.no_autoflush:
        rows = (await db.execute(stmt)).all()
    keyed: dict[str, list[tuple[tuple[int, int, int, str], str]]] = {}
    for pid, priority, status, cat_rank in rows:
        if priority is None:  # excluded by the query
            continue
        band = priority.value
        if wanted is not None and band not in wanted:
            continue
        key = (
            (1, 0, 0, str(pid))
            if cat_rank is None
            else (0, dc.SCHEDULABLE_STATUS_ORDER[status.value], int(cat_rank), str(pid))
        )
        keyed.setdefault(band, []).append((key, str(pid)))
    return {band: [pid for _k, pid in sorted(keyed[band])] for band in sorted(keyed)}


def provisional_band_rank(
    status: ProjectStatus, priority: ProjectPriority | None, counter: dict[str, int]
) -> int | None:
    """A placeholder rank for a row inserted by the seed / factories before
    `assign_default_band_ranks` renumbers its band (the membership CHECK is
    immediate, the unique constraint deferred). Distinct per band."""

    band = band_of_project(status, priority)
    if band is None:
        return None
    counter[band] = counter.get(band, 0) + 1
    return counter[band]


async def assign_default_band_ranks(db: AsyncSession, bands: Iterable[str] | None = None) -> None:
    """R36-1(f): rank `bands` (default: every band) by the backfill rule.
    Flushes pending rows first so they are included."""

    await db.flush()
    orders = await default_band_orders(db, bands)
    await _update_ranks(
        db, [(pid, rank) for band in sorted(orders) for pid, rank in br.ranks(orders[band]).items()]
    )
    await db.flush()
