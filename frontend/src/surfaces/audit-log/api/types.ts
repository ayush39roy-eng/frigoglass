/**
 * Types for the Audit Log surface (P7-T05), read-only.
 *
 * Maps 1:1 to `backend/api/routers/audit_log.py` (`GET /audit-log`, P3-T04's
 * read side) and `backend/schemas/audit.py::AuditLogEntryRead` /
 * `AuditLogEntryList` — field names copied verbatim, no renaming, no derived
 * fields. `before_state`/`after_state` are written already redacted for the
 * four financial/PII field names (`backend/models/types.py::
 * FINANCIAL_FIELD_NAMES`) before ever being persisted — see
 * `components/redact.ts` for the client-side defense-in-depth pass this
 * surface additionally applies before rendering either JSONB blob.
 *
 * PLACEHOLDER-and-hand-authored like every other surface's `api/types.ts`
 * until the OpenAPI client is generated (`src/lib/api/README.md`).
 */

import type { Id } from '@/types/common';

export interface AuditLogEntry {
  id: Id;
  occurred_at: string;
  /** `null` for system/background-originated rows (e.g. an unattended
   *  ScheduleRun) — never resolved to a display name here: there is no
   *  `GET /users` reference endpoint in this backend to join against, so the
   *  raw id is shown verbatim rather than inventing a client-side lookup. */
  actor_user_id: Id | null;
  action: string;
  entity_type: string;
  entity_id: string;
  hub_id: Id | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
  request_id: string | null;
  ip_address: string | null;
  notes: string | null;
}

export interface AuditLogEntryList {
  items: AuditLogEntry[];
  total_count: number;
  limit: number;
  offset: number;
}

/** Filter/pagination params accepted by `fetchAuditLog` — field names match
 *  the backend's query params verbatim (all optional, ANDed together
 *  server-side; `hub_id` is a convenience filter, NOT row-level access
 *  control — see `backend/api/routers/audit_log.py`'s module docstring:
 *  Auditor/Admin are both "R (all)", not hub-scoped, for this surface). */
export interface AuditLogFilterParams {
  entity_type?: string | undefined;
  entity_id?: string | undefined;
  actor_user_id?: string | undefined;
  action?: string | undefined;
  hub_id?: string | undefined;
  occurred_from?: string | undefined;
  occurred_to?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}
