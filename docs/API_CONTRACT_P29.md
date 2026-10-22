# API contract: P29, OEM hubs under Greece capacity (ADR 0042) + type BC = RC (ADR 0038 amendment)

Owner: backend-builder (P29-T01, P29-T04 backend, P29-T06). Consumer: frontend-builder (P29-T03,
P29-T04 frontend). Date: 2026-10-23.
Rules: `docs/DOMAIN_RULES.md` "Capacity hubs" (ADR 0042), "Capacity supply" (ADR 0008), "Booked %
and areas" (ADR 0016), "P1 capacity fill" (ADR 0036), "Global hub filter" (ADR 0020).

Additive on the wire: no field is removed or renamed. What changes is **which rows** the capacity
surfaces serve (four capacity hubs instead of six hubs) and what a Greece row's figures cover.
Error envelope (unchanged): `{"detail": string | [{loc, msg, type, input?}], "code"?: string}`.

`HubName` is unchanged (six values). The four capacity hubs are `R&D-Greece`, `R&D-India`,
`PD-India`, `PD-Romania`. The two **member hubs** are `OEM-HCK` and `OEM-Seltek`; their capacity hub
is `R&D-Greece`.

## 0. Summary for the frontend

| Surface / endpoint | Before | After (P29) |
|---|---|---|
| `GET /capacity/hub-load` (= `/capacity/hubs`) `rows[]` | 6 hub rows | ≤ 4 capacity-hub rows; Greece row aggregates OEM; new `members[]`, `selected_member` |
| `GET /planning/capacity-summary` `design.hubs[]` | 6 hub rows | ≤ 4; new `not_counted_engineer_count`, `members[]`, `selected_member` |
| `GET /priorities/capacity-fill` `hubs[]` | 6 entries | ≤ 4; Greece walk covers OEM projects; new `members[]`, `selected_member` |
| `GET /capacity/engineer-utilization`, `/capacity/utilization-matrix`, `GET /planning/resource-load`, `/planning/resource-load/options`, `GET /engineers?hub_id=` | member-hub filter → no engineers | member-hub filter → the capacity hub's engineers (RBAC unchanged) |
| Engineer rows (`EngineerRead`, heatmap row, resource-load row) | — | new `counts_in_capacity: boolean` |
| `GET /hubs` (`HubRead`) | — | new `capacity_hub_id`, `capacity_hub_name` |
| `ProjectRead` / `ProjectListItem` / `WorkspaceProject` | — | new `leader_is_provisional: boolean` |
| `GET /reference/project-types` | did not exist | new: `[{code, label}]`, `RC` = "Regulatory / Business Compliance" |
| What-if (`/whatif/estimate`, `/simulate`, `/solve`) | 6 hub rows | design rows / designer additions / workings on capacity hubs only; designers on a member hub are a 422 |
| Capacity export (`surface=capacity`) | 6 rows | ≤ 4 rows; `members` is one text cell |

Everything else keeps six hubs: registration, the Projects list, the Gantt, the Dashboard Hub × Type
table and its other figures, the country filter (ADR 0025), the global hub filter's option list,
the Matrix rows, `GET /capacity/class-breakdown` (`by_hub` per project hub), and lab figures (lab
regions are unchanged; OEM lab region was already Greece).

## 1. Reference data

### 1.1 `GET /hubs` → `HubRead[]` (any authenticated principal; six rows, by name)

```ts
interface HubRead {
  id: string;                       // uuid
  name: HubName;
  lab_region: "Greece" | "India" | "Romania";
  is_oem: boolean;
  capacity_hub_id: string | null;   // NEW. R&D-Greece's id on OEM-HCK and OEM-Seltek; null elsewhere
  capacity_hub_name: HubName | null;// NEW. "R&D-Greece" on OEM-HCK and OEM-Seltek; null elsewhere
}
```

Use it for the "(Greece)" label on hub pickers (`capacity_hub_name != null`). Never hard-code the
mapping.

### 1.2 `GET /reference/project-types` → `ProjectTypeRead[]` (NEW; any authenticated principal)

```ts
interface ProjectTypeRead { code: "NM" | "CO" | "RC" | "NO" | "IMP"; label: string }
```

Served in this order: `NM` "New Model", `CO` "Cost Optimization", `RC` "Regulatory / Business
Compliance", `NO` "New Option", `IMP` "Improvement". The wire value stays `RC`. P29-T04 frontend:
show `label`; do not invent a `BC` type.

## 2. `GET /capacity/hub-load` and `GET /capacity/hubs` (same handler; RBAC unchanged)

