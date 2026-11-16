/**
 * Reference / lookup data shared across surfaces: the six hubs, the 14 workflow
 * step templates. Maps to `backend/api/routers/reference.py` (`GET /hubs`,
 * `GET /workflow-step-templates`) — public within the app, no RBAC.
 *
 * PLACEHOLDER types until the OpenAPI client is generated (src/lib/api/README.md).
 */

import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { queryKeys } from '@/lib/query-keys';
import type { CategoryCatalog } from '@/lib/category-catalog';
import {
  type CurrencyCode,
  type HubName,
  type LabRegion,
  type ProjectPriority,
  type ProjectType,
  type WorkflowId,
  type WorkflowStepKind,
} from '@/types/enums';
import type { Id } from '@/types/common';

import { fetchCategories, useCategories, type Category } from './categories';
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

/** P42 (ADR 0056 R42-1, API_CONTRACT_P42 §1): one row of
 *  `GET /reference/priorities`, served in band order P1, P2, P3, P4, Q. The
 *  app's label source is `PRIORITY_LABELS` in `types/enums.ts`, which mirrors
 *  `label` (pinned by the backend contract test), so no pill waits on a fetch. */
export interface PriorityBandRead {
  code: ProjectPriority;
  label: string;
  /** The chip text: the band code. */
  short_label: string;
  /** A non-frozen project of this band in a schedulable status is never scheduled (P4, Q). */
  not_scheduled: boolean;
  /** An In Queue project of this band does not count toward the year (P3, P4, Q). */
  queued_when_in_queue: boolean;
}

/** P42: `GET /reference/priorities`. */
export function fetchPriorityBands(signal?: AbortSignal): Promise<PriorityBandRead[]> {
  return apiGet<PriorityBandRead[]>('/reference/priorities', { signal });
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
 * P33 B1 (ADR 0047): `GET /reference/categories?hub_id=` returns the category
 * OBJECTS valid for that hub's workflow, in rank order. The server is the
 * authority (it 422s `CATEGORY_WORKFLOW_MISMATCH` on a wrong pairing); the list
 * here only drives the Registration picker.
 */
export function fetchCategoriesForHub(hubId: string, signal?: AbortSignal): Promise<Category[]> {
  return fetchCategories(hubId, signal);
}

/**
 * The category codes the Registration form offers for a hub, in rank order.
 * Pure: the hub's served list when we have it; else the global served list
 * narrowed to the hub's workflow (`Hub.is_oem` → OEM, ADR 0007) while the hub
 * request is in flight or failed; every category when no hub is chosen.
 * Exported for tests.
 */
export function categoryOptionsForHub(
  hub: Pick<Hub, 'is_oem'> | undefined,
  serverList: readonly Category[] | undefined,
  catalog: CategoryCatalog,
): readonly string[] {
  if (serverList && serverList.length > 0) {
    return [...serverList].sort((a, b) => a.rank - b.rank).map((c) => c.code);
  }
  if (!hub) return catalog.codes;
  return catalog.codesForWorkflow(hub.is_oem ? 'OEM' : 'PDD');
}

/** Categories valid for `hub` — server list with the workflow fallback (above). */
export function useCategoriesForHub(hub: Hub | undefined) {
  const { catalog } = useCategories();
  const query = useQuery({
    queryKey: queryKeys.categoriesForHub(hub?.id),
    queryFn: ({ signal }) => fetchCategoriesForHub(hub?.id ?? '', signal),
    enabled: hub !== undefined,
    retry: retryUnlessAuth,
    staleTime: 60 * 60_000,
  });
  const options = useMemo(() => categoryOptionsForHub(hub, query.data, catalog), [hub, query.data, catalog]);
  return { ...query, options };
}
