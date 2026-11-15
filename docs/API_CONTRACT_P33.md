# API contract — P33: category template editing, apply rules, categories table, timing editing retired

Final at P33-T01 (2026-11-13). Sources: ADR 0045 (editing, apply, permissions), ADR 0046
(per-project copy and gaps, with the workflow-auditor's ruling R33-1..R33-12 and the owner's ruling
OR-1..OR-6), ADR 0047 (categories table) and ADR 0048 (per-project timing retired). The rules are in
DOMAIN_RULES "Category templates, apply rules, categories table". Where this contract and
DOMAIN_RULES disagree, DOMAIN_RULES wins and the contract is fixed. **There is no pin:**
`length_pinned` and `length_set` do not exist (OR-6).

All bodies are Pydantic v2 strict (`extra="forbid"`; ints never accept strings or bools). Errors use
the existing `{code, message}` shape. All writes are audited and never log financial fields.

---

## Part A — Permissions (ADR 0045 §7)

- New RBAC surface `workflow_templates`:

  | Role | `workflow_templates` | `workflow_settings` |
  |---|---|---|
  | Super Admin | RW | RW |
  | Admin | **RW** | R |
  | everyone else | — | — |

- `GET /me` → `permissions.workflow_templates = {read, write}` is added. Nothing else in `/me`
  changes.
- **Write endpoints that need `workflow_templates.write`:** `POST /workflow-templates/timeline-preview`,
  `POST /workflow-templates/apply-preview`, `POST /workflow-templates/apply` and
  `POST /workflow-templates/categories`. The two previews are writes-in-preparation, so they also
  require write: a reader has no use for them, and this keeps project lists to the editors.
- **Read endpoints that need `workflow_templates.read` OR `workflow_settings.read`:**
  `GET /workflow-settings` (as today) and `GET /workflow-settings/category-timelines` (extended, C2).
- `workflow_settings.write` (Super Admin) still guards steps / precedence, hub calendars and
  chambers. It no longer guards lead times (retired endpoint, Part G).

## Part B — Categories (ADR 0047)

### B1. `GET /reference/categories[?hub_id=]`

The response changes from a list of strings to a list of objects:

```json
[{"code": "A+", "label": "A+", "workflow_id": "PDD", "rank": 1},
 {"code": "B2", "label": "B2 (light refresh)", "workflow_id": "PDD", "rank": 4}, ...]
```

- Ordered by `rank`.
- With `hub_id`: only the categories of that hub's workflow; 404 for an unknown hub, as today.
- Without it: all categories.
- Readable by every authenticated role (it is reference data). Nothing hub-scoped is in it.
- **Breaking change.** The frontend is the only consumer and moves in P33-T11. There is no
  versioned alias.

### B2. `POST /workflow-templates/categories`

```json
{"code": "B2", "label": "B2 (light refresh)", "workflow_id": "PDD",
 "copy_from": "B", "insert_after": "B"}
```

- **`code`:** 1..16 characters, `^[A-Za-z0-9+\- ]+$`, trimmed. It must be unique
  case-insensitively and must not be `OEM`. Otherwise 422 `BAD_CATEGORY_CODE`, or 409
  `CATEGORY_EXISTS` for a duplicate.
  *(Ruling 2026-11-15, T11 deviation.)* A `code` longer than 64 characters is rejected by the
  schema's bound with the app's generic schema 422 (FastAPI `detail` list, no `code` field), before the domain check. 17..64
  characters still give `BAD_CATEGORY_CODE`.
- **`label`:** optional, ≤ 60 characters, defaults to `code`.
- **`copy_from`:** must exist and belong to `workflow_id`, else 422 `BAD_COPY_SOURCE`.
- **`insert_after`:** an existing code (any workflow), or `null` for first place. Otherwise 422
  `BAD_POSITION`.
- **201 response:** `{"category": {...B1 object}, "categories": [...the full ordered list],
  "template_rows": 14, "engineers_extended": 7}`.
- **Side effects (one transaction):**
  - ranks renumbered densely;
  - 14 template rows copied (`weeks`, `gap_weeks`, `effort_weight_weeks`);
  - `template_version = 1`;
  - engineers whose `allowed_categories ∋ copy_from` get `code` appended;
  - audit `category.created` (`after`: category, copied rows, rank list) and one
    `engineer.allowed_categories_extended` per engineer (before/after lists only).
  - Nothing is marked stale and no run is dispatched.