Query: `hub_id?: uuid`, `region?: LabRegion` (both unchanged).

### 2.1 Rows

`rows[]` is one `HubCapacityRow` per **capacity hub** that has at least one of its hubs (itself or a
member) in the caller's RBAC scope AND the `hub_id` / `region` filter. Ordered by capacity-hub name.
No row is ever served with `hub` = `OEM-HCK` or `OEM-Seltek`.

For the Greece row (`hub: "R&D-Greece"`):

- **Design load** `design_load_weeks` = Σ design-kind step durations (effort weeks, active run) of
  the projects of R&D-Greece **and** OEM-HCK **and** OEM-Seltek (ADR 0042 §3). The same set feeds
  `design_load_by_priority`, `design_load_estimated_weeks` and `lab_load_units`.
- **Supply** `engineer_fte_total`, `design_capacity_year`, `design_capacity_remaining`,
  `working_weeks_per_engineer`, `design_capacity_days`, … = Greece's work calendar × Σ fte of the
  engineers on R&D-Greece with `counts_in_capacity = true` (ADR 0042 §2, §5). Member hubs have no
  calendar and no engineers.
- `design_booked_pct_*`, `design_booking_status_*`, `design_gap_*`, `design_completion_pct_*` are on
  the aggregate only (I19 holds on the row: `booked = load / capacity × 100`).
- Lab figures (`lab_*`) are unchanged: region-wide (Greece).

Every other row: as before, except supply now counts only `counts_in_capacity` engineers (Dipak on
R&D-India, Antonis and Sailesh on their hubs are not counted).

### 2.2 New fields on `HubCapacityRow`

```ts
interface CapacityHubMember {
  hub: HubName;               // "R&D-Greece" | "OEM-HCK" | "OEM-Seltek"
  own: boolean;               // true for the capacity hub itself (always listed first when in scope)
  project_count: number;      // projects of this hub with ≥ 1 non-skipped design step in the active run
  design_load_weeks: number;  // integer effort weeks of those projects (I6 per hub). 0 with no run
}

interface HubCapacityRow {
  // ... every existing field, unchanged in name and type ...
  members: CapacityHubMember[];   // NEW. never null
  selected_member: HubName | null;// NEW
}
```

- `members` is **empty** (`[]`) on a capacity hub with no member hubs (R&D-India, PD-India,
  PD-Romania). On the Greece row it lists own first, then members by name, **only hubs in the
  caller's RBAC scope** (the `hub_id` filter does not shrink it; `region` does, but every Greece
  member is in the Greece region).
- Σ `members[].design_load_weeks` = the row's `design_load_weeks` **when the caller sees all three
  hubs**. A caller scoped to a subset sees the full aggregate but only their members (ADR 0042 §8),
  so the frontend must not assert or display the sum as the row total; display the row's own
  `design_load_weeks`.
- `members` is display-only. Never compute a per-member booked % or status in the browser (I19):
  there is no per-member capacity.
- `selected_member`: the request's `hub_id` when it is one of this row's hubs (own or member),
  else null. With `hub_id = OEM-HCK` the Greece row is served with `selected_member: "OEM-HCK"`;
  with `hub_id = R&D-Greece`, `selected_member: "R&D-Greece"`; with no `hub_id` (or only `region`),
  null. Highlight that member in the breakdown.

### 2.3 Filter behaviour (ADR 0020 + ADR 0042 §4)

| Request | Rows served |
|---|---|
| no filter | every capacity hub with a hub in scope |
| `hub_id = OEM-HCK` or `OEM-Seltek` | the Greece row only, `selected_member` = that hub, figures **identical** to the unfiltered Greece row |
| `hub_id = R&D-Greece` | the Greece row, `selected_member = "R&D-Greece"`, same figures |
| `hub_id` = another capacity hub | that row, `selected_member` = that hub, `members: []` |
| `hub_id` out of the caller's scope (or unknown) | `rows: []`, zero totals (never widens) |
| `region = Greece` | the Greece row, `selected_member: null` |

### 2.4 `areas[]` and `totals`

Built from the served rows (unchanged code path). `areas[].hubs` and `totals.hubs` list **capacity
hubs**, so the Europe area is `["PD-Romania", "R&D-Greece"]`; each Greece aggregate is counted once.

### 2.5 RBAC (ADR 0042 §8) — scoping decisions

- A caller scoped to **any** of R&D-Greece, OEM-HCK, OEM-Seltek gets the Greece row with the full
  aggregate figures (load, supply, booked %, status, gap, completion, FTE total). This is aggregate
  data, like the ADR 0016 area figures.
