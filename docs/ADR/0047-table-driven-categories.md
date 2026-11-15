# ADR 0047: Categories become a table, and Admins can add one

## Status

Accepted (2026-11-13), in full since P33-T01. §3 is as amended by R33-7/R33-8 (ADR 0046 ruling).
See "Amendment (P33-T01)" at the end. Part of P33. Amends
ADR 0007 (categories per workflow) and DOMAIN_RULES "Scheduling order" key 5. Contract:
`docs/API_CONTRACT_P33.md` Part B.

## Context

The owner wants "+ Add category" on Workflow templates. The form takes:
- a name;
- a workflow (Standard PDD or OEM);
- an existing category to copy from (its lengths, gaps and engineer eligibility);
- a position in the scheduling order (for example between B and C). *(Note 2026-11-15, P33-T20:
  since ADR 0050, every schedulable live project has a band rank, so the category position is only a
  tie-breaker. See the amendment at the end.)*

Today categories are fixed:
- Postgres enums: `project_category` (A+, A, B, C, A-OEM, B-OEM, C-OEM), used by `projects.category`
  and `workflow_lead_times.category`; and `engineer_allowed_category` (the same plus `OEM`), used by
  `engineers.allowed_categories`.
- The trigger `trg_projects_category_matches_hub`, which keeps OEM categories on OEM hubs.
- The scheduler constants `CATEGORY_RANK`, `PDD_CATEGORIES` and `OEM_CATEGORIES`, and
  `domain_constants.CATEGORY_ORDER`.
- About 33 frontend files using `PROJECT_CATEGORIES` / `CATEGORY_ORDER` (filters, chips, the
  palette, the Matrix, the Dashboard, Registration, the what-if import schema).

## Decision

1. **A `categories` table.**
   - Columns: `code` (text primary key, the wire value, 1..16 characters of `[A-Za-z0-9+\- ]`,
     unique case-insensitively, not `OEM`), `label` (text ≤ 60, default = code), `workflow_id`
     (FK to the workflow, `PDD` or `OEM`), `rank` (int, unique, dense 1..n, the scheduling order),
     `template_version` (int, ADR 0045 §6), `copied_from_code` (nullable), `created_at` /
     `created_by`, and `active` (bool, always true in P33).
   - The migration seeds the seven existing codes with ranks 1..7 in today's order
     (A+, A, B, C, A-OEM, B-OEM, C-OEM). Every stored value is preserved as-is, because the code is
     the key.
   - `projects.category` and `workflow_lead_times.category` become `text` with an FK to
     `categories.code` (ON UPDATE RESTRICT, ON DELETE RESTRICT). The `project_category` enum is
     dropped.
   - `engineers.allowed_categories` becomes `text[]`. A trigger checks each element is a category
     code or the reserved `OEM` (an array cannot carry an FK). The `engineer_allowed_category` enum
     is dropped.
   - `trg_projects_category_matches_hub` is rewritten to compare `categories.workflow_id` with the
     hub's workflow (`hubs.is_oem`). Its behaviour is identical for the seven seeded codes.
   - Downgrade restores the enums. It refuses if any non-seeded category is in use.

2. **Adding a category** (`POST /workflow-templates/categories`, Admin and Super Admin). One
   transaction does the following:
   - Validate the fields: code, label, workflow, `copy_from` (an existing category of the **same**
     workflow) and `insert_after` (an existing code, or `null` = first).
   - Renumber ranks densely so the new category sits right after `insert_after`. The relative order
     of the existing categories does not change.
   - Copy every template row of `copy_from` (`weeks`, `gap_weeks`, `length_set`) to the new code.
   - Extend eligibility: every engineer whose `allowed_categories` contains `copy_from` gets the new
     code appended, with one audit row per engineer (`engineer.allowed_categories_extended`). An
     engineer with the blanket `OEM` already covers a new OEM-workflow category (the CAT_NOT_ALLOWED
     rule is unchanged).
   - Audit `category.created` with the copied template and the new rank order.
   - No project has the category yet. Nothing is marked stale and nothing is solved. Projects get it
     by registration or a category change, which copy its template (ADR 0045 §4).

