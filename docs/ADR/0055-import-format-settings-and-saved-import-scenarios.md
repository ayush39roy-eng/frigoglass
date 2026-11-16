# ADR 0055 — Editable import format, hand-picked scenarios, saved and exported import scenarios

- **Status:** Accepted (2026-11-17, orchestrator, owner request). No scheduler change.
- **Amends:** ADR 0044 ("Nothing is persisted") and P32-R05 / API_CONTRACT_P32 C2 ("scenarios are
  session-only").
- **Contract:** `docs/API_CONTRACT_P41.md`.

## Context

The owner asked on 2026-11-17 for three changes to the What-if planner's "Import plan (Excel)":

1. Admin and Super Admin can set and edit the Excel format.
2. The Executive view gets **scenarios**. Variants (P32-R05) are built from rules. A scenario is
   built by hand: the planner **ticks the projects to include** before computing. A scenario can
   be **saved** and **exported**.
3. Scenarios from **different imports** can be compared, and they stay saved for future reference.

Today the header names the parser recognises are hard-coded (`_FIELDS` in
`services/plan_import_xlsx.py`). The variants and the Compare tab live in the browser session only.

## Decision

**D1 — Import format settings.**
- One stored format: the header names (aliases) per known field, in a new table
  `import_format_settings`. It has a single row, an integer `version` and the JSONB
  `field_aliases`. There is no row until the first save, so the built-in `_FIELDS` is the default.
- The parser takes the aliases as an argument, so it stays a pure function. The default argument is
  the built-in set, so existing tests stay unchanged.
- **Edit:** Admin and Super Admin only (`PUT`), with "Reset to default". Every change writes an audit
  row with the before and after alias lists. There are no financial fields.
- **Validation:**
  - only known fields;
  - 1–10 aliases per field, 1–60 characters each, normalised the way the parser does
    (casefold, single spaces);
  - no alias shared by two fields;
  - `name` must have at least one alias, and so must `status` or `hub`;
  - the `version` must match (optimistic lock, 409 on a mismatch).
- **Everyone with What-if access** can read the format and download a blank template `.xlsx`. The
  template uses the first alias of each field as its header row, plus a `Process steps` sheet laid
  out the way the parser reads it.
- **Not in v1** (OQ #104): status value words, hub words and the steps-sheet layout stay as they are
  in code.

**D2 — Hand-picked scenario.**
- A scenario is a set of ticked projects: the file rows (their `include`) and, in merge mode, the
  plan projects.
- An unticked plan project is sent as `exclude_plan_project_ids`. It is taken out of **both** runs
  (before and after), on the same path as an On Hold / Cancelled file row (`without_projects`), so
  the before → after delta compares like with like. Ids are checked against scope; an unknown or
  out-of-scope id gets a 422.
- The KPIs serve the count of excluded plan projects (`kpis.plan_excluded`). The computation is the
  normal `/whatif/import/simulate`. No scheduler or engine change.

**D3 — Saved import scenarios.**
- A new table `whatif_import_scenarios`. Each row stores:
  - the name and an optional note;
  - the import it came from: `source_file_name`, `source_file_sha256`, `imported_at`;
  - the simulate **request** (options, rows, edits, `exclude_plan_project_ids`);
  - the served **response** exactly as returned;
  - the week it was simulated from, the active run version it was compared against, and the
    `hub_codes` it touches.
- **The server recomputes on save.** The client sends the request, and the server re-runs the
  simulation and stores that output, so a browser-supplied result is never persisted. A saved
  scenario is a **frozen record**. "Re-run on today's plan" makes a new unsaved result from the
  stored request.
- **Visibility:**
  - Admin and Super Admin see all saved scenarios.
  - Other users with What-if access see a scenario only when their hub scope covers every one of
    its `hub_codes`. The same rule applies to listing, opening, exporting and comparing.
  - Rename and delete: the creator, Admin or Super Admin.
- **Limits:**
  - 200 saved scenarios per user, and 2,000 in total;
  - a stored request plus response of at most 8 MB;
  - name 1–120 characters, note up to 1,000.
- **Audit:** save, rename, delete and export are audited by id and name. The payloads are not
  logged.
- **What the snapshots contain:** only import-row fields and served schedule fields. Neither has
  customer, TCOGS, margin or price fields. A test asserts that no financial key appears in a stored
  snapshot.
- **Engineers:** engineer names appear inside the snapshot, as they already do in the served
  response. GDPR note: OQ #8 applies. A deleted scenario is deleted for real, with no soft delete.

**D4 — Compare across imports.**
- The Compare tab picks up to 4 scenarios from the session list and from the saved list, whatever
  import each came from. The library groups them by source file and date.
- Every figure is still a served field of a stored response. The delta is the only arithmetic.
- A banner shows when the compared scenarios were simulated from different weeks or plan versions.

**D5 — Export.** All exports are server-side `.xlsx` files built with openpyxl, with formula
injection neutralised (a cell starting with `= + - @` gets a leading `'`):
- `GET /whatif/import/scenarios/{id}/export.xlsx` exports a saved scenario. Its sheets: Summary
  (KPIs, options, source, week), Breakdown (by year × category / hub / priority / status), Projects
  (outcome, finish, leader), Steps (the per-step rows), Capacity.
- `POST /whatif/import/export.xlsx` exports the current unsaved result. The server recomputes from
  the request body.
- `GET /whatif/import/scenarios/compare.xlsx?ids=…` exports up to 4 scenarios: KPI table, deltas,
  and the projects that change outcome.

## Consequences

- DOMAIN_RULES "Plan import into the What-if": "Nothing is persisted" becomes "Nothing in the live
  plan is changed. A saved import scenario is a frozen record (ADR 0055)."
- New migration `p41a_import_format_and_scenarios`.
- Security review: RBAC on the format `PUT`; hub scoping on the scenario list, read, export and
  compare; size caps; xlsx formula injection; audit without payloads.
- The Gate needs qa-inspector, security-auditor and workflow-auditor. For workflow-auditor this is a
  reconciliation only: a saved snapshot's figures equal a fresh simulate of the same request at the
  same week and plan version.

## Gate amendments (P41-R01, 2026-11-17)

- **Visibility (D3, as built).** Who can see a saved scenario:
  - its creator always sees it (security L-2: even after the creator's own scope narrows; accepted);
  - Admin and Super Admin see every scenario (L-3: a hub-scoped Admin would also see every one;
    none exists today);
  - anyone else sees it only when `hub_codes` is non-empty and `hub_codes ⊆ scope`.
- **How `hub_codes` is built.** It is the union of every hub referenced anywhere in the stored
  request and result:
  - project, capacity, designer, weekly, `plan_projects` and `changes` hubs;
  - every request row's hub;
  - matched and excluded project ids;
  - lab regions, mapped to the saver's own hubs in that region;
  - **plus the saver's whole hub scope**.

  An all-hubs saver therefore stores every hub. Migration `p41b` backfills the existing rows to all
  hubs.
- **The list** is paged as `{items, total, limit, offset}` (default 50, max 200) and reads a separate
  `kpis` column. The list and the GET are rate-limited.
- **Exclusions.** An excluded id that the file already removes, or that is no longer schedulable,
  is accepted and counted 0. An unknown or out-of-scope id is still a 422.
- **Erasure (L-4).** Any future erasure feature must also purge saved snapshots (OQ #106).
