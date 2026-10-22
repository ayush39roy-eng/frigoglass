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

import type { CurrencyCode, HubName, LabRegion, ProjectCategory, WorkflowId } from '@/types/enums';

/**
 * P12 (ADR 0020): append the global hub filter to a key. `undefined` returns
 * the bare prefix, so `invalidateQueries({ queryKey: k() })` still matches every
 * hub's entry; `null` ("All hubs") and a hub uuid are distinct cache entries,
 * so switching hubs refetches instead of serving another hub's figures.
 */
function withHub<const K extends readonly string[]>(
  base: K,
  hubId: string | null | undefined,
  region?: LabRegion | null,
): K | readonly [...K, { hubId: string | null; region: LabRegion | null }] {
  // P13 (ADR 0025): the country filter is keyed beside the hub, so switching
  // country refetches instead of serving another country's figures.
  return hubId === undefined ? base : ([...base, { hubId, region: region ?? null }] as const);
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
    region?: LabRegion | undefined;
    currency?: CurrencyCode | undefined;
    category?: ProjectCategory | undefined;
    // P13-T14 (API_CONTRACT_P13 §7): Type / Status chips and the Project search.
    type?: string | undefined;
    status?: string | undefined;
    q?: string | undefined;
  }) => ['priority-matrix', params ?? null] as const,
  priorityDimensions: () => ['priority-matrix', 'dimensions'] as const,
  // P26 (ADR 0037): the editable rubric and its versions (Matrix only).
  scoringRubric: () => ['scoring-rubric'] as const,
  scoringRubricVersions: () => ['scoring-rubric', 'versions'] as const,
  prioritySummary: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['priority-matrix', 'summary'], hubId, region),
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
  // P13-T15 (API_CONTRACT_P13 §7): the Downloads page's own export jobs.
  exportJobs: (limit: number) => ['export-jobs', limit] as const,
  // P13-T15: the Versions & History page's name lookup for scenario changes.
  historyProjectNames: () => ['history', 'project-names'] as const,
  dashboard: (versionId?: string) => ['dashboard', versionId ?? 'active'] as const,
  // P12 (ADR 0020): `hubId` is the global header hub filter. `undefined` gives
  // the prefix (for invalidation); `null` is "All hubs"; a uuid is one hub.
  dashboardPipelineTotals: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'pipeline-totals'], hubId, region),
  dashboardStatusOverview: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'status-overview'], hubId, region),
  dashboardHubTypePipeline: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'hub-type-pipeline'], hubId, region),
  dashboardCompletingWithinYear: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'completing-within-year'], hubId, region),
  // P13 (API_CONTRACT_P13 §2/§3): per-country summary and the register's facets.
  dashboardRegionSummary: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'region-summary'], hubId, region),
  dashboardProjectFacets: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'projects-facets'], hubId, region),
  // P13-T10 (API_CONTRACT_P13 §5): served analytics + completing Hub × Type.
  dashboardAnalytics: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['dashboard', 'analytics'], hubId, region),
  dashboardProjects: (filters?: DashboardProjectFilters) =>
    ['dashboard', 'projects', filters ?? null] as const,
  // Every changeable Gantt filter input goes in the key (P4-T04 review blocker:
  // a user-facing filter omitted from the key serves stale cache). `hubId` is the
  // API's `hub_id` uuid param.
  // P13-T13 (API_CONTRACT_P13 §7): the toolbar filters join the key as plain strings.
  gantt: (params?: {
    versionId?: string | undefined;
    hubId?: string | undefined;
    region?: LabRegion | undefined;
    q?: string | undefined;
    category?: string | undefined;
    type?: string | undefined;
    status?: string | undefined;
    leaderEngineerId?: string | undefined;
    currentStep?: string | undefined;
    priority?: string | undefined;
    sort?: string | undefined;
  }) => ['gantt', params ?? null] as const,

  // --- capacity ---
  capacity: (params?: { hub?: HubName; versionId?: string }) => ['capacity', params ?? null] as const,
  // P12 (ADR 0020): same `withHub` convention as the dashboard keys above.
  capacityHubLoad: (hubId?: string | null, region?: LabRegion | null) => withHub(['capacity', 'hub-load'], hubId, region),
  capacityClassBreakdown: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['capacity', 'class-breakdown'], hubId, region),
  capacityUtilizationMatrix: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['capacity', 'utilization-matrix'], hubId, region),
  capacityEngineerUtilization: (hubId?: string | null, region?: LabRegion | null) =>
    withHub(['capacity', 'engineer-utilization'], hubId, region),
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
  // P13-T16 (API_CONTRACT_P13 §5): served per-category timelines / B-equivalent.
  workflowCategoryTimelines: (workflow?: WorkflowId) =>
    workflow === undefined
      ? (['workflow-settings', 'category-timelines'] as const)
      : (['workflow-settings', 'category-timelines', workflow] as const),
  workflowBEquivalent: (workflow?: WorkflowId) =>
    workflow === undefined
      ? (['workflow-settings', 'b-equivalent'] as const)
      : (['workflow-settings', 'b-equivalent', workflow] as const),

  // --- project workspace (P9 contract §7) ---
  projectWorkspace: (id: string) => ['projects', 'workspace', id] as const,
  projectActivity: (id: string, before?: string) => ['projects', 'workspace', id, 'activity', before ?? null] as const,
  mentionSearch: (q: string) => ['users', 'mention-search', q] as const,

  // --- P12 (frontend B): Priority board, weekly check-in; P14: VIP board ---
  // `hubId` is the global hub filter (ADR 0020), sent as `hub_id`.
  // P13-T12: the board's toolbar filters are appended only when set, so the P12
  // key shape (and every test asserting it) is unchanged without them.
  priorityBoard: (hubId: string | null, region: LabRegion | null = null, filters?: PriorityBoardFilters) =>
    filters === undefined
      ? (['priority-board', hubId, region] as const)
      : (['priority-board', hubId, region, filters] as const),
  // P14 (ADR 0027): the curated VIP board on the Dashboard. Both filter params
  // (`hub_id`, `region`) are in the key; `vipBoard()` is the bare prefix.
  vipBoard: (params?: { hub_id?: string; region?: LabRegion }) =>
    params === undefined
      ? (['vip-board'] as const)
      : (['vip-board', { hubId: params.hub_id ?? null, region: params.region ?? null }] as const),
  // P14: the VIP item editor's project-link search (`GET /dashboard/projects?q=`).
  vipLinkSearch: (q: string, hubId: string | null, region: LabRegion | null) =>
    ['dashboard', 'projects', 'vip-link-search', { q, hubId, region }] as const,
  checkInsDue: (hubId: string | null, region: LabRegion | null = null) => ['check-ins', 'due', hubId, region] as const,
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
  /** P13-T17: server-side search (name / external code, ≤ 100 chars). */
  q?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  type?: string | undefined;
}

/** Filters for the Dashboard's "analytics breakdown" list (GET /dashboard/projects). */
/** P13-T12 (API_CONTRACT_P13 §6): `GET /priority-board` toolbar filters, sent
 *  as-is (snake_case query params, server-side filtering). */
export interface PriorityBoardFilters {
  q?: string | undefined;
  category?: string | undefined;
  type?: string | undefined;
  status_?: string | undefined;
  leader_engineer_id?: string | undefined;
}

export interface DashboardProjectFilters {
  hub_id?: string | undefined;
  category?: string | undefined;
  status_?: string | undefined;
  priority?: string | undefined;
  // P13 (API_CONTRACT_P13 §3) — all server-side.
  region?: LabRegion | undefined;
  q?: string | undefined;
  type?: string | undefined;
  leader_engineer_id?: string | undefined;
  current_step?: string | undefined;
  sort?: 'name' | 'priority' | undefined;
}
