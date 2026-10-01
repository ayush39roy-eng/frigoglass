# P9 API contract — shared by backend-builder (P9-T03) and frontend-builder (P9-T04)

Written 2026-09-27 by the orchestrator so the two can build in parallel. **backend-builder implements
these shapes exactly (Pydantic v2, `extra="forbid"` on requests); frontend-builder authors
`// PLACEHOLDER` TS mirrors of them and reconciles against the regenerated OpenAPI in the P9 gate
(P3-T07 contract test).** Any deviation either side needs is recorded in `docs/MEMORY.md` and told to
the other side via the orchestrator — do not silently diverge. All existing endpoints keep their
current shapes unless listed here as *extended*. Week numbers are ints on the app's 1..78 axis.
Every mutation writes an audit row and is RBAC-checked server-side per `docs/PROJECT_AND_STACK.md` §5.

## 1. Session — `GET /me`  (any authenticated principal)
```jsonc
{
  "user_id": "uuid", "email": "…", "full_name": "…",
  "roles": ["Super Admin"],                               // RoleName values
  "hub_scope_all": true, "hub_ids": ["uuid"], "engineer_id": "uuid|null",
  "permissions": {                                        // one key per core.rbac.Surface value
    "dashboard": {"read": true, "write": true}, "capacity": {…}, "matrix": {…}, "gantt": {…},
    "project_workspace": {…}, "project_registration": {…}, "capacity_planning": {…},
    "workflow_settings": {…}, "audit_log": {…}, "user_role_admin": {…}
  },
  "dev_mode": false                                       // true only when RPD_DEV_MODE is on
}
```
Dev mode only: request header `X-Dev-User-Email: <seeded email>` selects the acting user for an
unauthenticated request; `GET /me/dev-users` (dev mode only, else 404) lists `{email, full_name,
roles}` for the switcher.

## 2. User / role admin  (surface `user_role_admin`; Admin: non-admin roles; Super Admin: all)
- `GET /users?q=&limit=&offset=` → `{total_count, items: UserRead[]}`
- `POST /users` `{email, full_name, roles: RoleName[], hub_scope_all: bool, hub_ids: uuid[], engineer_id?: uuid}` → `UserRead`
- `PATCH /users/{id}` any subset of the above + `is_active` → `UserRead`
- `GET /roles` → `[{name, description, assignable: bool}]` (`assignable` false for Admin/Super Admin when the caller is Admin)
- `UserRead = {id, email, full_name, is_active, roles: RoleName[], hub_scope_all, hub_ids: uuid[], engineer_id, oidc_linked: bool, created_at, updated_at}`
- 409 `LAST_SUPER_ADMIN` when a change would leave no active Super Admin. 403 when an Admin touches an Admin/Super Admin account or role.

## 3. Workflow settings  (surface `workflow_settings`; Admin read, Super Admin write)
- `GET /workflow-settings` →
```jsonc
{
  "workflows": [{ "id": "PDD", "name": "…", "steps": [
      {"step_id":"PDD-A","code":"MKTG_BRF","name":"Marketing Brief","kind":"design","sequence_order":1,"predecessor_ids":[]}, … ] }],
  "lead_times": [{"workflow_id":"PDD","category":"A+","step_id":"PDD-A","weeks":1}, …],   // 98 rows
  "hub_calendars": [{"hub_id":"uuid","hub":"PD-India","weekdays_per_week":6,"national_holiday_days":13,
                     "medical_leave_days":7,"casual_leave_days":7,"annual_leave_days":20,"weeks_in_year":52,
                     "working_weeks_per_engineer": 43.93}],                                       // derived, read-only
  "chambers": [{"chamber_id":"uuid","code":"IN-CH-2","lab_region":"India","platforms":4,"efficiency":0.6,
                "maintenance_weeks":2,"breakdown_weeks":11,"calibration_weeks":1,
                "working_weeks_per_chamber":35.4,"efficient_lab_weeks":84.96}],                  // last two derived
  "current_week": 31, "horizon_weeks": 78, "within_year_week": 52,
  "updated_at": "…", "updated_by": "name|null"
}
```
- `PUT /workflow-settings/steps/{workflow_id}` body `{steps: [{step_id, kind, predecessor_ids}]}` (all 14) — validates kinds, acyclicity, same-workflow refs, non-empty predecessors except the first; 422 with `{code:"CYCLE"|"BAD_PREDECESSOR"|…, detail}`.
- `PUT /workflow-settings/lead-times` body `{lead_times: [{workflow_id, category, step_id, weeks}]}` (partial allowed; weeks ≥ 0).
- `PUT /workflow-settings/hub-calendars/{hub_id}` body = the five editable calendar fields.
- `PUT /workflow-settings/chambers/{chamber_id}` body `{platforms?, efficiency?, maintenance_weeks?, breakdown_weeks?, calibration_weeks?}` (Hub Planner may also call this for own-hub chambers via Capacity Planning — same handler, `capacity_planning` write).
- Every successful PUT returns the full `GET` payload, writes an audit row, and sets `schedule_stale=true` on every schedulable project. Response header `X-Schedule-Stale-Count: <n>`.