- Rate limit: 10 per minute per user (429 `RATE_LIMITED`).

### B3. Category validation everywhere

Every place that accepted the `ProjectCategory` enum validates against `categories.code`. Unknown
values give 422 with the same codes as today. This covers:
- the P31 repeatable `category` filters;
- registration and project PATCH;
- the what-if `add_projects`;
- plan-import parsing (exact match, case-insensitive);
- engineer `allowed_categories` (codes ∪ {`OEM`}).

A category of the wrong workflow for the hub gives 422 `CATEGORY_NOT_FOR_HUB`, as today (trigger and
service).

## Part C — Template read

### C1. `GET /workflow-settings`

Each `lead_times[]` entry gains `gap_weeks` (int) and `effort_weight_weeks` (int, read-only: it is
never accepted in any request). A new `categories` key holds the B1 list, and each category carries
a `template_version`. Nothing is removed.

### C2. `GET /workflow-settings/category-timelines`

Each step gains:
- `gap_weeks`, `effective_gap_weeks` (signed ints);
- `flags` (subset of `["same_leader_serialised", "anchor_clamped", "gap_ignored_zero_length"]`);
- `predecessor_ids`.

`start_week` and `duration_weeks` are produced by `scheduling.template_timeline` (Part F3), not by
the old service walk. Each category carries `workflow_id`, `rank`, `template_version` and `label`.
With all gaps 0 and no design∥design overlap, every start and duration equals today's.

## Part D — `POST /workflow-templates/timeline-preview`

Stateless and side-effect free. The editor calls it after each ± click (debounced 150 ms; the UI
moves the clicked bar optimistically until the reply).

```json
{"workflow_id": "PDD", "category": "A",
 "steps": [{"step_id": "PDD-E", "weeks": 7, "gap_weeks": -2}]}
```

- `steps` lists only the overridden steps; the others take the saved template values.
- Validation: weeks 0..104; gap −104..104; a non-zero gap on the workflow's first step gives 422
  `FIRST_STEP_GAP`; an unknown step or a step of another workflow gives 422 `BAD_STEP`; an unknown
  category or one of the wrong workflow gives 422.
- **200 response:** one C2 category object computed with the overrides, plus `changed_step_ids`.
- Rate limit: 120 per minute per user.

## Part E — Apply

### E1. Change set (shared by E2 and E3)

```json
{"changes": [
   {"workflow_id": "PDD", "category": "A", "base_version": 3,
    "steps": [{"step_id": "PDD-E", "weeks": 7}, {"step_id": "PDD-H", "gap_weeks": -2}]}
 ]}
```

- One entry per (workflow, category), at most 20 entries.
- Each step carries `weeks` and/or `gap_weeks`; at least one of them must differ from the saved
  value, else 422 `NO_CHANGE`.
- Validation is the same as Part D.
- A `base_version` that does not match the current `template_version` gives 409
  `TEMPLATE_CHANGED`, with the current versions in the body.

### E2. `POST /workflow-templates/apply-preview`

Body: the E1 change set. No writes. Rules: DOMAIN_RULES §C (R33-10 stage rule) and OR-4 (own
effort).

```json
{"categories": [{"workflow_id": "PDD", "category": "A", "timeline": {...C2 object}}],
 "counts": {"automatic": 41, "choosable": 12, "own_effort": 30, "never": 18},
 "automatic": [{"project_id": "…", "name": "…", "hub": "PD-India", "status": "In Queue",
                "steps": [{"step_id": "PDD-E", "eff_before": 4, "eff_after": 5,
                           "gap_before": 0, "gap_after": 0, "flags": []}]}],
 "choosable": [{"project_id": "…", "name": "…", "hub": "R&D-Greece", "status": "In Development",
                "current_stage": {"step_id": "PDD-D", "name": "Final Technical Brief & Project Kick-off",
                                  "status": "In Progress"},
                "steps": [ ...same shape, only the not-reached changed steps... ]}],
 "own_effort": [{"project_id": "…", "name": "…", "hub": "…", "status": "…",
                 "step_ids": ["PDD-E"], "kinds": ["design"],
                 "reason": "own_effort_length_not_applied"}],
 "never": [{"project_id": "…", "name": "…", "hub": "…",
            "reason": "frozen" | "cancelled" | "commercialized" | "reached_stage",
            "step_ids": ["PDD-E"]}]}
```

