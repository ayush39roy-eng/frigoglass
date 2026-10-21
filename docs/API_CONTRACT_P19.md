# API contract P19 — capacity figures for Capacity Planning and the Weeks / Days toggle

Owner: backend-builder (P19-T03). Consumers: frontend-builder (P19-T04 Capacity Planning page; the
Capacity page's Weeks / Days toggle from P19-T01/T02). Every change is **additive**: no field was
removed or renamed. Every number is served (I9/I19); the browser never multiplies weeks by days.

Basis words used everywhere:

- `year` = the full 52-week planning year (ADR 0008 yearly formulas).
- `remaining` = the rest of the year from `CURRENT_WEEK` (ADR 0008 remaining formulas).

```ts
type YearRemaining = { year: number; remaining: number }   // 2 dp
```

**Days.** `days = served weeks × weekdays_per_week`, rounded to 2 dp, where the served weeks are
already 2 dp. So a served days figure always equals the served weeks figure next to it times the
served `weekdays_per_week`, to 2 dp. A **design** figure uses the hub's
`HubWorkCalendar.weekdays_per_week`. A **lab** figure uses the weekdays of the *region calendar*:
the hub calendar of that lab region with the largest `national_holiday_days / weekdays_per_week`
(the one DOMAIN_RULES uses for the chambers' holiday weeks; ties go to the smaller weekdays, then
the hub id). Seeded values: Greece 5 (from R&D-Greece, not the OEM hubs' 6), India 6, Romania 5.
A hub with no calendar row falls back to 5 (data gap; every seeded hub has a calendar).

**Load has no basis.** A load is every booked week of the active run (I6/I7, spillover included).
That is the same on both bases, so a load `YearRemaining` carries the same value twice.

## 1. `GET /capacity/hub-load` (and `/capacity/hubs`): additions

Each `HubCapacityRow` (one per hub; it is the design row and repeats its lab region's figures):

| field | type | meaning |
|---|---|---|
| `weekdays_per_week` | number | the hub's calendar |
| `capacity_days` | YearRemaining | `design_capacity_year` / `_remaining` × `weekdays_per_week` |
| `load_days` | YearRemaining | `design_load_weeks` × `weekdays_per_week` (both keys equal) |
| `lab_weekdays_per_week` | number | the region calendar's weekdays (see above) |
| `lab_capacity_days` | YearRemaining | `lab_capacity_year` / `_remaining` × `lab_weekdays_per_week` |
| `lab_load_days` | YearRemaining | `lab_load_weeks` × `lab_weekdays_per_week` (both keys equal) |

There is no separate "lab-region row" in this response today, so the summary also gains one row
per lab region, served once:

```ts
HubCapacitySummary.lab_regions: LabRegionCapacityRow[]   // Greece, India, Romania order; only regions of the served rows
LabRegionCapacityRow = {
  lab_region: LabRegion
  weekdays_per_week: number       // = lab_weekdays_per_week on the region's hub rows
  chamber_count: number
  capacity_weeks: YearRemaining   // = lab_capacity_year / lab_capacity_remaining of the region's hub rows
  load_weeks: number              // = lab_load_weeks of the region's hub rows
  capacity_days: YearRemaining    // = lab_capacity_days
  load_days: YearRemaining        // = lab_load_days
}
```

`CapacityTotals` (the served `totals`) gains the day totals. Hubs can have different weekdays, so a
day total is the sum of the rows' served days (design: each hub; lab: each region once), never
"total weeks × one constant":

| field | type |
|---|---|
| `design_capacity_days` | YearRemaining |
| `design_load_days` | YearRemaining |
| `lab_capacity_days` | YearRemaining |
| `lab_load_days` | YearRemaining |

## 2. `GET /engineers` (and `GET /engineers/{id}`, POST/PATCH responses): additions to `EngineerRead`

| field | type | meaning |
|---|---|---|
| `weekdays_per_week` | number | the engineer's hub calendar |
| `capacity_weeks` | YearRemaining | `year = working_weeks_per_engineer(hub) × fte`; `remaining = ((52 − CURRENT_WEEK) − deduction_weeks × remaining_fraction) × fte` |
| `capacity_days` | YearRemaining | served `capacity_weeks` × `weekdays_per_week` |

Roles and hub scope are unchanged (Capacity Planning READ; a Hub Planner sees own-hub engineers).
Names are shown (ADR 0028).

## 3. `GET /chambers` (and `GET /chambers/{id}`, POST/PATCH responses): additions to `ChamberRead`

| field | type | meaning |
|---|---|---|
| `weekdays_per_week` | number | the region calendar's weekdays |
| `working_weeks` | number | `working_weeks_per_chamber` (same value as the existing field) |
| `capacity_weeks` | YearRemaining | `year = efficient_lab_weeks = working_weeks × efficiency × platforms`; `remaining = year × (52 − CURRENT_WEEK) / 52` |
| `capacity_days` | YearRemaining | served `capacity_weeks` × `weekdays_per_week` |

Scope unchanged: a Hub Planner sees the chambers of their hubs' lab regions.

## 4. `GET /planning/capacity-summary` (new)

Role: Capacity Planning READ (Portfolio Manager, Hub Planner, Admin, Super Admin; Engineer,
Executive Viewer and Auditor get 403; no token 401). Query: optional `hub_id` (uuid), `region`
(`Greece` | `India` | `Romania`). Both are ANDed with the RBAC hub scope and never widen it (ADR
0020/0025). An out-of-scope filter gives empty lists and zero totals, never 403.

```ts
CapacitySummaryResponse = {
  current_week: number
  design: {
    hubs: {
      hub: HubName
      engineer_count: number
      fte_total: number              // = hub-load engineer_fte_total
      weekdays_per_week: number
      capacity_weeks: YearRemaining  // = hub-load design_capacity_year / design_capacity_remaining
      capacity_days: YearRemaining   // = hub-load capacity_days
      share_pct: YearRemaining
    }[]                              // hub order as /capacity/hub-load
    total: { engineer_count: number; fte_total: number; capacity_weeks: YearRemaining; capacity_days: YearRemaining }
  }
  lab: {
    regions: {
      lab_region: LabRegion
      chamber_count: number
      weekdays_per_week: number
      capacity_weeks: YearRemaining  // = hub-load lab_capacity_year / _remaining of the region
      capacity_days: YearRemaining   // = hub-load lab_capacity_days
      share_pct: YearRemaining
    }[]                              // Greece, India, Romania; only the lab regions of the visible hubs
    total: { chamber_count: number; capacity_weeks: YearRemaining; capacity_days: YearRemaining }
  }
}
```

- `share_pct` = this hub's (region's) served capacity / the total over the caller's visible hubs
  (regions) × 100, 2 dp, `0.0` when the total is 0. The shares sum to 100 up to rounding.
- Totals equal `/capacity/hub-load` `totals.design_capacity_*`, `totals.lab_capacity_*`,
  `totals.design_capacity_days` and `totals.lab_capacity_days` for the same filters (tested).
- Additive beyond the brief: `current_week` and `weekdays_per_week` on each hub and region.

## 5. `GET /planning/resource-load` (new) — "Resource load analytics"

Role and scope as §4. **Audit-logged** on every read (per-engineer load is GDPR personal data, OQ
#8, ADR 0028): action `planning.resource_load.read`, `after_state = {filter_key, engineer_rows,
chamber_rows}` (filters and row counts, never a figure), coalesced to one row per user per filter
set per minute, exactly like `/capacity/engineer-utilization`. No financial field is served.

Query (all optional; list parameters repeat, for example `?category=A&category=B`):

| param | type | effect |
|---|---|---|
| `hub_id` | uuid | which engineers are listed; chambers narrowed to that hub's lab region |
| `region` | LabRegion | which engineers (hubs of the region) and chambers (that region) are listed |
| `project_type` | ProjectType[] (`NM`, `CO`, `RC`, `NO`, `IMP`) | load only from matching projects |
| `project_status` | ProjectStatus[] (served label values, for example `In Development`) | load only from matching projects |
| `requesting_department` | string[] (each ≤ 100 chars) | see the deviation below: matches no project today |
| `category` | ProjectCategory[] (`A+` … `C-OEM`) | load only from matching projects |
| `engineer_id` | uuid[] | lists only these engineers; load only from projects with a step booked on one of them |
| `basis` | `year` \| `remaining` (default `year`) | which capacity is used |

At most 50 values per list (500 for `engineer_id`), otherwise 422. An unknown enum value or basis
gives 422.

```ts
ResourceLoadResponse = {
  has_active_schedule_run: boolean
  schedule_run_version: number | null
  current_week: number
  basis: 'year' | 'remaining'
  engineers: {
    engineer_id: string; name: string; hub: HubName; weekdays_per_week: number
    capacity_weeks: number      // = GET /engineers capacity_weeks[basis]
    load_weeks: number
    utilization_pct: number | null   // load / capacity × 100, 2 dp; null when capacity is 0
    capacity_days: number; load_days: number   // × the hub's weekdays_per_week
  }[]                           // hub order, then name
  chambers: {
    chamber_id: string; code: string; lab_region: LabRegion; weekdays_per_week: number
    capacity_weeks: number      // = GET /chambers capacity_weeks[basis]
    load_weeks: number
    utilization_pct: number | null
    capacity_days: number; load_days: number   // × the region calendar's weekdays
  }[]                           // region, then code
  totals: {
    engineers: { capacity_weeks: number; load_weeks: number; utilization_pct: number | null; capacity_days: number; load_days: number }
    chambers:  { capacity_weeks: number; load_weeks: number; utilization_pct: number | null; capacity_days: number; load_days: number }
  }
  filters_applied: {
    hub_id: string | null; region: LabRegion | null
    project_type: ProjectType[]; project_status: ProjectStatus[]; requesting_department: string[]
    category: ProjectCategory[]; engineer_id: string[]; basis: 'year' | 'remaining'
  }                             // deduplicated, sorted (enum order; engineer ids as strings)
}
```

Rules:

- **Engineer load** = the sum of `duration_weeks` of the active run's non-skipped design-kind steps
  booked on the engineer (`assigned_engineer_id`), over projects matching the project filters.
  With no project filter it equals `/capacity/engineer-utilization` `total_booked` for every
  engineer (tested). It is the booked resource's load, so a leader from another hub counts on
  their own row.
- **Chamber load** = the sum of `duration_weeks × 1.0` of the active run's non-skipped lab-kind
  steps booked on the chamber, over matching projects. It is region-wide like `/capacity`: a Hub
  Planner's chamber load includes other hubs' projects in the shared region. Only the per-chamber
  aggregate is served.
- Capacity never depends on the project filters, only on `basis` and the listed resource.
- Totals = the sum of the served rows (2 dp); `utilization_pct` is computed on those sums.
- No active run: every load is 0 and `has_active_schedule_run` is false.

## 6. `GET /planning/resource-load/options` (new)

Role and scope as §4; optional `hub_id`, `region` (same AND rule). Not audit-logged: it serves
names only, the same names `GET /engineers` serves, and no figure.

```ts
ResourceLoadOptions = {
  hubs: HubName[]                     // visible hubs, hub order
  lab_regions: LabRegion[]            // their lab regions, Greece, India, Romania
  project_types: ProjectType[]        // distinct values on visible projects, enum order
  project_statuses: ProjectStatus[]   // distinct, enum order
  categories: ProjectCategory[]       // distinct, enum order
  requesting_departments: string[]    // always [] today (OQ #34)
  requesting_department_available: boolean   // false today: hide or disable the Dept filter
  engineers: { engineer_id: string; name: string; hub: HubName }[]   // visible engineers, hub order then name
}
```

## Deviations

1. **Requesting department does not exist.** Projects have no requesting-department field
   (`docs/OPEN_QUESTIONS.md` #34: "both columns are hidden. We do not invent values"). The
   parameter is accepted so the contract is stable. Any value matches no project (all loads 0).
   The options list is empty and `requesting_department_available` is `false`. No column or
   migration was added. Once the client answers OQ #34 the parameter starts to work with no shape
   change.
2. **"Lab-region rows" on hub-load** did not exist (lab figures are repeated on each hub row). They
   are served two ways: `lab_*` day fields on each `HubCapacityRow`, and a new
   `HubCapacitySummary.lab_regions[]`.
3. **Exports.** The Capacity Planning export now has `capacity_weeks_year`,
   `capacity_weeks_remaining`, `capacity_days_year`, `capacity_days_remaining` columns. The
   Capacity export flattens `*_by_priority` and the new day pairs the same way, and the nested
   `chambers` list on a hub row stays one comma-joined cell as before. A spreadsheet cell never
   holds a dict.