## 4. Capacity — `GET /capacity/hubs` *(extended; existing fields kept)*
Each row gains (ADR 0008; all floats to 2 dp, computed server-side):
```jsonc
{ "hub":"PD-India", "lab_region":"India",
  "design_load_weeks": 587, "design_load_estimated_weeks": 451.5,     // process-derived (I6) | Σ estimated_design_weeks
  "lab_load_weeks": 496.5, "lab_load_estimated_weeks": 2521,           // region-level, repeated on every hub of the region
  "engineer_fte_total": 5.75, "working_weeks_per_engineer": 43.93,
  "design_capacity_year": 252.62, "design_capacity_remaining": 179.75,
  "lab_capacity_year": 186.22, "lab_capacity_remaining": 132.5,        // region-level
  "design_gap_year": 334.38, "design_completion_pct_year": 0.43, "design_gap_remaining": …, "design_completion_pct_remaining": …,
  "lab_gap_year": …, "lab_completion_pct_year": …, "lab_gap_remaining": …, "lab_completion_pct_remaining": …,
  "remaining_fraction": 0.4038, "chambers": [ {chamber_id, code, platforms, efficiency, working_weeks_per_chamber, efficient_lab_weeks} ] }
```
Keep `design_capacity_weeks` / `lab_capacity_units` for one release as aliases of `*_remaining`
(frontend stops reading them). `completion_pct` is `null` when load is 0.

## 5. Gantt — `GET /gantt` *(extended)*
`GanttProjectRow` gains `target_end_week: int|null`, `expected_end_week: int|null`,
`projected_end_week: int|null`, `unconstrained_end_week: int|null`, `slip_weeks: int|null`
(`projected − expected`), `blocked: bool`, `schedule_stale: bool`, `workflow_id: "PDD"|"OEM"`.
`GanttStepRow.kind` becomes `"design"|"lab"|"elapsed"`; gains `skipped: bool`, `status`
(WorkflowStepStatus), `percent_complete`. Step rows may overlap in time.

## 6. Projects *(extended)*
`ProjectCreateRequest`/`ProjectUpdateRequest`/`ProjectRead` gain `target_end_week`,
`certification_testing_required`, `estimated_design_weeks`, `estimated_lab_weeks`; `ProjectRead`
also `schedule_stale`, `workflow_id`. Category must match the hub's workflow (422 `CATEGORY_WORKFLOW_MISMATCH`).
`status` accepts `Cancelled`. `GET /reference/categories?hub_id=` returns the categories valid for that hub.