- **Lists:**
  - `automatic` / `choosable` list every step whose `eff` or `g` changes for that project (R33-11).
  - A step can be in a project's `steps` with only its gap changing while its length is not applied
    (own effort). That step carries the flag `own_effort_length_not_applied` and
    `eff_before == eff_after`.
  - A project whose only receivable changes are own-effort lengths is in `own_effort`, not in
    `automatic` / `choosable`. Nothing is written to it.
- **Step flags** (subset of): `revived` (eff 0 → > 0), `skipped_now` (eff > 0 → 0),
  `gap_ignored_skipped` (the step is skipped for this project, so its gap has no effect),
  `cert_off_no_effect` (a lab length on a project with certification testing off),
  `own_effort_length_not_applied`.
- **Fields:**
  - `current_stage` is the stage with the lowest `sequence_order` among those In Progress / Blocked,
    else the last Done stage.
  - `eff_before` / `eff_after` are DOMAIN_RULES §B values as the server computes them.
- **Only changed copies are listed** *(ruling 2026-11-15, T10)*. A project appears in `automatic`
  or `choosable` only if E3 would write at least one value that differs from its current copy, or
  if it has an own-effort length not applied. A project whose copy already equals the new values
  has nothing to receive and is not listed or counted. This is consistent with I31 (only written
  pairs are audited) and with R33-11.
- **Rate limit** *(ruling 2026-11-15, T10)*: 30 per minute per user (429 `RATE_LIMITED`). It reads
  every project of the categories. No lock, no write, no audit.
- **Ordering and scope:** projects are ordered by name, then id. Lists are not paginated
  (≤ 330 projects). `hub_scope_filter` is applied (only global roles can call today).
- **Never served:** financial fields and engineer names.

### E3. `POST /workflow-templates/apply`

```json
{ ...E1 change set...,
  "selection": {"mode": "all_not_reached" | "selected" | "none",
                "project_ids": ["…"]},
  "reason": "optional text ≤ 500"}
```

- `project_ids` is required and non-empty only for `selected`, and must be empty otherwise (422).
- An id that does not exist in scope gives 422 `BAD_PROJECT`.
- An id that is no longer choosable (for example it has since reached the stage) is **not** an
  error: it is reported in `not_applied`.
- **Server order (one transaction):**
  1. lock the category rows **`FOR NO KEY UPDATE`** in code order and check `base_version`
     *(ruling 2026-11-15, T10 deviation)*. Only `template_version` changes. A full `FOR UPDATE`
     would conflict with the `FOR KEY SHARE` FK checks of concurrent project writes and could
     deadlock;
  2. lock the projects of the affected (workflow, category) pairs `FOR UPDATE` in `project_id`
     order. The stage PATCH and the check-in paths take the same project row lock (R33-10);
  3. evaluate the stage rule and `ownEffort` under the lock;
  4. write the template (`weeks`, `gap_weeks`) and `template_version += 1`;
  5. write a `template_changes` row (id, at, actor, reason, changes before/after, selection);
  6. write the per-project copies: `plan_gap_weeks` on every receiving pair, and `plan_weeks` only
     on receiving pairs with `¬ownEffort(p, kind(S))`; `template_change_id` on every written pair.
     **No `effort_weeks` is written and nothing is re-derived (R33-2);**
  7. set `schedule_stale` on the changed projects;
  8. write the audit rows: `workflow_template.applied` (summary: change id, changes, selection mode,
     and the automatic / selected / own-effort / never / not-applied id lists with reasons) and one
     `project.template_applied` per changed project (before/after per written field);
  9. commit;
  10. dispatch the greedy run with the priority-move lifecycle (`dispatch_greedy`,
      `trigger_reason="template_apply"`, coalesced follow-up per ADR 0023). It is `not_needed` when
      no schedulable project's copy changed.
