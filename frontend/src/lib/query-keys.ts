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

/**
 * P12 (ADR 0020): append the global hub filter to a key. `undefined` returns
 * the bare prefix, so `invalidateQueries({ queryKey: k() })` still matches every
 * hub's entry; `null` ("All hubs") and a hub uuid are distinct cache entries,
 * so switching hubs refetches instead of serving another hub's figures.
 */
function withHub<const K extends readonly string[]>(
  base: K,
  hubId: string | null | undefined,
): K | readonly [...K, { hubId: string | null }] {
  return hubId === undefined ? base : ([...base, { hubId }] as const);
}

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
  prioritySummary: (hubId?: string | null) => withHub(['priority-matrix', 'summary'], hubId),
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
  // P11 contract §3: `GET /schedule-runs/{run}/changes?against={baseline}`. Both
  // runs are immutable (I14), so the result never changes once fetched.
  scheduleRunChanges: (runId: string, againstRunId: string) =>
    ['schedule-runs', runId, 'changes', againstRunId] as const,
  dashboard: (versionId?: string) => ['dashboard', versionId ?? 'active'] as const,
  // P12 (ADR 0020): `hubId` is the global header hub filter. `undefined` gives
  // the prefix (for invalidation); `null` is "All hubs"; a uuid is one hub.
  dashboardPipelineTotals: (hubId?: string | null) => withHub(['dashboard', 'pipeline-totals'], hubId),
  dashboardStatusOverview: (hubId?: string | null) => withHub(['dashboard', 'status-overview'], hubId),
  dashboardHubTypePipeline: (hubId?: string | null) => withHub(['dashboard', 'hub-type-pipeline'], hubId),
  dashboardCompletingWithinYear: (hubId?: string | null) =>
    withHub(['dashboard', 'completing-within-year'], hubId),
  dashboardProjects: (filters?: DashboardProjectFilters) =>
    ['dashboard', 'projects', filters ?? null] as const,
  // Every changeable Gantt filter input goes in the key (P4-T04 review blocker:
  // a user-facing filter omitted from the key serves stale cache). `hubId` is the
  // API's `hub_id` uuid param.
  gantt: (params?: { versionId?: string | undefined; hubId?: string | undefined }) =>
    ['gantt', params ?? null] as const,

  // --- capacity ---
  capacity: (params?: { hub?: HubName; versionId?: string }) => ['capacity', params ?? null] as const,
  // P12 (ADR 0020): same `withHub` convention as the dashboard keys above.
  capacityHubLoad: (hubId?: string | null) => withHub(['capacity', 'hub-load'], hubId),
  capacityClassBreakdown: (hubId?: string | null) => withHub(['capacity', 'class-breakdown'], hubId),
  capacityUtilizationMatrix: (hubId?: string | null) => withHub(['capacity', 'utilization-matrix'], hubId),
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

  // --- session (P9 contract §1) ---
  // `/me` itself lives in the Zustand session store (read synchronously by
  // every guard); only the dev-user list is a query.
  devUsers: () => ['me', 'dev-users'] as const,

  // --- reference: categories valid for a hub (P9 contract §6) ---
  categoriesForHub: (hubId?: string) => ['reference', 'categories', hubId ?? null] as const,

  // --- user / role admin (P9 contract §2) ---
  users: (params?: { q?: string | undefined; limit?: number; offset?: number }) =>
    ['users', params ?? null] as const,
  roles: () => ['roles'] as const,

  // --- project access grants (ADR 0012, P10-T03) ---
  // One grant list per project — there is no cross-project list endpoint
  // (see `admin-users/api/project-access-api.ts`).
  projectAccessGrants: (projectId: string) => ['projects', 'access', projectId] as const,
  // The Project Access tab's project picker — a wide, unfiltered fetch
  // (server max `limit=500` covers the ~236-project baseline) kept as its
  // OWN key rather than reusing `projects(...)` above so it never collides
  // with Registration's filtered/paginated list cache.
  projectsForPicker: () => ['projects', 'picker'] as const,
  // A wider, unpaginated user fetch for the Project Access tab's user picker
  // and the grant table's user/granted-by name join — a DIFFERENT cache
  // entry from the paginated `users(...)` key the Users tab's table uses, so
  // neither view's page size forces the other's.
  usersForPicker: () => ['users', 'picker'] as const,

  // --- workflow settings (P9 contract §3) ---
  workflowSettings: () => ['workflow-settings'] as const,

  // --- project workspace (P9 contract §7) ---
  projectWorkspace: (id: string) => ['projects', 'workspace', id] as const,
  projectActivity: (id: string, before?: string) => ['projects', 'workspace', id, 'activity', before ?? null] as const,
  mentionSearch: (q: string) => ['users', 'mention-search', q] as const,

  // --- P12 (frontend B): Priority board, VIP projects, weekly check-in ---
  // `hubId` is the global hub filter (ADR 0020), sent as `hub_id`.
  priorityBoard: (hubId: string | null) => ['priority-board', hubId] as const,
  vipProjects: (params: { year: 'plan' | 'next'; hubId: string | null; limit: number }) =>
    ['vip-projects', params] as const,
  checkInsDue: (hubId: string | null) => ['check-ins', 'due', hubId] as const,
  checkInHistory: (projectId: string, stepId: string) => ['check-ins', 'history', projectId, stepId] as const,

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
