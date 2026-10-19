> **Amended 2026-10-19 (OQ #39 answered).** `area` ∈ Greece | India | Romania (= hub `lab_region`, OEM hubs → Greece). Seed: OEM slide → Greece, Europe slide → Romania, India slide → India. `is_vip` only from links on highlighted items. Area tiles also return `vip_items: [{id,title}]` (highlighted, in order). See ADR 0027 amendment.

# API contract — P14 (priority move preview/confirm, VIP board on Dashboard)

ADR 0026 and ADR 0027. Every read is hub-scoped and takes `hub_id` and `region` (ADR 0025). Every
figure is server-side (I9). There are no financial fields and no engineer-level figures.

## 1. Priority move preview (backend A)

### `POST /projects/{id}/priority/preview`

The permission is identical to `POST /projects/{id}/priority`: Registration WRITE, hub-scoped, or
an Admin-level grant. Rate limited through `services/rate_limit.py`.

```jsonc
// request
{ "priority": "P1" | "P2" | "P3" | "P4" | "Q" }
// 200
{
  "result": "preview" | "unchanged" | "not_needed",
  "project_id": "uuid",
  "from_priority": "P4", "to_priority": "P1",
  "baseline_run_id": "uuid|null",          // active run the preview is compared against
  "preview_token": "str",                  // opaque hash of the input snapshot + target priority
  "moved": { "end_week_before": 70, "end_week_after": 38,
             "within_year_before": false, "within_year_after": true,
             "left_out_before": false, "left_out_after": false },
  "summary": { "affected": 7, "delayed": 5, "earlier": 2,
               "pushed_out_of_year": 2, "pulled_into_year": 1 },
  "changes": [                             // other projects only; ordered: pushed_out_of_year, then delay desc, then name
    { "project_id": "uuid", "name": "…", "hub": "PD-India", "priority": "P1",
      "end_week_before": 30, "end_week_after": 34,
      "within_year_before": true, "within_year_after": true,
      "left_out_before": false, "left_out_after": false,
      "blocked_before": false, "blocked_after": false }
  ],
  "hidden_count": 0,                       // affected projects outside caller's scope
  "elapsed_ms": 820
}
```

- **Baseline (amended 2026-10-19 after P14-T03, M2).** The comparison is greedy on the **current**
  inputs against greedy on the current inputs plus the move. It is **not** compared with the stored
  active run, because input drift since that run (for example a freeze) would be blamed on the
  move. `moved.*_before` and `changes[].*_before` come from that in-memory baseline.
  `baseline_run_id` is informational only. Confirm computes its response the same way.
- The preview uses the same snapshot builder and `scheduling.greedy` as the worker. It runs through
  `run_in_threadpool` (or an equivalent) with a time cap. Over the cap → 503
  `PREVIEW_TIMEOUT`.
- When there is no active run, the `*_before` values are null. All projects are then listed as
  affected only if they have an `after` value. Simpler: `changes` = [] and `summary.affected` = 0,
  with a `note`.
- Errors: 409 `HARD_GATE_FORCES_P1`, 404 or 403 as on the move.

### `POST /projects/{id}/priority` (extended)

The request gains an optional `"preview_token": "str"`.

- **Token present and current:**
  - the move is applied, and greedy runs in-process;
  - a `ScheduleRun` is persisted (`trigger_reason="priority_move"`, `solver=greedy`) and activated
    before the response;
  - `recalc_status: "applied"` (a new enum value).
- **The response gains** `changes`, `summary`, `hidden_count` and `moved` (the §1 shapes, computed
  from the persisted runs through `services/run_changes.py`).
- **Token stale** → 409 `PREVIEW_STALE`. Nothing is written.
- **A non-abandoned worker run in flight** → `deferred`, as in ADR 0015.
- **No token** → ADR 0015 behaviour is unchanged.

### Abandoned runs

`run_dispatch.find_in_flight_run` (or a helper it calls) marks `queued` or `running` rows older
than `in_flight_window()` as `failed` with `error_code="ABANDONED"` (or the existing
error-message field). It writes one audit row, `schedule_run.abandoned`.

## 2. VIP board (backend B)

Migration `p14a_vip_items`: tables `vip_items` and `vip_item_projects`. The columns are those of
ADR 0027 §3. FK `parent_id` → `vip_items.id` ON DELETE CASCADE. The join table cascades on both
sides.

### `GET /vip-board?hub_id=&region=`

Permission: `DASHBOARD` READ.

```jsonc
{
  "run_id": "uuid|null",
  "pillars": [ { "key": "INNOVATION", "number": "01", "label": "Innovation",
                 "headline": "Refresh product aesthetics to strengthen differentiation",
                 "impact": ["Differentiation", "Fresh Looks", "value"] } /* ×3 */ ],
  "areas": [
    { "area": "OEM", "label": "OEM", "hubs": ["OEM-HCK", "OEM-Seltek"],
      "item_count": 13, "highlighted_count": 6, "high_risk_count": 0, "linked_project_count": 7,
      "items": [
        { "id": "uuid", "pillar": "MARKET_EXPANSION", "title": "Super-16 for Kazakhstan",
          "status_tag": null, "status_note": null, "highlighted": true, "sort_order": 2,
          "children": [ /* same shape, one level */ ],
          "projects": [ { "id": "uuid", "name": "…", "hub": "OEM-Seltek", "priority": "P3",
                          "status": "In Development", "projected_end_week": 40,
                          "within_year": true, "health": "on_track" } ],
          "hidden_project_count": 0 }
      ] }
  ]
}
```

- Areas are listed in the order OEM, Europe, India. Only areas containing at least one hub in the
  caller's scope that also passes `hub_id`/`region` are returned.
- Projects are filtered to the caller's scope. The rest are counted in `hidden_project_count`.
- The project facts come from the active run, the same source as the Gantt and Priority board.

### Writes (`MATRIX` WRITE; audited `vip_item.create|update|delete|link|unlink`)

- `POST /vip-items` `{area, pillar, title, status_tag?, status_note?, highlighted?, parent_id?, sort_order?}`
- `PATCH /vip-items/{id}` (same fields, partial)
- `DELETE /vip-items/{id}`
- `PUT /vip-items/{id}/projects` `{project_ids: [...]}`
  - Replaces the item's links.
  - Each project must be in scope, and its hub must be in the item's area. Otherwise 422
    `VIP_PROJECT_AREA_MISMATCH`.
  - Afterwards, `projects.is_vip` is recomputed as "linked to any VIP item" for the projects added
    and removed.

### Seed (idempotent, in the seed script / a data step of the migration; matched by area+pillar+title)

`H` means highlighted. Links name the existing project title exactly. A link is skipped silently if
the project is absent.

**OEM**
- INNOVATION:
  - Family Fridge for Commercial Appliances `H`
  - Monster Range:
    - Twin Reach R600a
    - Slim Counter Top R600a with GMC
    - Mini Cube R600a with GMC
- MARKET_EXPANSION:
  - Super-8 CC Kazakhstan TCCC EC 26 (Coke) `H` → "S8 for Kazakhstan"
  - Super-16 for Kazakhstan `H` → "S16 (DD sliding) for Kazakhstan"
  - ERX 3.0 B rating development
  - Beat Box 3D Logo → "BEATBOX 3D LOGO FLEX60", "BEATBOX 3D LOGO PREMIUM SLIM 130"
- PERFORMANCE:
  - IC2-40 Coke Certification `H`
  - FLEX-290 @ K1 & K2 EEI<20 `H` → "FLEX-290 @ K2 for HEINEKEN - Feasibility to define cost & CAPEX for EEI<15 & EEI<20"
  - FLEX-400 B rating K2 & K1 (EEI<20) `H` → "FLEX-400 @ K2 for HEINEKEN - Feasibility to define cost & CAPEX for EEI<15 & EEI<20"
  - IC2-150 with FDEx3
  - Drawer Improvement for Commercial Appliances → "DRAWER MODELS IMPROVEMENTS"

**Europe**
- INNOVATION:
  - IC3-450 [R290] B & A `H` ON_TRACK → "IC3-450 B rating"
  - IC3-900 [R290] B & A
  - UNBOUND Smart Vending Range Development:
    - Omnisense 750 (NU)
    - Shekel – 750 (Shekel) → "Shekel 750"
    - Plus-750 [R290] OV (Vision)
  - Coffee Combo (OMS 750 + Coffee m/c) `H` HIGH_RISK, note "to meet Brau timelines" → "Coffee and vending cooler combo"
- MARKET_EXPANSION:
  - MAX 1200 A COMMERCIALIZED
  - MAX 750 A COMMERCIALIZED
  - Beatbox 3D logo Max 450 COMMERCIALIZED → "Beatbox Max 450 3D logo"
  - Heineken 3D logo Max 450 `H` → "3D Heineken logo on Max 450 B"
  - Sollatek Planogram Camera to Plus-450 `H` ON_TRACK → "Sollatek Planogram Camera to Plus-450"
- PERFORMANCE:
  - RM Savings x 10 projects
  - CRA: Cyber Resilience Act `H` UNDER_INVESTIGATION
  - 3D Logo development (CC, Pepsi, Hell, HNKN, CC)
  - IC3 Options – RGB LED, Padlock, Door blocker `H` TBD → "RGB Neon LED IC3"
  - Huayi VSC – NMS series compressor → "Huaiy NMS070 (700/800/900/1000/750/1200 B)"
  - IoT Controller FDEx2 → FDEx3 DELAYED
  - Field Issues Investigations

**India**
- INNOVATION:
  - India aesthetics upgrade – Frameless-look with edge-light (option) `H` DELAYED, note "Tooling delayed"
  - Reliance aesthetics upgrade proposal `H`
  - TCCC 2028 energy and HNKN 2027 EC targets
- MARKET_EXPANSION:
  - Bar 250 R290 development `H` ON_TRACK
  - CT 50L R600a development `H` AWAITING_APPROVAL, note "HO Approval awaited"
  - S-1000 FFD for India and Africa region `H` DELAYED
  - S-200 R600a for India `H` DELAYED
  - BSL Migration to R290 | New models | Taxi Canopy
  - India plant Expansion: 250K → 325K annual volume
  - S-250 move-in Indonesia `H` COMMERCIALIZED
  - SEA SFC-500 (move-in) & SFC-700 IMPLEMENTED
- PERFORMANCE:
  - BIS License IND (ISI Marking) HIGH_RISK
  - BIS QCO – Component level HIGH_RISK
  - BEE 5-star labelling, report submission by 01st Jan 2027 `H` HIGH_RISK → every R&D-India project whose name starts "BEE star labelling"
  - 79 x Raw-material saving projects
  - Lab accreditation: ISO 17025 (ACCAB & NABL) + Scope addition

The seed sets `is_vip=true` on linked projects. Existing `is_vip` pins that are not linked to any
item are left as they are. The board does not show them. Record their count in MEMORY.

## 3. Frontend

- **Priority move dialog** (`components/shared/priority-move/…`). It is used by:
  - the Priority board drop;
  - the Gantt row and Workspace move control;
  - the Registration form priority change.

  Flow:
  - preview → loading state → summary, plus a table of affected projects (scrollable,
    `scrollLabel`, before → after weeks, a "pushed out of year" emphasis);
  - **Yes, apply** → confirm with the token → show the result. Then invalidate the active-run-backed
    queries.
  - **No** → close. A board drop snaps back.
  - `PREVIEW_STALE` → re-preview automatically once.
  - `deferred` → the existing deferred message.
- **Dashboard "VIP projects" card**, placed near the top, after the KPI cards:
  - three area tiles;
  - a tile opens a dialog in the slide layout (three pillar columns, coloured accents: Innovation
    amber, Market Expansion blue, Performance teal, each with its impact footer);
  - status tags are chips, with HIGH_RISK in the error colour; highlighted items get an accent
    background with AA contrast;
  - an item with one project links to `/projects/{id}` (the Workspace); several open a small
    picker.
  - For `MATRIX` WRITE users, an "Edit" mode lets them add, edit, delete and reorder items and link
    projects (with a project search, using `GET /dashboard/projects?q=`).
- **Navigation:** remove "VIP projects" from the nav. `/vip` redirects to `/`. Delete the VIP
  surface files that are no longer used, and update the nav tests.
