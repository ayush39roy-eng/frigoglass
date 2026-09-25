/**
 * Reference / lookup data shared across surfaces: the six hubs, the 14 workflow
 * step templates. Maps to `backend/api/routers/reference.py` (`GET /hubs`,
 * `GET /workflow-step-templates`) — public within the app, no RBAC.
 *
 * PLACEHOLDER types until the OpenAPI client is generated (src/lib/api/README.md).
 */

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import type { CurrencyCode, HubName, LabRegion, WorkflowStepKind } from '@/types/enums';
import type { Id } from '@/types/common';

import { apiGet, ApiError } from './client';

export interface Hub {
  id: Id;
  name: HubName;
  lab_region: LabRegion;
  is_oem: boolean;
}

/**
 * One row of `GET /currency-rates` (→ `backend/schemas/currency.py::CurrencyRateRead`).
 *
 * `rate_to_eur` is "multiply a EUR amount by this to get `currency_code`", per
 * `docs/DOMAIN_RULES.md` "Currency" (EUR 1.0 / USD 1.08 / INR 97,
 * runtime-configurable). Shown next to the currency toggle so a converted
 * financial figure is auditable — the frontend never multiplies by it
 * (Invariant I9 analogue for money: the API returns already-converted amounts).
 */
export interface CurrencyRate {
  id: Id;
  currency_code: CurrencyCode;
  rate_to_eur: number;
  updated_by_user_id: Id | null;
  updated_at: string;
}

export interface WorkflowStepTemplate {
  id: string;
  name: string;
  kind: WorkflowStepKind;
  base_weeks: number;
}

export function fetchHubs(signal?: AbortSignal): Promise<Hub[]> {
  return apiGet<Hub[]>('/hubs', { signal });
}

function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useHubs() {
  return useQuery({
    queryKey: queryKeys.hubs(),
    queryFn: ({ signal }) => fetchHubs(signal),
    retry: retryUnlessAuth,
    staleTime: 60 * 60_000,
  });
}

export function fetchCurrencyRates(signal?: AbortSignal): Promise<CurrencyRate[]> {
  return apiGet<CurrencyRate[]>('/currency-rates', { signal });
}

export function fetchWorkflowStepTemplates(
  signal?: AbortSignal,
): Promise<WorkflowStepTemplate[]> {
  return apiGet<WorkflowStepTemplate[]>('/workflow-step-templates', { signal });
}

/**
 * The 14 PDD workflow step templates, in sequence order. Used by Capacity
 * Planning's chamber form to build the `allowed_stages` picker restricted to
 * lab-kind steps only (`kind === 'lab'`) — the same lab-kind-only rule
 * `backend/api/routers/chambers.py::_validate_allowed_stages` enforces
 * server-side (this is a responsiveness hint, not the authority).
 */
export function useWorkflowStepTemplates() {
  return useQuery({
    queryKey: queryKeys.workflowTemplate(),
    queryFn: ({ signal }) => fetchWorkflowStepTemplates(signal),
    retry: retryUnlessAuth,
    staleTime: 60 * 60_000,
  });
}

/**
 * The active EUR→USD/INR conversion rates. Read-only config, shared across
 * surfaces (Matrix currency toggle now; Gantt / Registration later). Displayed
 * verbatim next to the toggle; never used in a client-side calculation.
 */
export function useCurrencyRates() {
  return useQuery({
    queryKey: queryKeys.currencyRates(),
    queryFn: ({ signal }) => fetchCurrencyRates(signal),
    retry: retryUnlessAuth,
    staleTime: 60 * 60_000,
  });
}
