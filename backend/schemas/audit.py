"""Pydantic response model for the audit-log read surface
(`backend/api/routers/audit_log.py`, P3-T04), per CLAUDE.md's "every endpoint
gets a Pydantic request model and a Pydantic response model. No untyped
`dict` passthrough."

There is no request *body* model here (this is a pure `GET`) — query/filter
parameters are plain typed FastAPI query params on the router function itself,
matching `api/routers/projects.py::list_projects`'s established convention
rather than inventing a dedicated filter-body schema for a read-only list
endpoint.

**Redaction note** (see `services/audit_helpers.py`'s module docstring and
this task's MEMORY.md entry for the full reasoning): `before_state`/
`after_state` are stored ALREADY REDACTED at write time — the four financial/
PII field names (`models.types.FINANCIAL_FIELD_NAMES`) are written as the
literal string `"<redacted>"` and the real value is never read into this
process at all, let alone persisted. This response model exposes
`before_state`/`after_state` verbatim (whatever JSONB is actually stored) —
there is no separate redaction step to add here, and none is needed: reading
back a value that was never written unredacted cannot un-redact it. This
holds for every role permitted to reach this endpoint (Auditor, Admin) alike;
there is no "Admin sees real values" special case anywhere in this stack.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AuditLogEntryRead(BaseModel):
    """One row of `models.audit.AuditLogEntry`, verbatim."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    occurred_at: datetime
    actor_user_id: uuid.UUID | None
    action: str
    entity_type: str
    entity_id: str
    hub_id: uuid.UUID | None
    before_state: dict | None
    after_state: dict | None
    request_id: str | None
    ip_address: str | None
    notes: str | None


class AuditLogEntryList(BaseModel):
    """Envelope for `GET /audit-log`: the page of matching rows plus the
    total count of rows matching the filters (ignoring `limit`/`offset`), so
    the frontend can render pagination controls without a second
    `count`-only request. Matches this endpoint's own need (a table this task's
    brief explicitly calls "growing unboundedly") rather than the bare
    `list[...]` convention `api/routers/projects.py::list_projects` uses,
    since that endpoint has no documented client need for a total count and
    this one — an audit trail a human will page through — does.
    """

    items: list[AuditLogEntryRead]
    total_count: int
    limit: int
    offset: int