- **200 response:**
  ```json
  {"template_change_id": "…", "versions": [{"workflow_id": "PDD", "category": "A", "template_version": 4}],
   "applied": {"automatic": 41, "selected": 9, "own_effort_not_applied": 30},
   "not_applied": [{"project_id": "…", "reason": "reached_stage" | "not_choosable"}],
   "recalc_status": "queued" | "deferred" | "not_needed",
   "schedule_run_id": "…" | null, "task_id": "…" | null}
  ```
- **Registration and category change take the category row `FOR SHARE`** *(ruling 2026-11-15)*.
  `FOR SHARE` conflicts with the apply's `FOR NO KEY UPDATE`, so a project registered into, or moved
  into, a category serialises with an apply. It either copies the pre-apply template and is then
  seen and locked by the apply, or it copies the post-apply template. This closes the residual race
  T10 documented.
  - **Lock order** (deadlock freedom; P33-T20 workflow leg): the band-rank lock first (R36-8),
    then the category row `FOR SHARE`, then project rows. The category row `FOR SHARE` is also taken
    on every figure-cleared path (the re-copy of OR-5) and always before project-row locks:
    - `PATCH /projects/{id}` whenever effort inputs change (and on a category change);
    - the register batch;
    - unfreeze;
    - `rederive_all_projects`;
    - inside `rederive_project_effort`.
  - The apply takes the categories, then the projects in id order. The stage PATCH and check-in
    take only project rows.
- Rate limit: 6 per minute per user (429). This is the S32-M2 lesson: every apply starts a
  portfolio run.

### E4. Registration, category change, effort figure edits (no new endpoint)

- `POST /projects` (registration) copies the category template into the new project's 14 step rows
  (`plan_weeks = weeks`, `plan_gap_weeks = gap_weeks`). An entered effort figure is split over
  `effort_weight_weeks` (R2) and governs its kind.
- `PATCH /projects/{id}` with a new `category`, or a hub move that changes the workflow, re-copies
  weeks and gaps onto the not-reached steps (R33-10). It re-derives effort (R6, new category's
  weights) and sets stale.
- A `design_effort_weeks` / `lab_effort_weeks` edit that **clears** a figure (kind loses own effort)
  re-copies the current template `weeks` onto the not-reached steps of that kind in the same
  transaction (OR-5). This replaces OQ #77's unpin control.
- Each of these writes `project.updated` with the per-step copy before/after.

## Part F — Scheduler (algorithm-engineer) and the input builder (backend-builder)

### F1. Inputs (`backend/scheduling/types.py`)

```python
@dataclass(frozen=True)
class StepTimingInput:
    step_id: str
    duration_override_weeks: int | None   # live: the effort merge only (R33-9); scenarios: an edit
    start_not_before_week: int | None     # live: always None (ADR 0048); what-if / plan import only
    overlap_weeks: int = 0                # ADR 0043; live: −plan_gap when < 0
    wait_weeks: int = 0                   # NEW: live: plan_gap when > 0; 0..104
    lead_weeks: int | None = None         # NEW: per-project lead (F4); None = the input table; 0..104

@dataclass(frozen=True)
class CategoryInput:                      # NEW, ADR 0047
    code: str
    workflow_id: str
    rank: int

ScheduleInput.categories: tuple[CategoryInput, ...] = default_categories()   # today's seven
```

- **Evaluation (R33-1):** `lead = lead_weeks ?? table`; `eff = 0` if `lead = 0` or (lab ∧ cert
  off); else `override ?? lead`.
- **Validation (R33-4, R33-8; T05 ruling 4):** `ValueError` for `overlap_weeks > 0 ∧ wait_weeks > 0`,
  for a non-zero gap on a first step, for a duplicate code or rank, for a rank < 1, for an unknown
  `workflow_id` **(checked on non-default lists only)**, and for a project category missing or of
  another workflow (checked unconditionally, so an absent workflow is unusable anyway).
- **Canonical / hashed form (R33-7):** a step timing row is kept only if it carries a non-null
  duration or floor, a non-zero `overlap_weeks` / `wait_weeks`, or a non-null `lead_weeks`.
  `wait_weeks` / `lead_weeks` keys appear only when non-default. `categories` is omitted when equal
  to the default; `workflow_snapshot["categories"]` likewise. `services/priority_preview._canonical`
  stops using `dataclasses.asdict` and uses the canonical forms. Golden files stay byte-identical.

