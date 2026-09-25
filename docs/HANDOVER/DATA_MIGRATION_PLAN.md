# Production Data Migration Plan — RPD Web Application (Frigoglass)

**Audience:** the person running the go-live data load (a backend engineer with DB access on the
deploying host) plus the Frigoglass portfolio manager / IT contact who owns the source spreadsheet.

**Status of this document:** this is **P7-T02, plan half only**. It is a plan and a runbook. The
migration itself has **not been executed** and **cannot be executed yet** — see §9 for the exact
list of client inputs still required. Nothing in this document invents Frigoglass data, column
names, or a cutover date; every place that depends on a real client decision is marked.

**This document contains no secrets, credentials, real hostnames, or example real values.**

---

## 1. Scope and premise

### 1.1 What kind of migration this is

Per `docs/OPEN_QUESTIONS.md` #7 and the P5-T05 scope-lock (`docs/MEMORY.md`, 2026-09-01):

> One-way export only (CSV/XLSX). The spreadsheet is **not** a round-trip system of record. There
> is no import contract for v1.

So the production data migration is a **one-time, one-way initial load** of Frigoglass's real R&D /
Product Development portfolio out of the existing spreadsheet and into the Postgres schema, run
once at go-live. It is **not** an ongoing sync, and there is **no** general-purpose Excel import
API or UI — building one is explicitly out of scope for v1 and must not be added under this task.

If a real client answer to OQ#7 later establishes that the spreadsheet stays authoritative during a
transition period (dual-running), this plan is reopened — a repeatable, reconciliation-capable
import is a materially different piece of work than the one-shot load described here.

### 1.2 What is migrated

| Loaded from the client spreadsheet | Target tables |
|---|---|
| Projects (portfolio rows) | `projects` |
| Per-project priority scores (13 dimensions + hard gates) | `priority_scores` |
| Engineers (name, hub, FTE, allowed categories) | `engineers` |
| Lab chambers (code, region, max concurrent, efficiency, weeks/chamber, allowed stages) | `chambers` |

Plus, per project, **14 `project_workflow_steps` rows are generated, not imported** — one per
`workflow_step_templates` row, with `duration_weeks` computed from the step's `base_weeks` and the
project's category multiplier (`domain_constants.duration_weeks`, exactly as `seed_demo_data.py`
already does). The client spreadsheet is not expected to carry per-step data.

### 1.3 What is NOT migrated

- **`workflow_step_templates`** (the 14-step template) and **`hubs`** (the 6 fixed hubs) — these
  are reference data sourced from `backend/domain_constants.py`, not from the client. They are
  seeded by the same mechanism `seed_demo_data.py` uses (`seed_workflow_step_templates`,
  `seed_hubs`) and are identical in every environment.
- **`currency_rates`** — seeded separately by `backend/seed/seed_currency_rates.py` from the
  `EUR=1.0 / USD=1.08 / INR=97` values in `docs/DOMAIN_RULES.md`. Rates are runtime-configurable by
  an Admin post-go-live (P1-T04 / P3); the migration only needs to establish the initial row set.
- **`schedule_runs` / `schedule_run_project_steps` / `schedule_run_project_outcomes`** — there is
  no schedule to import. These are produced by running the scheduler **after** the load (§5 step 7).
  The migration loads only the "live, unscheduled" state: `planned_*_week` on
  `project_workflow_steps` stays `NULL` until the first real solve.
- **`users` / `roles` / role assignments** — provisioned via OIDC/SSO per environment, not from the
  spreadsheet. `backend/seed/seed_dev_users.py` covers dev/staging only. Real user provisioning is
  gated on `docs/OPEN_QUESTIONS.md` #9 (P6-T03 OIDC cutover) and is out of scope here.
- **`audit_log_entries`** — starts empty. The migration is a bulk system load, not a set of
  user-attributed edits; a single "initial data migration, N projects loaded, script vX, operator
  <role>" note may be written into a runbook/CHANGELOG, not into the append-only audit table.