3. **Scheduling order from data (Proposed, ruling Q8).**
   - `ScheduleInput` gains `categories: tuple[CategoryInput(code, workflow_id, rank), ...]`. Its
     default is today's seven, so every existing caller and golden file is unchanged.
   - Sort key 5 becomes `rank` of the project's category.
   - Validation uses `workflow_id` (a project's category must belong to its workflow). This replaces
     `PDD_CATEGORIES` / `OEM_CATEGORIES` and `CATEGORY_RANK`, which stay as the default only.
   - CP-SAT uses the same rank wherever it uses category order.
   - The canonical / hashed input omits `categories` when equal to the default (I8, I14).
   - Every new run records the category list in `workflow_snapshot["categories"]` (I15). A stored run
     without the key means the seven defaults.
   - **I30 (new):** a run's scheduling order is non-decreasing in the snapshotted category rank among
     projects equal on keys 1–4.

4. **Readers move to the table.**
   - **Backend:** `GET /reference/categories` serves the list (code, label, workflow, rank), with or
     without `hub_id`. Every category filter (P31 multi-select), registration, the what-if
     `add_projects`, plan-import parsing (an exact, case-insensitive match against active codes) and
     the breakdown buckets read the table. `domain_constants.CATEGORY_ORDER` becomes the seed default.
   - **Frontend:** one cached `useCategories()` hook replaces the constants in every file.
     - Chips: existing codes keep their colours. A new code gets a palette slot by rank, so the same
       category always has the same colour.
     - Lists, filters and donuts order by rank.
     - The B-equivalent panel shows the new category against its workflow's reference (B or B-OEM).

5. **Category-keyed logic outside scheduling (checked 2026-11-13).**
   - Prioritisation scores, bands, the P1 capacity fill and VIP do not read category.
   - ADR 0038's backfill is `type` → scoring tags, not category.
   - CAT_NOT_ALLOWED reads `allowed_categories` (extended in §2).
   - The OEM checks move to `workflow_id`. These are `category_allowed_for_hub`, the trigger, the
     plan import's "category does not fit hub" check and the what-if.
   - A new category therefore behaves like its source in everything except its name, its rank and
     its own template from then on.

6. **Out of scope.** Renaming, deactivating, deleting and re-ranking an existing category
   (`OPEN_QUESTIONS.md` #79). The FK and the RESTRICT rules leave room for them.

## Consequences

- Seven enum-typed columns or uses become text plus an FK or trigger. Wire values do not change, so
  old links and exports keep working.
- A category list can grow without code changes. Every surface must handle an unknown-at-build-time
  code (palette, tests).

## Alternatives rejected

- *`ALTER TYPE … ADD VALUE` per new category.* DDL at runtime from an Admin action, with no rank or
  workflow metadata and no removal path.
- *A surrogate integer id as the FK.* Every reader, export and wire value would change for no
  benefit. The code is already the stable natural key.

## Amendment (P33-T01, 2026-11-13)

- **§2, adding a category,** copies `weeks`, `gap_weeks` and `effort_weight_weeks` (R33-2: the
  immutable split weights) from `copy_from`. `length_set` no longer exists (ADR 0046 OR-6).
- **§3 snapshot (R33-7).** `workflow_snapshot["categories"]` is written **only when the list differs
  from the seven defaults**, not on every run. When the key is absent, the run used the defaults.
  This keeps a fresh run straight after p33a/p33b byte-identical, snapshot included.
- **§3 validation (R33-8).** Codes unique; ranks unique integers ≥ 1; each `workflow_id` an input
  workflow; every project's category present and of the project's workflow. Key 5 is the rank value.
  CAT_NOT_ALLOWED's OEM test and the what-if / plan-import category lists read `workflow_id` from
  the input.
- **I30** as stated in the ruling (over `scheduling_order`, greedy and CP-SAT).

## Amendment (2026-11-15, P33-T20 workflow-auditor leg) — what the position means

Since ADR 0050 (P36), the scheduling order has the planner-set `band_rank` (key 3a) before status
and category, and every schedulable live project with a priority has one. The category rank (key 5)
therefore only breaks ties among projects equal on keys 1–4: in practice the unranked What-if and
plan-import projects. A new category placed "between B and C" does **not** make its live projects
schedule between B and C projects. Their order comes from priority and the Priority board. UI and
owner-facing copy must not promise otherwise (contract Part I).
