/**
 * Minimal read-only engineer lookup for the Project Registration leader picker
 * (`GET /engineers`, `backend/api/routers/engineers.py`).
 *
 * This is deliberately NOT the Engineer CRUD surface — that is Capacity
 * Planning's job (P4-T07, still TODO). Only `id`/`name`/`hub_id` are modelled
 * here, the minimum needed to populate a "leader" dropdown and to label an
 * already-assigned leader by name on the project list.
 *
 * GDPR note (`docs/OPEN_QUESTIONS.md` #8): OQ#8 and its P3-T09 remediation
 * withhold named-engineer *utilization* (workload/busy-weeks) from
 * `/capacity/utilization-matrix` and `/gantt` pending DPO sign-off. Assigning a
 * named "leader" to a project is a distinct, pre-existing business need (the
 * `Project.leader_engineer_id` FK, present since P1-T01) that reveals identity
 * but not workload — the same distinction the backend itself draws by leaving
 * `GET /engineers` (this endpoint, RBAC-gated on `CAPACITY_PLANNING` `READ`,
 * which every role with Project Registration `WRITE` also holds) untouched by
 * the P3-T09 remediation. Flagged for orchestrator/qa-inspector to confirm
 * this reading is correct before this surface's gate closes.
 */

import { apiGet, type ApiRequestOptions } from '@/lib/api/client';
import type { Id } from '@/types/common';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface EngineerOption {
  id: Id;
  name: string;
  hub_id: Id;
}

export function fetchEngineerOptions(
  hubId: string | undefined,
  ctx: FetchCtx = {},
): Promise<EngineerOption[]> {
  return apiGet<EngineerOption[]>('/engineers', {
    ...ctx,
    query: { hub_id: hubId },
  });
}