### F2. Semantics

DOMAIN_RULES §D exactly, in greedy, CP-SAT (`start ≥ pe + w` per release term),
`unconstrained_end_week` (with the one-leader rule, R33-6), Monte Carlo (samples durations only;
the R10 floor applies to `lead_weeks` too; never samples gaps) and the validator (I27, I28, I29,
I30). Sort key 5 is the rank value. If any golden file changes under R33-6, stop and report to the
workflow-auditor; do not re-bless it.

### F3. `scheduling.template_timeline`

```python
def template_timeline(*, workflow: Workflow, lengths: Mapping[str, int],
                      gaps: Mapping[str, int]) -> TemplateTimeline
# -> steps: (step_id, start_week, end_week, duration_weeks, requested_gap_weeks,
#            effective_gap_weeks, flags: frozenset[str]); total_weeks; design_weeks; lab_weeks
```

- Weeks are 0-based and end-exclusive, as P13-T16.
- It uses DOMAIN_RULES §D's gate with `frontier = 0`, no capacity, FTE 1.0 and the one-leader rule.
- Flags: `same_leader_serialised`, `anchor_clamped`, `gap_ignored_zero_length`.
- It is pure and deterministic.

### F4. The live input builder (`services/schedule_persistence.py`, OR-3)

| Step | `lead_weeks` | `duration_override_weeks` |
|---|---|---|
| `ownEffort(p, kind(s))` (some step of the kind has non-null `effort_weeks`) | `effort_weight_weeks` of the category row, None if equal to the input table `weeks` | `effort_weeks` |
| any other step (elapsed; a kind with no figure) | `plan_weeks`, None if equal to the input table `weeks` | None |

- `overlap_weeks` / `wait_weeks` come from `plan_gap_weeks`; `start_not_before_week` is None. There
  is no user-override term (P33-T13 removed it with p33c).
- **History — transitional rule (T05-A1, in force between p33b and p33c only; retired by P33-T13,
  2026-11-15).** While the hand-set ADR 0019/0043
  fields may still be non-null (live today: 4 projects, 5 rows, 7 values), the builder also carries
  them:
  - `duration_override_weeks = user_override ?? (effort_weeks if ownEffort else None)`;
  - `start_not_before_week` as stored;
  - `overlap_weeks` = the stored `overlap_weeks` if non-null, else `−plan_gap_weeks` when negative.
    `wait_weeks = 0` on any step with a stored overlap.
  
  After p33c the CHECK makes these fields null, and the table above is exact. Without this rule,
  deploying p33b alone changes the input hash and 16 greedy outcomes on live data. **Alternative:**
  ship p33c in the same deploy as p33b, still running the byte-identity check between them.
- Tests:
  - no live row carries `lead_weeks` equal to its table value (R33-9);
  - the builder's `eff` equals DOMAIN_RULES §B on every live step. While user-override or overlap
    fields were non-null (before p33c), it was evaluated with R33-1 including the override (T05-A2,
    retired with p33c);
  - with the transitional rule, after p33a/p33b and **before p33c**, the live input hash, a fresh
    greedy run and the re-serialised stored runs are byte-identical to before.
- **Deploy order (T05-A3).** P33-T02/T03 alone change every priority-preview token (`asdict` sees
  the new defaults). They must not reach a deploy without P33-T07's `_canonical` →
  `canonical_schedule_input_asdict` (sorted as today). `build_workflow_snapshot_from_input` adds
  `wait_weeks`, `lead_weeks` and `categories` only when non-default.