- **Per-step `actual_start_week` / `actual_end_week`** on `project_workflow_steps` — left `NULL`.
  Only `Project.actual_start_week` is populated, and only for `frozen` projects, matching
  `seed_demo_data.py`'s established reasoning (a non-frozen "actual start" in the source is an
  earliest-start scheduling hint, not a real execution record — see the `seed_projects` docstring
  and the P1-T03 `docs/MEMORY.md` entry).

---

## 2. Source → target field mapping

The **left column is the expected spreadsheet concept**, inferred from the prototype's embedded
dataset (`backend/seed/prototype_seed_data.json`) and `docs/DOMAIN_RULES.md`. **The real column
headers, sheet names, and value spellings must be confirmed against the actual Frigoglass file
before the script is finalised** (§9). Where the prototype used a short key, it is shown in
`code font` as a hint to whoever maps the real headers.

### 2.1 Projects → `projects`

| Source concept (prototype key) | Target column | Type / validation | Notes |
|---|---|---|---|
| Project code (`id`, e.g. `26-00200`) | `external_code` | `String(100)`, **unique** | Duplicate codes in the source abort the load. |
| Project name (`name`) | `name` | `String(300)`, required | |
| Hub (`hub`) | `hub_id` | FK → `hubs`; value must be one of `enums.HubName` | `R&D-Greece`, `R&D-India`, `PD-India`, `PD-Romania`, `OEM-HCK`, `OEM-Seltek`. Any other spelling aborts. |
| Leader / lead engineer (`leader`) | `leader_engineer_id` | FK → `engineers` by name; nullable | Must match an engineer row loaded in the same run (§2.3). Unmatched name → **error** (not silent null), unless the cell is genuinely blank. |
| Category (`cat`) | `category` | `enums.ProjectCategory` (`A+`,`A`,`B`,`C`); nullable | Drives step `duration_weeks`. A missing category means steps cannot be sized — flag as a warning and load with `NULL` (matches current model nullability) but list every such project in the report. |
| Type (`type`) | `type` | `enums.ProjectType` (`NM`,`CO`,`RC`,`NO`,`IMP`); nullable | **Client confirmation needed** — this enum was flagged provisional at P1-T01. |
| Priority band (`prio`) | `priority` | `enums.ProjectPriority` (`P1`..`P4`,`Q`); nullable | This is the *committed* band. The suggested band is recomputed into `priority_scores` (§2.2). |
| Status (`status`) | `status` | `enums.ProjectStatus`, required | `In Buyoff`, `Under Industrialization`, `In Development`, `In Queue`, `Commercialized`, `On Hold`, `Draft`. `Commercialized` / `On Hold` are excluded from scheduling (DOMAIN_RULES) but are still loaded. |
| Frozen flag (`frozen`) | `frozen` | `Boolean`, required, default `false` | |
| Actual start week (`actualStart`) | `actual_start_week` | `Integer`, nullable | **Loaded only when `frozen` is true**; else `NULL` (see §1.3). |
| Delay weeks (`delay`) | `delay_weeks` | `Integer`, required, default `0` | Terminal adjustment only (ADR 0004) — not propagated into step starts. |
| Registration year (`regYear`) | `reg_year` | `Integer`, nullable | |
| Carry-over flag (`carryOver`) | `carry_over` | `Boolean`, required, default `false` | |
| Comments (`comments`) | `comments` | `Text`, nullable | Empty string → `NULL`. |
| CAPEX (`capex`, kEUR) | `capex_keur` | `Numeric(12,2)`, nullable | **Not encrypted** (per the P1-T06 security review's accepted scope). |
| RM savings (`rm`, kEUR) | `rm_savings_keur` | `Numeric(12,2)`, nullable | Not encrypted. |
| **Customer name (`customer`)** | `customer_name` | **`EncryptedString`**, nullable | 🔒 Commercially sensitive. Written as a plain value; the ORM column type encrypts on write. Never logged, never echoed to stdout by the script. |
| **TCOGS (`tcogs`, EUR)** | `tcogs_eur` | **`EncryptedNumeric`**, nullable | 🔒 As above. |
| **Selling price (`sp`, EUR)** | `selling_price_eur` | **`EncryptedNumeric`**, nullable | 🔒 As above. |
| **Gross margin (`gm`, %)** | `gross_margin_pct` | **`EncryptedNumeric`**, nullable | 🔒 As above. |

🔒 = one of `models.types.FINANCIAL_FIELD_NAMES` (`tcogs_eur`, `selling_price_eur`,
`gross_margin_pct`, `customer_name`). Encrypted at rest via `EncryptedString` / `EncryptedNumeric`.
The migration script **must not** print these values, write them to a log, or include them in its
run report except as a non-null/null count.

### 2.2 Priority scores → `priority_scores` (one row per project)

The 13 dimension scores each ∈ `[1..5]`, all `NOT NULL`. Target columns, in the prototype's `dims`
array order (this order is load-bearing — it matches `DIMENSION_FIELD_NAMES` in
`seed_demo_data.py`):

`strategic_project`, `new_customer`, `new_options`, `regulatory_compliance`,
`quality_improvements`, `rm_savings`, `total_rm_savings`, `gross_margins`, `profitability`,
`annual_volume`, `three_year_volume`, `new_models`, `capex_investment`.

| Source concept | Target | Validation |
|---|---|---|
| The 13 dimension ratings | the 13 columns above | each an integer `1`–`5`; anything else aborts the row |
| Hard gates (`gates`) | `hard_gates` (array) | each value one of `enums.HardGateReason`: `Regulatory deadline within 6 months`, `Customer certification at risk (Coke/Pepsi)`, `Active safety non-compliance` |
| — | `weighted_score`, `normalized_pct`, `suggested_band` | **computed, not imported** — `weighted_score = Σ(score × weight)` over the `DOMAIN_RULES.md` weights (TOTAL_WEIGHT 280), `normalized_pct = round(weighted_score / 1400 × 100)`, band by the ≥70/≥55/≥40 thresholds. Reuse `seed_demo_data.py`'s `_priority_score_fields` verbatim. |

If the source has no priority data for a project, that is a hard decision point: `priority_scores`
rows are `NOT NULL` on all 13 dimensions. Options, to be confirmed with the client (§9): (a) the
source always has all 13 (verify), (b) default missing dimensions to `1` and flag every such
project, (c) leave the project without a `priority_scores` row (the model allows it —
`Project.priority_score` is nullable) and flag it. Do not guess silently.

### 2.3 Engineers → `engineers`

| Source concept (prototype key) | Target column | Validation |
|---|---|---|
| Name (`name`) | `name` | `String(200)`, required, **must be unique within the run** (it is the join key for `projects.leader_engineer_id` and for step assignment) |
| Hub (`hub`) | `hub_id` | FK → `hubs`; one of `enums.HubName` |
| FTE (`fte`) | `fte` | `Numeric(3,2)`, default `1.0` | 0.5 / 1.0 typical. Note: FTE is **reporting-only**, not applied by the scheduler (ADR 0002). |
| Allowed categories (`cats`) | `allowed_categories` (array) | each one of `enums.EngineerAllowedCategory`: `A+`,`A`,`B`,`C`,`OEM` |

### 2.4 Chambers → `chambers`

| Source concept (prototype key) | Target column | Validation |
|---|---|---|
| Chamber code (`id`, e.g. `GR-CH1`) | `code` | `String(50)`, **unique** |
| Lab region (`labHub`) | `lab_region` | one of `enums.LabRegion`: `Greece`, `India`, `Romania` |
| Max concurrent (`max`) | `max_concurrent` | `Integer`, required — the only field that actually gates booking |
| Platforms (`plat`) | `platforms` | `Integer`, default `1` |
| Efficiency (`eff`) | `efficiency` | `Numeric(4,3)`, default `1.0` — **reporting-only** (ADR 0003) |
| Weeks per chamber (`wksCh`) | `weeks_per_chamber` | `Numeric(6,2)`, default `0` — **reporting-only** (ADR 0003) |
| Allowed stages (`stages`) | `allowed_stages` (array of step-letter codes, e.g. `F`,`H`,`J`,`L`) | must be valid step identifiers; a lab step is only booked to a chamber whose `allowed_stages` contains it (Invariant I4) |

---

## 3. The migration mechanism

### 3.1 Decision: a dedicated script, built on the existing `backend/seed/` infrastructure

The migration reuses the exact pattern `backend/seed/seed_demo_data.py` already establishes:
async SQLAlchemy engine from `RPD_DATABASE_URL`, `--reset` guard against double-loading, FK-safe
insert order (templates → hubs → engineers → chambers → projects → per-project steps + score),
post-commit re-query of real row counts rather than trusting in-memory tallies, and letting the
`EncryptedString`/`EncryptedNumeric` column types handle financial-field encryption automatically
(never hand-encrypting).

### 3.2 Decision: the script is SPEC'd here, not implemented, and why

**This document specifies `backend/seed/migrate_production_data.py`; it does not implement it.**
This is a deliberate call on the merits, not only because execution is client-blocked:

1. The script's input contract is a **validated JSON file** produced from the client XLSX by a
   documented offline conversion step (§3.3). The shape of that JSON — which columns exist, how
   multi-value cells (allowed categories, hard gates, chamber stages) are delimited, how blanks vs.
   zeros are distinguished, whether financial figures are already in EUR — is **determined by the
   real spreadsheet**, which does not exist in this repo. Implementing the parser now would mean
   hard-coding guesses about Frigoglass's real headers that a future engineer would have to unpick.
2. `seed_demo_data.py` is already a complete, tested worked example of every non-trivial part
   (encryption via column type, category-multiplier step sizing, `_priority_score_fields`,
   `--reset` guard, verified row-count report). The production script is that file with (a) the
   input swapped from the bundled `prototype_seed_data.json` to the operator-supplied validated
   JSON, (b) `--dry-run` added, (c) the per-field validation in §2 enforced with a collected error
   report instead of a raw `KeyError`/`ValueError` on the first bad cell.

When the real file and column dictionary arrive (§9), implementing the script is a small, bounded
`backend-builder` task against this spec, with hermetic tests mirroring
`backend/tests/test_seed_scripts.py`.

### 3.3 Offline XLSX → validated JSON conversion (the step before the script runs)

A short, throwaway, human-run conversion — **not** committed as a product feature — turns the
client's `.xlsx` into the JSON the script consumes:

1. Open the client file. Identify the sheet(s) for projects, engineers, chambers, and (if
   separate) priority scores.
2. Map each real column header to the target field in §2. Record this mapping in the go-live
   runbook (it is the audit trail for what came from where).
3. Emit a single JSON object with top-level keys `projects`, `engineers`, `chambers` (each an
   array of objects keyed by **target column name**, not the spreadsheet header). Multi-value
   fields (`allowed_categories`, `hard_gates`, `allowed_stages`) as JSON arrays. Blank cells as
   `null`, not `""` or `0`.
4. Do **not** transform financial values beyond currency-normalising to EUR if the source is in
   another currency (record the rate used). The values stay in the JSON as plain numbers; the
   script encrypts them on write.
5. Keep this JSON file **out of the repo** and **off shared storage** — it contains unencrypted
   customer names and margins. Delete it from the deploying host after the load is verified.

### 3.4 `backend/seed/migrate_production_data.py` — behaviour spec

```
RPD_DATABASE_URL=postgresql+asyncpg://…  \
RPD_FIELD_ENCRYPTION_KEY=<Fernet key>    \
    python -m seed.migrate_production_data --input /path/to/validated.json [--dry-run] [--reset]
```

- **`--dry-run`** — parse and validate the entire input, resolve every FK (hub names, engineer
  names, enum values), compute every derived field, and print the full run report (§4) **without
  opening a write transaction**. Exit non-zero if any row fails validation. This is mandatory
  before the real run.
- **default (no `--dry-run`)** — refuses to run if any target table (`projects`, `engineers`,
  `chambers`, `priority_scores`, `project_workflow_steps`) already has rows, unless `--reset` is
  given (same guard as `seed_demo_data.py._guard_against_duplicate_seed`). Loads everything in one
  transaction: partial failure rolls back to zero rows, never a half-load.
- **`--reset`** — deletes rows from every table it writes, FK-safe order, before loading. For
  re-running after a failed/rejected load only. On a system that already has real user edits or
  schedule runs, `--reset` is **not** the rollback path — restore from the pre-migration backup
  instead (§4.4).
- **validation** — collect **all** row errors before aborting (don't stop at the first), print
  them grouped by table with the source `external_code`/name, then exit non-zero having written
  nothing. Enum mismatches, duplicate unique keys, unresolvable leader names, out-of-range
  dimension scores, and unknown hub/region values are all hard errors. Missing category and
  missing-priority-data are **warnings** listed in the report (see §2.1 / §2.2).
- **encryption** — financial fields assigned as plain values on the model; `EncryptedString`/
  `EncryptedNumeric` encrypt via `process_bind_param`. The script must fail fast and loud if
  `RPD_FIELD_ENCRYPTION_KEY` is unset (do not load financial data unencrypted).
- **output** — a JSON report to stdout (§4). Financial fields appear only as
  `"<field>_non_null": <count>`. No customer name, margin, price, or TCOGS value is ever printed.
- **step generation** — after each project row, generate its 14 `project_workflow_steps`
  (`step_template_id`, `sequence_order`, `duration_weeks` via
  `domain_constants.duration_weeks(base_weeks, category)`), identical to `seed_projects`. If the
  project's category is `NULL`, skip step generation for it and add it to the report's warnings
  (it cannot be scheduled until an Admin sets the category post-load).

---

## 4. Validation and acceptance

### 4.1 Pre-load checks (block the load if any fail)

- `alembic current` shows the schema at `head` on the target database.
- `RPD_FIELD_ENCRYPTION_KEY` resolves (the same key that will be used forever after — losing it
  makes the financial columns permanently unreadable; see `docs/HANDOVER/BACKUP_RESTORE.md` §2).
- Target tables (`projects`, `engineers`, `chambers`, `priority_scores`,
  `project_workflow_steps`) are empty.
- `workflow_step_templates` has 14 rows and `hubs` has 6 (seed reference data already loaded).
- `--dry-run` exits 0 with zero validation errors.
- The column-header → target-field mapping (§3.3 step 2) has been reviewed by the Frigoglass
  portfolio manager who owns the source file.

### 4.2 Post-load checks (acceptance criteria)

1. **Row counts** — `projects`, `engineers`, `chambers`, `priority_scores` counts match the
   source (the report's `_verified_from_db` block, re-queried from the DB, equals the input array
   lengths). `project_workflow_steps` count == `projects with a non-null category` × 14.
2. **Field-level spot check** — pick 5 projects spanning different hubs, categories, frozen/not,
   and gated/not. For each, compare every §2.1 field against the source file by hand, including
   decrypting the 4 financial fields (`psql` + `Fernet`, or a one-off read through the ORM) and
   confirming they match the source figures.
3. **Encryption at rest** — a raw `psql` `SELECT customer_name, tcogs_eur FROM projects LIMIT 5`
   returns ciphertext (Fernet base64 tokens), **not** readable names/numbers. This is the same
   check `security-auditor` runs in the phase gates.
4. **Invariant-safe schedule** — run the greedy scheduler once against the loaded data
   (`backend/scheduling/`, via the normal Celery `solver-worker` path — not inside FastAPI) and
   confirm the invariant validator reports **0 violations** for I1–I10. A load that produces a
   schedule with invariant violations means the input data is internally inconsistent (e.g. a lab
   step whose only candidate chamber's `allowed_stages` excludes it) — investigate before go-live.
5. **No PII / financial values in logs** — grep the migration run's captured output and the
   `api`/`worker` logs from the first schedule run for any of the 4 financial field values from
   the spot-check set. Zero hits.
6. **Cross-surface reconciliation** — load the Dashboard and Capacity surfaces as a
   Portfolio-Manager-role user and confirm the within-year count, per-hub design load (I6), and
   per-hub lab load (I7) reconcile with an independent re-derivation from `DOMAIN_RULES.md` (this
   is `workflow-auditor`'s standard check; fold it into the go-live gate).

### 4.3 The run report (script stdout, archived in the go-live runbook)

```jsonc
{
  "input_file_sha256": "…",
  "dry_run": false,
  "loaded": { "engineers": N, "chambers": N, "projects": N,
              "priority_scores": N, "project_workflow_steps": N },
  "_verified_from_db": { "engineers": N, "chambers": N, "projects": N,
                         "priority_scores": N, "project_workflow_steps": N },
  "financial_fields_non_null": { "customer_name": N, "tcogs_eur": N,
                                 "selling_price_eur": N, "gross_margin_pct": N },
  "warnings": [
    { "external_code": "…", "issue": "no category — steps not generated" },
    { "external_code": "…", "issue": "no priority data — priority_scores row skipped" }
  ]
}
```

### 4.4 Rollback

- **Before any real user activity** (the load is the very first thing done post-deploy): rerun
  with `--reset`, or `TRUNCATE` the five tables FK-safe, fix the input, reload.
- **After the system has any real user edits or schedule runs**: do **not** use `--reset`. Restore
  the whole database from the **pre-migration backup** taken in §5 step 4, per
  `docs/HANDOVER/BACKUP_RESTORE.md` §3, then retry the load from a corrected input.
- The decision point between the two is: "has anyone logged in and changed anything, or has a
  schedule been run and activated, since the load?" If yes → backup restore. If no → `--reset`.

---

## 5. Cutover runbook

Ordered. Steps 1–2 are owned by the Frigoglass portfolio manager / IT; 3 onward by the engineer
running the load.

1. **Freeze the source spreadsheet.** Announce a cutover time. After it, no more edits to the
   spreadsheet — it becomes a historical artifact. (If OQ#7 comes back saying the spreadsheet
   stays authoritative for a transition, stop here — this plan doesn't cover dual-running.)
2. **Export + hand over.** Portfolio manager exports the frozen spreadsheet and provides it, plus
   a column dictionary (what each column means, units, how multi-value cells are delimited), to
   the migration engineer over an approved internal channel.
3. **Deploy the stack** at schema `head` per `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` §4 (through
   step 4 "Verify"). Seed reference data (`seed_workflow_step_templates`/`seed_hubs` via whatever
   mechanism the deploy uses; `seed_currency_rates`). Do **not** seed demo data.
4. **Take a pre-migration backup.** Trigger the `pg_dump`-to-MinIO backup (or a manual `pg_dump`)
   and confirm it landed, per `docs/HANDOVER/BACKUP_RESTORE.md` §2–3. This is the rollback anchor.
5. **Convert** the XLSX to validated JSON (§3.3). Review the header mapping with the portfolio
   manager. Keep the JSON on the deploying host only.
6. **Dry run.** `python -m seed.migrate_production_data --input … --dry-run`. Resolve every
   validation error and every warning (decide category/priority-gap handling per §2). Re-run until
   it exits 0 and the warnings list is understood and accepted.
7. **Real load.** `python -m seed.migrate_production_data --input …`. Archive the run report.
8. **Validate** — every check in §4.2. Any failure → rollback decision per §4.4.
9. **First real schedule.** Run the greedy scheduler via `solver-worker`, review the invariant
   report (0 violations) and the within-year list, activate the run.
10. **Sign-off.** Portfolio manager confirms the spot-checked projects and the Dashboard
    within-year count look right against their knowledge of the portfolio. Delete the validated
    JSON file from the host. Record the load (date, script version, input file SHA-256, operator,
    row counts) in the go-live runbook.
11. Proceed to the P7-T04 final gate.

**Rollback decision point:** between steps 8 and 9. Once step 9 activates a schedule run, rollback
means a backup restore (§4.4), not a `--reset`.

---

## 6. Hard constraints honoured by this plan

- No `backend/scheduling/` file is touched or specified — the scheduler is run as-is, post-load.
- Financial fields stay encrypted at rest via the existing column types; the script never
  hand-encrypts and never logs/prints them.
- No raw SQL string interpolation — all writes via the ORM models.
- No general-purpose Excel import endpoint or UI (P5-T05 scope-lock).
- No secrets, real hostnames, or fabricated client data in this document.
- The migration writes nothing to the append-only `audit_log_entries` table.

---

## 7. Deviations / judgment calls

- **Script spec'd, not implemented** — §3.2. Correct on the merits (input shape depends on the
  real file) and unavoidable anyway (execution is client-blocked). Implementation is a bounded
  follow-up for `backend-builder` once §9 is satisfied.
- **`audit_log_entries` left empty** for the bulk load rather than synthesising a migration event
  per row — a bulk system import is not a user-attributed edit, and the append-only table's
  integrity guarantees are about user actions. A single free-text note in the runbook/CHANGELOG is
  the right record.
- **Category-missing projects are loaded without their 14 steps** rather than blocked — the model
  allows a `NULL` category and a project with no steps; blocking the whole load on one bad row
  would be worse. They are surfaced loudly in the report so an Admin fixes them before they matter.

---

## 8. Open dependencies — this migration cannot execute until

1. **`docs/OPEN_QUESTIONS.md` #7** — a real client answer confirming the spreadsheet is retired at
   cutover (one-shot load) vs. stays authoritative during a transition (this plan reopens).
2. **The real source spreadsheet** + a column dictionary from the Frigoglass portfolio manager.
   Everything in §2's left column is currently inferred from the prototype, not confirmed.
3. **Confirmation of the real rosters** — the actual engineers (names, hubs, FTE, allowed
   categories) and chambers (codes, regions, max concurrent, allowed stages) for the 6 hubs. The
   prototype's 46-project / handful-of-engineers dataset is demo data, not the real portfolio.
4. **`docs/OPEN_QUESTIONS.md` #8** — DPO / works-council sign-off, **if** the engineer roster
   loaded here is treated as GDPR personal data on EU employees. The migration loads engineer
   names either way (they are needed as the scheduling entities); #8 governs what the app may then
   *show/export* about named-engineer load, which is already handled server-side.
5. **`docs/OPEN_QUESTIONS.md` #9 / P6-T03** — real OIDC cutover, so real users can log in to do
   the step-10 sign-off and the P7-T01 UAT that should precede go-live.
6. The **`ProjectType` enum** (`NM`/`CO`/`RC`/`NO`/`IMP`) confirmed against the client's real
   project-type vocabulary (flagged provisional since P1-T01).

---

**Related documents:** `docs/HANDOVER/DEPLOYMENT_RUNBOOK.md` (stack stand-up — steps 3 of §5),
`docs/HANDOVER/BACKUP_RESTORE.md` (§2–3 — the pre-migration backup and the rollback restore),
`backend/seed/seed_demo_data.py` (the worked-example the production script is modelled on),
`docs/DOMAIN_RULES.md` (every enum, weight, multiplier, and invariant referenced here),
`docs/OPEN_QUESTIONS.md` (#7 / #8 / #9 — the blocking dependencies), `docs/ADR/0002`–`0004`
(FTE / chamber efficiency / delay — why several imported fields are reporting-only).
