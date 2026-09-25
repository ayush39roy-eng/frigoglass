/**
 * Fetcher for the Audit Log surface (P7-T05).
 *
 * Thin wrapper over `apiGet` — no transformation, no derived numbers, no
 * filtering/sorting/pagination performed client-side. Maps 1:1 to
 * `GET /audit-log` (`backend/api/routers/audit_log.py`).
 */

import { apiGet, type ApiRequestOptions } from '@/lib/api/client';

import type { AuditLogEntryList, AuditLogFilterParams } from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export function fetchAuditLog(
  params: AuditLogFilterParams,
  ctx: FetchCtx = {},
): Promise<AuditLogEntryList> {
  return apiGet<AuditLogEntryList>('/audit-log', {
    ...ctx,
    query: {
      entity_type: params.entity_type,
      entity_id: params.entity_id,
      actor_user_id: params.actor_user_id,
      action: params.action,
      hub_id: params.hub_id,
      occurred_from: params.occurred_from,
      occurred_to: params.occurred_to,
      limit: params.limit,
      offset: params.offset,
    },
  });
}