- `members` lists only the caller's in-scope hubs: an OEM-HCK-only planner sees
  `members: [{hub: "OEM-HCK", …}]`, never R&D-Greece's own or OEM-Seltek's breakdown.
- **Engineer rows are not widened.** Engineers sit on R&D-Greece; an OEM-only caller gets no Greece
  engineer rows from the heatmap, utilization matrix, resource load, options or `GET /engineers`
  (row-level hub scoping on `engineers.hub_id` is unchanged). They see the aggregate FTE only.

## 3. Capacity Planning

### 3.1 `GET /planning/capacity-summary` (query unchanged)

`design.hubs[]` follows §2.1 / §2.3 (one row per capacity hub, same filter rules). `DesignHubSummary`:

```ts
interface DesignHubSummary {
  hub: HubName;                     // a capacity hub
  engineer_count: number;           // CHANGED meaning: engineers with counts_in_capacity only
  not_counted_engineer_count: number; // NEW. engineers of the hub with counts_in_capacity = false
  fte_total: number;                // Σ fte of the counted engineers (= hub-load engineer_fte_total)
  weekdays_per_week: number;
  capacity_weeks: YearRemaining;    // = hub-load design_capacity_year / _remaining of the same row
  capacity_days: YearRemaining;
  share_pct: YearRemaining;
  members: HubName[];               // NEW. member hubs in scope, by name, own hub NOT listed;
                                    //      ["OEM-HCK","OEM-Seltek"] on Greece, [] elsewhere
  selected_member: HubName | null;  // NEW. as §2.2
}
```

`design.total.engineer_count` = Σ counted engineers.

### 3.2 `GET /planning/resource-load` and `/planning/resource-load/options`

