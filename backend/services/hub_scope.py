"""Row-level hub-scoped filtering (P3-T03) — the data-access-layer helpers
that turn `core.principal.Principal.hub_scope_all`/`hub_ids` (already
resolved by P3-T02's `api.deps.get_current_principal`/`require_permission`/
`require_any_permission`/`require_roles`) into actual SQLAlchemy `.where(...)`
predicates and pre-query lookups, per `docs/PROJECT_AND_STACK.md` §5:

    "Row-level hub scoping is enforced in the data access layer (SQLAlchemy
    query filters applied per-request from the authenticated user's hub
    claims), not just hidden in the UI — a Hub Planner's API calls must be
    rejected or filtered server-side for out-of-scope hubs, independent of
    what the frontend renders."

**Scope boundary**: this module does not touch `core/rbac.py` (action-level
permissions) or `api/deps.py`'s three dependency factories — those already
resolve and expose `Principal.hub_scope_all`/`hub_ids` on every request; this
module only *consumes* that, and every `api/routers/*.py` file composes these
helpers into its own queries. Nothing here decides "is this verb allowed on
this surface at all" (that's P3-T02's job, unchanged) — only "which rows, of
the rows already permitted to exist for this verb, may this particular
caller see/touch."

Three scoping shapes are needed, matching `docs/PROJECT_AND_STACK.md` §5's
row-level qualifiers:

1. **Hub-scoped rows** (`Project.hub_id`, `Engineer.hub_id`, `Hub.id` itself)
   — a plain `.in_(principal.hub_ids)` predicate when the caller is not
   `hub_scope_all`. `hub_scope_filter(...)` below.
2. **Lab-region-scoped rows** (`Chamber`) — `Chamber` has no `hub_id` column
   at all (see `models/chamber.py`/`models/hub.py`): a lab region is shared
   by up to four hubs per DOMAIN_RULES.md's "Hubs and lab-region mapping"
   table (R&D-India, PD-India, OEM-HCK and OEM-Seltek all map to "India").
   A Hub Planner scoped to e.g. only R&D-India must still see every chamber
   in the India lab region (chambers are genuinely shared infrastructure
   across those hubs, not owned by a single one) — resolved by mapping the
   caller's scoped `hub_ids` to their `LabRegion`s first
   (`scoped_lab_regions(...)`), then filtering
   `Chamber.lab_region.in_(...)` against that resolved set. This is a real
   architecture decision, not a mechanical transliteration of shape #1 —
   documented at length in `docs/MEMORY.md`'s P3-T03 entry, since
   DOMAIN_RULES.md/PROJECT_AND_STACK.md §5 do not spell out how chamber
   access composes with hub-scoping.
3. **"Own assignments"** (Engineer role, `GET /gantt` only) — narrower than
   hub: per the RBAC matrix, Engineer has NO hub scope at all (unlike Hub
   Planner) — a pure Engineer principal has `hub_scope_all=False` AND an
   EMPTY `hub_ids` (never assigned to a hub the way a Hub Planner is), which
   is exactly how `is_engineer_self_scoped(...)` below tells "this caller
   needs the narrower own-assignment filter" apart from "this caller is a
   misconfigured Hub Planner with zero hub scopes" (both would otherwise
   look identical from `hub_scope_filter(...)`'s point of view) — it also
   checks `RoleName.ENGINEER in principal.roles`. `api/routers/gantt.py`
   resolves the caller's own `Engineer` row (`Engineer.user_id ==
   principal.user_id`) and restricts the project set to only those with at
   least one schedule-run step assigned to that Engineer.

Every "no rows in scope" case below (an empty `hub_ids`, an empty resolved
lab-region set) is returned as an always-false predicate / empty set, never
as "no filter" — mirroring `core.principal.Principal`'s own documented
invariant ("'scoped to zero hubs' (misconfiguration) is never silently read
as 'scoped to all hubs'"). A caller must be explicitly `hub_scope_all=True`
to see everything; anything else defaults closed.
"""

from __future__ import annotations

import uuid
from typing import Any