- **Stored runs (T05 ruling 6).** Per-project overlaps recorded in stored runs keep their values
  (I14). A stored run is never re-derived. A re-validation of a historical input that carried a
  design ∥ design overlap (for example run v4's PDD-E overlap 2) would now compute a later
  unconstrained finish under R33-6. That is intended.
- The what-if baseline and `services/whatif_import.py` (matched live plan projects) use this builder
  instead of reading the table. New what-if projects use the table.
- The service-side skip predicate (`services.workspace.is_step_skipped` and every ADR 0041 R5
  reader) takes `(plan_weeks, kind, cert, own_effort, effort_weeks)` and equals §B.

## Part G — Retired and changed reads (ADR 0048)

- `PATCH /projects/{id}/steps/{step_id}/timing` → **410** `STEP_TIMING_RETIRED` ("Per-project step
  timing was retired; edit the category template on Workflow templates."). Still authenticated (401
  without a session). Removed in P33-F01.
- `PUT /workflow-settings/lead-times` → **410** `USE_TEMPLATE_APPLY`.
- `GET /gantt` steps:
  - removed: `timing_editable`, `duration_override_weeks`, `start_not_before_week`, `overlap_weeks`;
  - added: `gap_weeks` (signed, from `plan_gap_weeks`), `plan_weeks` and `own_effort` (bool: the
    step's kind follows the project's own effort figure);
  - kept: `predecessor_ids`.
- `GET /projects/{id}/workspace` stages gain the same three fields.
- What-if and plan-import requests and responses are unchanged.

## Part H — Audit actions, error codes, run trigger

- **Audit actions:** `workflow_template.applied`, `project.template_applied`, `category.created`,
  `engineer.allowed_categories_extended`, `project.step_timing_cleared` (migration, actor system),
  `schedule_run.dispatched` with `trigger_reason ∈ {template_apply, timing_cleared}`.
- **Error codes:** `BAD_CATEGORY_CODE`, `CATEGORY_EXISTS`, `BAD_COPY_SOURCE`, `BAD_POSITION`,
  `FIRST_STEP_GAP`, `BAD_STEP`, `NO_CHANGE`, `TEMPLATE_CHANGED`, `BAD_PROJECT`,
  `STEP_TIMING_RETIRED`, `USE_TEMPLATE_APPLY`, `RATE_LIMITED`.
- **`ScheduleRun.trigger_reason`:** add `template_apply` and `timing_cleared`. Keep `step_timing`
  readable for stored runs.

## Part I — Frontend (frontend-builder)

- **Categories** come from `useCategories()` (B1; cached, invalidated after B2). No module-level
  category constant remains except the test fixtures. Chip colour: the existing seven keep theirs,
  and others take palette slots by rank.
- **Timeline editor** (Workflow templates → Timeline previews; write controls only with
  `workflow_templates.write`):
  - per step: Move `−`/`+` (accessible names "Move PDD-E one week earlier/later") and Length
    `−`/`+`;
  - the gap badge `0w` / `−Nw Overlap` / `Nw` with a hatched wait;
  - notes for each flag ("Overlap — same leader, runs back-to-back"; "can't start before <step>
    starts"; "0-week step: gap ignored");
  - the template-view note;
  - Discard, per-row reset, and Save, which opens E2.
- **Apply dialog:**
  - counts and four sections: automatic (read-only); choosable (check boxes plus "Apply to all N
    projects that have not reached these stages"); "Uses its own effort figure — length not
    applied" (read-only); never (with reasons);
  - per-project eff before → after, with the step flags shown as short notes (revived, now skipped,
    gap has no effect on a skipped step, certification off, own effort);
  - Apply (E3), then run-follow exactly as a priority move, then a result summary that includes
    `not_applied`;
  - 409 `TEMPLATE_CHANGED` → "Someone saved this category meanwhile. Reload."
- **Lead times tab:** editable for `workflow_templates.write`. Save goes through the same E2 → dialog
  → E3 flow.
- **Add category dialog:** name, label, workflow, copy from (filtered to the workflow), position
  ("after …", including first). On success the list refreshes and the new timeline opens.
  - **Copy for the position field** (P33-T20): "Order among categories. In the live plan it only
    breaks ties: projects are ordered by priority and their position on the Priority board first.
    It mainly affects What-if and imported plans."
  - Never word it as "schedules between B and C".
- **Read-only timing** (Part G): remove the drag overlay, dialog, Reset and edited marker from
  `/timeline` and from the Workflow "Project step timing" tab. Show the gap chip ("parallel N wk" /
  "wait N wk"). The What-if import Gantt keeps its drag (OQ #78).
