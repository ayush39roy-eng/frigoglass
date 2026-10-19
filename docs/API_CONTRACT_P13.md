# API contract — P13 (country filter + all-projects register)

Shared contract between backend-builder and frontend-builder for ADR 0025. No migration. No
scheduler change.

## 1. `region` on every hub-filtered endpoint (backend)

Every endpoint that gained `hub_id` in `API_CONTRACT_P12.md` §4 gains
`region: LabRegion | None = None`. `LabRegion` is `Greece`, `India` or `Romania`.

- Extend `services.hub_scope.narrowed_hub_filter(principal, column, hub_id, region=None)`. Region
  predicate: `column.in_(select(Hub.id).where(Hub.lab_region == region))`.
- `region` is ANDed with the scope and with `hub_id`. It never widens either.
- A region with nothing in the caller's scope gives empty rows and zero totals, not a 403.
- Endpoints that filter by `hub_id` without the helper (`/dashboard/projects`, gantt, priorities,
  priority-board, vip, check-ins, capacity) apply the same predicate.
- **Capacity:** hub rows are reduced to the region's hubs. `areas[]` is reduced to the containing
  area (Greece and Romania → Europe, India → India). Lab rows are reduced to that lab region.
- A bad `region` value → 422 (FastAPI enum validation).

## 2. `GET /dashboard/region-summary?hub_id=&region=` (backend, new)

Same read permission as the other `/dashboard/*` endpoints.

```jsonc
{
  "total_count": 236,
  "regions": [
    {
      "region": "India",
      "total_count": 182,
      "share_pct": 77.12,                 // of total_count, 2 dp, server-side
      "spillover_count": 59,              // carry_over = true   (same basis as PipelineTotals)
      "newly_registered_count": 123,      // carry_over = false
      "status_counts": {                  // every ProjectStatus wire value, 0 if none
        "In Development": 33,
        "Under Industrialization": 50,
        "In Queue": 97,
        "Commercialized": 0,
        "Blocked": 2
        // …
      },
      "status_share_pct": { "In Development": 49.25 }  // share of that status's portfolio count held by this region
    }
  ]
}
```

- `regions` always lists Greece, India and Romania in that order, including zero rows.
- The scope and filter are the same as `/dashboard/pipeline-totals`. Its basis, including or
  excluding `Commercialized`, must match `PipelineTotals`, so the chips reconcile with the card
  they sit under.
- `status_counts` covers every status, so each status card can show its chips.

## 3. `GET /dashboard/projects` — enriched register (backend)

New optional query params, all ANDed and server-side:

- `region`;
- `q`, a case-insensitive substring of name or `external_code`, at most 100 characters;
- `type` (`ProjectType`);
- `leader_engineer_id` (uuid);
- `current_step` (step code, for example `PDD-E`).

Existing params are unchanged: `hub_id`, `category`, `status_`, `priority`.

New fields on `ProjectFilterRow`. All are additive, so existing consumers are unaffected.

```jsonc
{
  "external_code": "24-00221_1",        // null if absent
  "type": "CO",                         // null if unmapped
  "region": "India",                    // hub.lab_region
  "leader_name": "Rishi",               // null if no leader
  "leader_engineer_id": "uuid|null",
  "current_step_code": "PDD-E",         // first workflow step not Completed/Skipped; null if all done
  "current_step_name": "Design Detailing",
  "end_week": 43,                       // active schedule run finish week; null if no run or not scheduled
  "outcome": "WITHIN_YEAR",             // active run outcome; null if none
  "reg_year": 2026,
  "carry_over": false,
  "priority_rank": 1                    // rank by score within the filtered set, 1-based; null if unscored
}
```

- Ordering is unchanged (by name), unless `sort=priority` is passed, which orders by
  `priority_rank`.
- **No financial fields.** TCOGS, gross margin, selling price and customer name stay out of this
  projection.
