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
   least one schedule-run step assigned to that Engineer. *(2026-10-21)*
   Self-scoping is decided by the role set, not by `hub_ids`: a caller who
   also holds a hub-scoped role (PM, Hub Planner, Executive Viewer, Admin,
   Super Admin) gets that role's hub scope ORed with their own assignments
   (`project_row_scope`), never the narrower set alone.

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

from sqlalchemy import ColumnElement, and_, false, or_, select
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
    (Engineer role, `GET /gantt` and `services.workspace.
    get_scoped_project_or_404` only) rather than a hub-based filter or an
    unrestricted view — i.e. holds the `Engineer` role and has an EMPTY
    `hub_ids` (a real Hub Planner always has at least one; per
    DOMAIN_RULES.md's matrix, Engineer is never hub-scoped at all).

    **2026-09-30 (P10-F01 security fix, High).** This deliberately does
    **not** check `principal.hub_scope_all` — a prior version required `not
    principal.hub_scope_all` before applying this narrowing, which let any
    Engineer-role account with `hub_scope_all=True` silently skip
    own-assignment scoping entirely and fall through to
    `hub_scope_filter`'s "unrestricted, see every hub" branch instead. That
    was not a contrived edge case: it is the actual `seed/seed_dev_users.py`
    and `tests/factories.py::make_user` default for the Engineer role prior
    to this fix (a plain `hub_scope_all=True` account with no explicit
    override), so it was live-exploitable in dev/demo data, not just
    theoretically possible — see `docs/MEMORY.md`'s P10 gate
    security-auditor finding and the P10-F01 remediation entry. `hub_scope_all`
    is an "unrestricted, all hubs" bypass that only ever made sense for
    Hub-Planner-vs-Portfolio-Manager/Executive-Viewer/Admin (roles whose RBAC
    matrix qualifier is genuinely "(all hubs)"); Engineer's qualifier is
    always "(own assignments)", never "(all hubs)", so `hub_scope_all` must
    never be read for it at all. An Engineer principal is therefore ALWAYS
    scoped to their own assignments now, regardless of what `hub_scope_all`
    happens to be set to on the account — defense in depth alongside the
    schema-level guard (`schemas/user_admin.py`'s `_forbid_engineer_hub_scope_all`)
    that now rejects setting `hub_scope_all=True` on an Engineer-only account
    in the first place.

    **2026-10-21 (multi-role fix, ADR 0012 "MAX over the rules").** The
    test is now on the *role set*, not on `hub_ids`: a caller is
    self-scoped only when Engineer is the sole role that gives them project
    rows (`has_hub_project_scope` is False). The previous test,
    `not hub_ids and ENGINEER in roles`, was wrong for a multi-role account:
    a Portfolio Manager / Executive Viewer / Admin with `hub_scope_all=True`
    has an EMPTY `hub_ids` by construction, so adding Engineer to such an
    account narrowed every list (Gantt, engineer heatmap, run changes,
    check-in due list) to "own assignments", and to nothing at all when no
    `Engineer` row is linked. A broader role now always wins, and its own
    hub scope is widened (never narrowed) by the Engineer's own assignments
    — `project_row_scope` below. An Engineer whose only other roles are
    non-project ones (Auditor) stays self-scoped, and so does an
    Engineer-only account that happens to carry `hub_ids` (Engineer is
    never hub-scoped, per the matrix).
    """

    return RoleName.ENGINEER in principal.roles and not has_hub_project_scope(principal)


#: Roles whose project row scope is hub-based (§5 matrix qualifier "(own
#: hub)" or "(all hubs)" / unqualified), as opposed to Engineer's "(own
#: assignments)". Auditor reads no project surface, so it is in neither set.
HUB_SCOPED_PROJECT_ROLES: frozenset[RoleName] = frozenset(
    {
        RoleName.SUPER_ADMIN,
        RoleName.ADMIN,
        RoleName.PORTFOLIO_MANAGER,
        RoleName.HUB_PLANNER,
        RoleName.EXECUTIVE_VIEWER,
    }
)


def has_hub_project_scope(principal: Principal) -> bool:
    """True when at least one of the caller's roles reads project rows by
    hub scope (`hub_scope_filter`), so Engineer's narrower own-assignment
    rule must not replace it (ADR 0012: effective access is the MAX)."""

    return bool(principal.roles & HUB_SCOPED_PROJECT_ROLES)


def project_row_scope(
    principal: Principal,
    hub_id_column: InstrumentedAttribute[Any],
    own: ColumnElement[bool] | None,
) -> ColumnElement[bool] | None:
    """The project-row predicate for a surface Engineer may read (Gantt,
    run changes), as the UNION of every role's rows (ADR 0012):

    - self-scoped Engineer → `own` only (always-false when `own` is None,
      i.e. no linked `Engineer` row);
    - otherwise the hub scope, ORed with `own` when the caller also holds
      Engineer and `own` is given; `None` (no filter) for `hub_scope_all`.

    `own` is the caller's own-assignment predicate, built by the call site
    (each surface has its own definition of "assigned"); pass `None` when
    the caller has no linked engineer.
    """

    if is_engineer_self_scoped(principal):
        return own if own is not None else false()
    hub = hub_scope_filter(principal, hub_id_column)
    if hub is None:
        return None
    if own is not None and RoleName.ENGINEER in principal.roles:
        return or_(hub, own)
    return hub


def needs_own_assignments(principal: Principal) -> bool:
    """Whether `project_row_scope` will read `own` for this caller, so call
    sites can skip the own-assignment query for everyone else (a
    `hub_scope_all` caller already sees every row)."""

    if RoleName.ENGINEER not in principal.roles:
        return False
    return is_engineer_self_scoped(principal) or not principal.hub_scope_all


def global_hub_filter(
    hub_id_column: InstrumentedAttribute[Any],
    hub_id: uuid.UUID | None,
    region: LabRegion | None = None,
) -> ColumnElement[bool] | None:
    """The global filter alone (ADR 0020 hub, ADR 0025 country), without the
    RBAC scope: `column == hub_id` AND `column IN (hubs of region)`. `None`
    when neither is given. Callers that scope by something other than
    `hub_scope_filter` (the Gantt's own-assignment Engineer path) AND this
    with their own scope; everyone else uses `narrowed_hub_filter`.
    """

    parts: list[ColumnElement[bool]] = []
    if hub_id is not None:
        parts.append(hub_id_column == hub_id)
    if region is not None:
        # ADR 0025: "country" is the hub's served lab region. Bound parameter,
        # never interpolated.
        parts.append(hub_id_column.in_(select(Hub.id).where(Hub.lab_region == region)))
    if not parts:
        return None
    return parts[0] if len(parts) == 1 else and_(*parts)


def narrowed_hub_filter(
    principal: Principal,
    hub_id_column: InstrumentedAttribute[Any],
    hub_id: uuid.UUID | None,
    region: LabRegion | None = None,
) -> ColumnElement[bool] | None:
    """ADR 0020: the RBAC scope (`hub_scope_filter`) AND the optional global
    hub filter (`hub_id` query parameter). The filter only ever narrows: a
    `hub_id` outside the caller's scope gives an always-empty predicate
    (scope AND `column == hub_id`), so the endpoint answers with empty rows
    and zero totals rather than a 403 that would reveal the hub has data.
    `None` means no predicate at all (unrestricted caller, no filter).

    ADR 0025: `region` (a `LabRegion`, "country") is ANDed the same way:
    scope AND (`hub_id`) AND (hub in `region`). A region with no hub in the
    caller's scope gives empty rows, never a 403 and never a wider scope.
    """

    scope = hub_scope_filter(principal, hub_id_column)
    chosen = global_hub_filter(hub_id_column, hub_id, region)
    if chosen is None:
        return scope
    return chosen if scope is None else and_(scope, chosen)


async def narrowed_lab_regions(
    db: AsyncSession,
    principal: Principal,
    hub_id: uuid.UUID | None,
    region: LabRegion | None = None,
) -> set[LabRegion] | None:
    """The lab regions whose chambers a filtered Capacity view shows: the
    caller's scoped regions (`scoped_lab_regions`), narrowed to the chosen
    hub's region (ADR 0020 §4; an out-of-scope or unknown hub gives none) and
    to `region` (ADR 0025). `None` = unrestricted, no filter.
    """

    regions = await scoped_lab_regions(db, principal)
    if hub_id is not None:
        hub_region = (
            await db.execute(select(Hub.lab_region).where(Hub.id == hub_id))
        ).scalar_one_or_none()
        chosen = (
            {hub_region}
            if hub_region is not None and is_hub_in_scope(principal, hub_id)
            else set()
        )
        regions = chosen if regions is None else regions & chosen
    if region is not None:
        regions = {region} if regions is None else regions & {region}
    return regions
