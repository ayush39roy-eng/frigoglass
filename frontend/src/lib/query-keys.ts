/**
 * Single source of truth for TanStack Query keys (frontend-builder SKILL).
 *
 * Every hook derives its key from this factory — no ad-hoc arrays scattered across
 * surface hooks. Mutations that change a project, priority, or capacity input must
 * invalidate the relevant `scheduleRun` / `capacity` keys: a stale Gantt after
 * "Apply Priorities" is a correctness bug because Invariant I9 requires the
 * Dashboard's within-year count to match the current schedule run.
 *
 * The concrete endpoints these map to arrive in P3 (P3-T01). Keys are named for the
 * six surfaces' data needs (PROJECT_AND_STACK.md §2); they will not need to change
 * when the generated client lands, only the fetchers behind them.
 */

import type { CurrencyCode, HubName, ProjectCategory } from '@/types/enums';

export const queryKeys = {
  // --- reference / config ---
  hubs: () => ['hubs'] as const,
  currencyRates: () => ['currency-rates'] as const,
  workflowTemplate: () => ['workflow-template'] as const,

  // --- projects (Project Registration, P4-T06) ---
  projects: (filters?: ProjectListFilters) => ['projects', filters ?? null] as const,
  project: (id: string) => ['projects', 'detail', id] as const,
  // "Hard gate" here is the Registration required-fields gate
  // (GET /projects/{id}/hard-gate-status), NOT the Matrix's P1-override hard
  // gate (`priorityRow`/`priorityMatrix` above) — see api/types.ts's note.
  projectHardGateStatus: (id: string) => ['projects', 'detail', id, 'hard-gate-status'] as const,

  // --- prioritization matrix ---
  priorityMatrix: (params?: {
    hubId?: string | undefined;
    currency?: CurrencyCode | undefined;
    category?: ProjectCategory | undefined;
  }) => ['priority-matrix', params ?? null] as const,
  prioritySummary: () => ['priority-matrix', 'summary'] as const,
  priorityRow: (id: string, currency?: CurrencyCode) =>
    ['priority-matrix', 'detail', id, currency ?? null] as const,
  priorityApplicationRuns: () => ['priority-application-runs'] as const,
  // Versions & History (P5-T03) — `GET /scenarios/versions`/`GET
  // /scenarios/versions/{version}`. Deliberately a SEPARATE key namespace
  // from `priorityApplicationRuns` above (a different, unused mechanism —
  // see docs/MEMORY.md's P5-T02 entry, flag #3) and from `priorityMatrix`
  // (browsing history never invalidates/depends on the live grid's key).
  scenarioVersions: () => ['scenario-versions'] as const,
  scenarioVersion: (version: number) => ['scenario-versions', version] as const,

  // --- scheduling / gantt / dashboard ---
  scheduleRuns: () => ['schedule-runs'] as const,
  scheduleRun: (versionId: string) => ['schedule-runs', versionId] as const,
  activeScheduleRun: () => ['schedule-runs', 'active'] as const,
  dashboard: (versionId?: string) => ['dashboard', versionId ?? 'active'] as const,
  dashboardPipelineTotals: () => ['dashboard', 'pipeline-totals'] as const,
  dashboardStatusOverview: () => ['dashboard', 'status-overview'] as const,
  dashboardHubTypePipeline: () => ['dashboard', 'hub-type-pipeline'] as const,
  dashboardCompletingWithinYear: () => ['dashboard', 'completing-within-year'] as const,
  dashboardProjects: (filters?: DashboardProjectFilters) =>
    ['dashboard', 'projects', filters ?? null] as const,
  // Every changeable Gantt filter input goes in the key (P4-T04 review blocker:
  // a user-facing filter omitted from the key serves stale cache). `hubId` is the
  // API's `hub_id` uuid param.
  gantt: (params?: { versionId?: string | undefined; hubId?: string | undefined }) =>
    ['gantt', params ?? null] as const,

  // --- capacity ---
  capacity: (params?: { hub?: HubName; versionId?: string }) => ['capacity', params ?? null] as const,
  capacityHubLoad: () => ['capacity', 'hub-load'] as const,
  capacityClassBreakdown: () => ['capacity', 'class-breakdown'] as const,
  capacityUtilizationMatrix: () => ['capacity', 'utilization-matrix'] as const,
  capacityPlanning: (hub?: HubName) => ['capacity-planning', hub ?? null] as const,
  // `hubId` (uuid, `GET /engineers?hub_id=`) — corrected from an earlier
  // `HubName` typing (P4-T01 placeholder, never exercised until P4-T06's
  // leader-picker lookup and P4-T07's Engineer CRUD).
  engineers: (hubId?: string) => ['engineers', hubId ?? null] as const,
  // `GET /chambers` (backend/api/routers/chambers.py) takes NO query params at
  // all — a caller's visibility is resolved entirely server-side via
  // `services.hub_scope.scoped_lab_regions`, not a client-supplied filter.
  // Corrected from an earlier unused `hub?: HubName` placeholder (P4-T01) that
  // implied a filter param that doesn't exist — never exercised until P4-T07's
  // Chamber CRUD.
  chambers: () => ['chambers'] as const,

  // --- cross-cutting ---
  // Audit Log surface (P7-T05, `GET /audit-log` — `backend/api/routers/
  // audit_log.py`, P3-T04's read side). Corrected from an earlier unused
  // `cursor?: string` placeholder (P4-T01) that didn't match the real
  // `limit`/`offset` pagination contract — never exercised until this task.
  // Every changeable filter/pagination input goes in the key (same rule the
  // Gantt's `hubId` comment above states) so a filter change never serves a
  // stale cached page.
  auditLog: (filters?: AuditLogQueryFilters) => ['audit-log', filters ?? null] as const,
  notifications: () => ['notifications'] as const,
} as const;

/** Filters for `GET /audit-log` (Audit Log surface, P7-T05). Field names match
 *  the backend's query params verbatim (`backend/api/routers/audit_log.py`) —
 *  there is no `hub_id`/`status_` renaming needed here, unlike
 *  `DashboardProjectFilters` below, since this endpoint's params are already
 *  snake_case matches of themselves. */
export interface AuditLogQueryFilters {
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

/** Filters for `GET /projects` (Project Registration, P4-T06). Field names match
 *  the query params `apiGet` sends, not the backend's Python param names
 *  (`hub_id`/`status_`/`type_`) — the P4-T06 fetcher does that renaming, same
 *  as `DashboardProjectFilters` below does for its own endpoint. Corrected from
 *  an earlier unused `hub?: HubName` placeholder (P4-T01) that didn't match
 *  the real `hub_id` uuid param — never exercised until this task. */
export interface ProjectListFilters {
  hubId?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  type?: string | undefined;
}

/** Filters for the Dashboard's "analytics breakdown" list (GET /dashboard/projects). */
export interface DashboardProjectFilters {
  hub_id?: string | undefined;
  category?: string | undefined;
  status_?: string | undefined;
  priority?: string | undefined;
}