- `hub_id` = a member hub lists the **capacity hub's** engineers (R&D-Greece's), ANDed with RBAC.
  Each engineer's load is their whole active-run design load (not just the member hub's projects).
  Chambers: unchanged (the member hub's lab region).
- `EngineerResourceLoad` gains `counts_in_capacity: boolean`. The row's own `capacity_weeks` /
  `capacity_days` are still served for a non-counted engineer.
- `totals.engineers.capacity_weeks` / `capacity_days` sum **counted rows only** (supply);
  `load_weeks` / `load_days` sum every row; `utilization_pct` = load / that capacity.

### 3.3 Roster marker

Show "not in capacity roster" on any engineer row with `counts_in_capacity === false` (Capacity
Planning roster, heatmap). Today these are Theoni, Dipak, Antonis, Sailesh (OQ #52).

## 4. `GET /priorities/capacity-fill` (P1 capacity fill, ADR 0036)

`hubs[]`: one `HubP1Fill` per capacity hub, rows and filter as §2.1 / §2.3.

```ts
interface HubP1Fill {
  hub: HubName;                     // a capacity hub
  capacity_weeks: number;           // = hub-load design_capacity_remaining of the same row
  base_load_weeks: number;
  filled_load_weeks: number;
  promoted_count: number;
  members: HubName[];               // NEW. as DesignHubSummary.members
  selected_member: HubName | null;  // NEW
}
```

The Greece walk is one walk over the scored projects of R&D-Greece + OEM-HCK + OEM-Seltek against
Greece's remaining capacity. Matrix rows, Priority board cards, the Workspace score section and the
Matrix export (`suggested_band`, `capacity_fill`, `capacity_fill_reason`) of an OEM project now come
from that walk; their shape is unchanged. The P27 reason-scoping rule is unchanged: figures only to
a caller who has the **project's** hub in scope and can read the Matrix.

## 5. Engineers

### 5.1 `EngineerRead` (`GET /engineers`, `GET /engineers/{id}`, POST, PATCH)

Gains `counts_in_capacity: boolean`.

`GET /engineers?hub_id=<member hub>` lists the capacity hub's engineers (RBAC unchanged).

### 5.2 Writes

- `POST /engineers` body: optional `counts_in_capacity?: boolean` (default `true`). Sending `false`
  requires Admin or Super Admin, else **403 `COUNTS_IN_CAPACITY_ADMIN_ONLY`**.
- `PATCH /engineers/{id}` body: optional `counts_in_capacity?: boolean`. Sending the field at all
  (even unchanged) requires Admin or Super Admin, else **403 `COUNTS_IN_CAPACITY_ADMIN_ONLY`**.
  `null` is a 422. The change is in the `engineer.update` audit row. It does **not** mark any
  project stale: the scheduler books non-counted engineers exactly like counted ones.
- `hub_id` = a member hub (create or move) is **422 `HUB_NOT_CAPACITY_HUB`**. Hub pickers for an
  engineer must offer the four capacity hubs only (`capacity_hub_id == null`).

### 5.3 Work calendars

`PUT /workflow-settings/hub-calendars/{hub_id}` on a member hub is **422 `HUB_NOT_CAPACITY_HUB`**.
`GET /workflow-settings` serves calendars for the four capacity hubs only (the member rows were
deleted by `p29a`). Show the member hubs as "uses R&D-Greece's calendar".

## 6. Projects: provisional leaders (ADR 0042 §7)

`ProjectRead`, `ProjectListItem`, `WorkspaceProject` gain `leader_is_provisional: boolean`.

- `true`: the leader was assigned by the seed or migration `p29a_capacity_hubs` (the least-loaded
  eligible counted R&D-Greece engineer), not by a person. Show a "provisional" badge next to the
  leader in the Workspace and Registration (the client is asked who should lead, OQ #52).
- A `PATCH /projects/{id}` that changes `leader_engineer_id` to a different value sets it `false`.
  Re-sending the same leader, or any other edit, leaves it unchanged. It is not writable directly.

## 7. Engineer heatmap and utilization matrix

- `GET /capacity/engineer-utilization`: `EngineerUtilizationRow` gains `counts_in_capacity: boolean`.
  `hub` is always a capacity hub. A member-hub `hub_id` lists the capacity hub's engineers.
- `GET /capacity/utilization-matrix`: same member-hub resolution; shape unchanged.

## 8. What-if (P29-T06)

Request shapes are unchanged. Behaviour:

- `scenario.add_engineers[].hub` or `scenario.remove_engineer_counts[].hub` = `OEM-HCK` /
  `OEM-Seltek` → **422** with code `INVALID_SCENARIO` (the existing what-if scenario error) and a
  `detail` naming R&D-Greece. `remove_engineers` by id is unchanged.
- `add_projects[].hub` may still be an OEM hub (the project runs the OEM workflow); its design work
  is planned on Greece's counted engineers and counted in the Greece row.
- Responses: `design[]` (estimate), `utilization_before[]` / `utilization_after[]` rows with
  `scope: "hub"`, `additions.designers[]`, `searched_designer_hubs[]`, `touched_hubs[]` and hub
  workings lines are on **capacity hubs only**; no OEM row. A caller scoped to an OEM hub sees the
  Greece rows (aggregate, as §2.5).
- What-if supply sums `counts_in_capacity` engineers only, so its Greece / India figures match the
  Capacity page.
- Project-level rows (`projects[]`, `diff.*`, `new_projects`) keep the project's own hub (may be
  OEM-HCK / OEM-Seltek).

## 9. Exports

`surface=capacity`: one row per capacity hub as §2; `members` is a single text cell,
e.g. `R&D-Greece 3 project(s) 32 wk; OEM-HCK 11 project(s) 55 wk; OEM-Seltek 8 project(s) 44 wk`
(empty on other rows); `selected_member` is empty. `surface=capacity_planning` follows §3.

## 10. Type BC = RC (P29-T04 backend)

- Extractor: workbook type `BC` (and the text variants "Business Continuity", "Business
  Continiuty", "Business Continuation", any case) → `type: "RC"`; `excel_type` keeps the raw code.
- Seed: those 59 projects are `RC`, carry the `regulatory_compliance` tag, and their
  `regulatory_compliance` score is pre-filled with 5 (ADR 0038).
- Migration `p29b_bc_type_regulatory` (existing databases): for the 59 frozen external codes still
  `type = null`, sets `RC`, adds the tag, writes score 5 on that dimension (creating the score row
  if needed), recomputes the cached score under the current rubric, and audits both. `priority`
  and `schedule_stale` are never touched.
- No API shape changes beyond §1.2.

## 11. Figures after a fresh `client_2026` reseed (CURRENT_WEEK 42, greedy run, run-booked load)

| Capacity hub | Counted FTE | Design load (wk) | Capacity year (wk) | Booked year |
|---|---|---|---|---|
| PD-India | 5.75 | 500 | 253.96 | 196.88 % |
| PD-Romania | 5.75 | 138 | 253.00 | 54.55 % |
| R&D-Greece | 2.80 | 131 (own 32 / 3 projects, OEM-HCK 55 / 11, OEM-Seltek 44 / 8) | 124.88 | 104.90 % |
| R&D-India | 2.00 | 201 | 88.33 | 227.56 % |

17 leaderless OEM projects get provisional leaders; 3 projects remain leaderless (non-member hubs).
These load figures use lead-time durations and the run-booked basis; ADR 0041 changes them.