- Add `GET /dashboard/projects/facets?hub_id=&region=`. It returns the leader list
  (`{id, name}[]`) and the step list (`{code, name}[]`) present in the caller's scoped, filtered
  set, so the filter dropdowns only offer values that exist.

## 4. Frontend

- **`src/stores/hub-filter.ts`:**
  - State becomes `{ hubId, region, setHubId, setRegion, clear }`.
  - `setRegion` clears `hubId`. `setHubId` clears `region`.
  - The persisted key stays `rpd-hub-filter`, migrated so old `{hubId}` payloads still load.
  - Add `useHubFilterParams(): { hub_id?: string; region?: LabRegion }`.
  - Every surface that read `hubId` now passes both params and puts both in its query key.
- **Header select:** "All hubs", then a "Countries" group (Greece, India, Romania), then a "Hubs"
  group. Show only countries that contain at least one hub in the caller's scope.
- **`HubFilterChip`:** reads "Country: India" or "Hub: PD-India", each with a clear button.
- **Dashboard header:**
  - Segmented buttons All Hubs / Greece / India / Romania, each with a small inline CSS flag (not
    emoji). They bind to the same store.
  - A header button "All projects" scrolls to the register section (`id="all-projects"`).
- **Country chips:** rendered under the pipeline-composition KPI cards and the status-overview
  cards, from `/dashboard/region-summary`. Each chip shows flag, count and (share %).
- **Register:** upgrade `components/project-breakdown.tsx` to "All registered projects".
  - Full width, placed directly after the status overview.
  - A per-country summary row (Comm. / Ind. / Dev. / Que counts from region-summary).
  - Filters: search (debounced), Hub, Category, Type, Status, Leader, Current step. Hub and
    country follow the global filter.
  - Columns: #, Hub, Cat, Type, Status, Project, Leader, End wk, Current step, Priority, Actions.
  - Actions: Open → workspace. Edit → registration edit route, only if
    `usePermission('registration').write`.
  - Virtualised (existing `VirtualDataTable`). The Cards view and the CSV download stay.
  - The row count comes from `total_count`.

---

# Wave 2 (P13-T10..T17) — added 2026-10-18