from sqlalchemy import ColumnElement, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from core.principal import Principal
from models.enums import LabRegion, RoleName
from models.hub import Hub


def hub_scope_filter(
    principal: Principal, hub_id_column: InstrumentedAttribute[Any]
) -> ColumnElement[bool] | None:
    """A `.where(...)`-ready predicate restricting `hub_id_column` (e.g.
    `Project.hub_id`, `Engineer.hub_id`, `Hub.id`) to the caller's scoped
    hubs, or `None` if the caller is unrestricted (`hub_scope_all=True`) and
    no filter should be applied at all — callers must check for `None`
    explicitly and skip `.where(...)` in that case (adding
    `.where(hub_id_column.in_(()))` for an unrestricted caller would be a
    silent "empty" bug that only differs from a correct implementation once
    `hub_scope_all=True` callers exist, which every non-Hub-Planner role
    already does).
    """

    if principal.hub_scope_all:
        return None
    return hub_id_column.in_(principal.hub_ids)


def is_hub_in_scope(principal: Principal, hub_id: uuid.UUID | None) -> bool:
    """Whether the caller may write a row targeting `hub_id` — used on
    create/update paths where the target hub comes from the request body
    (there is no existing row to scope-filter a lookup against yet, unlike
    `hub_scope_filter` above, which composes into a SELECT). `hub_id=None`
    is never in scope for a hub-restricted caller (a hub-scoped write must
    always name a hub within that caller's scope).
    """

    if principal.hub_scope_all:
        return True
    if hub_id is None:
        return False
    return hub_id in principal.hub_ids


async def scoped_lab_regions(
    db: AsyncSession, principal: Principal
) -> set[LabRegion] | None:
    """Resolve the caller's scoped `hub_ids` to their `LabRegion`s (per
    DOMAIN_RULES.md's hub/lab-region mapping table), for filtering `Chamber`
    (which has no `hub_id` column of its own — see this module's docstring,
    shape #2). Returns `None` if the caller is unrestricted (`hub_scope_all`)
    — no lab-region filter should be applied. Returns an EMPTY set (never
    `None`) for a hub-restricted caller with no resolvable hubs, so a
    misconfigured/hub-less caller is filtered to zero chambers rather than
    silently seeing all of them.
    """

    if principal.hub_scope_all:
        return None
    if not principal.hub_ids:
        return set()
    rows = await db.execute(
        select(Hub.lab_region).where(Hub.id.in_(principal.hub_ids)).distinct()
    )
    return {row[0] for row in rows.all()}


def is_lab_region_in_scope(
    regions: set[LabRegion] | None, lab_region: LabRegion | None
) -> bool:
    """Companion to `scoped_lab_regions` for create/update body validation —
    `regions=None` means unrestricted (always in scope); an empty set or a
    `lab_region` not in it means out of scope.
    """

    if regions is None:
        return True
    if lab_region is None:
        return False
    return lab_region in regions


def is_engineer_self_scoped(principal: Principal) -> bool:
    """True when the caller should be restricted to their own assignments
    (Engineer role, `GET /gantt` only) rather than a hub-based filter or an
    unrestricted view — i.e. not `hub_scope_all`, an EMPTY `hub_ids` (a real
    Hub Planner always has at least one; per DOMAIN_RULES.md's matrix,
    Engineer is never hub-scoped at all), and holds the `Engineer` role.

    A caller who holds `Engineer` *plus* a broader role (e.g. also Hub
    Planner or Portfolio Manager on the same account) is scoped by that
    broader role's rules instead, not by this narrower one — a principal
    with a non-empty `hub_ids` or `hub_scope_all=True` never reaches this
    branch. This is a pragmatic, explicitly-documented interpretation for a
    multi-role account (untested in the P3-T02 seed data, where every test
    user holds exactly one role), not something DOMAIN_RULES.md/
    `docs/PROJECT_AND_STACK.md` §5 specifies directly — flagged in
    `docs/MEMORY.md`'s P3-T03 entry for orchestrator review.
    """

    return (
        not principal.hub_scope_all
        and not principal.hub_ids
        and RoleName.ENGINEER in principal.roles
    )
