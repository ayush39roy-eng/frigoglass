"""Audit log read surface (P3-T04).

**Scope note**: the *write* side of "immutable append-only audit log" —
DB-level append-only enforcement (a trigger rejecting `UPDATE`/`DELETE`/
`TRUNCATE` on `audit_log_entries`, P1-T02 + the P1-T07 `TRUNCATE`
remediation) and every mutation handler writing a real `AuditLogEntry`
(`api/routers/{projects,engineers,chambers,priorities,gantt,
schedule_runs,currency_rates}.py`) — already exists and was already verified
independently during the P3-T03 review (see `docs/MEMORY.md`). This module is
the only piece that was actually missing: a `GET /audit-log` endpoint reading
those rows back out.

**RBAC**: gated to `core.rbac.Surface.AUDIT_LOG` / `Action.READ`, which per
`docs/PROJECT_AND_STACK.md` §5's matrix (reproduced verbatim in
`core/rbac.py`) is granted to Auditor and Admin ONLY — every other role
(Portfolio Manager, Hub Planner, Engineer, Executive Viewer) gets 403, same as
any other `require_permission(...)`-gated endpoint in this codebase.

**No hub-scoping (P3-T03) applies here** — confirmed directly against the
matrix before writing this module: the Audit Log column's qualifier is
"R (all)" for Auditor, not "R (own hub)" like Hub Planner's qualifier
elsewhere. `services.hub_scope.hub_scope_filter` is deliberately NOT composed
into this router's query — an Auditor sees every hub's audit history, not
just their own (Auditor is not even hub-scoped in the `User`/`Principal`
model to begin with: Auditor and Admin are both `hub_scope_all=True`-only
roles per every prior P3 task's seed/test data). `hub_id` is still exposed as
an optional *filter* query param (like `entity_type`/`entity_id`/`actor_user_id`
elsewhere in this codebase) for a caller who wants to narrow their own view —
that is a convenience filter, not row-level access control, and omitting it
returns the full unfiltered (subject to RBAC) result set.

**Financial-field redaction**: `before_state`/`after_state` are written
already-redacted at audit-row-creation time (see
`services/audit_helpers.py`'s module docstring: the four financial/PII field
names are written as the literal string `"<redacted>"`, and the real value is
never read into the writing process at all). This read surface therefore
trivially inherits that redaction with **no additional work** — there is
nothing left to redact at read time, because nothing unredacted was ever
persisted. This holds identically for Auditor and Admin; neither role sees a
real financial value through this endpoint, which is the only reading
consistent with CLAUDE.md's "Financial columns ... never logged" — an audit
log read surface is exactly the kind of "logged" surface that rule guards
against. See `schemas/audit.py`'s module docstring for the same note attached
to the response schema, and this task's `docs/MEMORY.md` entry for the live
query that confirmed it.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import ColumnElement, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.db import get_db
from api.deps import require_permission
from api.query_params import MAX_FILTER_VALUES
from core.principal import Principal
from core.rbac import Action, Surface
from models.audit import AuditLogEntry
from schemas.audit import AuditLogEntryList, AuditLogEntryRead
from services.category_type_filter import one_of

router = APIRouter(prefix="/audit-log", tags=["audit-log"])

_read = require_permission(Surface.AUDIT_LOG, Action.READ)

_REPEAT_DOC = (
    "Repeatable (ADR 0050). Values are ORed; ANDed with every other filter. "
    f"Absent = no filter. At most {MAX_FILTER_VALUES} values."
)


@router.get("", response_model=AuditLogEntryList)
async def list_audit_log(
    entity_type: Annotated[
        list[str] | None, Query(description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES)
    ] = None,
    entity_id: str | None = None,
    actor_user_id: Annotated[
        list[uuid.UUID] | None, Query(description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES)
    ] = None,
    action: Annotated[
        list[str] | None, Query(description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES)
    ] = None,
    hub_id: Annotated[
        list[uuid.UUID] | None, Query(description=_REPEAT_DOC, max_length=MAX_FILTER_VALUES)
    ] = None,
    occurred_from: datetime | None = None,
    occurred_to: datetime | None = None,
    limit: int = 100,
    offset: int = 0,
    db: AsyncSession = Depends(get_db),
    current_user: Principal = Depends(_read),
) -> AuditLogEntryList:
    """List/filter audit-log entries, newest first. Requires READ on the
    `AUDIT_LOG` surface (401/403 enforced by `_read`) — Auditor and Admin
    only, per the matrix; not hub-scoped (see module docstring).

    Filters (all optional, ANDed together; ADR 0050: `entity_type`,
    `actor_user_id`, `action` and `hub_id` are repeatable, values ORed, at
    most 50 each):
    - `entity_type` / `entity_id`: e.g. `"Project"` / a specific row's UUID
      string (`AuditLogEntry.entity_id` is free-text, matching how every
      writer stores it — see `models/audit.py`).
    - `actor_user_id`: which user performed the mutation. `None` (system
      actor) rows are never matched by this filter when it's set — pass no
      `actor_user_id` to see all rows including system-originated ones.
    - `action`: exact match on the free-text action name (e.g.
      `"project.update"`).
    - `hub_id`: convenience narrowing, NOT row-level access control — see
      module docstring. `AuditLogEntry.hub_id` is nullable (hub-agnostic
      actions), so this filter naturally excludes those rows when set.
    - `occurred_from` / `occurred_to`: inclusive date-range bounds on
      `AuditLogEntry.occurred_at`.

    Pagination matches `api/routers/projects.py::list_projects`'s convention
    (`limit`/`offset`, `limit` in `[1, 500]`, `offset >= 0`, both 422 outside
    that range) — this table is unboundedly growing, so an unfiltered/
    unpaginated dump is never returned; `total_count` in the response lets a
    caller page through the full filtered result set without a second
    request.
    """

    if limit < 1 or limit > 500:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 500")
    if offset < 0:
        raise HTTPException(status_code=422, detail="offset must be >= 0")

    # ADR 0050: `entity_type`, `actor_user_id`, `action` and `hub_id` are
    # repeatable (OR within a param, AND across); exact matches, no sentinel.
    filters: list[ColumnElement[bool]] = []
    for column, values in (
        (AuditLogEntry.entity_type, entity_type),
        (AuditLogEntry.actor_user_id, actor_user_id),
        (AuditLogEntry.action, action),
        (AuditLogEntry.hub_id, hub_id),
    ):
        predicate = one_of(column, values)
        if predicate is not None:
            filters.append(predicate)
    if entity_id is not None:
        filters.append(AuditLogEntry.entity_id == entity_id)
    if occurred_from is not None:
        filters.append(AuditLogEntry.occurred_at >= occurred_from)
    if occurred_to is not None:
        filters.append(AuditLogEntry.occurred_at <= occurred_to)

    count_stmt = select(func.count()).select_from(AuditLogEntry)
    for f in filters:
        count_stmt = count_stmt.where(f)
    total_count = (await db.execute(count_stmt)).scalar_one()

    stmt = select(AuditLogEntry)
    for f in filters:
        stmt = stmt.where(f)
    stmt = stmt.order_by(AuditLogEntry.occurred_at.desc()).limit(limit).offset(offset)

    result = await db.execute(stmt)
    rows = result.scalars().all()
    # Explicit `model_validate(...)` per row (rather than relying on
    # `AuditLogEntryList`'s own construction to implicitly apply
    # `AuditLogEntryRead`'s `from_attributes=True` to each nested ORM
    # instance) so the ORM->schema boundary is unambiguous and not dependent
    # on Pydantic's nested-model validation-mode inference.
    items = [AuditLogEntryRead.model_validate(row) for row in rows]

    return AuditLogEntryList(items=items, total_count=total_count, limit=limit, offset=offset)
