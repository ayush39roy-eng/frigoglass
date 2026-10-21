/**
 * Fetchers for the Capacity Planning surface (P4-T07): Engineer CRUD, Chamber
 * CRUD, and the "Apply Logic" recalculation trigger.
 *
 * Thin wrappers over `apiGet` / `apiSend` — no transformation, no derived
 * numbers. Each maps 1:1 to an endpoint in `backend/api/routers/engineers.py`,
 * `backend/api/routers/chambers.py`, or `backend/api/routers/schedule_runs.py`.
 *
 * Scope note: "Auto-assign" (CP-SAT-backed bulk resource assignment) has no
 * fetcher here on purpose — see `components/auto-assign-placeholder.tsx`'s
 * module docstring for why it is not wired in this task.
 */

import { apiGet, apiSend, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type {
  ChamberCreateRequest,
  ChamberRead,
  ChamberUpdateRequest,
  EngineerCreateRequest,
  EngineerRead,
  EngineerUpdateRequest,
  CapacityBasis,
  CapacitySummary,
  GreedyRecalcResponse,
  ResourceLoadFilters,
  ResourceLoadOptionsResponse,
  ResourceLoadResponse,
  ScheduleRunSummary,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

// --- Engineers ---

export function fetchEngineers(
  hubId: string | undefined,
  ctx: FetchCtx = {},
): Promise<EngineerRead[]> {
  return apiGet<EngineerRead[]>('/engineers', { ...ctx, query: { hub_id: hubId } });
}

export function createEngineer(body: EngineerCreateRequest): Promise<EngineerRead> {
  return apiSend<EngineerRead>('POST', '/engineers', body);
}

export function updateEngineer(
  engineerId: string,
  body: EngineerUpdateRequest,
): Promise<EngineerRead> {
  return apiSend<EngineerRead>('PATCH', `/engineers/${engineerId}`, body);
}

/** `DELETE /engineers/{id}` — 409 if still referenced by a project/workflow
 *  step/schedule-run snapshot (`api/routers/engineers.py::delete_engineer`'s
 *  own by-design "never silently orphan schedule data" rule). Resolves to
 *  `void`, matching the 204 the backend returns. */
export function deleteEngineer(engineerId: string): Promise<void> {
  return apiSend<void>('DELETE', `/engineers/${engineerId}`);
}

// --- Chambers ---

/** `GET /chambers` takes no query params — hub visibility is resolved
 *  entirely server-side via lab-region scoping (see `api/types.ts`'s note). */
export function fetchChambers(ctx: FetchCtx = {}): Promise<ChamberRead[]> {
  return apiGet<ChamberRead[]>('/chambers', ctx);
}

export function createChamber(body: ChamberCreateRequest): Promise<ChamberRead> {
  return apiSend<ChamberRead>('POST', '/chambers', body);
}

export function updateChamber(
  chamberId: string,
  body: ChamberUpdateRequest,
): Promise<ChamberRead> {
  return apiSend<ChamberRead>('PATCH', `/chambers/${chamberId}`, body);
}

export function deleteChamber(chamberId: string): Promise<void> {
  return apiSend<void>('DELETE', `/chambers/${chamberId}`);
}

// --- Apply Logic (schedule-runs) ---

/** The single active schedule run, for the Apply Logic panel's provenance
 *  caption. Returns `null` (not a throw) on 404 — "no schedule computed yet"
 *  is a normal Capacity Planning state (same convention as every other
 *  surface's own `fetchActiveScheduleRun` copy — RPD Capacity/Dashboard/Gantt
 *  each keep their own, per the existing pattern in this codebase). */
export async function fetchActiveScheduleRun(
  ctx: FetchCtx = {},
): Promise<ScheduleRunSummary | null> {
  try {
    return await apiGet<ScheduleRunSummary>('/schedule-runs/active', ctx);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

/** `POST /schedule-runs/greedy-recalc` — see `components/apply-logic-panel.tsx`
 *  for why this is what "Apply Logic" calls. Admin-only server-side
 *  (`api/routers/schedule_runs.py::_admin_only`) — a Hub Planner with
 *  Capacity Planning WRITE access can still get a 403 here; the panel
 *  degrades gracefully on that (see its module docstring). */
export function triggerApplyLogic(): Promise<GreedyRecalcResponse> {
  return apiSend<GreedyRecalcResponse>('POST', '/schedule-runs/greedy-recalc');
}

// --- P19-T03: capacity summary and resource load ---

/** `GET /planning/capacity-summary`: per-hub design and per-lab-region lab
 *  capacity, both bases, weeks and days, with each group's share. Every figure
 *  on the Overview cards is one of these fields (I9/I19). */
export function fetchCapacitySummary(ctx: FetchCtx = {}): Promise<CapacitySummary> {
  return apiGet<CapacitySummary>('/planning/capacity-summary', ctx);
}

/**
 * The resource-load filters as query params. `hub_id` is single-valued; each
 * multi-select sends its values as REPEATED params (`project_type=NM&
 * project_type=CO`, the server's `list[...] = Query()`); "All" sends nothing.
 * Values are sorted so equal selections give equal URLs.
 */
export function resourceLoadSearch(basis: CapacityBasis, filters: ResourceLoadFilters): string {
  const params = new URLSearchParams();
  params.append('basis', basis);
  if (filters.hubId) params.append('hub_id', filters.hubId);
  const pairs: [string, string[]][] = [
    ['project_type', filters.types],
    ['project_status', filters.statuses],
    ['requesting_department', filters.departments],
    ['category', filters.categories],
    ['engineer_id', filters.engineerIds],
  ];
  for (const [key, values] of pairs) {
    for (const v of [...values].sort()) params.append(key, v);
  }
  return params.toString();
}

/** `GET /planning/resource-load`. Per-engineer load is personal data (ADR 0028);
 *  the server audits every read, so the page only calls this when the analytics
 *  section is on screen and debounces filter changes. */
export function fetchResourceLoad(
  basis: CapacityBasis,
  filters: ResourceLoadFilters,
  ctx: FetchCtx = {},
): Promise<ResourceLoadResponse> {
  return apiGet<ResourceLoadResponse>(`/planning/resource-load?${resourceLoadSearch(basis, filters)}`, ctx);
}

/** `GET /planning/resource-load/options`: the values each filter offers, from
 *  the caller's visible data. */
export function fetchResourceLoadOptions(ctx: FetchCtx = {}): Promise<ResourceLoadOptionsResponse> {
  return apiGet<ResourceLoadOptionsResponse>('/planning/resource-load/options', ctx);
}