## 7. Project Workspace  (surface `project_workspace`; hub-scoped rows)
- `GET /projects/{id}/workspace` →
```jsonc
{ "project": ProjectRead + {"hub":"PD-India","leader_engineer_name": "string|null (OQ#8 withheld → null)"},
  "health": "on_track"|"at_risk"|"off_track"|"left_out"|"unscheduled",     // I13, from the active run only
  "schedule": {"has_active_run":bool,"run_version":int|null,"expected_end_week":…,"projected_end_week":…,
               "unconstrained_end_week":…,"slip_weeks":…,"within_year":bool|null,"left_out":bool,"schedule_stale":bool},
  "progress_pct": 37,                                                       // duration-weighted (I12), server-computed
  "stages": [ {"step_id","code","name","kind","sequence_order","predecessor_ids","duration_weeks","skipped",
               "planned_start_week","planned_end_week","actual_start_week","actual_end_week",
               "status","percent_complete","remaining_weeks","remaining_weeks_override","blocked_reason",
               "assigned_engineer_name":null,"assigned_chamber_code":"…","overrun_weeks":int|null} ],   // 14 rows
  "priority_score": {13 dimension ints, "hard_gates":[…], "weighted_score", "normalized_pct", "suggested_band"} | null,
  "files": [FileRead], "activity": [ActivityItem] }                          // activity: latest 50, newest first
```
- `PATCH /projects/{id}/stages/{step_id}` body: any subset of `{status, percent_complete, actual_start_week, actual_end_week, remaining_weeks_override, blocked_reason}`; server enforces the DOMAIN_RULES consistency rules (422 with field errors), sets `schedule_stale`, writes an audit row, returns the full workspace payload.
- `POST /projects/{id}/recalculate` → `{"schedule_run_id": uuid, "task_id": str}`; progress via the existing SSE endpoint (P3-T05). On completion the new run is active, `schedule_stale` cleared, a system event emitted ("Schedule recalculated — finish moved week X → week Y").
- Files: `POST /projects/{id}/files` multipart `{file, display_name, category, description?}` (max 50 MB; allowed types pdf/png/jpg/jpeg/xlsx/docx/pptx/csv/txt/zip/step/stp/dxf; re-upload of an existing display_name → version+1) → `FileRead`; `GET /projects/{id}/files` → `FileRead[]`; `GET /projects/{id}/files/{file_id}/download` → streamed bytes with `Content-Disposition`; `PATCH /projects/{id}/files/{file_id}` `{display_name?, category?, description?}`.
  `FileRead = {id, display_name, category, description, version, size_bytes, content_type, uploaded_by_name: string|null, created_at}`.
- Comments: `POST /projects/{id}/comments` `{body_md}` → `CommentRead`; `PATCH /projects/{id}/comments/{cid}` `{body_md}` (author only, < 15 min, else 403 `EDIT_LOCKED`); `DELETE …/{cid}` soft-delete (author or Admin/Super Admin).
  `CommentRead = {id, body_md, body_html_sanitized, author_name: string|null, author_user_id, created_at, edited_at, can_edit: bool, mentioned_user_ids: uuid[]}`. `@mention` resolves `@First Last` / `@email` against `GET /users/mention-search?q=` (returns `{user_id, display}`; withheld/empty while OQ#8 is open — server decides).
  `ActivityItem = {"kind":"comment", comment: CommentRead} | {"kind":"event", id, occurred_at, actor_name: string|null, summary: str, audit_entry_id}`.
- `GET /projects/{id}/activity?before=&limit=` for paging.

## 8. Matrix *(no shape change)* — the frontend renders the deck's scoring anchors from a static
constant (`docs/DOMAIN_RULES.md` weights + slide-4 anchor texts in `docs/CLIENT_FORMULAS.md`
companion note below). Anchors (1 → 5): Strategic Project "Non-strategic → Core roadmap"; New
Customer "Existing minor → Major strategic customer"; New Options "Minor option → Breakthrough
feature"; Regulatory Compliance "None → Mandatory < 6 months"; Quality Improvements "Negligible →
Major field-issue reduction"; RM Savings "< €5K → > €100K annually"; Total RM Savings "Minimal →
Very high 3-year savings"; Gross Margins "< 1% → > 15%"; Profitability "Low/negative → Very high";
Annual Volume "< 5K → > 25K units"; 3-Year Volume "Low → Global multi-year scale"; New Models
"Single model → Global platform"; CAPEX Investment (inverted) "1 = > €500K → 5 = < €10K". Scale:
5 Exceptional/Must-do · 4 Strong case · 3 Moderate/Average · 2 Weak case · 1 Negligible/N/A.

## 9. Error envelope
Unchanged from P3: `{"detail": str | [{loc, msg, type}], "code"?: str}`.
