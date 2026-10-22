/**
 * Reference / lookup data shared across surfaces: the six hubs, the 14 workflow
 * step templates. Maps to `backend/api/routers/reference.py` (`GET /hubs`,
 * `GET /workflow-step-templates`) — public within the app, no RBAC.
 *
 * PLACEHOLDER types until the OpenAPI client is generated (src/lib/api/README.md).
 */

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import {
  NON_OEM_CATEGORIES,
  OEM_CATEGORIES,
  type CurrencyCode,
  type HubName,
  type LabRegion,
  type ProjectCategory,
  type ProjectType,
  type WorkflowId,
  type WorkflowStepKind,
} from '@/types/enums';
import type { Id } from '@/types/common';

import { apiGet, ApiError } from './client';

export interface Hub {
  id: Id;
  name: HubName;
  lab_region: LabRegion;
  is_oem: boolean;
  /** P29 (ADR 0042, API_CONTRACT_P29 §1.1): R&D-Greece's id on OEM-HCK and
   *  OEM-Seitek (their capacity hub); null on a hub that is its own capacity hub. */
  capacity_hub_id: Id | null;
  /** P29: "R&D-Greece" on OEM-HCK and OEM-Seitek; null elsewhere. Drives the
   *  "(Greece)" picker label (`lib/hub-labels.ts`); never hard-coded. */
  capacity_hub_name: HubName | null;
}

/** P29-T04 (API_CONTRACT_P29 §1.2): `GET /reference/project-types` row. The
 *  labels are static display text; the app's ONE label source is
 *  `PROJECT_TYPE_LABELS` in `types/enums.ts`, which mirrors the served list
 *  (backend `domain_constants.PROJECT_TYPE_LABELS`), so no surface waits on a
 *  fetch to name a type. */
export interface ProjectTypeRead {
  code: ProjectType;
  label: string;
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
  /** P21 (API_CONTRACT_P21 §1): the served enum adds EGP / ZAR / IDR. */
  currency_code: CurrencyCode | 'EGP' | 'ZAR' | 'IDR';
  /** P21: display name, e.g. "Egyptian pound". */
  name: string;
  /** P21: null until a rate is set (not configured). */
  rate_to_eur: number | null;
  /** P21: `rate_to_eur !== null`. */
  configured: boolean;
  updated_by_user_id: Id | null;
  updated_at: string;
}

/** `GET /workflow-step-templates` (→ `WorkflowStepTemplateRead`, ADR 0007 /
 *  0009): both workflows' steps with client codes. Durations are not on the
 *  template (they come from the lead-time table); the prototype-era
 *  `base_weeks` is gone (P30-T03). */
export interface WorkflowStepTemplate {
  id: string;
  workflow_id: WorkflowId;
  code: string;
  name: string;
  kind: WorkflowStepKind;
  sequence_order: number;
  predecessor_ids: string[];
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

/**
 * PLACEHOLDER (P9 contract §6) — `GET /reference/categories?hub_id=` returns the
 * project categories valid for that hub's workflow (`A+/A/B/C` for PDD hubs,
 * `A-OEM/B-OEM/C-OEM` for OEM hubs, ADR 0007). The server is the authority
 * (it 422s `CATEGORY_WORKFLOW_MISMATCH` on a wrong pairing); the list here only
 * drives the picker.
 */
export function fetchCategoriesForHub(
  hubId: string,
  signal?: AbortSignal,
): Promise<ProjectCategory[]> {
  return apiGet<ProjectCategory[]>('/reference/categories', { signal, query: { hub_id: hubId } });
}

/**
 * The category options the Registration form offers for a hub. Pure: the
 * server list when we have it, else the ADR 0007 split by `Hub.is_oem` as
 * the offline / in-flight fallback. Exported for tests.
 */
export function categoryOptionsForHub(
  hub: Pick<Hub, 'is_oem'> | undefined,
  serverList: readonly ProjectCategory[] | undefined,
): readonly ProjectCategory[] {
  if (serverList && serverList.length > 0) return serverList;
  if (!hub) return [...NON_OEM_CATEGORIES, ...OEM_CATEGORIES];
  return hub.is_oem ? OEM_CATEGORIES : NON_OEM_CATEGORIES;
}

/** Categories valid for `hub` — server list with the `is_oem` fallback (above). */
export function useCategoriesForHub(hub: Hub | undefined) {
  const query = useQuery({
    queryKey: queryKeys.categoriesForHub(hub?.id),
    queryFn: ({ signal }) => fetchCategoriesForHub(hub?.id ?? '', signal),
    enabled: hub !== undefined,
    retry: retryUnlessAuth,
    staleTime: 60 * 60_000,
  });
  return { ...query, options: categoryOptionsForHub(hub, query.data) };
}