All additive. Every new read takes `hub_id` + `region` (§1 semantics). Figures stay server-side
(I9/I19). There are no financial fields outside the Matrix (whose existing rules are unchanged),
and no engineer-level figures (OQ #8).

## 5. Slice A: Dashboard analytics (T10), Workflow previews (T16), Registration and Planning (T17)

- **`CompletingWithinYearRow`** gains `type: ProjectType | null`.
- **`GET /dashboard/analytics`** (new):

  ```jsonc
  {
    "by_type":     [{ "key": "CO", "count": 89, "share_pct": 37.71 }],      // every ProjectType + "Unmapped" if any
    "by_category": [{ "key": "B",  "count": 162, "share_pct": 68.64 }],
    "by_hub":      [{ "key": "PD-India", "count": 180, "share_pct": 76.27 }],
    "by_reg_year": [{ "key": "2026", "count": 160, "share_pct": 67.8 }],    // "Unknown" bucket for null reg_year
    "completing_hub_type": [{ "hub": "PD-India", "type": "CO", "pipeline_count": 82, "completing_count": 7, "completing_pct": 8.54 }],
    "completing_by_type":  [{ "key": "CO", "pipeline_count": 89, "completing_count": 10, "completing_pct": 11.24 }],
    "has_active_schedule_run": true
  }
  ```

  - The basis is the pipeline-totals basis.
  - "Completing" means the active run's `WITHIN_YEAR` outcome, the same as `/completing-within-year`.
  - Without an active run, the `completing_*` lists are empty.
- **Workflow settings:**
  - `GET /workflow-settings/category-timelines?workflow=PDD|OEM` returns, per category,
    `{category, total_weeks, design_weeks, lab_weeks, steps:[{code,name,resource_kind,start_week,duration_weeks}]}`.
    It is computed server-side from the served lead times and the precedence DAG (earliest start,
    no capacity).
  - `GET /workflow-settings/b-equivalent?workflow=PDD|OEM` returns
    `[{category, design_weeks, lab_weeks, design_ratio, lab_ratio}]`. The ratios are relative to
    category B (PDD) or B-OEM (OEM), 2 dp.
- **Registration and Planning (T17):** frontend only. Registration gets a search box. If
  `GET /projects` lacks it, add `q` there with the §3 semantics. Capacity Planning groups engineers
  by hub and chambers by lab region (display grouping only; the totals shown are the served ones).

## 6. Slice B: Capacity priority split (T11), Priority board (T12)

- **`HubCapacityRow`** gains `design_load_by_priority` and `lab_load_by_priority`, each
  `{P1, P2, P3, P4, Queue}` in weeks, 2 dp.
  - Same load basis as the existing `design_load` and `lab_load`. The values sum to them.
  - "Queue" means a project with null priority or In Queue status, as the scheduler classifies it.
- **`ClassBreakdownRow`** gains `deliverable_by_priority` and `left_out_by_priority` (same keys,
  counts) and `by_hub: [{hub, deliverable, left_out}]`.
- **`UtilizationMatrix`** hub rows gain the same per-priority design and lab loads, if the matrix
  is the hub table. Otherwise reuse the `HubCapacityRow` fields.
- **`PriorityBoardColumn`** gains `design_weeks` and `lab_weeks`. Each is the column's remaining
  load in weeks, server-side.
- **`GET /priority-board`** gains `q`, `category`, `type`, `status_` and `leader_engineer_id`
  filters (§3 semantics). The column totals follow the filtered set.

## 7. Slice C: Gantt toolbar (T13), Matrix toolbar (T14), Shell (T15)

- **`GanttProjectRow`** gains `external_code`, `type`, `leader_name` (GDPR rule as in §3),
  `design_weeks`, `lab_weeks` and `total_weeks` (served effective durations).
- **`GET /gantt`** gains `q`, `category`, `type`, `status_`, `leader_engineer_id`, `current_step`,
  `priority` and `sort=priority|name|start|end`.
- **`GET /gantt`** response gains `weekly_active_counts: [{week, pdd, oem}]`. These are counts of
  active steps per week for the filtered set, server-side.
- **Matrix rows** (`/priorities`) gain `leader_name` (GDPR rule), `status`, `type` and `rank`
  (1-based, by score, within the filtered set). The filters gain `type`, `status_` and `q`.
- **Shell:**
  - `GET /schedule-runs` exists. Add `GET /export-jobs?limit=50`, which returns the caller's own
    export jobs: `{id, kind, format, status, created_at, file_name}`. The download goes through
    the existing export download route. The scope is own jobs only, with Admin seeing all.
  - `GET /me` or the reference data gains `current_week` and `weeks_left_in_year` (52-week year,
    ADR 0024), if the header cannot already get them from a served endpoint.
- **Frontend:**
  - Gantt toolbar: search, filters, sort, P1–P4/Queue tabs, a px zoom slider (16–48), a Forest
    (compact) view, Hide stats, row meta, and a weekly PDD/OEM count row.
  - Matrix: Type and Status chips, per-column filter inputs, Rank / Leader / Status columns, Reset
    view, Detailed view (shows the score-dimension columns), and an editable FX rate. The FX rate
    is Admin only, through `PUT /currency-rates/{code}`.
  - Header: "Week N · M wks left" plus today's date.
  - New pages `/history` "Versions & History" (schedule runs with their change lists and scenario
    versions, read-only) and `/downloads` "Downloads" (export-jobs list), both in the Data nav
    group. RBAC: history uses the audit-log or matrix read permission, whichever already gates run
    lists; downloads is any authenticated user.
