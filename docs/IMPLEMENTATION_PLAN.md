# Implementation Plan

Every task has a stable ID (`P<phase>-T<NN>`), an owning agent, explicit dependencies, acceptance
criteria, and a status field: `TODO / IN_PROGRESS / BLOCKED / REVIEW / DONE`.

No phase advances until `qa-inspector`, `workflow-auditor` and `security-auditor` have each
recorded a PASS for that phase in `docs/MEMORY.md`, via `/gate-check`. A FAIL blocks the phase and
creates a remediation task at the top of the current phase.

## Phases

| Phase | Name | Owner | Gate |
|---|---|---|---|
| P0 | Spec lock & open questions | orchestrator | client sign-off on OPEN_QUESTIONS |
| P1 | Data model, migrations, seed import | backend-builder | qa + security |
| P2 | Scheduling engine (greedy → golden tests → CP-SAT) | algorithm-engineer | qa + workflow |
| P3 | API layer, auth, RBAC, audit log | backend-builder | qa + security |
| P4 | Design system + the six surfaces | frontend-builder | qa + workflow |
| P5 | Scenarios, versioning, history, exports | backend + frontend | qa + workflow |
| P6 | Security hardening, SSO, Docker Compose, observability | security-auditor + backend | security |
| P7 | UAT, data migration, handover docs | all | all three |
| P8 | Project Workspace (Surface #7) — per-stage progress capture | all | qa + workflow + security |
| P9 | Client formulas, RBAC/Super Admin, completion lines, precedence | all | all three |
| P10 | Project access grants, delegation, login page, Ask the agent | all | all three |
| P11 | Client change requests: priority move auto-recalc, capacity booked %, On Hold label | backend + frontend | all three |
| P12 | Client change requests 2: Priority board (Kanban), Gantt drag timing, global hub filter, weekly check-in, VIP projects | all | all three |

---

## P0 — Spec lock & open questions

**Owner:** rpd-orchestrator
**Gate:** client sign-off on `docs/OPEN_QUESTIONS.md`

- **P0-T01** — Bootstrap governance scaffold: `CLAUDE.md`, `docs/*`, `.claude/agents/*`,
  `.claude/skills/*`, `.claude/commands/*`, `.claude/settings.json`.
  Depends on: none.
  Acceptance: every file in the bootstrap prompt's file tree exists; zero application code written.
  Status: DONE

- **P0-T02** — Client reviews and signs off on all 9 questions in `docs/OPEN_QUESTIONS.md`.
  Depends on: P0-T01.
  Acceptance: each question has a recorded answer or an explicit "proceed with stated assumption"
  from the client, logged as a `docs/MEMORY.md` entry. Questions #2, #3, #5 (prototype defects)
  additionally require an ADR each, regardless of the answer.
  Status: DONE (provisional — project owner authorized proceeding on stated default assumptions in
  place of formal client sign-off; see MEMORY.md 2026-08-29 22:15 entry. Real client answers still
  pending; #8 GDPR remains hard-blocking for P4-T08 regardless.)

- **P0-T03** — Orchestrator reconciles any client answers that change `docs/DOMAIN_RULES.md` or
  `docs/PROJECT_AND_STACK.md`, writing ADRs for each change per `docs/ADR/0001-...md`.
  Depends on: P0-T02.
  Acceptance: DOMAIN_RULES.md and PROJECT_AND_STACK.md reflect client answers; every changed rule
  has a corresponding ADR.
  Status: DONE (no rule changes needed — all provisional decisions matched existing DOMAIN_RULES.md
  content, since they accept current prototype behaviour. ADRs 0002-0004 written for the record per
  P0-T02. Will reopen if real client answers require a rule change.)

---

## P1 — Data model, migrations, seed import — **GATE: PASSED (2026-08-30, see MEMORY.md)**

**Owner:** backend-builder
**Gate:** qa-inspector PASS + security-auditor PASS

- **P1-T01** — Design the SQLAlchemy 2.0 async data model: `Project`, `WorkflowStep` (14-step
  template + per-project instances), `Engineer`, `Chamber`, `Hub`, `PriorityScore` (13 dimensions),
  `ScheduleRun` (versioned), `AuditLogEntry`, `User`/`Role` (RBAC).
  Depends on: P0-T03.
  Acceptance: model covers every entity referenced in `docs/DOMAIN_RULES.md` and
  `docs/PROJECT_AND_STACK.md` §2; financial fields (TCOGS, gross margin, selling price) use an
  encrypted column type; reviewed against DOMAIN_RULES.md by the orchestrator before migration.
  Status: DONE (reviewed against DOMAIN_RULES.md by orchestrator and accepted — see MEMORY.md
  entry below. ProjectType enum flagged for client confirmation; capex_keur/rm_savings_keur
  encryption scope flagged for security-auditor's P1-T06.)

- **P1-T02** — Alembic migration for the initial schema.
  Depends on: P1-T01.
  Acceptance: `alembic upgrade head` runs clean on a fresh Postgres 17 instance; `alembic downgrade
  base` reverses cleanly.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. Verified against
  live Postgres 17; partial unique indexes and audit append-only trigger functionally tested; the
  enum-values-callable bug fix confirmed applied at all 17 call sites.)

- **P1-T03** — Seed data import: load the ~236 synthetic demo projects referenced in the prototype
  (or client-provided seed data if available by this point) into the new schema.
  Depends on: P1-T02.
  Acceptance: row counts match source; spot-check 5 projects' step data against the source for
  field-level accuracy.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. Prototype's
  embedded dataset is genuinely 46 projects, not ~236 — accepted as the correct real count, not
  padded. A separate bulk-synthetic-data generator will be needed before P2/P4 performance and
  virtualization testing needs ~236-scale volume; not this task's job.)

- **P1-T04** — Currency rate table (EUR/USD/INR), configurable at runtime per
  `docs/DOMAIN_RULES.md` §Currency.
  Depends on: P1-T02.
  Acceptance: rates are rows in a table, not hardcoded constants; an Admin-role endpoint can update
  them (stub endpoint acceptable at this phase, full API arrives in P3).
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. First runnable
  FastAPI app in the repo; update endpoint is honestly unauthenticated and loudly flagged rather
  than fake-gated, with an explicit MUST-FIX-BEFORE-P3-CLOSES cross-reference to P3-T02/T03.)

- **P1-T05** — `qa-inspector` writes backend model/migration tests (pytest + testcontainers
  Postgres).
  Depends on: P1-T01, P1-T02, P1-T03.
  Acceptance: ≥70% coverage on `backend/` (excluding `backend/scheduling/`, which is P2's 85%
  target); migrations tested up and down.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. 64/64 tests
  pass; 97.93% coverage, well above the 70% floor; enum-regression tests correctly use raw text()
  queries to bypass ORM decoding; migration test correctly extended mid-session to cover both
  revisions once P1-T07 landed.)

- **P1-T06** — `security-auditor` reviews the data model for the P1 gate: encrypted financial
  columns verified, no PII in logs, secrets absent from repo.
  Depends on: P1-T01 through P1-T04.
  Acceptance: findings table with severity; zero High/Critical.
  Status: DONE (review task itself complete and self-verifying -- live independent
  verification performed against a real Postgres 17 container, not just code reading; see
  MEMORY.md entry below for full findings table). ORIGINAL GATE RESULT (2026-08-30 10:15): FAIL --
  one High finding (audit_log_entries immutability bypassable via TRUNCATE, verified live as the
  app's own DB role) was unresolved. Orchestrator-opened remediation task: P1-T07 (below).
  **UPDATED GATE RESULT (2026-08-30, delta-recheck by security-auditor, fresh session): PASS.**
  P1-T07's remediation (migration `ba3881d85b55`) was independently re-verified live against a new
  disposable Postgres 17 container -- not taken on backend-builder's or the orchestrator's word --
  confirming: `TRUNCATE audit_log_entries` (and `TRUNCATE ... CASCADE` / `RESTART IDENTITY`
  variants) is now rejected as the app's own `rpd` DB role; pre-existing `UPDATE`/`DELETE` rejection
  still works with no regression; `INSERT` (the sole legal write path) still succeeds. This was the
  only High/Critical finding blocking the P1 gate from security-auditor's side; with it resolved,
  security-auditor's P1 gate requirement is now satisfied. See MEMORY.md
  "[2026-08-30 11:20] P1-T06 delta-recheck" entry for full live-verification output. (No other
  P1-T06 findings were re-examined -- this was a targeted delta-recheck of Finding #1 only, per
  its explicit scope; Findings #2-#10 from the original review stand as originally recorded.)

- **P1-T07** — REMEDIATION (opened by orchestrator in response to P1-T06's FAIL). Close the
  `TRUNCATE` gap in `audit_log_entries`'s append-only enforcement: the existing P1-T02 trigger
  covers `BEFORE UPDATE OR DELETE` only — Postgres row-level triggers do not fire on `TRUNCATE`,
  which is a separate statement-level operation. Add a `BEFORE TRUNCATE` statement-level trigger
  (reusing or extending the existing `audit_log_entries_reject_mutation()` function, or a sibling
  function, so the "enforced regardless of DB role" property the original trigger was chosen for is
  preserved rather than falling back to a REVOKE-based approach for just this one operation — see
  the migration's own comment block for that original reasoning) in a new Alembic migration (do not
  edit the already-applied `419f196fd00b_initial_schema.py` migration in place). Must include a
  downgrade that removes it.
  Depends on: P1-T06 (the FAIL that created this task).
  Acceptance: live-verified (same method P1-T06 used) that `TRUNCATE audit_log_entries` is rejected
  as the app's own DB role, that `INSERT` still works, and that the existing `UPDATE`/`DELETE`
  rejection still works (no regression). `alembic upgrade head` / `alembic downgrade base` both
  clean through the new migration.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. New migration
  ba3881d85b55 chained correctly to 419f196fd00b, not edited in place; statement-level TRUNCATE
  trigger with a dedicated sibling function; up/down/up/down cycle and no-regression on UPDATE/
  DELETE both live-verified; 4 new tests added without touching qa-inspector's in-flight suite.)

- **P1-T08** — REMEDIATION (opened by orchestrator, flagged by qa-inspector during P2-T09; scope
  widened during P3-T01 review). `ruff check .` from `backend/` reports lint errors across
  `models/`, `seed/`, and now `api/`/`schemas/`/`services/` (P3-T01 added 9 router modules
  following P1-T04's established `Depends(get_db)`/`Depends(get_current_user_placeholder)`
  FastAPI pattern, which flake8-bugbear's `B008` rule flags at every call site — confirmed this is
  not a P3-T01 regression: `api/routers/currency_rates.py`, P1-T04, already accumulates this same
  finding, just at 1/9th the call-site count). Plus the original `models/workflow.py` quoted
  `Mapped[...]` annotations, E501 in `seed/seed_demo_data.py`. Cause: installed `ruff` is 0.16.5 vs
  `pyproject.toml`'s `ruff>=0.7` pin, and rules enabled since the P1 gate now fire. `backend/
  scheduling/` and all test code remain clean. Not a P2 or P3-T01 blocker (neither phase's own gate
  requires backend-wide ruff cleanliness), but the repo-root `Makefile`'s `lint-backend` target
  surfaces it on every `make lint`.
  Depends on: none (independent cleanup).
  Acceptance: `ruff check .` from `backend/` is clean. The idiomatic fix for the `B008` share of
  this is a `[tool.ruff.lint.per-file-ignores]` entry for `api/routers/*.py` (`Depends(...)` in a
  parameter default is FastAPI's standard, documented dependency-injection pattern, not a real bug —
  rewriting ~40 endpoints to work around a linter false-positive would be the wrong fix), with the
  remaining `models/`/`seed/` findings fixed at the call site; document the reasoning for whichever
  rule gets a project-wide ignore rather than silently disabling it. Pin `ruff` to an exact version
  in `pyproject.toml` so this does not silently recur. No behavioural change to any module
  (lint-only diff); full backend suite still green (144+ passed at time of writing; 305 as of
  2026-08-31).
  **Scope additions (from the P3-T08 security review, 2026-08-31 — small, same files, same "convention
  debt" character):** also (i) add `model_config = ConfigDict(extra="forbid")` to
  `backend/schemas/currency.py::CurrencyRateUpdateRequest` — the only P3 request model missing it,
  noted in both the P3-T01 and P3-T02 reviews (security finding #8, Low; no exploit path, the router
  reads fields explicitly — consistency only); and (ii) refresh the stale `backend/api/main.py`
  module docstring + `FastAPI(description=...)` text, which still says "no auth / no RBAC / no SSE /
  no Celery dispatch" though all four now exist (security finding #16, Info, cosmetic). Both are
  lint/convention-debt, not behaviour changes — keep the "lint-only / no behavioural change" property
  (the `extra="forbid"` add is a stricter-validation no-op on all current callers; confirm no test
  sends an unknown field to that endpoint).
  Depends on: none (independent cleanup). Note: touches `backend/` outside `scheduling/` — do NOT run
  concurrently with P3-T09 (also backend-builder, also `backend/` non-scheduling).
  Owner: backend-builder.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31] P1-T08 —
  backend-builder" and "[2026-08-31] P1-T08 review — rpd-orchestrator" entries. `ruff check .` from
  `backend/` now exits 0 (was 261 errors); `ruff` pinned `==0.16.5`; documented per-file-ignores for
  B008 (FastAPI `Depends()` idiom) + UP042 (`(str,Enum)`→`StrEnum` is a `__str__` behaviour change,
  deliberately not taken) + `alembic/` excluded (P1-T07 forbids editing applied migrations). Part B
  (`CurrencyRateUpdateRequest` `extra="forbid"`, security finding #8) and Part C (`api/main.py`
  docstring refresh, finding #16) done. Independently re-verified: 305 passed / 85.65% backend suite,
  80 passed / 93.58% scheduling suite unchanged, `mypy .` 545 pre-existing / zero new, `scheduling/`
  untouched. Discovered + logged: `make lint-backend`'s unscoped `mypy .` reports 545 pre-existing
  errors (untyped `tests/*.py` under `strict=true`) — needs its own small config task before P6.)

## P2 — Scheduling engine (greedy → golden tests → CP-SAT) — **GATE: PASSED (2026-08-31, see MEMORY.md)**

**Owner:** algorithm-engineer
**Gate:** qa-inspector PASS + workflow-auditor PASS

P2 must include, as blocking tasks, **in this order**:

- **P2-T01** — Implement the greedy SGS (serial schedule-generation scheme) scheduler
  **from `docs/DOMAIN_RULES.md`**, not by transliterating the prototype. Read the prototype only to
  resolve ambiguity in the deck, and record each such resolution in `docs/MEMORY.md`.
  Depends on: P1 complete.
  Acceptance: pure function, dataclass input → dataclass output, no DB/network access; deterministic
  (fixed seeds, sorted iteration, no set-iteration-order dependence).
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. Independently
  re-ran the 47-check self-test suite and ruff — both clean. Purity confirmed via direct import
  grep: zero non-stdlib, non-domain_constants imports anywhere in backend/scheduling/. Flagged
  "earliest-start floor" decision (non-frozen search starts at current_week, not the prototype's
  actualStart/CURRENT_WEEK-6 hint) will produce large-volume INTENTIONAL divergence in P2-T02/T03 —
  expected and pre-flagged, not a surprise to triage later.)

- **P2-T02** — Build the differential oracle: run the prototype in headless Chrome against the seed
  dataset, capture its full schedule output as JSON, commit under `tests/oracle/`. Mark the
  directory as temporary — it is deleted at P2 close.
  Depends on: P2-T01, P1-T03 (seed data).
  Acceptance: oracle JSON captures every project's full 14-step schedule output, byte-reproducible
  from a documented capture script.
  Status: DONE (algorithm-engineer's capture script hit a session limit before it could be run;
  orchestrator ran it, found and fixed a real bug — a stray "use strict" directive silently broke
  the direct-eval scope-leak the script depends on — then independently verified byte-identical
  output across two runs and spot-checked one project's duration_weeks against the DOMAIN_RULES.md
  formula. See MEMORY.md entry below. 46 projects captured: 2 excluded, 8 left_out.)

- **P2-T03** — Run the diff. Produce `docs/ORACLE_DIVERGENCE.md` listing every difference, each
  classified as `INTENTIONAL` (with ADR reference) or `PORT_BUG` (with fix).
  Depends on: P2-T02.
  Acceptance: **zero unclassified divergences.** A large number of classified divergences is an
  acceptable and expected outcome — the oracle has known defects (see DOMAIN_RULES.md).
  Status: DONE (two algorithm-engineer attempts lost to environment interruptions before writing
  any files; orchestrator built the diff harness and analysis directly. 1055 divergences across 41
  of 46 projects, ALL traced to a single already-accepted root cause (P2-T01's earliest-start-floor
  decision) plus its mechanical downstream effects — zero unclassified, zero PORT_BUGs, zero changes
  to backend/scheduling/. See docs/ORACLE_DIVERGENCE.md and MEMORY.md entry below.)

- **P2-T04** — Implement invariant assertions I1–I10 (`docs/DOMAIN_RULES.md`) as a reusable
  validator. These, not the oracle, are the permanent correctness contract.
  Depends on: P2-T01.
  Acceptance: validator runs against any schedule output and asserts I1–I10; used by
  workflow-auditor on every subsequent solver-touching change.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. Independently
  re-ran the 24-check self-test — all pass, including zero violations on the real 46-project seed
  dataset and correctly catching a hand-crafted broken case for all 10 invariants. Purity and ruff
  confirmed independently.)

- **P2-T05** — Replace the oracle fixtures with spec-derived test cases: hand-constructed scenarios
  that exercise each rule in DOMAIN_RULES.md in isolation (single engineer contention, chamber
  saturation, frozen conflict, left-out at horizon, category mismatch, spillover boundary at
  week 52). Delete `tests/oracle/`.
  Depends on: P2-T03, P2-T04.
  Acceptance: `tests/oracle/` no longer exists; golden-file tests derived from DOMAIN_RULES.md cover
  every named rule; all green.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md entry below. Independently
  re-ran the full suite: 88/88 pass, 97.93% coverage. tests/oracle/ confirmed deleted;
  docs/ORACLE_DIVERGENCE.md confirmed retained. All 5 outcome flags get isolated coverage; every
  golden-file test also asserts validate_invariants(...) == ().)

- **P2-T06** — CP-SAT model: intervals + `AddNoOverlap` per engineer, `AddCumulative` per chamber,
  objective = maximise weighted value completing by week 52.
  Depends on: P2-T04.
  Acceptance: model runs on the full seed dataset within a bounded `max_time_in_seconds`; never
  invoked from the FastAPI request-handling process (Standing Decision).
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md
  "[2026-08-30 23:15] P2-T06 review" entry. `backend/scheduling/cp_sat.py` + `_selftest_cp_sat.py`,
  99/99 checks pass, re-run fresh at review. Real 46-project seed dataset: OPTIMAL in ~1.8s, well
  under the 60s bound; `validate_invariants` reports zero violations; byte-identical single-threaded
  re-run; two-frozen-project conflict scenarios (engineer and chamber) stay FEASIBLE with the correct
  flag raised, confirming the highest-risk frozen-pre-resolution design works. Full pytest suite
  88/88, no regression. Purity + "never in the FastAPI process" verified structurally. ADR 0005
  written for the objective band-weight gap-fill. Note: the AE-authored MEMORY.md entry the prior
  plan text referenced was never written — the prior session ended first; the orchestrator review
  entry does double duty. Flagged for P2-T09: cp_sat.py has zero pytest-measured coverage yet.)

- **P2-T07** — Solver comparison harness: greedy vs CP-SAT on the same input, diff report.
  Depends on: P2-T05, P2-T06.
  Acceptance: harness runs both solvers on identical input, reports objective value and per-project
  divergence; any unexplained divergence is investigated by workflow-auditor before P2 closes.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31 00:20] P2-T07
  review" entry. `backend/scheduling/solver_comparison.py` + `_selftest_solver_comparison.py`, all
  self-tests re-run fresh + full pytest 88/88 + ruff clean at review. Real 46-project dataset:
  greedy objective 33 / CP-SAT objective 39, 0 invariant violations both sides, 809 field
  divergences across 34 projects, 0 frozen divergences, 0 unexplained — VERDICT CLEAN. The
  classifier's strictness is negatively tested (a leader-mismatch divergence is correctly flagged
  UNEXPLAINED). FLAGGED for workflow-auditor P2-T10 + client: CP-SAT drops schedulable P1
  `26-00201` entirely (greedy schedules it into spillover) — consistent with ADR 0005's provisional
  objective as written, but "optimizer silently drops a P1" is a client-visible decision.)

- **P2-T08** — Monte Carlo delivery forecast (P50/P80) on top of the solver.
  Depends on: P2-T06.
  Acceptance: forecast produces P50/P80 completion-week distributions per project from repeated
  solver runs under input perturbation; deterministic given a fixed random seed.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31 01:10] P2-T08"
  and the orchestrator review entry below. `backend/scheduling/monte_carlo.py` (pre-existing,
  reviewed clean against purity contract / ADR 0004 / I8-determinism) + new
  `_selftest_monte_carlo.py`, 33/33 checks pass. All four prior `_selftest_*` scripts + pytest
  88/88 (97.93%) + ruff re-run fresh at review, no regression. Real 46-project dataset, 500
  iterations, greedy inner solver: portfolio within-year count P50=9 / P80=10; 10 projects left
  out every iteration. Perturbation-model gap-fills (Poisson delay, triangular duration factor,
  500 iterations, nearest-rank percentile, completion-week definition) documented in the MEMORY.md
  entry — DOMAIN_RULES.md is silent on all of these.)

- **P2-T09** — `qa-inspector` enforces ≥85% coverage on `backend/scheduling/` and confirms
  golden-file tests are green.
  Depends on: P2-T05, P2-T06, P2-T07, P2-T08.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31 02:20] P2-T09"
  and the orchestrator review entry below. Ported all five `_selftest_*` scripts into parametrized
  pytest modules under `backend/tests/scheduling/`; added a dedicated `backend/pytest-scheduling.ini`
  + repo-root `Makefile` enforcing ≥85% on `backend/scheduling/` separately from the unchanged
  backend-wide ≥70% gate. Scheduling coverage **93.58%** (cp_sat 98 / greedy 94 / invariants 91 /
  monte_carlo 92 / solver_comparison 90 / types 100 / __init__ 100), 80/80 scheduling tests pass,
  golden-file suite 24/24 green, full backend suite 144/144, `ruff check scheduling/ tests/` clean —
  all re-run fresh by the orchestrator at review. **P2 qa-inspector gate criterion: PASS** (recorded
  in MEMORY.md). Pre-existing `models/`/`seed/`/`api/` ruff errors flagged → P1-T08 remediation task.)

- **P2-T10** — `workflow-auditor` re-derives the schedule independently from DOMAIN_RULES.md,
  asserts I1–I10, confirms every ORACLE_DIVERGENCE.md entry is classified, confirms `tests/oracle/`
  is deleted. Has authority to FAIL this gate on its own.
  Depends on: all above P2 tasks.
  Status: DONE (reviewed by orchestrator — see MEMORY.md "[2026-08-31 03:30] P2-T10" entry and the
  P2 gate closure entry below. Independent from-scratch re-derivation of the greedy SGS from
  DOMAIN_RULES.md, run against the real 46-project seed dataset, reconciles field-by-field with
  backend/scheduling/greedy.py's actual output (zero divergence on 40/44 schedulable projects; the
  other 4's apparent divergence traced to a bug in the auditor's own verification script, not the
  engine — orchestrator re-verified the coverage/test numbers fresh). I1-I10 hold on both greedy and
  CP-SAT real-dataset runs; all ten check functions read line-by-line against DOMAIN_RULES.md's
  wording and confirmed faithful. docs/ORACLE_DIVERGENCE.md: zero unclassified, zero PORT_BUGs,
  classification independently verified sound. tests/oracle/ confirmed independently deleted
  (repo-wide search, re-confirmed by orchestrator). ADRs 0002-0005 cross-checked against actual code
  via grep, all accurate. Both carry-forward flags adjudicated: neither blocks the P2 gate — flag
  (a) (CP-SAT drops P1 26-00201 under ADR 0005) became docs/OPEN_QUESTIONS.md #10, blocking for
  P4-T07 (Auto-assign) specifically, not for P2; flag (b) (Monte Carlo perturbation defaults)
  accepted as a documented, bypassable reporting-overlay default. **P2 workflow-auditor gate vote:
  PASS.** Combined with P2-T09's qa-inspector PASS — **P2 PHASE GATE: PASSED.**)

---

## P3 — API layer, auth, RBAC, audit log

**Owner:** backend-builder
**Gate:** qa-inspector PASS + security-auditor PASS

**Open gap tracked, not yet a task (from P3-T06 review, 2026-08-31):** a completed CP-SAT
`ScheduleRun` never auto-activates (by design — an unreviewed optimizer run silently replacing the
live schedule is a bigger deal than a greedy recalc) and no "activate a completed run" endpoint
exists yet anywhere, so a dispatched CP-SAT run is currently inert on every client-facing surface
once it finishes. Not blocking P3's own gate (no surface yet depends on activating a CP-SAT run —
P4-T07 Auto-assign, the first feature that would, is itself blocked on `OPEN_QUESTIONS.md` #10).
Needs an explicit activation endpoint (or folding into whatever "Apply Priorities"/"Auto-assign"
consequence eventually calls this dispatch primitive) before P4-T07 can be built — revisit then.

- **P3-T01** — FastAPI endpoints for all six surfaces' data needs (CRUD + read models), each with a
  Pydantic request and response model. Status: DONE (reviewed by orchestrator and accepted — see
  MEMORY.md "P3-T01 — backend-builder" and the orchestrator review entry below. Independently
  live-verified against a fresh Postgres 17 container: full Draft→hard-gate→submit lifecycle,
  extra="forbid" 422s, Engineer/Chamber 409/422 negative paths, two consecutive greedy-recalcs
  correctly maintaining exactly one active ScheduleRun, Dashboard/Capacity/Gantt all reading from
  it, and audit-log financial-field redaction confirmed by raw SQL query. Both flagged decisions
  (extra="forbid" convention, POST /schedule-runs/greedy-recalc) accepted. New B008 ruff findings
  folded into the existing P1-T08 remediation task, not a new blocker.)
- **P3-T02** — OIDC auth integration (per `docs/OPEN_QUESTIONS.md` #9 resolution) and RBAC
  middleware enforcing the role/permission matrix in `docs/PROJECT_AND_STACK.md` §5. Status: DONE
  (reviewed by orchestrator and accepted — see MEMORY.md "P3-T02 review — rpd-orchestrator" entry.
  Independently re-ran the full backend suite (203 passed, 82.42% coverage) and the scheduling suite
  (80 passed, 93.58%, unchanged), independently confirmed `backend/scheduling/` untouched, and ran a
  fresh live smoke test against a real throwaway Postgres 17 + this task's Keycloak compose file:
  real password-grant tokens for all 6 provisioned roles plus the deliberately-unprovisioned 7th
  user, 401/403/200 matching `docs/PROJECT_AND_STACK.md` §5's matrix exactly across Dashboard/
  Capacity/Matrix/Gantt/Project Registration/Capacity Planning/schedule-runs/currency-rates,
  tampered-signature rejection, no-auto-provisioning 401, DB-level confirmation of JIT `oidc_subject`
  linking and audit `actor_user_id` attribution, `updated_by_user_id` populated on currency PUT, ruff
  (79 findings: 76 B008 + 1 E501 + 2 UP042, all pre-existing-pattern) and mypy (13 pre-existing
  `models/` errors, zero new in `core/`/`api/deps.py`) counts matched claims exactly. Both flagged
  decisions (OIDC-identity-only/local-DB-authorization architecture; `schedule_runs.py`'s
  any-of-three-surfaces READ / Admin-only greedy-recalc WRITE interpretation) accepted. Containers
  and processes confirmed torn down cleanly after review.)
- **P3-T03** — Hub-scoped row-level filtering enforced in the data access layer for every endpoint
  touching project data. Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md
  "P3-T03 review — rpd-orchestrator" entry. Independently re-ran the full backend suite (237
  passed, 84.49% coverage) and the scheduling suite (80 passed, 93.58%, unchanged), independently
  confirmed `backend/scheduling/` untouched (no file mtimes newer than this task's own commit
  point), cross-checked the lab-region-sharing claim directly against DOMAIN_RULES.md's hub/lab-
  region table (India correctly shared by 4 hubs), and confirmed the Engineer-scoping bug fix's
  `if is_engineer_self_scoped(...)/else hub_scope_filter(...)` mutually-exclusive ordering directly
  in `api/routers/gantt.py`. Ran a fresh live smoke test against a real throwaway Postgres 17 +
  this task's Keycloak compose file, independent of backend-builder's own: hub-scoped 200/404/403
  confirmed both ways across projects/engineers/chambers/dashboard/capacity/priorities/gantt for a
  manually hub-scoped Hub Planner (Bob, R&D-Greece), unrestricted access confirmed unchanged for
  Portfolio Manager (Alice) and Executive Viewer (Dave), 403 confirmed unchanged for Auditor (Erin)
  on Dashboard/Gantt, and Engineer (Carol, linked to the Dimopoulou Engineer row) confirmed to see
  exactly her 1 assigned project on Gantt — cross-checked against a direct `psql` join query
  returning the identical project name. Both flagged architecture decisions (Chamber's lab-region-
  not-hub-id scoping; the Engineer-self-scoped principal-shape detection and its multi-role edge
  case) accepted, along with the `schedule_runs.py`/priorities-summary/upsert-defense-in-depth
  decisions. Containers and processes confirmed torn down cleanly after review.)
- **P3-T04** — Immutable append-only audit log: every mutation writes an audit row. Status: DONE
  (write-side and DB-level append-only enforcement already existed and were verified in P1-T02/T06/
  T07 and every P3-T01/T02/T03 mutation handler; this task built the missing **read surface** —
  `GET /audit-log` — per the P3-T03 review's scope note. Built by a `backend-builder` subagent that
  was interrupted mid-task by a session-wide rate limit before it could verify or report; the
  orchestrator completed and independently re-verified the work — see MEMORY.md "P3-T04 —
  backend-builder (interrupted) + rpd-orchestrator (completion & verification)" entry and the
  "P3-T04 review — rpd-orchestrator" entry below. Independently re-ran the full backend suite (254
  passed, 84.92% coverage, exact match) and the scheduling suite (80 passed, 93.58%, unchanged),
  confirmed `backend/scheduling/` untouched by file-mtime inspection, confirmed the `make_hub()`
  test-fixture bug fix is real by reading the current test code directly, confirmed ruff (81
  findings: 78 B008 + 2 UP042 + 1 E501, all pre-existing patterns) and mypy (2 pre-existing-pattern
  findings in `schemas/audit.py`, mirroring `models/audit.py`) counts match claims exactly, and read
  `services/audit_helpers.py` directly to confirm the redaction mechanism (financial/PII values are
  never read into the process at all — written as the literal string `"<redacted>"` unconditionally
  at audit-row-creation time) rather than trusting the claim. Ran a fresh independent live smoke test
  against a real throwaway Postgres 17 + this repo's Keycloak compose file: real tokens for all 6
  roles, 401/403/200 matrix confirmed exactly against the matrix (Auditor/Admin 200, all four other
  roles 403, no-token 401, tampered-signature 401), pagination bounds (`limit=0`/`501`, `offset=-1`
  all 422) confirmed, `hub_id`-as-convenience-filter-not-access-control confirmed live (narrows
  results to 0 rather than 403ing on an out-of-scope hub), and financial-field redaction
  independently re-derived via a real `POST /projects` with real `customer_name`/`tcogs_eur`/
  `selling_price_eur`/`gross_margin_pct` values followed by `GET /audit-log` as both Auditor and
  Admin, confirming `"<redacted>"` for all four fields for both roles and confirming none of the raw
  values appear anywhere in the response body. Containers and processes confirmed torn down cleanly
  after review. The orchestrator's one-off code-writing deviation (a 3-line test-fixture fix) is
  accepted as a narrow, explicitly-flagged, one-time judgment call to unblock verification of
  otherwise-complete interrupted work — not a precedent for the orchestrator writing feature code
  going forward.)
- **P3-T05** — SSE endpoint for solver progress streaming, subscribed to the Redis pub/sub channel
  published by `solver-worker`. Status: DONE (reordered after P3-T06 — this task is the *subscriber*
  side of a producer/consumer pair, and its producer, the Redis progress-publish wiring, is P3-T06's
  job. Built by a `backend-builder` session that ended before writing its `docs/MEMORY.md` entry or
  running final verification; the orchestrator verified and closed it — see MEMORY.md
  "[2026-08-31] P3-T05 — SSE progress endpoint" entry. `GET /schedule-runs/{id}/progress`, plain
  `data:` SSE framing, `Authorization`-header auth via `_read_any` — **binding P4 consequence: the
  frontend consumer must be a `fetch()`-based streaming reader, never a bare `EventSource`**.
  Subscribe-before-refresh closes the already-terminal race; owned Redis objects, no request-scoped
  session in the body generator. 13 real-Redis testcontainer tests pass; full backend suite
  305 passed / 85.64%; scheduling suite 80 / 93.58% unchanged; `backend/scheduling/` untouched. The
  real worker→SSE end-to-end path is covered by code review + the 13 tests only until P3-T07
  exercises it against a real worker.)
- **P3-T06** — Celery task wiring: solver dispatch, progress publish, cancellation. Status: DONE
  (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31] P3-T06 review" entry.
  Independently re-ran the full backend suite (292 passed, 85.30% coverage, exact match) and the
  scheduling suite (80 passed, 93.58%, unchanged), confirmed `backend/scheduling/` untouched by
  file-mtime inspection, confirmed ruff (11 findings on touched/new files, all pre-existing B008;
  investigated and confirmed the "down from 81" framing compares two different scopes, not a config
  change — no ruff/coverage config narrowing occurred) and mypy (1 new finding, same untyped-decorator
  class as the accepted python-jose precedent) counts match exactly. Ran a fresh live end-to-end
  smoke test against a real throwaway Postgres 17 + Redis 7 + a separate-OS-process Celery worker +
  (going further than the completing session) a successfully-stood-up real Keycloak: real Admin
  (Frank) and non-Admin (Alice) tokens confirmed 202/403 on dispatch; independently PSUBSCRIBEd the
  Redis channel via a separate `redis-cli` process and observed real "queued"/"running"/"completed"
  JSON events matching the documented schema exactly; confirmed both completed CP-SAT runs
  persisted with `is_active=false` and zero effect on live `ProjectWorkflowStep` rows; live-verified
  both cancellation paths including direct OS PID inspection proving the RUNNING-cancel hard-kill
  (child PID changed, worker log showed `Terminating ... (15)`, zero step/outcome rows persisted for
  the cancelled run) and confirming the QUEUED-cancel's DB-side no-op guard is load-bearing, not just
  theoretical (live-reproduced a worker restart wiping Celery's in-memory revoked-task registry,
  correctly caught by the task's own `status == CANCELLED` re-check). All containers/processes torn
  down clean after review. Auto-activation gap (no "activate a completed CP-SAT run" endpoint)
  accepted as a real, adequately-flagged, non-blocking product gap for this task's scope. Redis
  channel/message contract confirmed precise and stable for P3-T05 to build against. Both self-found
  bugs confirmed real and correctly fixed by direct code reading plus live reproduction. One minor
  process note: the MEMORY.md entry uses "What's next" instead of the template's "Gate result"/"Next"
  headings — content-complete, not grounds for REVIEW, flagged for the next entry's author.)
- **P3-T07** — `qa-inspector`: contract tests confirming the OpenAPI schema matches the frontend TS
  types (P4 dependency once that exists); ≥70% coverage on `backend/` outside scheduling.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31] P3-T07 —
  qa-inspector" entry. Independently re-ran the full backend suite (339 passed, 86.58% coverage) and
  the scheduling suite (80 passed, 93.58%, unchanged, confirmed untouched by mtime), independently
  re-ran the new `tests/test_openapi_frontend_contract.py` (30 passed), and independently re-ran the
  frontend suite fresh (`pnpm typecheck`/`lint`/`build` clean, budget PASS at 130.0 KB gzip — byte-
  identical to the P4-T05 baseline as expected for a type-only change; `vitest run
  --no-file-parallelism` 64 files / 197 tests pass). Confirmed the flagged `EngineerWeekLoad.name`
  drift is genuinely fixed in `frontend/src/surfaces/capacity/api/types.ts` (field removed, docstring
  updated) by reading the file directly. New minor drift found and correctly left flagged, not fixed:
  `PriorityScoreUpdateRequest.hard_gates` is optional-with-default on the backend but required in the
  frontend TS type — harmless direction (frontend always sends it), left for frontend-builder.
  **P3-T07 qa-inspector gate criterion: PASS.**)

  **P3 PHASE GATE: PASSED (2026-08-31).** Both gate requirements now satisfied: qa-inspector PASS
  (P3-T07, above) + security-auditor PASS (P3-T08 delta-recheck via P3-T09, findings #1/#2/#3/#7
  resolved — see the P3-T08 "UPDATED GATE RESULT" note above). Medium finding #4 (CSRF) remains
  correctly deferred to a P6-T03 acceptance gate per its original disposition — does not block this
  gate. P4 (already substantially built as an authorized parallel-track exception per P4-T01) may now
  be treated as a formal phase advance rather than a provisional exception; P4-T09/P4-T10 remain the
  formal P4 gate.
- **P3-T08** — `security-auditor`: authn/authz negative tests, hub-scoping bypass attempts via
  parameter tampering, CSRF on mutations. Status: DONE (review task itself complete and
  self-verifying — live independent verification via a 54-assertion throwaway adversarial suite with
  real RS256 tokens → real `get_current_principal` → real `core.rbac` → real `services.hub_scope`, a
  dedicated throwaway Postgres 17 container for raw-SQL audit-immutability re-check, `pip-audit`, and
  a repo secret scan; full backend suite 305 passed / 85.64% re-run clean afterward. See MEMORY.md
  "[2026-08-31] P3-T08 — security-auditor" entry and the orchestrator review entry below for the full
  16-row findings table. Severity count: Critical 0 · **High 1** · Medium 2 · Low 6 · Info 7.)
  **GATE RESULT (2026-08-31): FAIL.** One unresolved **High** finding: `GET /capacity/utilization-matrix`
  and `GET /gantt` serve named per-engineer utilization/assignment data (`EngineerWeekLoad.name` +
  `busy_weeks`; `assigned_engineer_name` on every Gantt step for `hub_scope_all` readers) while
  `docs/OPEN_QUESTIONS.md` #8 (GDPR lawful basis for per-engineer utilization on EU employees) is
  unresolved and explicitly hard-blocking — the P4-T03 frontend withholds the engineer side, but the
  backend still returns the data, making the control UI-only, which the `security-review` skill
  explicitly rejects. Orchestrator-opened remediation task: **P3-T09** (below). Medium findings #2
  (`ecdsa` PYSEC-2026-1325 reachable via `python-jose`) and #4 (no CSRF control — not exploitable
  today, but record a P6-T03 cookie-cutover acceptance gate) to be resolved before the P3 gate
  closes; Lows/Info folded into P6 or cleanup at the orchestrator's discretion, none block. **P3 gate
  also still pending P3-T07 (qa-inspector), which has not run** — P3 does not close until P3-T07
  records a PASS regardless of P3-T09.
  **UPDATED GATE RESULT (2026-08-31, delta-recheck by security-auditor after P3-T09's remediation):
  PASS on findings #1/#2/#3/#7.** See MEMORY.md "[2026-08-31] P3-T09 delta-recheck —
  security-auditor" entry: independently re-verified live against a real throwaway Postgres 17 +
  Redis 7 + JWKS server + running `uvicorn` process with real tokens for Portfolio Manager/Hub
  Planner/Engineer — no `name`/`assigned_engineer_name` leaks to non-self readers, chamber-side data
  unaffected, hub-scoping/RBAC unregressed, `python-jose`/`ecdsa`/`authlib` genuinely gone from the
  dependency tree, both SSE error-text leak sites confirmed fixed live. Medium finding #4 (CSRF)
  remains correctly deferred to P6-T03, out of scope for this recheck. With findings #1/#2/#3/#7
  resolved, **security-auditor's P3-T08 gate requirement is now satisfied** (mirrors P1-T06's
  delta-recheck pattern). **P3's full phase gate still requires P3-T07 (qa-inspector), which has not
  run.**

- **P3-T09** — REMEDIATION (opened by orchestrator in response to P3-T08's FAIL). Top-of-phase
  priority per the Gate Protocol. Three clearly-delineated deliverables (keep them as separate
  commits/diffs so the security-auditor's finding-#1 delta-recheck stays clean):

  **(1) Finding #1 (High) — withhold named-engineer data at the API layer** pending
  `docs/OPEN_QUESTIONS.md` #8 resolution, mirroring the P4-T03 frontend decision:
  (a) `GET /capacity/utilization-matrix` — drop `EngineerWeekLoad.name` (return `engineer_id`/`hub`/
  `busy_weeks` only, or `engineers: []`); (b) `GET /gantt` — omit `assigned_engineer_name` on step
  rows for readers who are not the assigned engineer viewing their own self-scoped Gantt (the
  Engineer self-scoped view may keep its own name). Add an explicit OQ#8 dependency annotation the
  same way P4-T08 has one, so this is consciously reversible once the DPO signs off. Chamber-side
  utilization (equipment, not personal data) is unaffected and must keep working.

  **(2) Finding #2 (Medium) + #3 (Low) — JOSE dependency cleanup.** Replace `python-jose[cryptography]`
  with `pyjwt[crypto]` in `backend/core/oidc.py` (removes the `ecdsa` / PYSEC-2026-1325 transitive
  dependency entirely — the preferred fix) OR, if the migration is riskier than it looks, pin
  `OIDCSettings.algorithms` hard to RS* and add a documented `pip-audit` ignore entry with a review
  date. Either way, drop the unused `authlib` dependency from `pyproject.toml` (imported nowhere).
  `pip-audit` must be clean (or clean-with-documented-ignore) afterward.

  **(3) Finding #7 (Low) — SSE error text.** In `backend/workers/schedule_tasks.py`, relay a generic
  `"Solver run failed — see server logs"` to the SSE `error` field; keep the full `str(exc)` only in
  `ScheduleRun.error_message` (Admin-only) and server logs.

  Do not touch `backend/scheduling/`.
  Depends on: P3-T08 (the FAIL that created this task).
  Acceptance: live-verified (same method P3-T08 used — real tokens, real endpoints) that no
  `name`/`assigned_engineer_name` for a non-self reader appears in any `/capacity/utilization-matrix`
  or `/gantt` response; chamber utilization + the rest of the Gantt/Capacity payloads unchanged;
  hub-scoping and RBAC unregressed; `pip-audit` clean (or documented ignore); SSE `error` field
  carries no raw exception text; full backend suite green; `backend/scheduling/` untouched. Then
  `security-auditor` delta-re-checks findings #1/#2/#3/#7 and flips the P3-T08 gate vote.
  Owner: backend-builder.
  Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31] P3-T09 —
  backend-builder" entry. Independently re-ran the full backend suite (309 passed, 86.58% coverage)
  and the scheduling suite (80 passed, 93.58%, unchanged), confirmed `backend/scheduling/` untouched
  by mtime, confirmed `pip-audit` clean and `python-jose`/`ecdsa`/`authlib` genuinely absent from the
  resolved dependency tree (not just pinned/ignored), confirmed `ruff check .` clean, and read the
  `EngineerWeekLoad`/`GanttStepRow`/`show_engineer_names` and both SSE-error-text diffs directly in
  source. All three deliverables delivered as separable diffs; a second SSE leak in
  `schedule_runs.py::_build_synthetic_terminal_payload` was discovered and fixed beyond the task's
  literal file reference, correctly judged in-scope of finding #7's intent.
  **security-auditor delta-recheck (2026-08-31, see MEMORY.md "[2026-08-31] P3-T09 delta-recheck —
  security-auditor" entry): PASS on findings #1/#2/#3/#7 — the P3-T08 FAIL is flipped with respect
  to these four findings**, live-verified against a real throwaway Postgres 17 + Redis 7 + JWKS
  server + running `uvicorn` process with real tokens for Portfolio Manager/Hub Planner/Engineer:
  no `name`/`assigned_engineer_name` leaks to non-self readers, chamber-side data unaffected,
  hub-scoping/RBAC unregressed, both SSE leak sites confirmed fixed live (including the second one),
  `ScheduleRun.error_message` confirmed unreachable via any API response model. One new Info-only
  cosmetic note (a stale code comment) does not block. Flagged fast-follow (non-blocking, outside
  this task's remit): `frontend/src/surfaces/capacity/api/types.ts`'s `EngineerWeekLoad.name: string`
  is now a stale TS contract given the backend field removal — pick up whenever frontend-builder next
  touches that file. **This does not close the P3 phase gate — P3-T07 (qa-inspector) has not run.**)

## P4 — Design system + the six surfaces

**Owner:** frontend-builder
**Gate:** qa-inspector PASS + workflow-auditor PASS

- **P4-T01** — Design tokens and base components (shadcn/ui + Tailwind, sourced from 21st.dev where
  they fit). Status: DONE (reviewed by orchestrator and accepted — see MEMORY.md
  "[2026-08-31 00:45] P4-T01 review" entry. Started 2026-08-30 out of phase sequence on
  project-owner direction, finished 2026-08-31 — the original start was never logged, so the
  frontend-builder entry covers the whole task. Independently re-ran `pnpm typecheck`/`lint`/`test`/
  `build` fresh: all clean, 28/28 test files (57/57 tests) pass, bundle 127.5 KB / 400 KB gzip
  budget. Spot-checked for scope/rule compliance: zero `dangerouslySetInnerHTML`, zero raw hex in
  components, zero real six-surface functionality (placeholders only), `schedule-outcome-meta.ts`'s
  5 outcome flags match DOMAIN_RULES.md exactly including CAT_NOT_ALLOWED's warning-not-block
  semantics. Scope is limited to the backend-independent scaffold + design system only — the six
  surfaces P4-T02..T07 stay TODO until P3's API contracts exist. P2 and P3 gates are NOT passed;
  this remains an authorized parallel-track exception, not a P4 phase advance — the formal P4 gate
  is still P4-T09/P4-T10.)
- **P4-T02** — Global RPD Dashboard surface. Status: DONE (reviewed by orchestrator and accepted —
  see MEMORY.md "[2026-08-31] P4-T02 review — rpd-orchestrator" entry. Independently re-ran
  `pnpm typecheck` / `lint` / `test` / `build` fresh: all clean, 40 files / 91 tests pass, initial
  load 128.8 KB gzip / 400 KB budget, Dashboard is a 32.6 KB-gzip lazy chunk. I9 verified in code:
  every schedule-outcome number is read verbatim from `GET /dashboard/completing-within-year` (which
  the backend sources entirely from `ScheduleRunProjectOutcome` snapshot rows — zero client
  recompute); `schedule-run-provenance.tsx` states the active run version + the within-year rule
  verbatim from DOMAIN_RULES.md in visible UI text, closing the P4-T01-review carry-forward flag and
  the P2-T10 "10-vs-11" recommendation. `dangerouslySetInnerHTML` / raw-hex / `three` all absent from
  the new surface. Decision #1 (hand-built accessible CSS/SVG bars instead of ECharts/Recharts on the
  index route, to protect the initial-load budget) accepted for the Dashboard's simple bar
  comparisons — but P4-T03 (Capacity) / P4-T04 (Matrix) MUST install and use the stack's
  ECharts/Recharts in their own route chunks; if hand-built chart primitives end up spanning
  surfaces, an ADR is required then. Backend gap (a) — `CompletingWithinYear` lacks
  `solver_type`/`computed_at`/`within_year_week`, forcing a second `GET /schedule-runs/active` call
  and one hard-coded `52` display literal — flagged to backend-builder to fold into P3 before the P3
  gate; not blocking (current approach is I9-safe). Gaps (b)/(c) are cosmetic row-level, noted.)
- **P4-T03** — RPD Capacity surface. Status: DONE (built by a `frontend-builder` session that ended
  before writing its `docs/MEMORY.md` entry or running final verification; the orchestrator reviewed
  against Invariants I6 / I7, ADR 0002 / 0003, OPEN_QUESTIONS #8, and the P4-T02 review's Recharts
  condition, then closed it — see MEMORY.md "[2026-08-31] P4-T03 — RPD Capacity surface" entry.
  Three panels (hub load vs. capacity, class breakdown, chamber utilization heatmap) each render one
  `capacity.py` endpoint verbatim — zero browser recompute; load figures traced to the active
  `ScheduleRun` snapshot (I6 / I7). Engineer side of the utilization matrix **withheld** with a
  visible GDPR placeholder (P4-T08 / OPEN_QUESTIONS #8). `recharts@3.10.1` added, lands in the lazy
  `/capacity` chunk (110 KB gzip) — initial load 129.3 KB / 400 KB budget. typecheck/lint clean,
  49 files / 119 tests pass, `backend/` untouched. Still the authorized P4-T01 parallel-track
  exception, not a P4 phase advance — formal gate is P4-T09 + P4-T10.)
- **P4-T04** — Prioritization Matrix surface, with currency toggle. Status: DONE (reviewed by
  orchestrator and accepted — see MEMORY.md "[2026-08-31] P4-T04 review — rpd-orchestrator" entry.
  `/matrix` surface: 13-dimension scoring grid (row-virtualized, single scroll container, sticky
  header + project column), server-driven `CurrencyToggle` (new `components/shared/` — zero
  browser-side currency math, only flips `?currency=`), `ScoreCell` rendering `normalized_pct` /
  `weighted_score` / `suggested_band` verbatim from the API, separate `Hard gate → P1` rule badge
  (the backend's `suggested_band` deliberately does NOT encode the override — that is the deferred
  "Apply Priorities" action — and the surface does not synthesize an effective band client-side, per
  I9), react-hook-form + zod inline `PUT /priorities/{id}` edit that invalidates only
  `['priority-matrix', …]` keys (never schedule-runs/capacity), Recharts band-distribution bar in
  the lazy `/matrix` chunk only. Independently re-ran typecheck / lint / test / build fresh: clean,
  57 files / 149 tests, initial load 129.5 KB gzip / 400 KB budget, `/matrix` lazy chunk 35.7 KB
  gzip with Recharts confined to the shared lazy chunk. One review blocker found and fixed before
  close: `usePriorityMatrix` omitted `hubId` from its TanStack Query key while the Hub filter is
  user-facing — stale-cache bug on a hub-scoped surface; fixed + regression test added. Flags
  adjudicated: 3 SKILL-mandated form deps (lazy-chunk only), matrix-local virtual grid, `canEdit`
  default-true + 403-downgrade (no `/me` endpoint; frontend auth is P6-T03) all accepted.
  Recommendation logged for backend-builder: add `effective_band` to `PriorityMatrixRow` in P5 so
  the hard-gate override has a single API field — not a P4-T04 change. Still the authorized P4-T01
  parallel-track exception, not a P4 phase advance — formal gate is P4-T09 + P4-T10.)
- **P4-T05** — Project Execution Timeline (custom Gantt) — see `dataviz-gantt` skill. Status: DONE
  (reviewed by orchestrator and accepted — see MEMORY.md "[2026-08-31] P4-T05 review — rpd-orchestrator"
  entry. `/timeline` surface (route path from `nav.ts`, the single source of truth — folder + query
  key stay `gantt`): hand-built virtualized SVG Gantt, no commercial Gantt lib, no new npm dep, no
  three.js. Week-bucket coordinate module (`lib/gantt-coordinates.ts`) is pure + unit-tested — every
  bar x/width is a render of server `planned_*`/`actual_*` week integers, never a sum of
  `duration_weeks`; verified in code (`gantt-chart.tsx::BarLayer` is the only `barGeometry` caller).
  All outcome/conflict badges (`LEFT_OUT`/`SPILLOVER`/`CAT_NOT_ALLOWED`/`ENG_CONFLICT`/`OVERLAP`) are
  server flags rendered verbatim via the shared `schedule-outcome-badge`. Freeze toggle: I10-safe
  (already-frozen path only offers unfreeze, never presented as changing locked dates; does not
  recalc; invalidates `['gantt']` only, surfaces a "recalc needed" notice). `hubId` in the query key
  (P4-T04 review lesson applied). Independently re-ran fresh: `pnpm typecheck`/`lint` clean;
  `pnpm test` **64 files / 197 tests pass** (parallel mode — the subagent's reported parallel-mode
  localStorage failure did NOT reproduce for the orchestrator, flagged for qa-inspector regardless);
  `pnpm build` clean, initial load **130.0 KB gzip / 400 KB** (entry carries no framer-motion/Gantt
  code), `/timeline` lazy chunk **48.1 KB gzip**; ban-grep clean; `backend/` untouched. Flags
  adjudicated (see review entry): activity-load bottleneck strip is a view-derived non-numeric
  histogram of the active-run snapshot across filtered projects (NOT scroll-dependent — aggregates
  the full filtered `rows`, not the virtualized slice) — accepted as an I9-safe scan aid, **flagged
  for P4-T10 workflow-auditor** who has final say; SVG-only (no Canvas fallback), repo
  `usePrefersReducedMotion` over framer's, single sliding `layoutId` focus-accent, `limit=500` fetch
  with truncation notice — all accepted. Backend contract gap (no `solver_type`/`computed_at` on
  `GanttResponse` → second `GET /schedule-runs/active` call for provenance) — same flag as
  P4-T02/T03, folded into that P3 follow-up, not blocking. Still the authorized P4-T01
  parallel-track exception, not a P4 phase advance — formal gate is P4-T09 + P4-T10.)
- **P4-T06** — Project Registration surface, with hard-gated required fields. Status: DONE
  (reviewed by orchestrator and accepted — see MEMORY.md "[2026-09-01] P4-T06 review —
  rpd-orchestrator" entry. `/register` surface: 17 new files under `frontend/src/surfaces/
  registration/` — types/API mirrors of `backend/schemas/project.py`, hub-scoped TanStack Query
  hooks, an RHF+zod create/edit form, a hard-gate-status panel driving `GET /projects/{id}/
  hard-gate-status` + `POST /projects/{id}/submit` verbatim, a row-virtualized project list, routing
  wiring, plus a correctness fix to two dead `lib/query-keys.ts` placeholders (`ProjectListFilters`,
  `queryKeys.engineers`) left over from P4-T01. Terminology distinction (Registration's 7-field
  "leave Draft" hard gate vs. the Matrix's 3-reason "force P1" hard gate) independently verified
  against `docs/DOMAIN_RULES.md` lines 125-130 and `backend/services/project_hard_gates.py` — the two
  are genuinely distinct concepts sharing a name; the surface never imports `HardGateReason`
  (grep-confirmed). Independently re-ran `pnpm typecheck`/`lint`/`test`/`build` fresh: typecheck
  clean; lint 0 errors, 1 pre-existing-pattern warning (`react-hooks/incompatible-library` on
  `useVirtualizer`, same as Matrix/Gantt); **71 files / 234 tests pass** (was 64/197 at the P4-T05
  baseline); build clean, bundle-budget **PASS at 132.0 KB gzip / 400 KB** (RegistrationPage lazy
  chunk 6.87 KB gzip) — all figures match the builder's report exactly. Ban-grep
  (`dangerouslySetInnerHTML`/`from 'three'`/`console.*`) clean; `backend/` confirmed untouched by
  mtime (all referenced backend files predate this session's frontend file mtimes by hours-to-days).
  **GDPR ruling (OPEN_QUESTIONS.md #8):** displaying an engineer's *name* as a project's assigned
  leader (identity only — no hours/busy-weeks/workload figures attached) is ruled OUTSIDE OQ#8's
  scope, not blocking. Reasoning: (a) OQ#8's own text scopes the block to "per-engineer
  *utilization*" and "named-engineer *load*," not to bare identity; (b) `leader_engineer_id` is one
  of Registration's own 7 hard-gate required fields — the surface cannot function or satisfy its own
  Draft-exit gate without a leader picker showing engineer names, unlike utilization/workload
  reporting which is optional/ancillary; (c) `Project.leader_engineer_id` and this business need
  predate P4 (present since P1-T01); (d) the P3-T09 security-auditor remediation, which did withhold
  `assigned_engineer_name` from `/gantt` and `/capacity/utilization-matrix` for non-self readers,
  deliberately left `GET /engineers` itself untouched — the existing security-reviewed precedent
  already draws this exact line. Flagged residual, non-blocking consideration for the record: because
  the project list can show every project's leader, an attentive viewer could roll up "how many
  projects does engineer X lead" as a soft/indirect workload signal — this is a materially weaker
  signal than an explicit busy-weeks figure and is not what OQ#8 or the P3-T09 finding targeted, but
  should be revisited if the DPO's eventual answer is broader than "utilization figures." Not
  sufficient ambiguity to withhold the leader field today, given (a)-(d) above and that doing so
  would break the surface's own hard-gate requirement.

  **[2026-09-01] Remediation:** orchestrator's independent re-verification (routine, not triggered by
  a new change) found `pnpm typecheck`/`pnpm build` failing (2 TS2769 errors, invalid `exact` prop on
  a role query) and 1 failing test (a shadcn-stock-convention assertion mismatched to this repo's
  actual `Skeleton` markup) in this surface's own test files — both regressions postdated this task's
  original close with no MEMORY.md entry explaining them (see MEMORY.md's "P4-T06 remediation" and
  "P4-T06 remediation review" entries for the full forensic note). Fixed by a frontend-builder session
  scoped to exactly those two test files; independently re-verified clean:
  typecheck/lint/test(295 passed)/build(132.5 KB gzip) all green. Status remains DONE.)
- **P4-T07** — Capacity Planning surface (engineers, chambers, Apply Logic, Auto-assign).
  Status: DONE for its deliberately-scoped deliverable — Engineer CRUD, Chamber CRUD, and Apply
  Logic (reviewed by orchestrator and accepted — see MEMORY.md "[2026-09-01] P4-T06 remediation
  review + P4-T07 review — rpd-orchestrator" entry). **Auto-assign deliberately NOT built — remains
  blocked on `docs/OPEN_QUESTIONS.md` #10** per this task's explicit scope limit; a visible,
  specifically-worded placeholder (`components/auto-assign-placeholder.tsx`, names OQ#10 and the
  concrete `26-00201` scenario) ships in its place, mirroring the P4-T03/P4-T08 GDPR-placeholder
  pattern. "Apply Logic" → `POST /schedule-runs/greedy-recalc` (deterministic greedy SGS, not
  CP-SAT) confirmed the only reading consistent with `docs/PROJECT_AND_STACK.md` §2's two-action
  description and with OQ#10 blocking Auto-assign specifically. The RBAC granularity gap this task
  flagged (Hub Planner has Capacity Planning R/W per the role matrix but 403s on Apply Logic
  specifically, since that endpoint is `RoleName.ADMIN`-only) is **not a new gap** — confirmed by
  direct code read to be the same Admin-only design already reviewed and accepted in P3-T01/P3-T02;
  no backend change needed. Independently re-ran typecheck/lint/test(295 passed, includes this
  surface's 10 new files)/build(132.5 KB gzip / 400 KB) fresh — all clean. No per-engineer
  utilization/workload data anywhere in this surface (bare identity/config fields only); P4-T08
  remains correctly unaffected/BLOCKED. Auto-assign itself is not reopened as a remediation task — it
  was never in scope pending OPEN_QUESTIONS #10's answer.
- **P4-T08** — GDPR gate check: confirm `docs/OPEN_QUESTIONS.md` #8 is resolved before shipping any
  per-engineer utilization view. **Blocking** — do not implement named-engineer utilization display
  until this is unblocked. Status: BLOCKED (on OPEN_QUESTIONS #8)
- **P4-T09** — `qa-inspector`: Vitest + Testing Library units, Playwright per-surface, axe
  accessibility pass on every surface, bundle budget check (400 KB gzipped initial).
  **Status: FAIL (2026-09-01)** — see MEMORY.md "[2026-09-01] P4-T09 — qa-inspector" entry. Vitest
  (295 passed / 81 files, after fixing a real Testing-Library `asyncUtilTimeout` flakiness bug in
  test infra only — no application code touched), Playwright functional flows (7/7 across all six
  surfaces, including new coverage added for P4-T07's Planning surface), and bundle budget
  (132.5 KB gzip / 400 KB) all PASS. **Axe accessibility FAILS on all six surfaces** — one CRITICAL
  (`aria-required-children`, Registration's virtualized row markup, 23 instances) plus a
  cross-cutting `serious` `color-contrast` defect in the global `--color-text-subtle` design token
  (2.72:1 vs required 4.5:1) that mechanically affects every surface via the always-rendered
  `AppHeader`, plus `definition-list` (Dashboard ×2) and `scrollable-region-focusable` (Capacity ×1,
  Dashboard ×2). Remediation opened: **P4-T11** (below), then closed.
  **[2026-09-01] Delta-recheck: PASS** (see MEMORY.md "[2026-09-01] P4-T09 delta-recheck —
  qa-inspector" entry) — independently re-verified live, twice over (the repo's own Playwright suite
  across two fresh-seed runs, plus a separately-written out-of-band axe scan): zero serious/critical
  violations on all six surfaces; the two structurally-riskiest fixes (`virtual-data-table.tsx`'s
  role/scroll-container reorder, `project-list.tsx`'s new `role="cell"` wrapper) confirmed to hold up
  under live, real-browser interaction (scroll, virtualization, keyboard nav, expand/collapse
  aria-state), not just static markup; the remediation's contrast-ratio arithmetic independently
  reproduced exactly for all four token/theme combinations. No regression: typecheck/lint/Vitest
  (295/81)/build (132.5 KB gzip) all unchanged. **This flips the vote to PASS — qa-inspector's half
  of the P4 phase gate is satisfied.** Status: DONE.
- **P4-T10** — `workflow-auditor`: reconciles Dashboard/Capacity/Matrix/Gantt numbers against a
  single schedule-run source; confirms invariant I9 (within_year count has no independent
  calculation). Status: DONE (workflow-auditor half of the P4 gate — see MEMORY.md "[2026-09-01]
  P4-T10 — workflow-auditor: Dashboard/Capacity/Matrix/Gantt reconciliation" entry. **PASS**,
  live-traced end-to-end against a real ephemeral Postgres + the real FastAPI app (not just static
  code review): seeded the real 46-project demo dataset, ran the real greedy scheduler via
  `POST /schedule-runs/greedy-recalc`, then cross-checked `GET /schedule-runs/active`,
  `/dashboard/completing-within-year`, `/capacity/hub-load`, `/capacity/class-breakdown`,
  `/gantt?limit=500`, and `/priorities`(+`/summary`) against each other and against an independent
  by-hand recomputation for the same active run — exact match on within_year/spillover/left_out
  project-id sets between Dashboard and Gantt, exact match on per-hub design/lab load (I6/I7) between
  Capacity's own figures and an independent recompute from Gantt's raw step rows, identical
  `schedule_run_version` across all four endpoints, and consistent hub-scoped results for a Hub
  Planner principal. Matrix confirmed to carry zero schedule-run-derived fields (by design — a
  priority-scoring surface only), so it is correctly out of scope for the outcome/load reconciliation
  rather than a gap. Both carry-forward flags adjudicated with final say: (1) the Gantt
  activity-load bottleneck strip is confirmed I9-safe (a step-bar-count scan aid over the full
  filtered row list, never a project-outcome number, flag closed); (2) the backend
  `solver_type`/`computed_at` contract gap (second `GET /schedule-runs/active` call for provenance)
  is re-confirmed non-blocking — applied uniformly via one shared component/hook pattern across all
  three surfaces, never feeds a headline number, zero observed inconsistency in the live trace (one
  narrow theoretical race noted for the already-planned backend follow-up, not gate-blocking). One
  new, out-of-scope observation flagged for backlog routing (not actioned here, not a P4-T10
  blocker): the greedy scheduler's documented `project_id` tie-break (P2-T01, accepted) uses the
  DB-surrogate UUID rather than the stable `external_code`, so re-seeding/re-importing an otherwise
  -identical portfolio can silently reshuffle which marginal, equally-ranked project lands
  within-year vs. spillover — confirmed NOT an Invariant I8 violation (pure-function determinism on
  one fixed input holds) and NOT a cross-surface contradiction (every surface stayed internally
  consistent with every other surface within each independent run). **Caveat**: this PASS covers only
  P4-T10's own acceptance criteria. The full P4 gate ("qa-inspector PASS + workflow-auditor PASS")
  still requires `P4-T09` (qa-inspector, TODO) and is further gated by `P4-T07`/`P4-T08`
  (TODO/BLOCKED) before a phase advance.)

- **P4-T11** — REMEDIATION (opened by orchestrator in response to P4-T09's FAIL). Top-of-phase
  priority per the Gate Protocol. Fix exactly the four axe findings from the P4-T09 qa-inspector
  entry, scoped narrowly so the delta-recheck stays clean:
  1. **Global `color-contrast` (all six surfaces)** — `src/styles/tokens.css`'s
     `--color-text-subtle` semantic token renders at 2.72:1 (`#8e9eb4` on `#ffffff`) against WCAG
     AA's 4.5:1 requirement for normal text; the same family also fails at 2xs (11px) size on status
     pills/captions (e.g. "In Queue" measured 4.14:1). Darken the token (and/or bump caption font
     weight/size where 11px is used) until every current usage clears 4.5:1 for normal text / 3:1 for
     large text — re-run axe per-surface after, don't just eyeball a contrast calculator, since the
     token is reused at multiple sizes/weights.
  2. **Registration CRITICAL `aria-required-children` (23 instances)** —
     `surfaces/registration/components/project-list.tsx`'s virtualized rows use `role="row"` on
     `<div>`s whose children are plain `<div>`/`<button aria-label>` elements instead of
     `role="cell"`/`"gridcell"`. Give each direct child cell the matching ARIA role (or restructure to
     avoid `role="row"` if a cell-role structure doesn't fit the virtualized layout — Matrix/Gantt's
     own virtualized lists don't trigger this rule; mirror whichever of their patterns applies).
  3. **Dashboard `definition-list` (2 instances)** — two `<dl>` elements (one
     `aria-label="Pipeline composition..."`, one under `.border-t`) have children that aren't
     exclusively `<dt>`/`<dd>`/`<script>`/`<template>`/`<div>` pairs. Fix the markup structure.
  4. **`scrollable-region-focusable` (Capacity ×1, Dashboard ×2)** — the virtualized table scroll
     containers (`data-testid="virtual-table-scroll"`, `overflow-auto`) have no `tabindex`, so a
     keyboard-only user can't scroll them. Add `tabIndex={0}` (and an accessible name/role if axe
     still flags it after that).
  Do not touch `backend/` or `backend/scheduling/`. Do not attempt to resolve `docs/OPEN_QUESTIONS.md`
  #8/#10 or touch P4-T08/Auto-assign.
  Depends on: P4-T09 (the FAIL that created this task).
  Acceptance: qa-inspector delta-recheck (same live-axe method as P4-T09) confirms zero
  serious/critical axe violations on all six surfaces for these four finding classes; full Vitest
  suite still green (no regression); bundle budget still under 400 KB gzip; `pnpm typecheck`/`lint`
  clean.
  Owner: frontend-builder.
  Status: DONE (see MEMORY.md "[2026-09-01] P4-T11 — accessibility remediation — frontend-builder"
  entry, and its independent qa-inspector delta-recheck PASS above. All four finding classes fixed:
  a new `--slate-450`/`--slate-550` primitive pair repointing `--color-text-subtle`/`--color-text-
  muted` in both themes with real margin (min 4.84:1); ARIA `columnheader`/`cell` roles added to
  Registration's virtualized row markup mirroring Matrix's existing pattern; Dashboard's `<dl>` bar-
  track element switched from `role="presentation"` to `aria-hidden="true"` (the former still fails
  the content-model check regardless of tag); `tabIndex={0}` added to Dashboard's virtualized-table
  scroll container (with a `role="table"`/scroll-container structural reorder to fix a regression
  the fix itself introduced, self-caught via live axe) and to Capacity's chamber-utilization
  horizontal-scroll wrapper (the actual live violation — no literal `virtual-table-scroll` testid
  existed under `capacity/`). Two out-of-scope observations flagged for backlog, not fixed:
  Capacity's legend `<dl>` in `chamber-utilization-heatmap.tsx` (a `dt`-without-`dd` structure not
  live-flagged by axe in this session's scan) alongside the already-on-file Registration-hard-gate/
  `priority` and `project_id`-tie-break items.)

## P4 PHASE GATE: PASSED (2026-09-01)

Both gate requirements per this section's header ("qa-inspector PASS + workflow-auditor PASS") are
now satisfied:
- **workflow-auditor PASS** — P4-T10, live-traced end-to-end cross-surface reconciliation
  (Dashboard/Capacity/Gantt numbers, Invariant I9, I6/I7) against a real ephemeral Postgres + FastAPI
  app.
- **qa-inspector PASS** — P4-T09's FAIL on accessibility, remediated by P4-T11, and independently
  delta-rechecked live (twice over) by qa-inspector, confirming zero serious/critical axe violations
  on all six surfaces with no functional or bundle-budget regression.

**What this does and doesn't mean:** the five originally-scoped P4 surfaces (Dashboard, Capacity,
Matrix, Timeline/Gantt, Project Registration) plus P4-T07's in-scope Capacity Planning deliverable
(Engineer CRUD, Chamber CRUD, Apply Logic) are DONE and gated. **P4-T08 (GDPR gate check) remains
BLOCKED** on `docs/OPEN_QUESTIONS.md` #8 — no named-engineer utilization view may ship regardless of
this gate closing. **Auto-assign remains un-built**, blocked on `docs/OPEN_QUESTIONS.md` #10 — both
require a real client/DPO answer, not an engineering default, and neither is retroactively unblocked
by this phase gate closing around them (mirroring how P3's gate closed around its own explicitly-
deferred, non-blocking findings). Non-blocking backlog items carried forward for P5/routing:
Registration hard-gate fields vs. scheduler `priority` precondition; greedy scheduler's
`project_id`-vs-`external_code` tie-break reproducibility; Capacity's legend `<dl>` structure.

P5 (Scenarios, versioning, history, exports) may now start.

- **Backlog (not gate-blocking, logged for routing):** Registration's 7 hard-gate required fields
  (leader, category, type, actual_start_week, tcogs, selling_price, gross_margin) do not include
  `priority` — a project can leave Draft with `priority=None`, which then breaks
  `POST /schedule-runs/greedy-recalc` for the entire portfolio (422) on the next run, per P4-T09's
  live-reproduced finding. Needs a decision (add `priority` to the hard-gate field list, or give it a
  required default) spanning Registration's frontend hard-gate list and/or the scheduler's
  input-validation contract — route to backend-builder/algorithm-engineer. Also open: the P4-T10
  `project_id`-vs-`external_code` greedy tie-break reproducibility backlog item (see that entry).

## P5 — Scenarios, versioning, history, exports

**Owner:** backend-builder + frontend-builder
**Gate:** qa-inspector PASS + workflow-auditor PASS — **STATUS: PASSED (2026-09-05, re-run post
P5-T10)**, see MEMORY.md "[2026-09-05] P5 PHASE GATE RE-RUN (post P5-T10): PASS" entry. P5 is closed;
P6 is unblocked.

- **P5-T10** — REMEDIATION (blocks the P5 gate). `backend/services/notifications.py`'s
  `DELAY_INTRODUCED` trigger compares raw `outcome.end_week`/`ScheduleRunProjectOutcome
  .last_step_end_week`, neither of which ever includes `Project.delay_weeks`
  (`scheduling/greedy.py`'s `completion_week = end_week + project.delay_weeks` is computed only for
  in-memory `within_year`/`spillover` classification, never persisted as a column;
  `schedule_persistence.py` persists the undelayed `end_week` as `last_step_end_week`). A planner
  recording a delay via `PUT /projects/{id}` (`delay_weeks`) — the most direct real-world "this
  project is now delayed" workflow in the app — can flip a project's `within_year` from `True` to
  `False` (a real SPILLOVER regression) while `end_week` stays identical, producing **zero
  notifications**. Fix: the diff must account for `delay_weeks`/`completion_week`, or more directly,
  compare the already-persisted `within_year: Mapped[bool]` column (`models/schedule.py`) between
  the two runs — that field already reflects delay correctly and needs no new computation. Either
  fix or an explicit ADR narrowing this v1 feature to raw-end-week-only delay detection (if the
  project owner accepts that limitation) is acceptable; silence is not. **Also fix while touching
  this area** (secondary, non-blocking finding from the same gate check): `ScenarioApplyRunSummary
  .change_count` (portfolio-wide, unfiltered) can silently disagree with the same version's
  `ScenarioApplyRunDetail.changes` count (hub-scope-filtered per viewer) in the Version History UI,
  with no indication the two counts differ in scope — add a UI note or filter-consistent count.
  Status: DONE. See MEMORY.md "[2026-09-05] P5-T10 — backend-builder (via rpd-orchestrator
  delegation)" entry for the full fix detail and independent verification.

- **P5-T01** — Scenario edit state (Zustand) with undo/redo, diffed against last committed version
  on Apply. Status: DONE for priority-score edits — the only entity type P5-T02's backend contract
  currently accepts (reviewed by orchestrator and accepted — see MEMORY.md "[2026-09-01] P5-T01 —
  frontend-builder" entry). New `useScenarioStore` (Zustand, no persistence — an in-progress
  scenario is intentionally ephemeral): per-project pending edits with a captured `baseline` (never
  rebased on re-staging) and `hasScore` flag so a first-time score for a previously-unscored project
  is never dropped as a false no-op; simple past/future snapshot stacks for undo/redo with correct
  redo-branch pruning on a new edit after undo; pure `computeScenarioDiff`/`isNoOpEdit` matching
  `ScenarioPriorityScoreChange`'s full-row-replacement shape exactly (confirmed against
  `backend/schemas/scenario.py` directly, not assumed). Additive `ScenarioModeToggle` +
  `ScenarioPendingPanel` (diff list, Undo/Redo, notes, Apply/Discard) on the existing `/matrix`
  surface; `score-edit-dialog.tsx` gained an additive `mode` prop with byte-identical
  validation/submit contract; the pre-existing immediate-write `PUT /priorities/{id}` flow is
  untouched and its own tests pass unmodified. `useApplyScenario` invalidates `['priority-matrix']`
  only, matching `useUpdatePriorityScore`'s existing I9-consistent precedent (a scenario Apply never
  triggers a schedule run). Independently re-ran `pnpm typecheck`/`lint` fresh: clean (0 errors, the
  1 pre-existing Registration warning only); `npx vitest run --no-file-parallelism --exclude
  "e2e/**"` — **341 passed / 83 files** (was 295/81, +46), exact match; `pnpm build` — bundle-budget
  **PASS, 132.5 KB gzip**, byte-for-byte unchanged (new code lives in the lazy `MatrixPage` chunk).
  Spot-checked the flagged `ScenarioModeToggle` accessible-name fix (two distinct ids via
  `React.useId()`, `role="group"`/`aria-labelledby` separating the group heading from the checkbox's
  own label) directly in source — confirmed as described. `backend/` untouched (read-only). **Not
  built, correctly out of scope**: Capacity/Engineer/Chamber scenario edits (no backend path yet)
  and Versions & History UI (P5-T03's job, though the read-endpoint response types this task added
  give P5-T03 a head start).
- **P5-T02** — Backend snapshot-on-Apply: pre-apply state versioned to Postgres before writing new
  state. Status: DONE for a real, tested vertical slice — `PriorityScore` scenario edits only
  (reviewed by orchestrator and accepted — see MEMORY.md "[2026-09-01] P5-T02 — backend-builder"
  entry). New `ScenarioApplyRun`/`ScenarioApplyChange` models (immutable before/after JSONB
  snapshots, versioned, hub-scoped via `project_id`/`hub_id`), `POST /scenarios/apply` (generalises
  the existing `PUT /priorities/{id}`, MATRIX/WRITE, atomic — validates every project before writing
  anything), `GET /scenarios/versions`/`GET /scenarios/versions/{version}` (MATRIX/READ, hub-scoped,
  404-not-200-empty on out-of-scope). Independently re-ran: `ruff check .` clean; full backend suite
  **357 passed / 87.57% coverage** (was 339/86.58%); scheduling suite **80 passed / 93.58%**,
  confirmed byte-for-byte unchanged and untouched by mtime; the new `tests/test_scenario_apply_api.py`
  re-run in isolation, **18/18 passed**, covering real DB-verified snapshot creation, HTTP- and
  service-layer atomicity (a mid-batch failure leaves zero rows, not a partial write), RBAC negative
  tests, and hub-scoped list/detail. **Deferred, flagged, not built:** `Project`/`Engineer`/`Chamber`
  diff write paths (schema is generic enough to add later without a new migration; `POST
  /scenarios/apply` only accepts `priority_scores` today) — P5-T01 must be scoped to priority-score
  edits only against this contract until a follow-up task extends it. A revert-to-version-N endpoint
  was deliberately not built — that's P5-T03's job; the snapshot data needed for one already exists.
  Also discovered: a pre-existing, unused `PriorityApplicationRun`/`PriorityApplicationResult` model
  pair (from an earlier session) is a *different* mechanism for the still-unbuilt portfolio-wide
  "Apply Priorities" band-recompute action — not to be conflated with this task's scenario-apply
  versioning when that action is eventually built.
- **P5-T03** — Versions & History UI: browse and compare historical schedule runs. Status: DONE for
  what's actually versioned today — priority-score scenario-apply history only (reviewed by
  orchestrator and accepted — see MEMORY.md "[2026-09-02] P5-T03 review — rpd-orchestrator" entry).
  Read-only browse/compare dialog on the Matrix surface consuming P5-T02's `GET /scenarios/versions`
  / `GET /scenarios/versions/{version}`. Does NOT cover Capacity/Engineer/Chamber/Project edits or
  actual solver schedule runs — none of those have a backend versioning write path yet; the UI's own
  copy says so explicitly. No revert action (no backend endpoint to call).
- **P5-T04** — CSV/XLSX export for every surface, via MinIO for large exports. Status: DONE, backend
  only (reviewed by orchestrator and accepted — see MEMORY.md "[2026-09-02] P5-T04 review —
  rpd-orchestrator" entry). `GET /exports/{surface}` streams sync CSV/XLSX by default;
  `?async_export=true` dispatches to a new general-purpose `worker` Celery process (distinct from
  `solver-worker`) that writes to MinIO, polled via `GET /exports/jobs/{id}` and downloaded via
  `GET /exports/jobs/{id}/download` (server-proxied, no presigned URL). Both paths call one shared
  builder that reuses each surface's own existing read-endpoint function in-process, so RBAC/hub
  scoping/GDPR engineer-name-withholding are inherited automatically, never re-derived. **Not
  built, explicitly out of scope:** frontend Download UI/job-status poller (a follow-up frontend
  task). See MEMORY.md entry for the routed pre-existing `test_openapi_frontend_contract.py`
  allowlist gap this task discovered but correctly declined to fix under its own banner.
- **P5-T07** — Add P5-T03's `ScenarioApply*` frontend interfaces
  (`frontend/src/surfaces/matrix/api/types.ts`) to `tests/test_openapi_frontend_contract.py`'s
  `CONTRACT_TABLE`/`frontend_only` allowlist. Status: DONE (reviewed by orchestrator and accepted
  — see MEMORY.md "[2026-09-02] P5-T07 review — rpd-orchestrator" entry). All 7 interfaces added to
  `CONTRACT_TABLE` as real field-for-field checks against `backend/schemas/scenario.py` (6 `exact`,
  1 `subset` — `ScenarioApplyChangeSummary` against `ScenarioApplyChangeDetail`, mirroring the
  existing `GanttActiveRun`→`ScheduleRunSummary` subset precedent, since the backend base class is
  never emitted as its own OpenAPI component). No mismatches found; nothing loosened. Full backend
  suite now **383 passed, 0 failed, 90.16% coverage** — the P5-T04 review's flagged failure is
  resolved.
- **P5-T05** — Resolve `docs/OPEN_QUESTIONS.md` #7 (Excel import contract) before building any
  import path; export-only if unresolved. **Status: DONE (2026-09-01, orchestrator decision — no
  code, a scope-lock only).** OQ#7 remains unanswered by the real client; its stated default
  ("one-way export only (CSV/XLSX), no round-trip import contract, for v1") stands under the same
  project-owner provisional-proceed authorization already covering most other open questions (see
  `docs/OPEN_QUESTIONS.md`'s status note and `docs/MEMORY.md`'s 2026-08-29 P0-T02 entry) — OQ#7 was
  never called out as hard-blocking the way #8/#10 are. **Locking P5's scope accordingly: P5-T04
  builds export only; no Excel/CSV import endpoint or UI is in scope for P5.** Revisit and reopen
  P5-T04's scope if a real client answer to OQ#7 arrives establishing a round-trip contract.
- **P5-T06** — Notifications: in-app notification on schedule changes affecting a user's hub/
  projects. Status: DONE, backend only (reviewed by orchestrator and accepted — see MEMORY.md
  "[2026-09-04] P5-T06 review — rpd-orchestrator" entry). Generation is wired into the single choke
  point `services.schedule_persistence.persist_schedule_output`, gated on `activate=True` only,
  diffing the newly-activated run's in-memory outcomes against whatever run was previously active
  for the three named triggers (delay introduced, project left out, conflict raised). Recipients
  reuse the existing RBAC/hub-scope model (DASHBOARD/CAPACITY/GANTT read-eligible roles, hub-scoped
  or hub_scope_all, plus Engineer-own-project GDPR-conscious narrowing) — no new audience system.
  `GET /notifications`, `POST /notifications/{id}/read`, `POST /notifications/read-all`, gated on
  `get_current_principal` only (no `Surface`/`Action` — this is a per-user inbox, not a surface).
  Messages never reference financial fields. **Not built, explicitly out of scope:** frontend
  consumption (badge/list UI) — a follow-up frontend task.
- **P5-T08** — Frontend: wire P5-T04's six `GET /exports/{surface}` endpoints into a "Download"
  action on each of the six surfaces. Status: DONE, sync-only by deliberate scope decision (reviewed
  by orchestrator and accepted — see MEMORY.md "[2026-09-04] P5-T08 review — rpd-orchestrator"
  entry). One shared `<DownloadButton path filters fallbackFilename />` component (new
  `apiDownload`/`saveBlob` primitives) used on all six surfaces, each passing that surface's own
  live filter state through as export query params. No async/MinIO job-poll UI built — the sync
  path is sufficient at this app's real scale per the backend's own reasoning; `ExportJobAccepted`/
  `ExportJobStatusResponse` remain unconsumed by the frontend. RBAC relies entirely on the existing
  per-surface `AccessNotice` precedent (no new permission logic in the frontend) — confirmed the
  button sits inside the same `denied ? <AccessNotice/> : ...` branch on every surface.
- **P5-T09** — Frontend: wire P5-T06's `GET /notifications` + mark-read endpoints into a
  notification badge/list in the app shell. Status: DONE (reviewed by orchestrator and accepted —
  see MEMORY.md "[2026-09-05] P5-T09 review — rpd-orchestrator" entry). `NotificationBell` mounted
  once in `AppHeader`, real 60s poll (`refetchInterval`), no `AccessNotice` gate (correct — every
  authenticated user has an inbox, gated on `get_current_principal` only, not per-surface RBAC).
  This task's own build surfaced and fixed a real full-suite test-infra bug along the way: abandoned
  `QueryClient` instances across the test suite were leaking real `gcTime` timers
  (`@tanstack/query-core`'s own documented scalability caveat), which this task's `AppHeader`
  mount measurably worsened; fixed in `frontend/src/test/setup.ts` (patches `QueryClient.prototype
  .mount` to track and `.clear()` every client per `afterEach`) — test-infra only, no shipped
  behavior changed. See MEMORY.md for full root-cause detail and the honestly-flagged small
  residual (~64 pending timers, understood, not eliminated, well below TanStack's stated danger
  threshold).

## P6 — Security hardening, SSO, Docker Compose, observability

**Owner:** security-auditor + backend-builder
**Gate:** security-auditor PASS — **STATUS: PASSED (2026-09-05)**, see MEMORY.md "[2026-09-05] P6-T07
— security-auditor: full OWASP ASVS L2 pass across the whole app (P6 gate)" entry (zero
Critical/High findings). **However, P6 as a whole is NOT fully closed**: P6-T03 (OIDC cutover to the
client's real production IdP) remains BLOCKED on `docs/OPEN_QUESTIONS.md` #9 (client has not
confirmed IdP/app-registration credentials). The security gate itself does not require T03 to be
done — security-auditor explicitly assessed the still-dev-Keycloak-pointed OIDC implementation and
found no defect in the mechanism itself, only in what it's currently pointed at — but do not treat
P6 as a fully finished phase or silently assume real SSO is live when starting P7. Revisit P6-T03
the moment OPEN_QUESTIONS #9 is answered; it does not block starting P7 tasks that don't themselves
assume production SSO is live (P7-T02 data migration, P7-T03 handover docs), but likely does block
P7-T01 (client UAT) and P7-T04 (final go-live gate) in practice, since real users logging in via the
client's real identity system is a natural UAT precondition — orchestrator judgment, not yet
confirmed with the client.

- **P6-T01** — Production Docker Compose: nginx, api, worker, solver-worker, postgres, redis, minio,
  per `docs/PROJECT_AND_STACK.md` §6. Status: DONE — all 8 topology services, both Dockerfiles,
  `worker`/`solver-worker` genuinely queue-separated (`solver`/`worker` Celery queues, previously
  both silently defaulted to `"celery"` — fixed as part of this task), `make dev` wired, live
  end-to-end verified (full stack up, migrations auto-run, curl through nginx to `/`, `/healthz`,
  `/api/healthz` all 200). See MEMORY.md "[2026-09-05] P6-T01 — backend-builder" entry.
- **P6-T02** — TLS 1.3, HSTS, ModSecurity + OWASP CRS at the reverse proxy. Status: DONE — edge nginx
  terminates TLS 1.2+1.3, HSTS + baseline security headers, HTTP->HTTPS redirect; `waf-api`/
  `waf-frontend` (OWASP CRS, `BLOCKING_PARANOIA=1`) front `api`/`frontend`, narrowly-scoped overrides
  for this app's real bulk-edit payload shapes verified load-bearing via differential test against a
  stock-CRS container. Independently re-verified live by security-auditor (PASS, one Medium — CSP
  `unsafe-inline` — deferred to P6-T07, no Critical/High). See MEMORY.md "[2026-09-05] P6-T02 —
  backend-builder" and "[2026-09-05] P6-T02 independent review — security-auditor: PASS" entries.
- **P6-T03** — Full OIDC SSO cutover against the confirmed client IdP. Status: BLOCKED — per
  `docs/OPEN_QUESTIONS.md` #9 ("Which IdP, and can we get an app registration?"), the client has not
  yet confirmed the target IdP or supplied app-registration/client credentials. Cannot proceed
  without real, client-supplied values (fabricating a fake cutover would be worse than leaving this
  blocked). Orchestrator decision 2026-09-05: skip ahead to P6-T04/T05/T06 (none depend on the IdP
  answer) and revisit this task once OPEN_QUESTIONS #9 is answered by Frigoglass IT/security.
- **P6-T04** — Vault or Docker secrets wiring; confirm zero secrets in repo history. Status: DONE —
  Docker Compose native `secrets:` chosen over Vault (single-client on-premise Compose deployment,
  no existing Vault install to justify the overhead); `_FILE`-suffix resolution shim in
  `backend/docker-entrypoint.sh` covers all backend containers with zero Python code changes;
  postgres/minio use their own native `_FILE` support. Runtime-verified: `docker inspect` confirms
  zero raw secret values in `Config.Env`, Fernet round-trip / live Postgres query / live MinIO call
  all succeed via secret-file-resolved credentials, HTTPS routing through P6-T02's nginx/WAF chain
  unaffected. `.gitignore` covers `secrets/*` (README/.gitkeep excepted). No git repo exists yet, so
  "repo history" is trivially clean; working tree confirmed to contain no real secret material.
  Independently re-verified by orchestrator (`docker compose config` with dummy secret files, no
  plaintext secret env vars in `docker-compose.yml`, backend suite still 415/0 clean). See MEMORY.md
  "[2026-09-05] P6-T04 — backend-builder" entry.
- **P6-T05** — Dependency and container scanning (`pip-audit`, `npm audit`, Trivy) wired into CI.
  Status: DONE — `.github/workflows/security-scans.yml` (GitHub Actions, per orchestrator's
  no-vendor-specified assumption above): `pip-audit` (fail on any finding), `pnpm audit
  --audit-level=high` (fail High/Critical only), Trivy on the two repo-built images (`CRITICAL,HIGH
  --ignore-unfixed`, blocking) plus a report-only weekly pass over pinned third-party images
  (postgres/redis/minio/WAF). Baseline run for real: pip-audit clean; pnpm audit found 2 Moderate
  `react-router` advisories (reported, not fixed — needs a v6->v7 major bump, out of this task's
  scope); Trivy found 34 fixable findings (2 CRITICAL/32 HIGH) on the frontend image from a stale
  `nginx:1.27-alpine` base and fixed them in place with an `apk upgrade` layer (independently
  re-verified by orchestrator: fresh rebuild scores 0 CRITICAL/HIGH); backend image's 63 findings are
  all unfixed-upstream OS packages (confirmed via `--ignore-unfixed`), 2 apparent HIGH Python
  findings confirmed as Trivy false positives (packages not actually installed). Third-party image
  findings (notably `minio/minio:latest`, several CRITICAL) not remediated here — confirms the
  pin-discipline gap already flagged in P6-T01, tracked via the report-only weekly job rather than
  fixed in this task. Independently re-verified by orchestrator (YAML parses valid, pip-audit and
  pnpm audit re-run with matching results, frontend image rebuilt from scratch and Trivy-rescanned:
  0 CRITICAL/HIGH). See MEMORY.md "[2026-09-05] P6-T05 — backend-builder" entry.
- **P6-T06** — Observability: structured logging (no PII), metrics, backup/restore drill.
  Status: DONE — structured JSON logging (`backend/core/logging_config.py`) across `api`/`worker`/
  `solver-worker`; PII/financial-field audit of every existing log call found zero fixes needed
  (only opaque UUIDs/statuses/counts were ever logged); request correlation via a random `request_id`,
  never a name/financial value, per `docs/OPEN_QUESTIONS.md` #8's utilization-views-and-exports
  scoping (not bare user-id correlation). `GET /metrics` (Prometheus format, bounded-cardinality
  route/method/status labels only) on `api`, deliberately never routed through the P6-T02 edge/WAF.
  Nightly `pg_dump`-to-MinIO backup via a new `beat` service (Celery beat on the existing `worker`
  app) to a separate lifecycle-managed `rpd-backups` bucket; a real restore drill was executed
  (seeded data, real backup dispatched and confirmed in MinIO, restored into a fresh Postgres
  instance, row counts and financial-column ciphertext fingerprints matched exactly, decryption
  re-confirmed against the live Fernet key post-restore). Independently re-verified by orchestrator:
  backend suite 435/0 passed, 89.97% coverage (exact match); scheduling suite 80/0 passed, 93.58%
  coverage, confirmed unchanged from every prior P6 baseline; `docker compose config` validates;
  metrics route and logging module's PII-boundary docstring read directly, confirmed as described.
  See MEMORY.md "[2026-09-05] P6-T06 — backend-builder" entry.
- **P6-T07** — `security-auditor`: full OWASP ASVS L2 pass across the whole app. Status: DONE —
  **PASS, zero Critical/High findings.** Live-verified (real 11-service stack, real signed/forged
  JWTs, real hub-scoped test users, RBAC/hub-scoping parameter-tampering matrix across every surface,
  GDPR named-engineer withholding, financial-field encryption bypassing the ORM entirely down to raw
  `psql`+`Fernet`, audit-log immutability at the DB level, independent pip-audit/pnpm audit/Trivy
  re-runs, whole-backend raw-SQL-interpolation grep, whole-frontend `dangerouslySetInnerHTML` grep —
  both clean). Three new non-blocking findings (Medium: WAF-to-api upstream DNS staleness on
  container recreate; Low-Medium: nginx/frontend healthcheck IPv6 false-unhealthy; Low: `Access-
  Control-Allow-Headers: *` on WAF-proxied responses, inert today). Carried-forward items formally
  re-assessed and accepted: CSP `unsafe-inline` (Medium, concrete fix recommended for later), `minio:
  latest` pin gap + 2 Moderate react-router advisories (interim-acceptable given internal-only
  exposure), CSRF (structurally a non-issue — Bearer-only, no cookies), P6-T03's OIDC cutover
  (confirmed externally blocked per `docs/OPEN_QUESTIONS.md` #9, implementation itself has no
  defect). Independently spot-checked by orchestrator (raw-SQL and dangerouslySetInnerHTML greps
  re-run clean). See MEMORY.md "[2026-09-05] P6-T07 — security-auditor: full OWASP ASVS L2 pass
  across the whole app (P6 gate)" entry for full detail.

## P7 — UAT, data migration, handover docs

**Owner:** all
**Gate:** qa-inspector + workflow-auditor + security-auditor, all PASS

- **P7-T01** — Client UAT session(s) against the real six surfaces. Status: TODO
- **P7-T02** — Production data migration plan and execution (from spreadsheet system of record,
  per `docs/OPEN_QUESTIONS.md` #7 resolution).
  Status: PLAN DELIVERED; EXECUTION BLOCKED ON CLIENT. `docs/HANDOVER/DATA_MIGRATION_PLAN.md`
  (new) covers the one-shot one-way load (OQ#7 default: spreadsheet retired at cutover, no
  round-trip import), the full source→target field mapping (financial fields flagged encrypted),
  the `backend/seed/migrate_production_data.py` behaviour spec (SPEC'd, not implemented — its input
  shape depends on the real client file; implementation is a bounded `backend-builder` follow-up
  once the file + column dictionary arrive), pre/post-load validation + acceptance checks, rollback,
  and the ordered cutover runbook. Execution cannot proceed until: OQ#7 answered, the real
  spreadsheet + column dictionary supplied, the real engineer/chamber rosters confirmed, and
  (for the step-10 sign-off / P7-T01 UAT that should precede go-live) OQ#9 / P6-T03. See
  `docs/MEMORY.md` "[2026-09-08] P7-T02 — rpd-orchestrator (plan half)" entry.
- **P7-T03** — Handover documentation: deployment runbook, admin guide, backup/restore procedure.
  Status: DONE — both halves complete. `backend-builder` delivered `docs/HANDOVER/
  DEPLOYMENT_RUNBOOK.md` and `docs/HANDOVER/BACKUP_RESTORE.md` (ops/deployment half); `frontend-
  builder` delivered `docs/HANDOVER/ADMIN_GUIDE.md` (end-user/admin half, based on the actually-built
  six surfaces, not the aspirational spec). See `docs/MEMORY.md`'s "[2026-09-07] P7-T03 (part 1 of 2)"
  and "[2026-09-07] P7-T03 (part 2 of 2)" entries for full detail.
- **P7-T04** — Final three-way gate check (qa + workflow + security) before go-live. Status: TODO
- **P7-T05** — Audit Log viewer UI: `backend/core/rbac.py` defines an `AUDIT_LOG` surface for
  Auditor/Admin roles, but no frontend page/route was ever built to view the immutable audit log
  written by P3-T04. Discovered by `frontend-builder` while writing the admin guide for P7-T03 (see
  `docs/MEMORY.md`, "[2026-09-07] P7-T03 (part 2 of 2)"). Acceptance: a read-only, filterable
  (by entity, actor, date range, hub) Audit Log surface, gated to Auditor/Admin via existing RBAC,
  consistent with the design system used by the other six surfaces. Owner: `frontend-builder`.
  Status: DONE — a `GET /audit-log` read endpoint (`backend/api/routers/audit_log.py`) already
  existed from P3-T04 (filterable, paginated, RBAC-gated, financial-field-redacted-at-write-time —
  no backend follow-up needed); this task added the frontend surface consuming it: new
  `/audit-log` route (`frontend/src/surfaces/audit-log/`) gated via the existing per-surface
  `AccessNotice` 401/403 pattern, added to `SURFACES` (`frontend/src/app/nav.ts`) and route-split
  as its own lazy chunk (`frontend/src/app/lazy-surfaces.ts`/`routes.tsx`). TanStack Virtual
  row-virtualized table with an expandable before/after JSON diff panel, filters for entity type/
  entity ID/actor user ID (UUID-validated)/action/hub/date range, and limit/offset pagination
  against the real endpoint. `hub_id` is a convenience filter, not row-level access control — this
  surface is deliberately NOT hub-scoped, matching the backend's "Auditor/Admin = all hubs" RBAC
  qualifier for this one surface. Added a second, independent client-side redaction pass
  (`components/redact.ts`) over the four financial/PII field names as defense-in-depth on top of
  the backend's write-time redaction. Bundle-budget PASS (145.8 KB gzip initial load, Audit Log
  chunk not in the initial bundle). See `docs/MEMORY.md`'s P7-T05 entry for full detail.
- **P7-T06** — Off-host backup mirror: nightly Postgres backups currently land in MinIO on the same
  host as the primary database, with no automated off-host copy — a single point of failure.
  Discovered by `backend-builder` while writing `docs/HANDOVER/BACKUP_RESTORE.md` for P7-T03 (see
  `docs/MEMORY.md`, "[2026-09-07] P7-T03 (part 1 of 2)"). Acceptance: an automated off-host mirror
  of the MinIO backup bucket (e.g. `mc mirror` on a schedule) to a second target, documented in
  `docs/HANDOVER/BACKUP_RESTORE.md`; destination host/credentials are Frigoglass's infra decision —
  implement against a configurable target, do not hardcode one. Owner: `backend-builder`.
  Status: DONE — `backend/workers/backup_mirror_tasks.py`'s `mirror_backups_offhost` Celery beat
  task (new `backend/core/backup_mirror_config.py::BackupMirrorSettings`), scheduled 03:00 UTC (one
  hour after the existing 02:00 UTC nightly pg_dump) on the same `worker`/`beat` mechanism
  `workers/backup_tasks.py` already uses. Mirrors the whole `rpd-backups` bucket to any configurable
  S3-compatible off-host target via the `minio` Python SDK (equivalent to `mc mirror`, no `mc`
  binary shipped in the image); deliberately no-ops when unconfigured (all `RPD_BACKUP_MIRROR_*`
  values ship blank in `.env.example`) rather than failing the nightly schedule, since Frigoglass has
  not yet chosen a destination. `docs/HANDOVER/BACKUP_RESTORE.md` §4 rewritten to document what it
  does, how to configure/verify it, and how to restore from the mirror if the primary host is a total
  loss. See `docs/MEMORY.md`'s P7-T06 entry for full detail, including what was and wasn't tested
  against real off-host infrastructure.

---

## P8 — Project Workspace (Surface #7) — per-stage progress capture

**Owner:** all (backend-builder, algorithm-engineer, frontend-builder; gated by the three auditors)
**Gate:** qa-inspector PASS + workflow-auditor PASS + security-auditor PASS

Added 2026-09-08 from a project-owner feature spec. Scope: the seventh surface
(`docs/PROJECT_AND_STACK.md` §2, "Project Workspace"), the per-stage progress contract
(`docs/DOMAIN_RULES.md` "Per-stage progress capture", invariants I11–I14), and ADR 0006. This is a
new gated phase — none of P1–P7's gates cover it. P8 is independent of the client-blocked remainder
of P7; it can proceed now. **`docs/OPEN_QUESTIONS.md` #8 (GDPR) is hard-blocking for P8-T03's
comment/@mention/named-engineer parts** the same way it blocks P4-T08 — build the rest, gate those
parts behind the DPO determination.

- **P8-T01** — Data model + Alembic migration. Owner: backend-builder. Depends on: none.
  - Extend `ProjectWorkflowStep`: `status` (new `WorkflowStepStatus` enum:
    `Not Started`/`In Progress`/`Blocked`/`Done`), `percent_complete` (int 0–100, CHECK),
    `remaining_weeks_override` (int ≥ 0, nullable), `blocked_reason` (text, nullable). DB-level
    CHECK constraints for the consistency rules in `docs/DOMAIN_RULES.md` (Done ⇒ percent 100 +
    both actuals; Not Started ⇒ percent 0 + no actuals; Blocked ⇒ blocked_reason non-empty).
    Add `Project.schedule_stale` (bool, default false).
  - New `ProjectFile` model: `display_name`, `category` (new `ProjectFileCategory` enum: Drawing /
    Test Report / Certification / Costing / Supplier Doc / Photo / Other), `description`,
    `uploaded_by_user_id`, `size_bytes`, `version` (int), `minio_object_key`, timestamps.
    Unique on `(project_id, display_name, version)`; re-upload against an existing display name
    increments `version`.
  - New `ProjectComment` model: `body_md`, `author_user_id`, `created_at`, `edited_at`,
    `edit_locked` (derived: created_at + 15 min), `soft_deleted_at` (nullable — never hard-delete),
    `mentioned_user_ids`. System events are NOT stored here — they are read from
    `audit_log_entries` at query time.
  - Migration up + down; `alembic upgrade head` / `downgrade base` clean; encryption scope
    unchanged (financial fields already `EncryptedString`/`EncryptedNumeric` on `Project`).
  - Acceptance: model + migration reviewed against `docs/DOMAIN_RULES.md` by the orchestrator;
    `backend/scheduling/` untouched; CHECK constraints functionally tested.

- **P8-T02** — Progress-aware scheduling. Owner: algorithm-engineer. Depends on: P8-T01.
  - Greedy SGS and CP-SAT both consume per-stage progress per `docs/DOMAIN_RULES.md` "How progress
    feeds a schedule run": `Done` → fixed history, capacity consumed only for weeks ≥ `CURRENT_WEEK`,
    never re-placed; `In Progress` → start fixed to `actual_start_week`, only `remaining` weeks
    booked forward from `CURRENT_WEEK`; `Blocked` → as In Progress but held at the frontier + project
    flagged for Notifications; `Not Started` → unchanged. `remaining` derivation
    (`remaining_weeks_override` else `ceil(duration_weeks × (1 − percent/100))`, floored at 0).
    Reject a project as a data error if an In Progress/Blocked/Done step lacks a required actual.
  - Extend the I1–I10 validator with I11–I14. Determinism (I8) preserved — progress fields join the
    hashed solver input.
  - Roll-up `project_progress_pct` (duration-weighted, I12) computed here as a pure function.
  - Acceptance: pure functions, no DB/network; spec-derived golden tests for all four status modes
    + the mixed case + roll-up weighting; validator catches hand-broken I11–I14; ≥85% coverage on
    `backend/scheduling/` maintained; `frozen` precedence (ADR 0006) tested.

- **P8-T03** — API layer. Owner: backend-builder. Depends on: P8-T01 (P8-T02 for the recalc path).
  - `GET /projects/{id}/workspace` read model: header fields + derived health badge (from the
    active `ScheduleRun` only, I13), Details fields, 14 progress rows (planned from the active run,
    actuals/status/percent from `ProjectWorkflowStep`), duration-weighted roll-up, files list,
    activity feed (comments ∪ audit-log system events, reverse-chronological).
  - Progress mutation: `PATCH` per stage (status / percent / actuals / remaining override / blocked
    reason) with the consistency rules enforced; sets `Project.schedule_stale = true`; writes an
    audit row. Details inline-edit endpoints (reuse P3-T01 project update; financial fields stay
    encrypted + redacted in audit).
  - "Recalculate schedule": dispatches a solver run via the P3-T06 Celery primitive, clears
    `schedule_stale` on activation of the new run, emits the "Schedule recalculated — finish moved
    week X → week Y" system event.
  - Files: upload (MIME + size validation, MinIO object storage, display-name versioning),
    list, download (streamed / presigned). Comments: create, edit (author only, < 15 min),
    soft-delete, `@mention` → `Notification` rows. Markdown rendered through a sanitising pipeline —
    **no `dangerouslySetInnerHTML`** (frontend), no HTML passthrough (backend).
  - RBAC per the `docs/PROJECT_AND_STACK.md` §5 Project Workspace column + hub-scoped row filtering
    (P3-T03 pattern). **OQ#8-gated:** `@mention`/comment-authorship exposure and the named engineer
    on progress rows carry the same withholding + OQ#8 annotation as P3-T09 / P4-T08 until the DPO
    signs off.
  - Acceptance: live-verified against a real Postgres 17 + MinIO + Keycloak; ≥70% coverage on
    `backend/` outside scheduling; `backend/scheduling/` untouched.

- **P8-T04** — Frontend surface. Owner: frontend-builder. Depends on: P8-T03.
  - New `/projects/:id` route (`frontend/src/surfaces/project-workspace/`), lazy chunk, added to
    `SURFACES` nav where appropriate; row click-through wired from Dashboard, Matrix and Gantt.
  - Sticky header + health badge; two-column layout; Details panel (inline edit, all Project
    Registration fields incl. the 13 scoring dimensions); Progress panel (14 stage rows per the
    editability table in §2, slider + number input for percent, duration-weighted roll-up bar);
    Files panel (drag-and-drop upload, category tags, version display); Activity & Comments feed
    (Markdown via the sanitised renderer, 15-min edit affordance, `@mention` autocomplete, system
    events interleaved). "Progress updated. Schedule is now stale." banner + "Recalculate schedule"
    button driving the P3-T05 `fetch()`-streamed SSE progress reader.
  - Design-system compliant; bundle-budget PASS; no `three`; no raw hex; no `dangerouslySetInnerHTML`.
  - Acceptance: functional flow test against a real backend; axe zero serious/critical.

- **P8-T05** — `qa-inspector`: coverage gates (≥70% backend non-scheduling, ≥85% scheduling
  maintained), golden-file tests for the four status modes + roll-up + health badge derivation,
  OpenAPI ↔ frontend TS contract for the new endpoints, frontend flow + axe. Depends on: P8-T02..T04.

- **P8-T06** — `workflow-auditor`: independently re-derive a progress-aware schedule from
  `docs/DOMAIN_RULES.md` against a seed dataset with hand-set stage progress; assert I1–I14;
  reconcile the health badge, duration-weighted roll-up, and within-year count against the active
  run; confirm `frozen` precedence per ADR 0006; confirm no progress edit auto-triggers a solve.
  Authority to FAIL the gate on its own. Depends on: all above P8 tasks.

- **P8-T07** — `security-auditor`: file-upload hardening (MIME/type/size, MinIO key traversal,
  no path from display name to object key), Markdown/comment XSS (sanitiser bypass attempts,
  `dangerouslySetInnerHTML` grep clean), `@mention` user-enumeration, soft-delete-not-hard-delete
  verified, financial fields in the Details panel still encrypted + never logged, GDPR/OQ#8 review
  of comments + mentions + named engineer, hub-scoping + RBAC negative tests for the new endpoints.
  Any High/Critical fails the gate. Depends on: all above P8 tasks.

---

## P9 — Client formulas, RBAC/Super Admin, Gantt completion lines, configurable precedence, Project Workspace — **GATE: PASSED (2026-09-27, re-run P9-R04; see MEMORY.md "P9 gate re-run — combined result: PASS")**

**Owner:** all (backend-builder, algorithm-engineer, frontend-builder; gated by the three auditors)
**Gate:** qa-inspector PASS + workflow-auditor PASS + security-auditor PASS

Added 2026-09-27 from the client formula workbook (`docs/CLIENT_FORMULAS.md`) and the project
owner's requests of that day. ADRs 0007–0010. P9 **absorbs P8** (P8-T01..T07 were planned but never
started — no P8 code exists; their acceptance criteria are carried into P9-T01/T02/T03/T04 below
and the P8 gate is folded into the P9 gate). `docs/OPEN_QUESTIONS.md` #8 (GDPR) still gates the
comment/@mention/named-engineer parts exactly as P8 stated. "Ask the agent" on the Project
Workspace is explicitly **out of scope** for P9 — to be specified with the client later.

**P9 GATE: FAIL (2026-09-27), then PASSED on re-run (P9-R04, 2026-09-27)**. First run: workflow-auditor FAIL (F1–F3); qa-inspector FAIL (axe
Q-F1..Q-F3, flaky Vitest, §7 nullability); security-auditor PASS with 3 Mediums. See MEMORY.md "P9 gate — combined result". The
remediation tasks below come first. The gate is re-run after them.

- **P9-R01** — (DONE, gate re-run passed) Scheduler remediation. Owner: algorithm-engineer. Status: DONE (pending gate re-run).
  F1: anchored lab steps choose the first eligible chamber with room; overbook and raise `OVERLAP`
  only when none has room; I2 validator updated to match (DOMAIN_RULES remediation ruling 1).
  F2: CP-SAT always emits a progress-tracked project's anchored rows, and uses `left_out` plus
  anchored rows when the rest is unscheduled (ruling 2). F3: `progress_pct` uses the one
  duration-weighted formula for every project, frozen ones included (ruling 3). CP-SAT passes use
  deterministic-time limits, with the solver status recorded (ruling 6). Regression goldens for all
  three auditor repros.
- **P9-R02** — (DONE, gate re-run passed) Backend remediation. Owner: backend-builder. Status: DONE (pending gate re-run) — see MEMORY.md "[2026-09-27] P9-R02 — backend-builder".
  F3: stage PATCH on a frozen project returns 409 `PROJECT_FROZEN`; the workspace uses the shared
  progress helper. `blocked` health state (ruling 5). Solver status column on `ScheduleRun` if
  P9-R01 needs it. Security S-01: serialise Super Admin membership changes (advisory lock or `FOR
  UPDATE` on the role row), map deadlocks to 409, add a threaded regression test. S-02: drop
  `body_html_sanitized` from workspace/activity payloads or render it off the event loop with a
  cache; cap comment length (10 000 chars); rate-limit comment creation. S-03: remove the
  `*.vercel.app` regex, keep the two exact demo origins, and let `RPD_CORS_ORIGINS` override. S-04:
  BEFORE TRUNCATE trigger on `project_comments`. S-05: nginx files route `client_max_body_size 51m`
  plus the WAF body limit. S-07: authenticate the reference endpoints.
  P9-R02b tidy-up DONE — greedy `solver_status` null; CP-SAT dispatch takes `deterministic_time`, wall-clock limit removed (see MEMORY.md "[2026-09-27] P9-R02b — backend-builder").
- **P9-R03** — (DONE, gate re-run passed) Frontend remediation. Owner: frontend-builder. Status: DONE (pending gate re-run). Built against the
  rulings in parallel with P9-R02. Progress panel disabled on frozen projects with the ruling-3
  message; handle 409 `PROJECT_FROZEN`; Blocked health badge. S-06: bound the link-text quantifier in
  the Markdown renderer. Comment length counter (10 000). qa Q-F1: sidebar muted-label contrast
  ≥ 4.5:1. Q-F2: Details `<dl>` structure. Q-F3: label on `#reg-comments`. §7 TS nullability
  (`progress_pct`, priority-score derived fields) with null handling in the progress and scoring
  panels. Make the Files-panel upload test deterministic.
- **P9-R04** — (DONE — PASS ×3) Gate re-run: workflow-auditor on F1–F3 repros plus a full invariant pass;
  security-auditor spot-check of S-01..S-07; qa-inspector full re-run, after adding the §7 workspace,
  notification and planning-chamber types to `CONTRACT_TABLE` so nullability is tested. Status: TODO.

- **P9-T00** — Docs: `docs/CLIENT_FORMULAS.md`, ADRs 0007–0010, DOMAIN_RULES.md revision,
  PROJECT_AND_STACK.md §5, OPEN_QUESTIONS.md #11–#22, this section. Owner: rpd-orchestrator.
  Status: DONE (see MEMORY.md "[2026-09-27] P9-T00").

- **P9-T01** — Data model + Alembic migration + seed. Owner: backend-builder. Depends on: P9-T00.
  - Workflow: `Workflow` (`PDD`, `OEM`); `WorkflowStepTemplate` gains `workflow_id`, `code`,
    `kind ∈ {design, lab, elapsed}`, `predecessor_ids` (JSON list), client names; `base_weeks`
    dropped; `WorkflowLeadTime(workflow_id, category, step_id, weeks ≥ 0)` seeded from
    `docs/CLIENT_FORMULAS.md` §1. OEM step rows OEM-A..N.
  - `ProjectCategory` + `A-OEM/B-OEM/C-OEM`; `ProjectStatus` + `Cancelled`; `EngineerAllowedCategory`
    accepts the OEM categories. `Project` gains `target_end_week`, `certification_testing_required`
    (default true), `estimated_design_weeks`, `estimated_lab_weeks`, `schedule_stale` (P8-T01), and
    a DB CHECK that OEM-hub projects carry an OEM category and vice-versa.
  - `HubWorkCalendar` (per hub; ADR 0008 fields, seeded §2.1); `Chamber` + `maintenance_weeks`,
    `breakdown_weeks`, `calibration_weeks`, drop `weeks_per_chamber`; seed the ten workbook chambers'
    platforms/efficiency/breakdown (§2.2) where codes match, else add them.
  - `ScheduleRun.workflow_snapshot` (JSON); `ScheduleRunProjectStep.skipped`;
    `ScheduleRunProjectOutcome` + `unconstrained_end_week`, `expected_end_week`, `projected_end_week`.
  - P8-T01 verbatim: `ProjectWorkflowStep` progress columns + CHECKs, `ProjectFile`, `ProjectComment`.
  - `RoleName.SUPER_ADMIN`; `seed_dev_users` + `sam.super@example.com`.
  - Acceptance: `alembic upgrade head` / `downgrade` clean on Postgres 17; CHECKs tested; seed
    reproduces the lead-time table byte-for-byte from `docs/CLIENT_FORMULAS.md`; `backend/scheduling/`
    untouched; orchestrator review against DOMAIN_RULES.md.
  - Status: DONE (orchestrator-reviewed and accepted — see MEMORY.md "[2026-09-27] P9-T01/P9-T02/P9-T04a orchestrator review").

- **P9-T02** — Scheduling engine: lead times, kinds, DAG, completion lines, progress. Owner:
  algorithm-engineer. Depends on: P9-T00 (contract) — may run in parallel with P9-T01; the
  `ScheduleInput` shape is fixed in the task brief so backend-builder's adapter matches.
  - `types.py`: `WorkflowStepTemplate{workflow_id, step_id, code, name, kind, sequence_order,
    predecessor_ids}`; `LeadTime{workflow_id, category, step_id, weeks}` on `ScheduleInput.lead_times`;
    `ProjectInput` + `workflow_id`, `certification_testing_required`, `target_end_week`, and the
    P8-T02 per-step progress tuple; `StepSchedule.skipped`; outcome + `unconstrained_end_week`,
    `expected_end_week`, `projected_end_week`.
  - Greedy + CP-SAT: durations from the table; skipped steps; elapsed kind books nothing; lab
    consumption 1.0; DAG precedence with `sequence_order` as walk order; OEM workflow; progress-aware
    rules (P8-T02 verbatim); unconstrained finish as a pure by-product.
  - Validator: I3 (DAG form), I5, I6, I7 revised; I11–I17 added. Golden files regenerated from the
    contract (no prototype oracle — retired at P2). `frozen` precedence (ADR 0006) tested.
  - Acceptance: pure functions; ≥85% coverage on `backend/scheduling/`; determinism (I8) including
    precedence + lead times + progress in the hashed input; hand-broken I15 caught.
  - Status: DONE (orchestrator-reviewed and accepted, ADR 0011 — see MEMORY.md "[2026-09-27] P9-T01/P9-T02/P9-T04a orchestrator review").

- **P9-T03** — API layer. Owner: backend-builder. Depends on: P9-T01, P9-T02.
  - `GET /me`; `/users`, `/roles` admin endpoints (ADR 0010, last-Super-Admin guard, audit rows);
    `X-Dev-User-Email` honoured only under `RPD_DEV_MODE`.
  - Workflow Settings: `GET/PUT /workflow-settings` (steps, kinds, predecessors with acyclicity
    validation, lead-time table, hub calendars, chamber downtime) — Super Admin write; every PUT
    audit-logged and sets `schedule_stale` on all schedulable projects.
  - DB → `ScheduleInput` adapter updated for P9-T02's shape; `workflow_snapshot` written on every run.
  - Capacity: ADR 0008 supply figures + intermediates (working weeks/engineer, per-chamber efficient
    weeks, remaining-year figures, "Process derived" vs "Estimated" load, gap, completion %).
  - Gantt rows + `expected_end_week`, `projected_end_week`, `unconstrained_end_week`,
    `target_end_week`, `slip_weeks`; step rows + `skipped`, `kind ∈ {design, lab, elapsed}`.
  - Projects: new fields on create/update/read; OEM category validation.
  - P8-T03 verbatim: workspace read model, progress PATCH, recalc, files (MinIO), comments (sanitised
    Markdown, no HTML passthrough), notifications; OQ#8 withholding on names/mentions.
  - Acceptance: live-verified on Postgres 17 + MinIO + Keycloak; ≥70% coverage outside scheduling;
    OpenAPI regenerated; `backend/scheduling/` untouched.
  - Status: DONE (orchestrator-reviewed and accepted with follow-up — see MEMORY.md "[2026-09-27] P9-T03 orchestrator review").

- **P9-T04** — Frontend. Owner: frontend-builder. Depends on: P9-T03.
  - `session` store from `GET /me`; nav filtered by `read`; write controls hidden/disabled by
    `write`; read-only notices; dev-only role switcher. User/Role Admin surface (`/admin/users`).
  - Workflow Settings surface (`/settings/workflow`): step list with kind badges, predecessor editor
    ("can run in parallel with…" toggles rendered from the DAG), lead-time grid per workflow ×
    category, hub calendars, chamber downtime; "Settings changed — recalculate" banner.
  - Gantt: two vertical marker lines per project row — *Expected completion* and *Will be completed*
    — distinct colours + legend + slip label; step rows may overlap; `elapsed` steps drawn hollow,
    `skipped` steps omitted with a "n/a" chip when expanded.
  - Registration + Workspace: `target_end_week`, `certification_testing_required`, estimated weeks,
    OEM categories for OEM hubs, `Cancelled` status.
  - Capacity: client breakdown (yearly vs remaining, process-derived vs estimated, gap, completion %).
  - Matrix: show the deck's per-dimension scoring anchors (slide 4 "Scoring Logic") as column
    tooltips/rubric.
  - P8-T04 verbatim: `/projects/:id` Project Workspace (header + health badge, Details, Progress,
    Files, Activity & Comments, stale banner + Recalculate via SSE), click-through from Dashboard,
    Matrix and Gantt. **No "Ask the agent" UI.**
  - Acceptance: typecheck/lint/test/build green within the 400 KB budget; axe zero serious/critical;
    no `dangerouslySetInnerHTML`; no raw hex.
  - Status: DONE (orchestrator-reviewed and accepted — see MEMORY.md "[2026-09-27] P9-T04b orchestrator review"; contract reconciliation at gate) — see MEMORY.md
    "[2026-09-27] P9-T04a — frontend-builder" and "[2026-09-27] P9-T04b — frontend-builder".

- **P9-T05** — `qa-inspector` gate. **P9-T06** — `workflow-auditor` gate (re-derive a schedule under
  the lead-time table + an edited DAG + hand-set progress; assert I1–I17; reconcile Capacity to
  ADR 0008 to two decimals; reconcile Gantt lines to I16). **P9-T07** — `security-auditor` gate
  (Super Admin last-admin guard, dev-header ignored outside dev mode, user-admin negative tests,
  workflow-settings write restricted to Super Admin, P8-T07 items verbatim). Depend on: P9-T01..T04.

### P9 follow-ups (non-blocking, recorded at gate close 2026-09-27)

- **P9-F01** — Security Lows from the P9-R04 re-run. Owner: backend-builder. Status: DONE
  (2026-09-30, backend-builder — see `docs/MEMORY.md`).
  - R04-L1: bound `CpDispatchRequest.deterministic_time` (`le=60`, `allow_inf_nan=False`, strict).
    Add an in-flight check on CP-SAT dispatch and a sweeper for stuck `running` runs.
  - R04-L2: `allow_inf_nan=False` plus `le=` bounds on the chamber float fields.
  - R04-L3: `hide_parameters=True` on the async engine.
- **P9-F02** — Dashboard: a fourth "Blocked" bucket alongside within-year / spillover / left-out.
  A Blocked-held project currently counts in none of them. Owner: backend-builder +
  frontend-builder. Status: DONE (2026-09-30, backend half — `blocked_count` field, backend-builder;
  frontend half — Blocked tile/badge/donut segment + contract test flipped back to `"exact"`,
  frontend-builder — see `docs/MEMORY.md`).
- **P9-F03** — Three mypy narrowing errors in `scheduling/` (`workflow.py:309`, `greedy.py:766`,
  `cp_sat.py:369`). Owner: algorithm-engineer. Status: DONE (2026-09-30, algorithm-engineer — see
  `docs/MEMORY.md`).
- **P9-F04** — Dev seed: link `carol.eng` to an Engineer and hub-scope `bob.hub`, so the
  "own assignments" and hub-scoped views can be exercised in dev. Owner: backend-builder.
  Status: DONE (2026-09-30, backend-builder — see `docs/MEMORY.md`).
- **P7 carry-forward:** CP-SAT wall time rises with machine load even under a fixed deterministic
  budget; load-test at 236 projects. The comment rate limiter counts per worker (accepted Low).

## P10 — Project-level access grants (Viewer/Editor/Admin), manager delegation, explicit login page, "Ask the agent" (Groq)

**Owner:** all (backend-builder, frontend-builder; gated by the three auditors)
**Gate:** qa-inspector PASS + workflow-auditor PASS + security-auditor PASS

Opened 2026-09-30 from the project owner's request. ADRs 0012 (project access grants + manager
delegation), 0013 (explicit login page), 0014 (Ask the agent via Groq — provisional, see
`docs/OPEN_QUESTIONS.md` #23). Extends ADR 0010's role matrix; does not replace it.

- **P10-T00** — Docs: ADRs 0012–0014, `docs/DOMAIN_RULES.md` "Project access grants and
  delegation" + "Ask the agent" sections + I18, `docs/PROJECT_AND_STACK.md` §5 addendum,
  `docs/OPEN_QUESTIONS.md` #23, this section. Owner: rpd-orchestrator. Status: DONE (this entry).
- **P10-T01** — Data model + migration. Owner: backend-builder. Depends on: P10-T00.
  Status: DONE (`docs/MEMORY.md` 2026-09-30 "P10-T01/P10-T02 — backend-builder").
  - `ProjectAccessGrant(project_id, user_id, project_role ∈ {viewer, editor, admin},
    granted_by_user_id, created_at, revoked_at NULL)`, FKs to `projects`/`users`, indexed on
    `(project_id, user_id)` where `revoked_at IS NULL`.
  - `User.manager_id` (nullable self-FK to `users.id`); a CHECK or API-level guard against a
    1-hop self-cycle (`manager_id != id`) — full cycle prevention enforced at the API layer, not
    the DB, since a DB-level acyclicity CHECK across the whole graph isn't practical in SQL.
  - Seed: dev seed gets at least one manager → report relationship so P10-T01..T03 are testable
    (e.g. an existing Hub Planner as manager of `carol.eng`, building on the P9-F04 seed fix).
  - Acceptance: `alembic upgrade head`/`downgrade` clean; audit rows on every grant write.
- **P10-T02** — Backend API. Owner: backend-builder. Depends on: P10-T01.
  Status: DONE (`docs/MEMORY.md` 2026-09-30 "P10-T01/P10-T02 — backend-builder").
  - `services/project_access.py`: the single effective-access resolver (DOMAIN_RULES "Project
    access grants and delegation", the 6-rule MAX) and the delegation-authorization check (I18).
    Used to gate Project Workspace/Registration/Gantt-row detail reads AND writes — Editor's
    write set is exactly {stage progress PATCH, file upload, comment post}, enforced server-side,
    not just hidden in the UI.
  - `GET /projects/{id}/access` (list active grants), `POST /projects/{id}/access` (grant),
    `DELETE /projects/{id}/access/{grant_id}` (revoke) — all three run the I18 check; 403 on
    failure, never a silent no-op. `PATCH /users/{id}` gains `manager_id` (Super Admin/global
    Admin only, same guard as role assignment).
  - `services/ask_agent.py` + `POST /projects/{id}/ask-agent`: assembles the redacted context per
    ADR 0014 §2 (financial fields and real engineer names never included, unconditionally — not a
    permission check), calls Groq via `RPD_GROQ_API_KEY`/`RPD_GROQ_MODEL`
    (`core/config.py::GroqSettings`, blank in `.env.example`, Docker secret per the P6-T04
    pattern). Returns `503 AGENT_UNAVAILABLE` when unconfigured. Rate-limited (reuse
    `services/rate_limit.py`). Audit-logged (actor, project, question — never the financial/PII
    set, so safe to log per ADR 0014 §4).
  - Acceptance: unit tests proving the resolver's 6 rules and I18 exactly (including negative
    cases: non-report, non-Admin manager, self-grant); an integration test capturing the actual
    outbound Groq request payload and asserting the four financial field names and any real
    engineer name string are absent; live-verified 503 when unconfigured; `backend/scheduling/`
    untouched.
- **P10-T03** — Frontend. Owner: frontend-builder. Depends on: P10-T02.
  Status: DONE (`docs/MEMORY.md` 2026-09-30 "P10-T03 — frontend-builder"). SSO redirect built as a
  minimal, honest, config-gated slice (disabled until `VITE_OIDC_ISSUER`/`VITE_OIDC_CLIENT_ID` are
  set — no backend callback endpoint exists yet to complete a real round trip); the
  Registration/Workspace "Editor-grant read-only notice on charter fields" bullet below is
  deferred — no backend field exposes the caller's effective project-grant role to the frontend,
  so it cannot be implemented without re-deriving the resolver client-side (see memory entry).
  - `/login` route per ADR 0013: SSO button (prod path, unchanged OIDC redirect) or, in dev mode,
    the seeded-user picker (reusing `fetchDevUsers`/`setDevUserEmail` verbatim) grouped by role,
    Super Admin first. `SessionGate`'s `unauthorized` state redirects here instead of showing a
    dead-end "try again" card. No new backend call.
  - `/admin/users` gains a **Project Access** tab: Super Admin sees/edits every grant on every
    project; a manager sees the same tab server-filtered to their own reports and the projects
    they can Admin — one code path, no separate "manager mode" UI.
  - Project Workspace gains an **Ask the agent** panel/tab: free-text question, loading state,
    answer display, explicit error copy for `503 AGENT_UNAVAILABLE` and `429` (reuse the P9-R03
    comment-rate-limit UI pattern).
  - Registration/Workspace header: an Editor-level grant shows the existing read-only-notice
    pattern (ADR 0010 §2) on the fields Editor cannot write (charter fields, freeze), exactly as a
    role without write already does elsewhere. DEFERRED — see status note above.
  - Acceptance: typecheck/lint/test/build green within the 400 KB budget; axe zero
    serious/critical; no `dangerouslySetInnerHTML`.
- **P10-T04** — `qa-inspector` gate. **P10-T05** — `workflow-auditor` gate (I18, the resolver's 6
  rules, no double-counting/no-regression on the existing role matrix). **P10-T06** —
  `security-auditor` gate (delegation privilege-escalation tests per ADR 0012 Consequences; the
  Groq redaction capture test per ADR 0014; `RPD_GROQ_API_KEY` never logged; login page doesn't
  weaken the existing dev-mode gate). Depend on: P10-T01..T03.

### P10 gate findings — remediation (recorded at gate close 2026-09-30, gate itself PASSED)

All three auditors PASSED P10 (see `docs/MEMORY.md`, "P10 gate — workflow-auditor/qa-inspector/
security-auditor"). These three findings surfaced during that gate are landed now rather than
deferred, given severity/scope:

- **P10-F01** — Security High (security-auditor, pre-existing P3-T03/P9-T03 defect, not introduced
  by P10): `services/hub_scope.py::is_engineer_self_scoped` requires `not
  principal.hub_scope_all`; an Engineer-role account with `hub_scope_all=True` (the actual
  seed/factory default for that role) gets its own-assignment row-scoping silently disabled in
  `services/workspace.py::get_scoped_project_or_404`, returning any project unfiltered (financial
  fields still withheld separately; writes still blocked — confirmed bounded blast radius). Owner:
  backend-builder. Status: **DONE** (2026-09-30, backend-builder — see `docs/MEMORY.md`'s
  "P10-F01/F02/F03 — backend-builder" entry; scoping fix + schema-level guard + same-assumption
  fix in `services/notifications.py`, all with regression tests).
- **P10-F02** — Functional gap (qa-inspector): the Project Access tab's project picker (`GET
  /projects`) is gated by `project_registration` READ, which Engineer/Executive Viewer/Auditor all
  lack — a manager-delegate holding one of those roles cannot use the UI to manage their reports'
  grants at all, though the backend endpoints correctly support them. Owner: backend-builder
  (picker data source) + frontend-builder (wire it). Status: **DONE** (2026-09-30 backend-builder
  for `GET /users/me/manageable-projects`; 2026-09-30 frontend-builder for wiring
  `ProjectAccessTab`'s picker to it — see `docs/MEMORY.md`'s "P10-F02/F03 — frontend-builder"
  entry).
- **P10-F03** — Regression (qa-inspector): P10-T03's `/admin/users` `<RequireRead>` removal
  (needed so a non-Admin manager can reach the Project Access tab) broke
  `frontend/e2e/p9-rbac.spec.ts`'s "unreadable routes show the 403 forbidden page" check for 5
  roles. Fix: restore the guard, OR'd with a new `/me` signal for "has delegation rights" rather
  than removing it outright. Owner: backend-builder (`/me` signal) + frontend-builder (route
  guard). Status: **DONE** (2026-09-30 backend-builder for `MeResponse.is_delegate_manager`;
  2026-09-30 frontend-builder for the route guard OR + reconciling `p9-rbac.spec.ts`/
  `p10-gate.spec.ts` — see `docs/MEMORY.md`'s "P10-F02/F03 — frontend-builder" entry).

## P11 — Client change requests: priority move auto-recalculates, capacity booked %, "On Hold"

**Owner:** backend-builder, frontend-builder. Gated by the three auditors.
**Gate:** qa-inspector PASS + workflow-auditor PASS + security-auditor PASS.

Opened 2026-10-09 from Frigoglass's requests, relayed by the project owner:
- "P1 to P2 can be moved and it decide timeline automatically";
- "Lab and design capacity. Design and chamber full. Europe design booked 90 percent and lab 50
  percent book";
- "Instead of blocked it should be on hold".

ADRs: 0015 (priority move), 0016 (booked % and areas), 0017 (On Hold label). Contract:
`docs/API_CONTRACT_P11.md`. Open questions: #24–#27. **`backend/scheduling/` is not touched**,
because no scheduler rule changes.

- **P11-T00**: Docs. Owner: rpd-orchestrator. Status: DONE (2026-10-09).
  - ADRs 0015–0017.
  - `docs/API_CONTRACT_P11.md`.
  - DOMAIN_RULES: "Priority moves", "Booked % and areas", the On Hold label note, I19 and I20.
  - OQ #24–#27, and this section.
- **P11-T01**: Backend. Owner: backend-builder. Depends on: P11-T00.
  Status: DONE (`docs/MEMORY.md` 2026-10-09 "P11-T01 — backend-builder").
  - Priority move: one service function used by both `POST /projects/{id}/priority` (new) and
    `PATCH /projects/{id}` when priority changes.
    - 409 `HARD_GATE_FORCES_P1` when hard gates are set.
    - The audit row is `project.priority_move`.
    - Greedy dispatch reuses the Workspace recalc lifecycle, with the same in-flight check, but a
      run in flight gives `deferred`, not 409.
    - PATCH returns the three response headers, which are also added to CORS `expose_headers`.
  - `GET /schedule-runs/{run_id}/changes?against=`: compares stored fields only, is hub-scoped,
    and returns `hidden_count`.
  - Capacity: `booked_pct` and `booking_status` for year and remaining, on both design and lab, on
    every hub row. Also `area` and the `areas[]` roll-up (lab regions counted once). Thresholds in
    `domain_constants`.
  - On Hold label (ADR 0017): add a single display-label helper and use it in:
    - notification text;
    - Workspace activity summaries;
    - Ask-the-agent context;
    - exports, if they carry stage status.
    Wire values stay unchanged.
  - Acceptance:
    - pytest green;
    - ruff and mypy clean;
    - at least 70 % coverage on touched modules;
    - OpenAPI regenerated;
    - tests cover each `recalc_status` branch, the hard-gate 409 on both paths, the RBAC negatives
      (Engineer, Executive Viewer, out-of-hub Hub Planner, Viewer/Editor grant), I19 to two
      decimals, the area region-once rule, the changes endpoint's hub scoping, and `hidden_count`;
    - `backend/scheduling/` diff is empty.
- **P11-T02**: Frontend. Owner: frontend-builder. Depends on: P11-T00. It builds against the
  contract in parallel with P11-T01 and reconciles before close. Status: DONE (2026-10-09; see
  MEMORY.md "[2026-10-09] P11-T02 — frontend-builder").
  - **Priority move control** (one shared component):
    - Placement: on the Gantt project row and the Project Workspace header. Shown only with
      Registration write; otherwise the existing read-only chip.
    - Flow: choose P1–P4 or Q, call `POST …/priority`, then follow the SSE run.
    - When the run completes: show a "Timeline updated" panel from `GET …/changes`: this project's
      finish week from → to, the other projects that moved, and "+N in hubs you can't see"; then
      invalidate Gantt, Dashboard, Capacity and Workspace queries.
    - `deferred`, `not_needed` and `HARD_GATE_FORCES_P1` each get honest copy.
    - Registration edit form: a note under Priority, "Changing priority recalculates the
      timeline". It reads the `X-Schedule-Recalc` header after save and shows the same panel.
  - **Capacity booked %:**
    - An area strip at the top of the Capacity surface: Europe and India, design and lab booked %,
      with a Full / Near full / Available chip. It follows the existing year/remaining toggle.
    - A booked % with a status chip on each hub row.
    - A Dashboard "Capacity booked" card, shown only with capacity read.
    - Every figure and status is served (I19), never computed in the browser.
  - **On Hold:** every user-facing "Blocked" becomes "On Hold" and "Blocked reason" becomes "Hold
    reason":
    - stage select and chips;
    - health badge;
    - Dashboard tile, donut and provenance copy (caption "In the plan, waiting at a stage");
    - Gantt badge;
    - notification meta.
    Wire values stay unchanged. Status-On-Hold projects stay listed as "paused (status On Hold)".
  - Acceptance:
    - typecheck, lint, test and build green within the 400 KB budget;
    - axe zero serious or critical;
    - no `dangerouslySetInnerHTML`, no raw hex;
    - existing tests updated for the new labels, plus new tests for the move flow (each
      `recalc_status`, 409), the changes panel and the booked % chips.
- **P11-T03**: `qa-inspector` gate.
- **P11-T04**: `workflow-auditor` gate.
  - Do a priority move on a live stack and re-derive that the new run reflects the new sort order.
  - Assert I10 (frozen dates unchanged), I14, I19 and I20.
  - Reconcile Capacity booked % and area sums to two decimals.
  - Confirm Dashboard On Hold count equals `blocked_count`.
- **P11-T05**: `security-auditor` gate.
  - Check the priority move RBAC and hub scope, including grant roles.
  - Check that the changes endpoint does not leak out-of-scope project names (count only).
  - Check that recalc dispatch cannot be used to flood the solver: deferred, not queued, when in
    flight.
  - Check that the new response headers carry no sensitive data.
- P11-T03 to P11-T05 depend on P11-T01 and P11-T02.

### P11 follow-ups (non-blocking, recorded at orchestrator review 2026-10-09)

- **P11-F01**: Show the priority move control to a user whose only write route is an
  Admin-level project grant (ADR 0012). It needs a served per-project effective role. That shares
  a root cause with P10-T03's deferred Editor-grant notice, so build both together. Owner:
  backend-builder + frontend-builder. Status: OPEN.

## P12 — Client change requests 2: Priority board, Gantt drag timing, hub filter, live tracking, VIP

**Owner:** algorithm-engineer, backend-builder (×2: A and B), frontend-builder (×2: A and B).
**Gate:** qa-inspector PASS + workflow-auditor PASS + security-auditor PASS. Because the P11 gate
(P11-T03..T05) was launched on 2026-10-09 but never recorded, **this gate covers P11 and P12
together**; P11 is not closed separately.

Opened 2026-10-10 from Frigoglass's requests, relayed by the project owner:
- "a drag and drop … Kanban chart that allows to change the priority P1, P2 …";
- "change the time of the 14 work steps by moving the Gantt chart … decrease or increase it";
- "a dropdown for all the hubs everywhere … in the main top … to see the stats for a particular hub";
- "Lab and design capacity … Europe design booked 90 % and lab 50 %" and "Instead of blocked it
  should be on hold" — **already delivered by P11** (ADR 0016, ADR 0017); nothing new to build;
- "Project tracking should be LIVE … engineers fill it weekly, or the project itself moves";
- "VIP Projects: critical projects per hub per year, top 10–15, an additional tab on the left".

ADRs 0018–0022. Contract: `docs/API_CONTRACT_P12.md`. DOMAIN_RULES *(2026-10-10)* sections and
I21–I23. Open questions #28–#33.

- **P12-R01** (DONE —, blocking — security-auditor H-1, 2026-10-10): `authorize_project_action`
  (`backend/services/project_access.py:273`) lets the role permission pass without checking the
  project is in the caller's hub scope, and the project lookups admit out-of-hub projects on any grant.
  A Hub Planner with a Viewer/Editor grant on another hub's project can PATCH it (incl. moving its hub),
  move priority, pin VIP, edit stages, upload, comment, recalc. Fix: role path requires
  `is_hub_in_scope(principal, project.hub_id) and not is_engineer_self_scoped(principal)`, else fall
  through to the grant check; regression tests for Viewer/Editor/Admin grants on every write.
  Owner: backend-builder. Status: DONE (2026-10-10; `docs/MEMORY.md` "P12-R01 — backend-builder").
- **P12-R03** (REMEDIATION, blocking — qa-inspector QA-P12-1): frozen projects have no due stages
  (tracking `idle`, `can_check_in=false`), supersedes P12-F03. Owner: backend-builder. Status: DONE
  (2026-10-10; `docs/MEMORY.md` "P12-R03 — backend-builder").
- **P12-R04** (REMEDIATION, blocking — qa-inspector B): categorical chip text contrast ≥ 4.5:1 for
  every slot in `categorical-palette.ts` (B-OEM 3.02:1 today); also fix the check-in 429 copy.
  Owner: frontend-builder. Status: DONE (2026-10-10; `docs/MEMORY.md` "P12-R04 — frontend-builder").
- **P12-R02** (non-blocking, M-1): bump `react-router` to ≥ 7.18.0. Owner: frontend-builder. Status: OPEN
  (2026-10-10, P12-R04: skipped — the app is on `react-router-dom@6.30.6`; ≥ 7.18.0 is a v6→v7 major
  migration with API changes, not a patch/minor bump; needs its own task).
- **P12-T00**: Docs. Owner: rpd-orchestrator. Status: DONE (2026-10-10).
- **P12-T01**: Scheduler step timing (ADR 0019, contract §1). Owner: algorithm-engineer. Depends
  on: P12-T00.
  Status: DONE (2026-10-10; `docs/MEMORY.md` "P12-T01 — algorithm-engineer").
  - `StepTimingInput`, `ProjectInput.step_timing`; effective duration in greedy, CP-SAT,
    unconstrained finish, remaining-duration derivation, roll-up weights; floor for Not Started.
  - I21 and I22 in `invariants.py`; hashed input includes `step_timing`.
  - Acceptance: every existing golden file unchanged (default `()`); new golden/property tests for
    override longer, override shorter, floor later than precedence, floor earlier than precedence
    (no effect), In Progress resize, skipped step with override (stays skipped); self-tests green.
- **P12-T02**: Backend A — step timing endpoint + hub filter (contract §0 p12a, §3, §4). Owner:
  backend-builder. Depends on: P12-T00; the input wiring depends on P12-T01.
  Status: DONE (2026-10-10; `docs/MEMORY.md` "P12-T02 — backend-builder (A)").
  - Migration `p12a_step_timing`; model columns; `PATCH …/steps/{step_id}/timing` with every 409;
    dispatch via `run_dispatch`; Gantt step row and project row extensions; schedule input build
    passes `step_timing`; capacity load uses the effective duration; `hub_id` on every endpoint
    listed in §4.
  - Acceptance: pytest green, ruff + mypy clean, ≥ 70 % on touched modules, OpenAPI regenerated,
    RBAC negatives (Engineer, Executive Viewer, PM — Gantt read only, out-of-hub Planner), each
    `recalc_status`, hub filter never widens scope (out-of-scope `hub_id` ⇒ zeros), I23 on a seed.
- **P12-T03**: Backend B — Priority board, VIP, check-ins, tracking status (contract §0 p12b, §2,
  §5, §6). Owner: backend-builder. Depends on: P12-T00.
  Status: DONE (`docs/MEMORY.md` 2026-10-10 "P12-T03 — backend-builder (B)"; includes the ADR 0023
  amendment).
  - Migration `p12b_vip_checkins` (down_revision `p12a_step_timing`); `StageCheckin` model with
    UPDATE/DELETE protection; `services/tracking.py`; `GET /priority-board`; `GET /check-ins/due`,
    `POST /check-ins`, `GET /check-ins/history`; `GET /vip-projects`, `PUT /projects/{id}/vip`;
    `is_vip` + `tracking_status` on `/dashboard/projects` rows.
  - Acceptance: as P12-T02, plus Engineer can check in only own/led stages (403/422
    `FORBIDDEN_STAGE` otherwise), batch atomicity, server-filled actual weeks, VIP ranking and
    `over_limit`, check-in rows immutable.
- **P12-T04**: Frontend A — global hub filter + Gantt drag (ADR 0019, 0020). Owner:
  frontend-builder. Depends on: P12-T00.
  Status: DONE (2026-10-10; `docs/MEMORY.md` "P12-T04 — frontend-builder (A)").
  - `stores/hub-filter.ts`, header hub select, every portfolio surface wired (query keys + params),
    Gantt local select removed, "Hub: X" chip; Gantt bar move + right-edge resize with week snapping,
    honouring `timing_editable`, keyboard alternative (a timing dialog), optimistic ghost then the
    P11 run-follow + "Timeline updated" panel, "Reset timing"; VIP badge and tracking chip on rows.
- **P12-T05**: Frontend B — Priority board, VIP projects, Weekly check-in surfaces (ADR 0018, 0021,
  0022). Owner: frontend-builder. Depends on: P12-T00.
  Status: DONE (2026-10-10; `docs/MEMORY.md` "P12-T05 — frontend-builder (B)").
  - Three nav entries and routes; Kanban with accessible drag (pointer + keyboard) calling the P11
    move flow; VIP page with year toggle and pin control; check-in page with batch form, "per plan"
    progress, history drawer, due-count badge in the sidebar; `TrackingStatusChip`, `VipBadge`.
- Acceptance for P12-T04/T05: typecheck, lint, test and build green within the 400 KB initial
  budget; axe zero serious/critical; no `dangerouslySetInnerHTML`, no raw hex; every figure served.
- **P12-T06**: `qa-inspector` gate (P11 + P12). Status: PASS (2026-10-10; see MEMORY.md gate entries).
- **P12-T07**: `workflow-auditor` gate (P11 + P12): I10, I14, I19–I23 on a live run; a drag and a Status: PASS (2026-10-10; see MEMORY.md gate entries).
  priority move re-derived independently; hub-filtered reconciliation.
- **P12-T08**: `security-auditor` gate (P11 + P12): Engineer check-in write scope, hub-filter Status: PASS (2026-10-10; see MEMORY.md gate entries).
  non-widening, timing/VIP/board RBAC incl. grants, check-in immutability, rate limiting, no
  per-engineer ranking (GDPR).

### P12 amendment (2026-10-10, after the owner's answers to OQ #28–#33) — ADR 0023

- **P12-T03 (backend B) extended:** `POST /check-ins` dispatches one greedy run per batch
  (`trigger_reason="check_in"`, priority-move lifecycle; response gains `recalc_status`,
  `schedule_run_id`, `baseline_run_id`, `task_id`). Coalesced follow-up run in
  `services/run_dispatch.py` + worker completion + `schedule_run_sweeper` (durable flag in Postgres,
  added to migration `p12b_vip_checkins`), honoured by `priority_move`, `step_timing`, `check_in`.
  Tests: burst of N deferred ⇒ exactly one follow-up (I24); follow-up on failure/sweep; Workspace
  Recalculate unchanged.
- **P12-T04 / P12-T05 (frontend) extended:** `deferred` copy becomes "Saved — the timeline updates
  automatically after the current recalculation"; the UI watches for the next active run and
  refreshes; check-in submit follows a `queued` run and shows the "Timeline updated" panel.
- **P12-T07 (workflow-auditor) extended:** I24.

### P12 follow-ups (non-blocking, recorded at orchestrator review 2026-10-10)

- **P12-F01**: Touch drag on the Priority board (pointer events or a library); the per-card move
  control is the touch path until then. Owner: frontend-builder. Status: OPEN.
- **P12-F02**: Extend P11-F01 (per-project effective role) to the board drag, VIP pin and check-in
  for users whose only write route is an Admin-level grant. Owner: backend-builder +
  frontend-builder. Status: OPEN.
- **P12-F03** (workflow-auditor W-1): a frozen project can show tracking "due"/"overdue" while
  check-ins on it are refused (`PROJECT_FROZEN`). Treat frozen projects as `idle` in
  `services/tracking.py`. Owner: backend-builder. Status: DONE (2026-10-10, via P12-R03;
  `docs/MEMORY.md` "P12-R03 — backend-builder").
- **P12-F04** (workflow-auditor W-2): the timing response reports `effective_duration_weeks` = lead
  time for a cert-off (skipped) lab step; should report 0. Display only. Owner: backend-builder.
  Status: DONE (2026-10-10, with P12-R03; `docs/MEMORY.md` "P12-R03 — backend-builder").

## P13 — Client change requests 3: country filter, all-projects register, mock-up parity

**Owner:** backend-builder, frontend-builder. **Gate:** qa-inspector PASS + workflow-auditor PASS +
security-auditor PASS.

Opened 2026-10-18 from Frigoglass's requests, relayed by the project owner, with their earlier web
app (github.com/ultimatechin/RPDCHARTERV1del) and the mock-up deck (15-09):
- "in the main dashboard there are India, Romania and Greece options and All Hubs — we want that";
- "whatever is in their website and mock-up, everything should be in ours too";
- "on dashboard add a place that displays all the projects".

ADR 0025. Contract: `docs/API_CONTRACT_P13.md`. Open question #34.

- **P13-R01** (REMEDIATION, blocking — qa-inspector QA-P13-1/2/3):
  - Fix the serious `aria-hidden-focus` on the analytics charts (`analytics-breakdown.tsx:257/339/495`).
  - Fix `scrollable-region-focusable` on `completing-hub-type-table.tsx:66`,
    `hub-utilization-matrix.tsx:91` / `ui/table.tsx:18` and `category-timeline.tsx:136`.
  - Fix the register's Table/Cards tabs (`aria-valid-attr-value`) and the `bg-drop` pill
    contrast (4.13:1).
  - Also P13-F11: validate the `?edit=` UUID and use `encodeURIComponent`.
  - Owner: frontend-builder. Status: DONE (2026-10-19).
- **P13-R02** (REMEDIATION, gate-adjacent):
  - P13-F10: CSV/XLSX formula injection.
  - P13-F06: "Deliverable" counts schedulable statuses only.
  - P13-F12: withhold `leader_name` in exports; Gantt `offset` `ge=0`; Engineer `engineer_names`
    limited to the caller.
  - Owner: backend-builder. Status: DONE (2026-10-19, P13-R02).

- **P13-T00**: Docs (ADR 0025, contract, OQ #34). Owner: orchestrator. Status: DONE (2026-10-18).
- **P13-T01**: Backend — `region` on every hub-filtered endpoint (contract §1),
  `GET /dashboard/region-summary` (§2), the enriched `/dashboard/projects` and its facets (§3).
  Owner: backend-builder. Depends on: P13-T00. Status: DONE (2026-10-18).
- **P13-T02**: Frontend — country filter store, header and Dashboard segmented buttons, chip,
  country chips on the KPI cards, and the all-projects register (contract §4). Owner:
  frontend-builder. Depends on: P13-T00; the types follow P13-T01. Status: DONE (2026-10-18).
- **P13-T03**: Mock-up parity gap list → follow-up tasks (P13-T1x). Owner: orchestrator. Status:
  DONE (2026-10-18; gap analysis summarised in `docs/MEMORY.md` "P13-T03 — orchestrator").

Wave 2 (starts after P13-T01/T02 land, so that no two builders edit the same files):
- **P13-T10**: Dashboard analytics.
  - Charts: By Hub donut, By Category donut, a flat By Type bar, and Registered by Year (a
    server-side aggregate on `reg_year`).
  - "Completing within year: Hub × Type" table and a Pipeline-vs-Completing-by-type chart. Add
    `type` to `CompletingWithinYearRow` and serve the cross-tab server-side.
  - Owner: backend-builder + frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T11**: Capacity priority split.
  - Load by priority bucket (P1/P2/P3/Queue) per hub.
  - Stacked load-vs-capacity charts.
  - Priority columns on the utilization matrix.
  - KPI caption lines.
  - Class cards with a per-hub ✓/✗ split and a P split.
  - Owner: backend-builder + frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T12**: Priority board. Design and lab weeks per column (server-side), search, and Category /
  Type / Status / Leader filters. Owner: backend-builder + frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T13**: Gantt toolbar.
  - Search, Category / Type / Status / Leader / Step filters, a sort select, P1–P4/Queue tabs, a px
    zoom, a Forest (compact) view, and Hide stats.
  - Row meta: leader, code, type, D/L weeks.
  - A weekly PDD/OEM active-step count row.
  - Owner: backend-builder + frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T14**: Matrix toolbar.
  - Type and Status chips, per-column filters, a Rank column, and Leader and Status columns.
  - Reset view and Detailed view.
  - An editable FX rate, Admin only, through the existing `PUT /currency-rates/{code}`.
  - Owner: backend-builder + frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T15**: Shell.
  - Header "Week N · M wks left" and today's date.
  - A Versions & History page listing schedule runs, with their change lists, and scenario
    versions.
  - A Downloads page listing export jobs (needs a list endpoint).
  - Owner: backend-builder + frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T16**: Workflow settings. Per-category timeline previews derived from served lead times and
  the DAG, and a B-equivalent workload panel with server-side ratios. Owner: backend-builder +
  frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` P13 slice entries).
- **P13-T17**: Registration search, and Engineers and Chambers grouped by hub / lab region on
  Capacity Planning. Owner: frontend-builder. Status: DONE (2026-10-19; `docs/MEMORY.md` slice A
  entries).
- **P13-T20**: Gate: qa-inspector, workflow-auditor and security-auditor for all of P13. Status:
  PASSED (2026-10-19). The first QA run failed; it passed on re-run after P13-R01/R02.

P13 follow-ups (non-blocking, recorded at orchestrator review 2026-10-19):
- **P13-F01**: The Capacity KPI Deliverable / Left-out strip still sums `classBreakdown.rows` in the
  browser. This predates P13. Serve `ClassBreakdown.totals`. Owner: backend-builder +
  frontend-builder. Status: OPEN.
- **P13-F02**: The Matrix Hub and Leader column filters only narrow the rows on screen. Make them
  server params. Owner: backend-builder + frontend-builder. Status: OPEN.
- **P13-F03**: The Gantt and Matrix exports ignore the new toolbar filters. `/priorities/summary`
  ignores them too. Owner: backend-builder + frontend-builder. Status: OPEN.
- **P13-F04**: Merge `services/project_filters.py` with the private helpers in `dashboard.py`. The
  priority board has its own LIKE-escape. Owner: backend-builder. Status: OPEN.
- **P13-F05**: The Downloads page lists only async export jobs, and the page Download buttons are
  synchronous, so the list is usually empty. Decide whether to log the synchronous downloads too.
  Owner: backend-builder. Status: OPEN.
- **P13-F06** (workflow-auditor): the Capacity class breakdown counts every active-run project that
  is not left out as "Deliverable", including Commercialized, On Hold and Cancelled projects. That
  is 61 projects in the live data. This predates P13; P13 carries it into the priority splits, the
  by-hub split and the total badge. Count schedulable statuses only, or define "deliverable" in
  DOMAIN_RULES. Owner: backend-builder (client wording check). Status: DONE (2026-10-19, P13-R02).
- **P13-F07** (workflow-auditor): the Board never shows projects with no priority (ADR 0018), so
  its Q column is Q only. This corrects the 2026-10-19 ruling text; see the MEMORY correction
  entry. Decide whether no-priority projects belong in the Board's Queue column. Owner:
  orchestrator + backend-builder. Status: OPEN.
- **P13-F08** (workflow-auditor): Board remaining weeks come from the stored step window and can
  overcount when a predecessor runs past the current week. There is no live divergence. Use the
  progress-derived remaining figure instead. Owner: backend-builder. Status: OPEN.
- **P13-F09** (workflow-auditor): `gantt.py::_kind_weeks` treats a step kind missing from the
  snapshot as design, while Capacity ignores it. Align the two. Owner: backend-builder. Status:
  OPEN.
- **P13-F10** (security-auditor M-1; dates from P5): CSV/XLSX formula injection in
  `export_builder._stringify` and `xlsx_bytes`. Prefix `'` to strings that start with
  `= + - @ \t \r`, and force XLSX cells to text. Owner: backend-builder. Status: DONE (2026-10-19, P13-R02).
- **P13-F11** (security-auditor L-3): validate that `?edit=` is a UUID before fetching, and use
  `encodeURIComponent` (`registration-api.ts:55`). Owner: frontend-builder. Status: DONE (2026-10-19, via P13-R01).
- **P13-F12** (security-auditor L-4, Info-5, Info-6): withhold `leader_name` in exports; add
  `ge=0` to the Gantt `offset`; limit the Gantt `engineer_names` map to the caller for Engineers.
  Owner: backend-builder. Status: DONE (2026-10-19, P13-R02).
- **P13-F14** (qa-inspector QA-P13-4/5/6): the Radix Select fails axe while open; `/exports/capacity`
  has no hub/region filter; per-file coverage gaps; `dev-role-switcher.tsx` is unused. Owner:
  frontend-builder + backend-builder. Status: OPEN.
- **P13-F13** (security-auditor L-2): the withheld leader name can be re-identified through
  `leader_engineer_id` and `GET /engineers` by roles that can already read engineers. Added to OQ #8
  for the DPO. Owner: orchestrator. Status: OPEN.

Blocked on client answers (OQ #34–#38), not built: Plant and Req. dept fields and their charts;
ROI, payback and RM-savings formulas; bulk Apply Priorities and exclude; Apply & Save All and global
undo; the 2026–2027 Gantt horizon; project delete and Excel import with merge; saved baselines;
Weeks/Days man-day conversion; Manage Tabs; the portfolio-wide AI question bar.

## P14 — Client change requests 4: priority-move preview, scheduler check, VIP on Dashboard

Opened 2026-10-19. ADR 0026 and ADR 0027. Contract: `docs/API_CONTRACT_P14.md`. The gate covers
all of P14.

| ID | Task | Owner | Depends | Status |
|---|---|---|---|---|
| P14-T01 | Priority move preview and confirm: in-process greedy, preview token, abandoned-run reaper (contract §1) | backend-builder A | — | DONE (MEMORY 2026-10-19; gate pending) |
| P14-T02 | VIP board: migration, seed, `GET /vip-board`, item writes (contract §2) | backend-builder B | — | DONE |
| P14-T03 | Scheduler and calculation re-derivation on the live DB: invariants I1–I24, dashboard, capacity and Gantt reconciliation, and the root cause of "priority board not working" | workflow-auditor | — | DONE |
| P14-T04 | Frontend: priority move dialog on every move entry point; Dashboard VIP card and dialogs; remove the `/vip` nav (contract §3) | frontend-builder | T01, T02 shapes | DONE |
| P14-T20 | Gate: qa-inspector, workflow-auditor and security-auditor | — | T01–T04 | DONE |

## P15 — Per-engineer utilization and leader names (ADR 0028)

| ID | Task | Owner | Status |
|---|---|---|---|
| P15-T01 | Backend: `GET /capacity/engineer-utilization`, audit, leader_name un-withheld everywhere incl. exports | backend-builder | DONE |
| P15-T02 | Frontend: Engineers × Weeks heatmap replaces the placeholder; leader names displayed ("Withheld" removed) | frontend-builder | DONE |
| P15-T20 | Gate: qa, workflow, security | — | DONE |

## P16 — Prioritization matrix: Gross Profitability, ROI, new weights (ADR 0029)

| ID | Task | Owner | Status |
|---|---|---|---|
| P16-T01 | Backend: constants, scoring, served scaled weights and points, recompute stored scores, mark stale | backend-builder | DONE |
| P16-T02 | Frontend: labels, pillar move, weights and points scaled to 100 in the Matrix, Registration, Workspace | frontend-builder | DONE |
| P16-T20 | Gate | qa / workflow / security | DONE |

## P17 — Dashboard parity with the client's older app (ADR 0030)

Opened 2026-10-20. Contract: `docs/API_CONTRACT_P17.md`. The Project Pipeline row becomes
`Spillover + Newly registered + Unregistered date = Total projects` (total includes Commercialized).

| ID | Task | Owner | Status |
|---|---|---|---|
| P17-R01 | Gate remediation: update `_zeroed` in test_p12_hub_filter.py to the new StatusOverview shape; correct the "lower completing %" claim in ADR 0030; add hub-restricted Hub Planner test on pipeline-totals / status-overview / region-summary | backend-builder | DONE (MEMORY 2026-10-20) |
| P17-T01 | Backend: `unregistered_count`, server-side shares, all-projects pipeline basis across totals / region summary / hub-type / analytics | backend-builder | DONE (MEMORY 2026-10-20) |
| P17-T02 | Frontend: pipeline row (three cards + total, shares, per-country chips); update hand-mirrored types | frontend-builder | DONE (MEMORY 2026-10-20) |
| P17-T03 | Backend: five-card status overview (`commercialized_count`, `on_hold_count`, `total_count`, shares, `other_statuses_*`) on `/dashboard/status-overview` | backend-builder | DONE (MEMORY 2026-10-20) |
| P17-T04 | Frontend: five status cards (count, % of total, per-country chips from `region-summary.status_counts`, progress bar), "Other statuses: n"; mirror the new `StatusOverview` fields | frontend-builder | DONE (MEMORY 2026-10-20) |
| P17-T20 | Gate: qa, workflow, security | — | DONE (MEMORY 2026-10-20; qa PASS, security PASS, workflow FAIL then PASS on re-gate) |
| P17-R03 | Backend: `status` + `not_started` on `CompletingWithinYearRow`; server-side `priority_delivery` bands (in flight / not started / delivered / other) on `/dashboard/completing-within-year` | backend-builder | DONE (MEMORY 2026-10-21) |
| P17-R04 | Frontend: "Delivery by priority" card split into in flight vs not started, Commercialized set apart; mirror `status`, `not_started`, `PriorityDeliveryBand`, `priority_delivery` | frontend-builder | DONE |
| P17-R05 | Frontend: Dashboard layout (Project pipeline row, then Status overview, at the top) and scheduled-vs-pipeline count labelling ("209 scheduled" chip/badge + info popover from served figures) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P17-R06 | Frontend: Dashboard rearrangement (remove Project outcomes table, Planning week card, Finish-week chart; Hub x Type pipeline summary + compact VIP side column directly below Completing within the year); dead-code removal | frontend-builder | DONE (MEMORY 2026-10-21) |
| P17-R07 | Frontend: disambiguate the two Dashboard "On Hold" figures (outcome tile "On Hold at a stage" + served paused-status line; scheduled-count popover "paused (status On Hold)"; outcome and status info popovers name each other; donut / hub-stack / completion-profile labels qualified) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P17-R08 | Frontend: Dashboard Hub × Type row (pipeline summary table + completing table side by side, Pipeline vs completing chart beneath) with drill-down dialogs on every non-zero cell / total; Hub × type bar chart removed; VIP squeezed into a slim column beside the Project pipeline row; register moved to the bottom; Delivery-by-priority card redesigned as per-band stacked bars. Backend follow-up needed: `type=Unmapped` on `GET /dashboard/projects` | frontend-builder | DONE (MEMORY 2026-10-21) |
| P17-R09 | Backend: `GET /dashboard/projects` accepts `type=Unmapped` (= `Project.type IS NULL`, the analytics `by_type` sentinel), ANDed with every filter inside hub scope, other unknown values 422; frontend flips `UNTYPED_REGISTER_FILTER_SERVED` | backend-builder | DONE (MEMORY 2026-10-21) |

## P18 — What-if planner: scenario engine, tool API, chat (ADR 0031)

Opened 2026-10-20. Contract: `docs/API_CONTRACT_P18.md` (the pure-Python interface of
`backend/scheduling/whatif.py`). A planner (or the chat assistant, through the same tools) describes
a scenario (more projects, more or fewer designers, more chambers, downtime changes, priority
moves). The engine answers instantly with formulas (extra design and lab weeks, booked % per hub and
lab region, the minimum extra designers and chambers) and exactly by re-running the real greedy
scheduler on a copy of the plan (who slips, who finishes, utilization, a diff against today's plan).
No LLM and no CP-SAT inside the engine. Nothing is persisted by a what-if.

| ID | Task | Owner | Status |
|---|---|---|---|
| P18-R01 | Gate remediation, engine (workflow D2/D2b/D3, security S18-M1): estimate "before" load = active run's I6/I7 sums; headline totals over touched hubs/regions only (+ `touched_*` fields); `exact` only when verified (probes + polish + verification); engine caps (200 projects, 50 designers, 20 chambers) and cooperative `deadline_s` / `WhatIfBudgetExceeded` | algorithm-engineer | DONE (MEMORY 2026-10-21) |
| P18-R02 | Gate remediation, API layer: mirror the caps in strict request models (and zod), pass `deadline_s` to the engine and map `WhatIfBudgetExceeded` to 503 `WHATIF_TIMEOUT`, D1 (within-year = `within_year AND NOT blocked`), recompute totals from `touched_*`, surface `touched_*` and the new `exact` wording, amend OQ #45; see `docs/API_CONTRACT_P18.md` section 10 | backend-builder | DONE (MEMORY 2026-10-21) |
| P18-T01 | Scheduling: pure what-if engine `scheduling/whatif.py` (`Scenario`, `analytic_requirements`, `simulate`, `solve_minimum_additions`), tests, ADR 0031, contract | algorithm-engineer | DONE (MEMORY 2026-10-20) |
| P18-T02 | Backend: build `WhatIfBaseline` from the DB (hub-scoped), scenario API, tool layer, chat endpoint (LLM only translates text to `Scenario` and explains results; never computes) | backend-builder | DONE (MEMORY 2026-10-21) |
| P18-T03 | Frontend: What-if UI and chat panel on Capacity Planning | frontend-builder | DONE (MEMORY 2026-10-21) |
| P18-R03 | Frontend follow-ups after the P18 gate: mirror `touched_*`, touched-first estimate rows and headline label, `diff.within_year_*` headline, `exact` wording, zod caps and running totals, 429/503 handling and disabled Run buttons, chat egress hint, 390 px scrollable tables, stale p9-rbac sidebar spec (contract sections 10-11) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P18-T20 | Gate: qa, workflow, security | — | DONE (MEMORY 2026-10-21; qa PASS, security PASS, workflow PASS on re-gate; first gate FAILED on D1/D2/D3, fixed in P18-R01..R03) |

## P19 — Capacity page redesign (client mock-up parity)

Opened 2026-10-21. Owner request: the RPD Capacity surface follows the client's older app (KPI cards,
class cards, load-vs-capacity charts first), shows "capacity booked" for every hub and lab region,
and collapses the verbose per-hub detail behind a summary table + Details dialog and disclosures.
Frontend only; every number stays a served field (I9/I19).

| ID | Task | Owner | Status |
|---|---|---|---|
| P19-R03 | Gate remediation, Gantt (P19 + P20 re-gate, qa): QA-P19-4 drag label calendar weeks from the unclipped span (`stepDragCalendar`: `fteSpanWeeks(work, fte)`, 1:1 without FTE) with ", to W53" / "past W52" past the plan year; QA-P19-3 focus returns to the narrow Details button when `GanttProjectDetailsDialog` closes (`onCloseAutoFocus`); O-R1 resize handle inset at the axis end | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-R02 | Gate remediation, Gantt (P19 + P20 gate, qa): QA-P19-1 skipped step rows no longer dimmed with `opacity-60` (name muted token + strikethrough + "(skipped)", kind badge full contrast; activity strip `text-text-subtle/60` dot also removed); QA-P19-2 responsive fixed columns below 768 px (one name column, 40 % of the chart clamped 88..124 px, status column folded into a row icon + project details dialog, labelled focusable timeline region, 20 px touch handle; 1280+ unchanged); O1 drag label flips left of the cursor near the right edge and wraps when wider than the visible timeline | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-R01 | Gate remediation, security (P19 + P20 gate): S19-M1 `GET /planning/resource-load` intersects `engineer_id` with the caller's hub scope before any predicate (none in scope = empty lists, zero totals; echo in-scope ids only); S19-L1/L2 explicit `null` on engineer / chamber PATCH is 422, integrity errors mapped (409 unique only) with no row values logged; S19-L3 strict engineer / chamber request models; S19-I1 note in ADR 0032 + OQ #8; add-on D2: seed docstring "scheduler ignores FTE" corrected | backend-builder | DONE (MEMORY 2026-10-21) |
| P19-T01 | Frontend: Capacity page redesign (header toggles Weeks/Days + YTD/Full year; 4 KPI cards; class cards; two load-vs-capacity charts; booked tiles for all hubs and lab regions; compact hub summary table + Details dialog; collapsed utilization sections, lazy-fetched) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-T02 | Frontend: Capacity fixes after owner review: summary table fits 1280-1440 (Design / Lab header bands, short headers, compact % and status icons, Details icon button), lab figures once per lab region (grouped rows), accurate booked-% note, hub utilization matrix inline; Europe / India area view removed, booked % per hub only (owner ruling) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-T03 | Backend: capacity figures for Capacity Planning and the Weeks/Days toggle: `weekdays_per_week` + day figures on `/capacity/hub-load` rows, `lab_regions[]` and day totals; `capacity_weeks` / `capacity_days` on `/engineers` and `/chambers`; new `GET /planning/capacity-summary`; "Resource load analytics" `GET /planning/resource-load` (audited, filters, basis) and `/planning/resource-load/options`; see `docs/API_CONTRACT_P19.md` | backend-builder | DONE (MEMORY 2026-10-21) |
| P19-T04 | Frontend: Capacity Planning page redesign against `docs/API_CONTRACT_P19.md` (capacity summary by hub and lab region with shares, engineer and chamber capacity in weeks/days, Resource load analytics filter bar + engineer and chamber load-vs-capacity charts and tables); enable the Capacity page Days toggle on the served day fields; mirror the new fields in `api/types.ts` (turns the P19 contract rows green) | frontend-builder | DONE (MEMORY 2026-10-21; Capacity-page Days toggle NOT wired: needs served day gap / priority fields or an owner ruling) |
| P19-T05 | Frontend: RPD Capacity Weeks / Days toggle on the served day fields (`API_CONTRACT_P19` §1): KPI cards + per-hub / per-region lines, charts (axis title + value labels), booked tiles, hub summary table (lab once per region, Total), Details dialog, utilization matrix; one `CapacityView` state for unit + horizon; no browser multiplication (I19); absent day fields show "—". Owner add-on: class chart disclosure moved below the hub matrix, above chamber / engineer utilization | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-T06 | Frontend: RPD Capacity owner changes: "Capacity booked" tiles grouped in one labelled box per hub family (R&D / PD (Product Development) / OEM; 3 / 2 / 1 per row; no family total, none served); "Load vs. capacity per hub" and "Global resource utilization matrix" merged into ONE "Load vs. capacity by hub" table (family row groups, Design and Lab bands, lab figures once per region with a shared marker, served totals, priority split mini-bar + "Show priority split" columns, status-tinted booked % with bar, signed / coloured gap); gate D1 booked-note wording (ADR 0032) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-T07 | Frontend: RPD Capacity owner removals: the class chart ("Show class chart" disclosure + deliverable vs. left-out bar chart; the seven class cards stay) and the chamber "Resource utilization matrix" ("Show chamber utilization" disclosure) are removed with their components, hook and fetcher; the page no longer requests `/capacity/utilization-matrix`. "Show engineer utilization" unchanged | frontend-builder | DONE (MEMORY 2026-10-21) |
| P19-T20 | Gate: qa, workflow, security | — | TODO |

## P20 — FTE gates scheduling speed (ADR 0032)

Opened 2026-10-21. Owner ruling (final): "0.5 FTE represents half speed". A design step of a
non-frozen project led by an engineer with FTE `f` books `ceil(duration / f)` weeks; lab, elapsed
and skipped steps, frozen projects and Done steps are not stretched; In Progress tails stretch
their remaining effort; FTE <= 0 is a `data_error`; load stays in effort weeks. Supersedes ADR
0002 and answers OQ #2.

| ID | Task | Owner | Status |
|---|---|---|---|
| P20-T01 | Scheduling: ADR 0032, DOMAIN_RULES (booking rules, remaining span, capacity supply note, known defect #1 closed, I1/I6/I21), FTE stretch in `prepare_run` / greedy SGS / CP-SAT / invariant validator / what-if engine, tests, impact study on a disposable client_2026 DB at W42 | algorithm-engineer | DONE (MEMORY 2026-10-21) |
| P20-T02 | Backend follow-ups to ADR 0032 §6: engineer-utilization weekly cells spread effort over the elapsed span (In Progress / Blocked: remaining effort on the booked tail), totals unchanged; `stage_overrun` / health badge against the FTE-stretched planned span; Priority board remaining design weeks in effort; engineer FTE request bounds (0.01..9.99, no NaN/inf); ADR 0002 docstrings point to ADR 0032; sweep of every backend span derivation | backend-builder | DONE (MEMORY 2026-10-21; + `GanttStepRow.span_fte`, migration `p20a_run_step_span_fte`) |
| P20-T03 | Frontend follow-ups to ADR 0032 §6: Gantt right-edge drag converts elapsed width to effort for `duration_override_weeks` and labels effort vs elapsed; copy that cites ADR 0002 (`capacity-reporting-notice.tsx`, `engineer-form.tsx`, `planning/api/types.ts`, `card-info.tsx`) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P20-T20 | Gate: qa, workflow, security | — | TODO |

## P22 — Projects and Registration merged

Opened 2026-10-21. Owner request: "club the project registration and all project page". One page,
"Projects", at `/projects`: the all-projects register (list / cards, filters, sort, export) plus a
"Register project" button and an "Edit registration" row action that open the registration form in
a full-height side drawer (hard gates, leave-Draft submit, financial fields, priority-move preview,
unsaved-changes guard). `/register` redirects to `/projects`; `?edit=<id>` deep links open the
drawer. Frontend only, existing endpoints; every number stays a served field (I9).

| ID | Task | Owner | Status |
|---|---|---|---|
| P22-T01 | Frontend: merge Project Registration into the Projects page (header filters + Drafts chip + list/card toggle + Export menu with both exports + Register button for writers; registration drawer for create / edit with hard-gate panel; `/register` and `/register/:id` redirects, `?edit=` deep link; nav single "Projects" entry; tests and e2e page objects) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P22-T20 | Gate: qa, workflow, security | — | TODO |

## P21 — Prioritization matrix: currencies, rubric columns, distribution, compare, score 0

Opened 2026-10-21. Owner requests: EGP / ZAR / IDR currencies (no invented rates; 422
`CURRENCY_NOT_CONFIGURED` until a rate is set; OQ #50); rubric scores per row (`dimension_scores`)
with the financial columns moved out of the main table (still in the edit dialog and exports);
band distribution and score histogram; compare 2–5 projects; a dimension may be scored 0 (owner
ruling, ADR 0033). Contract: `docs/API_CONTRACT_P21.md`.

| ID | Task | Owner | Status |
|---|---|---|---|
| P21-R01 | Security remediation (P19 + P20 re-gate, security-auditor, two Lows): S21-L1 `CurrencyRateUpdateRequest` strict (`extra="forbid", strict=True`; a boolean, a string or an extra key gives 422, a JSON number gives 200 and is audited); S21-L2 `useSignOut` removes every `rpd-` sessionStorage key (incl. `rpd-matrix-compare`) and dispatches `rpd:signed-out` (no matrix import) | backend-builder | DONE (MEMORY 2026-10-21) |
| P21-T01 | Backend: currencies EGP/ZAR/IDR with null rates + `name`/`configured` on `GET /currency-rates`, 422 `CURRENCY_NOT_CONFIGURED`, bounded rate PUT; score 0..5 (schemas, CHECK constraints, ADR 0033, DOMAIN_RULES); `dimension_scores` on matrix rows; `GET /priorities/distribution`; `GET /priorities/compare`; migration `p21a_currencies_score_zero`; contract `docs/API_CONTRACT_P21.md` | backend-builder | DONE (MEMORY 2026-10-21) |
| P21-T02 | Frontend: Matrix currency picker on the served list (disabled when not configured, 422 handling), rubric columns from `dimension_scores`, financial columns out of the main table, distribution chart + histogram, compare dialog (2–5), score inputs 0..5; mirror the contract types (turns the P21 contract rows green) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P21-T03 | Frontend: Matrix scoring grid boxes and borders (pillar boxes with 2 px separators and alternating tint, identity / info / Score /100 blocks with 3 px separators, inner 1 px cell lines, score chips whose intensity follows the served 0..5 score, zebra + hover + selected rows across the frozen block, opaque sticky header/frozen cells, frozen-block shadow when scrolled sideways, wrapping centred dimension headers) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P21-T04 | Frontend: editable 0–5 scores in the Compare dialog (same permission rule and the same `PUT /priorities/{id}` body and mutation as the edit dialog; explicit per-project Save / Discard with dirty cells and a labelled preview; server refetch after save; Scenario mode stages; close guard; inline 403/422) + compare-selection reset on sign-out (S21-L2 second half) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P21-T05 | Frontend: Priority board moved into the Matrix as a second tab (`/matrix?view=board`, `/priority-board` redirects, nav entry removed); shared View panel filters and search; score writes also refresh the board and Workspace; Scenario marking on the board; Cards / List board layout (`layout=list`, per-user localStorage); stale links fixed in e2e | frontend-builder | DONE (MEMORY 2026-10-21) |
| P21-T20 | Gate: qa, workflow, security | — | TODO |

## P23 — UI clean-ups

Opened 2026-10-21. Owner requests: "In Buyoff" and "Draft" removed from the UI (no project has either:
In Queue 85, In Development 83, Cancelled 29, Under Industrialization 24, Commercialized 17, On Hold 15).
Owner ruling (same day): Draft is dropped from registration; a new project is created In Queue once its
hard-gate fields are set (ADR 0034, contract `docs/API_CONTRACT_P23.md`). The wire enum, the
`ProjectStatus` type and the scheduler's status order (In Buyoff first) are unchanged.

| ID | Task | Owner | Status |
|---|---|---|---|
| P23-T01 | Frontend: one shared `UI_PROJECT_STATUSES` (and `UI_SCHEDULABLE_STATUSES`) in `types/enums.ts` without In Buyoff / Draft, used by every filter, chip and select (Projects, Dashboard register, Gantt, Priority board, Matrix via `PROJECT_STATUSES`, leave-Draft target, what-if); Drafts chip removed; Dashboard "Other statuses" copy names only served statuses; badge still renders any status. Extension (owner ruling): registration drawer has one "Register project" action, client-side check of the 8 hard-gate fields (incl. priority), server 422 `HARD_GATE_FIELDS_MISSING` mapped onto the fields, Leave Draft kept only for a legacy Draft | frontend-builder | DONE (MEMORY 2026-10-21) |
| P23-T02 | Backend: `POST /projects` validates the hard-gate fields up front (422 `HARD_GATE_FIELDS_MISSING` with `field_errors`), creates In Queue; PATCH to Draft is 422 `DRAFT_RETIRED`; priority joins the gate (ADR 0034); `UNKNOWN_LEADER` 422; legacy `/submit` shares the 422 shape; ORM Draft default removed; seed refuses Draft; contract `docs/API_CONTRACT_P23.md` | backend-builder | DONE (MEMORY 2026-10-21) |
| P23-T03 | Frontend: Dashboard "Capacity booked" card (Europe / India booked %, "Open capacity" link) removed, with its test; the Dashboard no longer requests `GET /capacity/hub-load`; no empty row left (Hub × Type leads into Portfolio analytics); DashboardPage tests assert absence + no capacity request; e2e page object / specs updated (stale "Completion outcome" locator replaced) | frontend-builder | DONE (MEMORY 2026-10-22) |
| P23-R01 | Final-gate qa remediation QA-F23-1 (WCAG 1.4.3): Dashboard "Delivery by priority" segment counts take the ink of their token pair (no fixed white; dark text on amber, the tints and grey), segments moved to `dashboard/lib/delivery-segments.ts`; same fix on "Outcomes by hub" (white on amber found live); token-measured contrast test light + dark; live axe 0 across every country incl. India at 1440 / 390 | frontend-builder | DONE (MEMORY 2026-10-22) |
| P23-T20 | Gate: qa, workflow, security | — | TODO |

## P24 — Real client data in the seed (ADR 0035)

Opened 2026-10-21. Owner ruling: "go with your recommendations" on the workflow-auditor's seed
data verification (MEMORY 2026-10-21). The `client_2026` seed uses the formula workbook's roster
(17 people, real FTE), adds the 6 workbook leaders who are not on it as provisional engineers,
leaves the 20 blank-leader projects unassigned (`no_leader`), uses the workbook chamber
efficiencies, and stores plant / requesting department / product type, `Spillover '25` and the
end dates. ADR 0024's tuning (leader cap, capacity engineers, FTE and efficiency tuning) is
retired. Rubric scores stay synthetic and flagged. OQ #52–#62. The dev DB is reseeded by the owner.

| ID | Task | Owner | Status |
|---|---|---|---|
| P24-T01 | Backend: extractor reads the roster (`RPD Capacity!I39:T50`), plant / product type / requesting department, end date (`target_end_week` rule) and `Spillover '25`; JSON regenerated; `seed/client_2026.py` real roster + provisional leaders + no invented assignment, tuning removed; `seed_demo_data` stores the new fields, `carry_over` / `reg_year`; migration `p24a_project_charter_fields`; `ProjectRead` and `ProjectFilterRow` serve the 3 fields (read-only); resource-load department filter + options; ADR 0035; OQ #52–#62; tests | backend-builder | DONE (MEMORY 2026-10-21) |
| P24-T02 | Frontend: mirror `plant`, `requesting_department`, `product_type` (all `string \| null`) on `ProjectRead` (registration types), `WorkspaceProject` (project-workspace types) and `ProjectFilterRow` (dashboard types), turning those contract rows (and the WorkspaceProject nullability row) green; fix `e2e/p15-gate.spec.ts`, which picks engineer index 40 (the seed now has 23 engineers); show them read-only (register columns / Workspace); the Resource load analytics department filter now has served options; optionally label a no-leader left-out project ("No leader") — the reason is not served today, only `leader_engineer_id = null` + `LEFT_OUT` | frontend-builder | DONE (MEMORY 2026-10-21) |
| P24-R01 | Backend: multi-role row scoping — Engineer no longer narrows a principal who also holds a hub-scoped role (ADR 0012 MAX): `is_engineer_self_scoped` by role set, `project_row_scope` union on Gantt / run changes; heatmap keeps the ADR 0028 own-row rule; alice.pm's extra roles were added in the UI (audit log), dev-DB correction command in MEMORY | backend-builder | DONE (MEMORY 2026-10-21) |
| P24-R02 | Final-gate qa remediation QA-F24-1 (WCAG 4.1.2): Capacity Planning resource-load filter popovers (Type, Status, Dept, Cat, Engineer) get an accessible name (`<Name> filter options`, Dept → Department, Cat → Category); tests per filter; live axe 0 with each open at 1440 / 390 | frontend-builder | DONE (MEMORY 2026-10-22) |
| P24-T20 | Gate: qa, workflow, security | — | TODO |

## P25 — P1 capacity fill (ADR 0036)

Opened 2026-10-21. Owner ruling: "P1 for score ≥ 70 is right, but if capacity is not full, add
projects to P1 until capacity is full." Per hub, against the remaining-year design capacity (the
Capacity page's `design_capacity_remaining`), using remaining design effort from the active run
(ADR 0032). Candidates below 70 are walked by score descending, then `project_id`, and the walk
stops at the first one that would exceed 100 %. Only the SUGGESTED band changes ("P1 (capacity
fill)"); committed priorities stay a human decision. The fill is read only and never writes,
audits or schedules. Contract: `docs/API_CONTRACT_P25.md`. OQ #51.

| ID | Task | Owner | Status |
|---|---|---|---|
| P25-T01 | Backend: ADR 0036 + DOMAIN_RULES "P1 capacity fill"; pure walk `fill_p1_capacity` in `services/priority_scoring.py`; one-pass loader `services/priority_capacity_fill.py`; matrix rows / compare items gain `score_band`, `capacity_fill`, `capacity_fill_reason` (`suggested_band` = promoted band); `GET /priorities/capacity-fill`; distribution `capacity_fill_count` + summary `score_band_counts` / `capacity_fill_count` (promoted-band counts); contract `docs/API_CONTRACT_P25.md`; tests | backend-builder | DONE (MEMORY 2026-10-21) |
| P25-T02 | Frontend: label promoted rows "P1 (capacity fill)" from the served `capacity_fill` (tooltip = `capacity_fill_reason`), show the per-hub fill from `GET /priorities/capacity-fill`, mirror the contract types (turns the six P25 contract rows green) | frontend-builder | DONE (MEMORY 2026-10-21) |
| P25-T03 | Backend: serve the fill everywhere a band is shown, from the one-pass loader (`compute_capacity_fill`, optional pre-loaded `active_run`): `PriorityBoardCard` + `external_code`, `suggested_band` (promoted), `score_band`, `capacity_fill`, `capacity_fill_reason` (board totals unchanged); `WorkspacePriorityScore` same four (`suggested_band` = promoted); `GET /exports/matrix` + `score_band` / `capacity_fill` / `capacity_fill_reason`, promoted band relabelled `suggested_band_after_capacity_fill`; contract §5; tests | backend-builder | DONE (MEMORY 2026-10-21) |
| P25-T04 | Frontend: mirror P25-T03 (board card + `WorkspacePriorityScore` types, turning the two contract rows and the §7 nullability row green); show "P1 (capacity fill)" on board cards and in the Workspace score section; show `external_code` in the board's List layout | frontend-builder | DONE (MEMORY 2026-10-21) |
| P25-T20 | Gate: qa, workflow, security | — | TODO |

## P26 — Editable scoring rubric (ADR 0037)

Opened 2026-10-22. Owner request: "in the Prioritization Matrix, only there, we can edit the
scoring rubric: edit the weightage and also add something (new dimensions)"; details delegated to
the orchestrator's defaults. The rubric moves into tables (`scoring_dimensions`,
`rubric_versions`, `priority_dimension_scores`); Admin / Super Admin edit weights, labels, pillars,
order, add / deactivate / reactivate dimensions (never delete), with optimistic versioning (409),
a preview, and an audited new version that recomputes every stored score in the same transaction.
TOTAL_WEIGHT = Σ active weights; a missing score counts 0 and marks the score incomplete. The
schedule is never touched. Contract: `docs/API_CONTRACT_P26.md`.

| ID | Task | Owner | Status |
|---|---|---|---|
| P26-T01 | Backend: ADR 0037 + DOMAIN_RULES amendment; migration `p26a_scoring_rubric_tables` (3 tables, 13 dimensions + version 1, lossless score copy, old 13 columns dropped); `GET/PUT /scoring-rubric`, `GET /scoring-rubric/versions`, `POST /scoring-rubric/preview`; every reader on the tables (Matrix rows N `dimension_scores` + `missing_dimension_keys` + `rubric_version`, compare, distribution, summary, capacity fill, board, Workspace, score PUT `scores` map, scenario apply, export one column per active dimension, seed); constants removed; contract `docs/API_CONTRACT_P26.md`; tests | backend-builder | DONE (MEMORY 2026-10-22) |
| P26-T02 | Frontend: rubric editor in the Prioritization Matrix only (Admin / Super Admin: weights, labels, pillars incl. new, order, add, deactivate / reactivate, reason; preview impact before save; 409 reload flow; version history); Matrix grid / compare / edit dialog / Workspace / scenario on N dynamic dimensions and the `scores` map; "incomplete" marker from `missing_dimension_keys`; mirror the contract types (turns the 16 P26 contract rows green) | frontend-builder | DONE (MEMORY 2026-10-22) |
| P26-T03 | Frontend (owner request): rubric editing moves into the "Scoring scale and dimensions" card on the Matrix; the View panel "Scoring rubric" button, the side sheet and the "Show / Hide rubric" collapse are removed; the card is always expanded (pillar-first table: one rowspan cell per pillar with count and weight, grid-matching tint, accents and separators; stacked boxes on phones); "Edit rubric" for the served `can_edit` only (else "Read-only · managed by Admins"); "Version history" dialog for everyone; inline edit mode with the P26-T02 editor (cross-pillar reorder), expandable preview, sticky footer, Cancel asks to discard, leave-page warning; tests + e2e | frontend-builder | DONE (MEMORY 2026-10-22) |
| P26-R01 | Final-gate qa remediation QA-F26-1 (lost update): the rubric 409 "Re-apply my draft" re-applies only the Admin's own changes (draft vs the version it was edited from, kept on the draft) onto the latest version; conflicts (same field both sides, a dimension deactivated / renamed remotely, same label added twice, both reordered) shown per field "Your value 40 · Current 30" with a choice defaulting to the server value; added dimensions re-added; unit tests for the scenarios, panel tests, two-tab e2e with mocked routes (`e2e/qa-f26-1-rubric-rebase.spec.ts`); also the read card's pillar-name contrast | frontend-builder | DONE (MEMORY 2026-10-22) |
| P26-T20 | Gate: qa, workflow, security | — | TODO |

## P27 — Registration "project nature" tags pre-fill scores (ADR 0038)

Opened 2026-10-22. Owner request: if Registration says the project is a New Customer, Strategic
Project, New Options, Regulatory / Business Compliance, New Models or Improvement, that dimension
gets full score. Owner answers: multi-select tags; pre-filled 5 stays editable; untagged
dimensions manual; backfill existing projects from `type`. Contract: `docs/API_CONTRACT_P27.md`.

| ID | Task | Owner | Status |
|---|---|---|---|
| P27-T01 | Backend: `Project.scoring_tags` (6 fixed values, multi); migration + backfill from `type` (NM/NO/RC/IMP) setting mapped scores to 5 and recomputing; create/PATCH accept tags, set→5 only on not-set→set transition, audited with tag source; tags served on project/Workspace reads and the Matrix rows; contract `docs/API_CONTRACT_P27.md`; tests | backend-builder | DONE (MEMORY 2026-10-22) |
| P27-T02 | Frontend: "Project nature" multi-select on Registration and the Workspace edit; Matrix / Workspace score shows a "from registration" hint on tag-filled dimensions (still editable); mirror contract types; tests | frontend-builder | DONE (MEMORY 2026-10-22) |
| P27-T20 | Gate: qa, workflow, security | — | TODO |

### P27 — Security remediation (final gate)

Opened 2026-10-22 from "Final gate (P21–P26) — security-auditor: FAIL" (MEMORY). Top priority in
P27. Code items here; S26-C1 (dev mode off on Render + exposure review) and the actual Render DB
password / field-key rotation are operator actions, both required for the re-gate (evidence:
`/me` 401 + `/me/dev-users` 404 without credentials; rotated count = non-null count). IDs are
`P27-R..` because P27-T.. is the tags work above.

| ID | Task | Owner | Status |
|---|---|---|---|
| P27-R01 | S26-L1: Workspace `capacity_fill_reason` with hub figures only when the hub is in the caller's scope and the caller can read the Matrix; otherwise "P1 (capacity fill)" when promoted, else null; `capacity_fill` unchanged; DOMAIN_RULES + contract P25 §5b note; auditor-probe tests | backend-builder | DONE (MEMORY 2026-10-22) |
| P27-R02 | S26-L2: `/docs`, `/redoc`, `/openapi.json` only in dev mode (`api_docs_urls()`); `app.openapi()` still works for the contract tests; tests | backend-builder | DONE (MEMORY 2026-10-22) |
| P27-R03 | S26-M1: `render.yaml` static-site `headers:` (strict CSP with script hash, no inline script; style `'unsafe-inline'` proven necessary; `connect-src` = API origin; `frame-ancestors 'none'`, XFO DENY, Referrer-Policy, Permissions-Policy, nosniff, COOP); browser check 0 violations; guard test | backend-builder | DONE (MEMORY 2026-10-22) |
| P27-R04 | S26-H1 support: `backend/scripts/rotate_field_key.py` (MultiFernet, one transaction, verify + rollback, `--dry-run`, keys from env/files only, columns from the models); tests on disposable DBs; `docs/HANDOVER/KEY_ROTATION.md` (Render steps + production env checklist) | backend-builder | DONE (MEMORY 2026-10-22) |


## P28 — Executive dashboard view (ADR 0039)

Opened 2026-10-22. Owner request: the client's "Level 1: Executive View (Helicopter)" (Teams
proposal + ASCII mock-up + Power BI quality-dashboard visual reference): one compact page for
CEO / CMO / top management on the Dashboard, with pipeline and status-overview pie charts and
the key figures. Frontend only; every number stays a served field (I9/I19). Mock-up items with
no served source (CAPEX, roadmap quarters, curated alerts, test success rate, hiring) are not
invented — OQ #63. Contract: ADR 0039.

| ID | Task | Owner | Status |
|---|---|---|---|
| P28-R01 | Gate remediation (QA leg of P30-T20): QA-F28-1 Upcoming completions stacks below `sm` (chip + name / hub · priority; quarter strip 2-col with Delivered full width), QA-F28-2 KPI tile header stacks below `md` (no icon, label line, badge line; one taller fixed frame); Risks rows stack below `sm`; no letter-level `break-words` on names; dead `hubsGlance()` removed; e2e `p28-executive.spec.ts` (typecheck-only); unit tests; 1440 unchanged (0-pixel diff). Addendum QA-F28-3: the KPI badge moved from the label row to the figure line at every width (sweep 390 + 760–1920, 0 issues) | frontend-builder | DONE (MEMORY 2026-10-23 P28-R01 + P28-R01 addendum) |
| P28-T01 | Frontend: Executive view on the Dashboard (header Executive / Detailed toggle, `?view=executive`, per-user localStorage, Executive-Viewer-only role default; KPI tile strip; pipeline + status donuts + delivery gauge; delivery-by-priority bars; Risks & escalations list from served rows: blocked, overdue check-ins, VIP not within year; Hubs at a glance from `/capacity/hub-load`, fetched only in Executive view; P23-T03 absence test narrowed to the Detailed view; tests) | frontend-builder | DONE (MEMORY 2026-10-22 P28-T01) |
| P28-T20 | Gate: qa, workflow, security | — | DONE (MEMORY 2026-10-23 "Gate P28–P30": qa PASS re-check 2, workflow PASS, security code PASS; owner-accepted open risks S26-C1, S26-H1, S30-H1) |

## P29 — OEM hubs under Greece capacity (ADR 0042)

Opened 2026-10-22. Client ruling: both OEM hubs are under Greece; Greece's capacity serves all
three and Greece's load includes the OEM projects. `hubs.capacity_hub_id`, `engineers.counts_in_capacity`,
capacity surfaces on four capacity hubs with a members breakdown, Greek engineers eligible for OEM
categories, provisional leaders for the 17 leaderless OEM projects. Contract: `docs/API_CONTRACT_P29.md`.
Solver input changes: workflow-auditor gates.

| ID | Task | Owner | Status |
|---|---|---|---|
| P29-T01 | Backend: migration `p29a_capacity_hubs` (`hubs.capacity_hub_id`, `engineers.counts_in_capacity`, Theoni → R&D-Greece, Greek roster + OEM categories, OEM calendars retired, provisional leaders for leaderless OEM projects with audit); capacity service per capacity hub with `members`; hub-load / capacity-fill / heatmap / dashboard capacity cards / Capacity Planning readers; scheduler input passes `capacity_hub`; seed + extractor; contract `docs/API_CONTRACT_P29.md`; tests | backend-builder | DONE (MEMORY 2026-10-23 P29-T01/T04/T06) |
| P29-T02 | Scheduler: `ProjectInput.capacity_hub` (defaults to hub); engineer pool and leader eligibility by capacity hub; OEM workflow still selected by hub; golden files / invariants updated; self-tests | algorithm-engineer | DONE |
| P29-T03 | Frontend: capacity surfaces show four rows with the Greece members breakdown and OEM-filter behaviour; "not in capacity roster" marker on Capacity Planning roster; provisional-leader badge in Workspace/Registration; hub pickers label OEM hubs "(Greece)"; mirror contract types; tests + e2e page objects | frontend-builder | DONE (MEMORY 2026-10-23 P29-T03 + P29-T04 frontend) |
| P29-T04 | Data: client type `BC` (Business Continuity) = app `RC`, relabelled "Regulatory / Business Compliance"; extractor + seed + migration step (type, `regulatory_compliance` tag, score 5 pre-fill, audit); frontend label (ADR 0038 amendment 2026-10-22) | backend-builder (in P29-T01) / frontend-builder (in P29-T03) | backend DONE (MEMORY 2026-10-23 P29-T01/T04/T06); frontend DONE (MEMORY 2026-10-23 P29-T03 + P29-T04 frontend) |
| P29-T05 | Scheduler follow-up: `EngineerInput.counts_in_capacity` (default true); what-if supply sums counted engineers only (ADR 0042 §6 clarified) | algorithm-engineer | DONE |
| P29-T06 | Backend follow-up: input builder passes `counts_in_capacity` to `EngineerInput`; what-if service serves the four capacity hubs only | backend-builder (in P29-T01) | DONE (MEMORY 2026-10-23 P29-T01/T04/T06) |
| P29-T20 | Gate: qa, workflow, security | — | DONE (MEMORY 2026-10-23 "Gate P28–P30": qa PASS re-check 2, workflow PASS, security code PASS; owner-accepted open risks S26-C1, S26-H1, S30-H1) |


## P30 — Per-project effort drives schedule and load (ADR 0041)

Opened 2026-10-23. Owner accepted R1 (one effort figure sets load and span; B design 10 → 4 weeks
at 1.0 FTE). ADR 0041 is Accepted with the workflow-auditor's R1–R14 binding. Sequencing (R14):
the solver change lands before any 0 is written; migration `p30a` runs after `p29a_capacity_hubs`.
The workflow-auditor re-derives after the reseed. No figure is tuned toward a target.

| ID | Task | Owner | Status |
|---|---|---|---|
| P30-R01 | Gate remediation (security leg): S30-L1 strict `design_effort_weeks` / `lab_effort_weeks` (string / bool → 422); S30-I1 engineer lists scope-check the REQUESTED `hub_id` before member → capacity-hub resolution (out of scope → empty, ADR 0020); tests | backend-builder | DONE (MEMORY 2026-10-23 P30-R01) |
| P30-R02 | Gate follow-ups (non-blocking, from P30-T20 QA / workflow / security): deterministic ORDER BY on `/dashboard/hub-type-pipeline` (hub, type, NULL last) and `/dashboard/completing-within-year` (name, id) + ANALYZE stability test + robust P13 region test (QA 1b / N3); tests for R7 rejection on lead-time edit and unfreeze and the check-in R6 re-derivation (QA 3); S30-L2 unknown `hub_id` on engineer-utilization → 200 empty, audit FK only for an existing hub; N4 docstring (inside `scheduling/`, reported to algorithm-engineer) | backend-builder | DONE (MEMORY 2026-10-23 P30-R02) |
| P30-T01 | Scheduler: one skip predicate (R5: eff = 0 ⇒ skipped in `analyse_project`), override/effort domain 0..104, validator I5 derives skip from inputs, I25/I26 checks, Monte Carlo floor (R10), fixtures + golden files incl. the R14 hub-spelling rename (stored runs keep the old spelling, I14); self-tests | algorithm-engineer | DONE (MEMORY 2026-10-23 P30-T01; `prototype_seed_data.json` rename left to P30-T02 with the enum) |
| P30-T02 | Backend: migration `p30a` (after p29a) adding `project_workflow_steps.effort_weeks` (R4 precedence user ?? effort ?? lead) + per-project `design_effort_weeks` / `lab_effort_weeks`; exact-rational split (R2) with recorded-work protection (R3); R6 re-derivation triggers + audit action; R5 predicate in step_timing / stage PATCH / gantt / project_cards / tracking / demand query; I25 demand fields and R12 reader mapping; seed + extractor read the client's effort columns; R7/R8 edge cases; DOMAIN_RULES text (R13); contract `docs/API_CONTRACT_P30.md`; tests | backend-builder | DONE (MEMORY 2026-10-23 P30-T02) |
| P30-T03 | Frontend: Gantt "Reset timing" / `hasTimingEdit` / "(table T)" tooltip ignore effort values (R4); effort fields shown read-only where the contract serves them; mirror contract types; tests | frontend-builder | DONE (MEMORY 2026-10-23 P30-T03; contract test 224 passed) |
| P30-T04 | Reseed client_2026 on a disposable DB + workflow-auditor re-derivation (I1–I26), and report the resulting within-year rate as served | workflow-auditor | DONE (MEMORY 2026-10-23 P30-T04 audited reseed; greedy + CP-SAT PASS) |
| P30-T20 | Gate: qa, workflow, security (covers P29 + P30) | — | DONE (MEMORY 2026-10-23 "Gate P28–P30": qa PASS re-check 2, workflow PASS, security code PASS; owner-accepted open risks S26-C1, S26-H1, S30-H1) |

## P31 — Multi-select category and project-type filters

Opened 2026-10-23. Owner: "Can we pick A+, A, B — multiple together, same with project types." Every
category / type filter becomes multi-select, applied server-side (I9: totals and counts stay served).

**Contract:**
- `category` and `type` are repeatable query params (`?category=A%2B&category=B&type=NM&type=CO`).
  - Values within one param are ORed; different params are ANDed.
  - An empty list means no filter.
  - A single value behaves exactly as today, so old links keep working.
  - The Dashboard register's `type` also accepts `Unmapped` (type IS NULL) in the list.
- Unknown values give 422 as today.
- Endpoints:
  - `GET /dashboard/projects` and its facets, if they take these filters;
  - `GET /projects` (list);
  - `GET /gantt` (and its export, if any);
  - `GET /priorities` and `GET /priorities/…` at priorities.py:200/392;
  - `GET /priority-board`;
  - `GET /exports/matrix` and any other export with these params.
- Planning resource-load already takes lists and is unchanged.

| ID | Task | Owner | Status |
|---|---|---|---|
| P31-T01 | Backend: repeatable `category` / `type` on every endpoint above (OR within, AND across, empty = all, single value unchanged, `Unmapped` on the register); hub scoping unchanged; OpenAPI; tests (scope extended to every Dashboard aggregate + `/vip-projects`) | backend-builder | DONE (MEMORY 2026-10-23 P31-T01; `docs/API_CONTRACT_P31.md`; suite 2420 passed) |
| P31-T02 | Frontend: multi-select category and type filters on Dashboard register, Projects page, Gantt toolbar, Matrix View panel, Priority board toolbar; URL state as repeated params (old single-value links still parse); compact chip / toggle-group UI with clear-all; export carries the selection; tests | frontend-builder | DONE (MEMORY 2026-10-23 P31-T02; + Dashboard cross-filter donuts) |
| P31-R01 | Owner bug (Render): reload shows "Could not load" and forces a new sign-in. Session `/me` retries network / timeout / 502–504 with backoff for ~90 s behind a "Waking up the server…" state (elapsed time, Retry now); 401 → /login at once; dev-user email untouched while retrying; "Remember me" defaults ON; login dev-mode probe waits out 502–504; tests | frontend-builder | DONE |
| P31-T20 | Gate: qa, workflow, security | — | TODO |

## P32 — Plan import into the What-if, parallel steps by overlap (ADR 0043, ADR 0044)

Opened 2026-11-04 from the client's two requests relayed by the owner: (1) upload the 2027 capacity
planning workbook to the What-if planner and get the Gantt, capacity and completion for file +
current projects; (2) per-step Gantt bars that can be moved, resized and overlapped (parallel steps),
recomputing everything. Contract: `docs/API_CONTRACT_P32.md`.

| ID | Task | Owner | Status |
|---|---|---|---|
| P32-R09 | GATE REMEDIATION (security S32-M1): plan import hub scope — reject rows whose hub or existing leader is out of scope in `to_engine_request`; parse roster from in-scope designers only; probe tests | backend-builder | TODO (MEMORY 2026-11-12 gate FAIL) |
| P32-R10 | GATE REMEDIATION (workflow F3): plan import baseline = untouched live plan (or amend ADR 0044 + contract B1) | backend-builder + algorithm-engineer | TODO |
| P32-R11 | GATE REMEDIATION (workflow F1): serve the within-year share and scheduled count; remove the browser formula in `dashboard/lib/outcome.ts` | backend-builder + frontend-builder | TODO |
| P32-R12 | GATE REMEDIATION (workflow F2): owner ruling + ADR — auto-recalculation replacing an active CP-SAT run, and what the change list is diffed against | orchestrator (owner decision) | TODO — blocked on owner |
| P32-R13 | GATE REMEDIATION (security S32-M2/M3, live 500s, workflow F4/F5): rate-limit step timing + workspace recalculate, run retention; `.env.example` dev mode false + startup guard; 422 for invalid export filters / NUL / int64 offset / deep JSON, app body cap; `spread_effort` start = tail; one VIP count | backend-builder | TODO |
| P32-T01 | Scheduler: `StepTimingInput.overlap_weeks`, release/gate semantics in greedy, CP-SAT, unconstrained finish, invariants (I3 via G, new I27), validation, hash omits 0; golden files unchanged; new tests | algorithm-engineer | DONE (MEMORY 2026-11-04 P32-T01) |
| P32-T02 | Pure engine `scheduling/plan_import.py` (`run_plan_import`): scenario build, two greedy runs, per-step rows, windowed + weekly capacity, designers, KPIs, changes, issues; tests | algorithm-engineer | DONE (MEMORY 2026-11-04 P32-T02) |
| P32-T03 | Backend: migration `p32a_step_overlap`, timing PATCH `overlap_weeks`, Gantt `overlap_weeks` + `predecessor_ids`, schedule input passes it; tests | backend-builder | DONE (MEMORY 2026-11-04 P32-T03) |
| P32-T04 | Backend: `.xlsx` parser + `POST /whatif/import/parse` and `/whatif/import/simulate`, schemas, scope, audit, limits; tests with a synthetic workbook | backend-builder | DONE (MEMORY 2026-11-04 P32-T04) |
| P32-T05 | Frontend: live Gantt overlap gesture (release helper, drag label, dialog field, broken bar with lanes, Reset) ; tests | frontend-builder | DONE (MEMORY 2026-11-04 P32-T05) |
| P32-T06 | Frontend: What-if "Import plan (Excel)" flow — upload, review/fix (engineer assignment), results (overview, draggable Gantt with re-simulate, capacity, projects); tests | frontend-builder | DONE (MEMORY 2026-11-04 P32-T06) |
| P32-R01 | Owner bug "Solver queued" forever (no Celery worker locally / on Render): greedy recalcs run in-process (`RPD_GREEDY_INLINE`, default true; CP-SAT unchanged), Redis optional (best-effort progress, SSE falls back to the run row) | backend-builder | DONE (MEMORY 2026-11-04 P32-R01) |
| P32-R02 | Owner: step bar editing (move, resize, parallel overlap) on the Project Execution Timeline only; a per-project section was tried and reverted the same day | frontend-builder | DONE (MEMORY 2026-11-04 P32-R02) |
| P32-R03 | Owner rule: "Num of Projects" (models) n ≥ 2 → n projects by default (`expand_multi` default true, `projects_after_expansion`, ×n chip, invalid → 1 + warning) | backend-builder + frontend-builder | DONE (MEMORY 2026-11-04 P32-R03) |
| P32-R04 | Owner: per-project step drag on the Workflow page ("Project step timing" tab, picker, 14-step waterfall, unplaced-project banner); Timeline keeps its drag | frontend-builder | DONE (MEMORY 2026-11-04/05 P32-R04) |
| P32-R05 | Owner: What-if import Executive tab (served `breakdowns` by year), year filter (All/2026/2027/after/not placed) on Executive/Gantt/Projects, session scenarios + variant builder (e.g. only 5 A+) + Compare tab, card-based UI clean-up | backend-builder + frontend-builder | DONE (MEMORY 2026-11-05 P32-R05) |
| P32-R06 | Client's priorities workbook (no Status column, Num of Models, Running, Rom/Unbound/OEM, budget lines) read alongside the first format | backend-builder + frontend-builder | DONE (MEMORY 2026-11-05 P32-R06) |
| P32-R07 | Owner: every What-if import number is clickable → side sheet listing exactly those projects (count = number), Show on Gantt / Open project | frontend-builder | DONE (MEMORY 2026-11-05 P32-R07) |
| P32-R04b | Owner: Workflow "Project step timing" lists ALL projects (the Timeline's Gantt with editing), expand → drag steps; search filter; axis past W52 | frontend-builder | DONE (MEMORY 2026-11-05 P32-R04 rework) |
| P32-T20 | Gate: qa, workflow, security | — | TODO |

## P33 — Category template editing, apply rules, categories table; per-project timing retired (ADR 0045–0048)

Opened 2026-11-13 from the owner's change request, with the owner's answers to our clarifying
questions:
- the Timeline previews become editable with Move ± / Length ± buttons and signed gaps (overlap or
  wait);
- the stage rule decides which projects receive a change;
- Admins may add a category;
- per-project timing editing is removed;
- Admin and Super Admin edit templates.

Contract: `docs/API_CONTRACT_P33.md`. DOMAIN_RULES "Category templates, apply rules, categories
table".

**Status at P33-T01 (2026-11-13).** The ruling (R33-1..R33-12) and the owner's answer to OQ #76/#77
(OR-1..OR-6, "if it is manually set then use them only as the timeline") are folded into ADR
0045–0048, DOMAIN_RULES (final P33 section) and the contract. **Nothing pins:** `length_pinned` /
`length_set` are dropped. A project's own effort figure is its timeline for that kind. The template
length applies only to projects without a figure for the kind, and gaps apply to all.
`workflow_lead_times.effort_weight_weeks` (immutable) holds the R2 weights. P33-T02..T04 are open.

**Release (2026-11-15).**
- The P33-T13 code and migration `p33c` ship together. After `alembic upgrade head`, run
  `python -m scripts.p33_recalc_after_timing_clear` once.
- Migration chain: `p32a → p35a → p33a → p36a → p33b → p33c`. P35/P36 migrations ship with P33 or
  before it.
- T02/T03 never deploy without T07's canonical token (T05-A3).
- Open builder follow-up from the 2026-11-15 rulings: registration and category change take the
  category row `FOR SHARE` before any project lock (contract E3).

**Sequencing (as planned at opening).**
1. **P33-T00 first.** The workflow-auditor rules on ADR 0046 Q1–Q9, then the orchestrator folds the
   ruling in (P33-T01). No algorithm task opens before the ruling, and no backend task that writes or
   reads per-project template values opens before P33-T02/T03 land. This mirrors P30's R14: the
   solver change lands before data that needs it.
2. **Tasks that may run before the ruling:** P33-T06 (RBAC surface) only. The categories migration
   P33-T07 waits for P33-T03.

**Carried in from P32.** The P32 gate is FAIL with P32-R09..R13 open. P32-R12 (auto-recalculation
replacing an active CP-SAT run) also governs `template_apply` runs; it is still blocked on the
owner. P32-R13's step-timing rate limit is moot once P33-T13 retires the endpoint; the apply
endpoint carries its own limit.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P33-R02 | **Gate remediation (P33-T20 qa-inspector FAIL).** Apply dialog: the scrollable project lists in `frontend/src/surfaces/workflow-settings/components/template-apply/project-rows.tsx` (`max-h-72 overflow-y-auto` list at :27 and the virtualized container at :65) fail axe `scrollable-region-focusable` (serious) on real data — make them keyboard-scrollable (`tabIndex={0}`, visible focus ring; the virtualized `<div>` gets `role="region"` + `aria-label`). Also wrap the long line at `backend/tests/test_p11_capacity_booked.py:170` (repo-wide `ruff check .` red). | frontend-builder | P33-T20 | Unit axe test with >10 rows (overflowing) and a test for the virtualized path (>100 rows), both clean; `project-rows.tsx` coverage raised; the "apply: …" scans in `frontend/e2e/p33-gate.spec.ts` clean on a disposable stack; `ruff check .` clean; tsc/eslint/vitest pass; MEMORY entry. Then re-run the qa-inspector leg (dialog axe scans + frontend suite) — see MEMORY "P33-T20 gate — combined result: FAIL". | DONE (MEMORY 2026-11-15 P33-R02) |
| P33-T00 | **Ruling** on ADR 0046 Q1–Q9: per-project lead and pin in `eff`; R2 weights and shadowed share; copy rule (a)/(b); signed gap semantics (wait ignored on started, skipped and frozen steps; first step 0); waits in the unconstrained finish and CP-SAT; the preview's one-leader rule and whether the unconstrained finish applies it; canonical hash omission; category rank from data and I30; the timing fields kept for what-if only. Binding R-items, as for ADR 0041 | workflow-auditor | — | MEMORY entry with an answer per Q1–Q9 (accept / amend with exact text) and any new R-items; the invariant list I27–I31 confirmed or amended; no code | DONE (MEMORY 2026-11-13 P33-T00: ACCEPT WITH CHANGES, R33-1..R33-12) |
| P33-T01 | Fold the ruling in: ADR 0046 status → Accepted (with R-items), ADR 0047 §3 / ADR 0048 §4; DOMAIN_RULES P33 section loses "PROPOSED"; contract Part F updated; plan dependencies re-checked | orchestrator | P33-T00 | ADR, DOMAIN_RULES and contract consistent with the ruling; MEMORY entry | DONE (MEMORY 2026-11-13 P33-T01, incl. the owner's ruling on OQ #76/#77) |
| P33-T02 | Scheduler: `StepTimingInput.lead_weeks` and `wait_weeks`; R33-1 evaluation (`lead_weeks ?? table`, `override ?? lead`); piecewise gate (R33-4); `w = 0` on tails and Blocked holds; `g` ignored on skipped steps and in frozen projects (which still honour `lead_weeks`); first-step / both-non-zero `ValueError`; greedy, CP-SAT (`start ≥ pe + w`), unconstrained finish with the one-leader rule (R33-6), Monte Carlo (never samples gaps; R10 floor on `lead_weeks`), validator I27 rev., I28, I29; canonical form, snapshot keys only when non-default (R33-7) | algorithm-engineer (`backend/scheduling/` only) | P33-T01 | All golden files byte-identical (if R33-6 changes one: stop and report, never re-bless); the scheduling suite passes at ≥ 85 % coverage; new tests: wait on design / lab / elapsed, wait + capacity, wait already elapsed costs nothing, wait → LEFT_OUT at the horizon, In Progress tail ignores the wait, skipped step's gap ignored, `lead_weeks` 0→n revives and n→0 skips, override beats lead, both-non-zero rejected, I28 as a difference test, CP-SAT ≡ greedy on these cases, unconstrained one-leader with a design ∥ design overlap; MEMORY entry | DONE (MEMORY 2026-11-13 P33-T02 and "P33-T02 closed": the 3 P32 re-blesses accepted at P33-T05 applied; 570 passed, 95.31 % coverage) |
| P33-T03 | Scheduler: `ScheduleInput.categories` (`CategoryInput`) with today's seven as the default; R33-8 validation; sort key 5 = rank value; CAT_NOT_ALLOWED OEM test, `whatif` and `plan_import` category lists read `workflow_id` from the input; CP-SAT via `ctx.ordered`; I30 in the validator; canonical omission and `workflow_snapshot["categories"]` only when non-default (R33-7) | algorithm-engineer | P33-T01 | Golden files byte-identical; a test inserting a category between B and C orders those projects between B and C and leaves everything else unchanged; I30 checked on greedy and CP-SAT; MEMORY entry | DONE (MEMORY 2026-11-13 P33-T03) |
| P33-T04 | Scheduler: pure `template_timeline` (contract F3): DOMAIN_RULES §D gate from week 0, no capacity, FTE 1.0, one-leader rule, flags `same_leader_serialised` / `anchor_clamped` / `gap_ignored_zero_length` | algorithm-engineer | P33-T02 | With all gaps 0 it reproduces today's category-timelines for all 7 categories; tests for each flag, wait, lab ∥ design overlap, design ∥ design serialised; agrees with the unconstrained finish on a fresh not-started project; MEMORY entry | DONE (MEMORY 2026-11-13 P33-T04; shares T02's one-leader rule — T02 blocker cleared at P33-T05, T02 DONE) |
| P33-T05 | Workflow-auditor check of P33-T02..T04 before the data lands (as P30-T01 → T02), plus a review of the owner-ruling builder mapping OR-3 / OR-4 / OR-5 (contract F4, E3 step 6, E4) and the restated I31 / I32 against R33-1 / R33-2, before P33-T08 opens | workflow-auditor | P33-T02, P33-T03, P33-T04 | PASS recorded in MEMORY: invariants hold on the seeded data with the new code; stored runs re-validate byte-stable; the live `workflow_snapshot` DAG keeps design steps totally ordered (R33-6); OR-3's mapping reproduces DOMAIN_RULES §B `eff` and today's input byte-for-byte after backfill | DONE (MEMORY 2026-11-13 P33-T05 PASS; binding T05-A1..A3, rulings 1–6) |
| P33-T06 | Backend: RBAC surface `workflow_templates` (Admin RW, Super Admin RW, others none); `GET /me`; dependency helpers; `docs/PROJECT_AND_STACK.md` §5 matrix row (orchestrator reviews) | backend-builder | — | Role-matrix tests for all 7 roles; `/me` contract test; no change for other surfaces; MEMORY entry | DONE (MEMORY 2026-11-13 P33-T06) |
| P33-T07 | Backend: migration `p33a_categories` (`categories` table seeded with ranks 1..7; `projects.category`, `workflow_lead_times.category` → text + FK; `engineers.allowed_categories` → `text[]` + validation trigger; `trg_projects_category_matches_hub` rewritten on `workflow_id`; enums dropped; downgrade refuses non-seeded codes in use); models; `GET /reference/categories` objects (B1); category validation everywhere (B3); `workflow_snapshot["categories"]` only when non-default; input builder passes `categories`; `services/priority_preview._canonical` uses the canonical forms, not `asdict` (R33-7); `domain_constants.CATEGORY_ORDER` as the seed default only | backend-builder | P33-T03, P33-T05 | Upgrade/downgrade round-trip on a copy of the dev DB with every value preserved; `alembic check` has no new drift; the full backend suite passes; the live input hash, a fresh run (snapshot included) and a pre-deploy priority-preview token are unchanged after the migration; **T05-A3: `_canonical` → `canonical_schedule_input_asdict` (sorted as today) is a release blocker for P33-T02/T03 — they do not deploy without it**, with a test that the live token equals HEAD's; MEMORY entry | DONE (MEMORY 2026-11-13 P33-T07; dev DB not migrated — needs `alembic upgrade head` (p35a + p33a); B1 breaks the Registration picker until P33-T14) |
| P33-T08 | Backend: migration `p33b_template_copy` (template `gap_weeks` and immutable `effort_weight_weeks`, backfill = `weeks`; step `plan_weeks`, `plan_gap_weeks`, `template_change_id`; backfill from the table and gap 0; CHECK ranges; `template_changes` table; **no** `length_pinned` / `length_set`); `services.effort_split` weights = `effort_weight_weeks` (R33-2); `eff` per DOMAIN_RULES §B in every service reader (demand, workspace, gantt, project cards, tracking, the skip predicate on `(plan_weeks, kind, cert, own_effort, effort_weeks)`); R6 triggers minus the lead-time edit; the live builder per contract F4 (OR-3) **including the T05-A1 transitional rule** (until p33c: override = user ?? (effort if own effort), stored `start_not_before_week`, stored `overlap_weeks` else −`plan_gap_weeks`, wait 0 on a step with a stored overlap; alternative: ship p33c with p33b); copy rules for registration, category change, hub workflow change and **figure cleared** (E4, OR-5) under the R33-10 not-reached test; the what-if baseline and `whatif_import` use the builder | backend-builder | P33-T05, P33-T07 | After backfill and before p33c: the live input hash, a fresh greedy run and re-serialised stored runs are byte-identical; I25 / I26 unchanged on the seed; no live row has `lead_weeks` equal to its table value; "builder `eff` equals §B" evaluated with R33-1 including the override while those fields exist (T05-A2); tests: a template `weeks` change leaves an own-effort project's split and run identical (I32 iii), a figure cleared re-copies template weeks onto not-reached steps only, a category change re-copies not-reached steps and re-derives with the new weights, registration copies weeks and gaps; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T08; `p33b` revises `p36a` (P36-T03), not p33a; live and seed byte-identical; dev DB not migrated) |
| P33-T09 | Backend: `POST /workflow-templates/timeline-preview` (D) and the extended `GET /workflow-settings` / `category-timelines` (C1, C2) via `template_timeline` | backend-builder | P33-T04, P33-T06, P33-T08 | Contract tests; with no overrides, equal to C2; 403 for non-editors; validation errors per contract; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T09; contract-test rows LeadTimeSetting / WorkflowSettings / TimelineStep / CategoryTimeline temporarily "subset" until T16/T17) |
| P33-T10 | Backend: `POST /workflow-templates/apply-preview` (E2: automatic / choosable / own_effort / never; R33-11 step flags incl. `own_effort_length_not_applied`) and `POST /workflow-templates/apply` (E3): R33-10 stage rule with the successor clause on stored statuses, project rows `FOR UPDATE` in id order (and the same lock added to the stage PATCH and check-in paths), selection modes, template + copies per OR-4 (no `plan_weeks` on own-effort kinds; gaps to all), **no effort writes, no re-derivation**, stale, audit summary + per project, `template_version` locking, rate limit, dispatch (`template_apply`, `not_needed` when no schedulable copy changed, coalesced follow-up); `PUT /workflow-settings/lead-times` → 410 `USE_TEMPLATE_APPLY` | backend-builder | P33-T09 | Tests: every row of DOMAIN_RULES §C (frozen, Cancelled, Commercialized, Done / In Progress / Blocked, a Not Started step behind a started successor = reached, all Not Started incl. On Hold / Draft, started-not-reached selected / unselected / all); own-effort project: length not applied, gap applied, listed in `own_effort` when only lengths; elapsed length applies to own-effort projects; R33-12: E In Progress + an apply changing K writes no `effort_weeks`; a race (a stage PATCH waits on the lock, or the project reaches the stage before apply → `not_applied`); 409 on a stale version; exactly one run or `deferred` + one follow-up (I24); I31 and I32 hold; audit lists exact; no financial field logged; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T10; category rows locked FOR NO KEY UPDATE, not FOR UPDATE (deadlock avoidance, orchestrator to review); apply-preview rate limit 30/min added; lock-wait race tested on a committed scratch DB) |
| P33-T11 | Backend: `POST /workflow-templates/categories` (B2): rank insert, template copy (`weeks`, `gap_weeks`, `effort_weight_weeks`), eligibility extension, audit, rate limit | backend-builder | P33-T07, P33-T08, P33-T06 | Tests: insert between B and C; first place; OEM-workflow category (blanket `OEM` engineers stay eligible); duplicate / `OEM` / bad source / cross-workflow source rejected; nothing stale, no run; a new project registered in it copies the source's template and splits its figure over the copied weights; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T11; What-if prompt reads the table; hub trigger messages not reworded) |
| P33-T12 | Backend: `GET /gantt` and workspace field changes (Part G: drop `timing_editable` and the user-override fields; add signed `gap_weeks`, `plan_weeks`, `own_effort`); remove the readers of the user override; ask-agent context reads the copies | backend-builder | P33-T08 | Contract tests; Gantt totals still reconcile with the capacity booked loads (I23); MEMORY entry | DONE (MEMORY 2026-11-15 P33-T12; Gantt/Workspace TS mirrors red until P33-T15) |
| P33-T13 | Backend: retire per-project timing (ADR 0048): migration `p33c_clear_step_timing` (audit `project.step_timing_cleared` per project, values null, CHECK, stale), PATCH → 410 `STEP_TIMING_RETIRED`, one-off `scripts/p33_recalc_after_timing_clear` (one greedy run, `timing_cleared`, audit; no-op when nothing was cleared); the what-if and plan import still pass `StepTimingInput` | backend-builder | P33-T08, P33-T12 | Migration test: the 4 projects / 7 values cleared with 4 audit rows; the CHECK rejects a write; the script dispatches exactly one run and a second invocation none; the what-if and plan-import suites green; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T13; `p33c` revises `p33b`; dev DB not migrated — run `alembic upgrade head` then `python -m scripts.p33_recalc_after_timing_clear` once) |
| P33-T14 | Frontend: categories from the API (`useCategories`, B1): replace `PROJECT_CATEGORIES` / `CATEGORY_ORDER` in every consumer (filters, chips and palette, Matrix, Dashboard, Registration, Projects, Gantt toolbar, Priority board, what-if and import schema, lead-times lib); unknown-code palette by rank | frontend-builder | P33-T07 | `grep` finds no category constant outside fixtures; a fixture with an 8th category renders in every filter, chip and donut in rank order; tsc, eslint, vitest and the bundle budget pass; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T14; seeded-colour map and the B / B-OEM reference kept as named exceptions; what-if new-line default A → A+) |
| P33-T15 | Frontend: remove per-project timing editing: `/timeline` and the Workflow "Project step timing" tab read-only; delete the drag overlay, step-timing provider, dialog, Reset and edited marker; gap chip "parallel N wk" / "wait N wk" from `gap_weeks`; the What-if import Gantt untouched | frontend-builder | P33-T12, P33-T13 | No drag or resize handles or Edit timing anywhere outside the What-if import (tests on both pages); no dead code; axe passes; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T15; contract test green; tsc -b / full vitest / bundle blocked only by P33-T14 in flight) |
| P33-T16 | Frontend: category timeline editor (Part I): Move ± / Length ± per step, gap badge (0w, −Nw Overlap, Nw hatched), flag notes incl. "Overlap — same leader, runs back-to-back", template-view note, live redraw via timeline-preview (debounced, optimistic), discard and per-row reset, write controls gated on `workflow_templates.write` | frontend-builder | P33-T09, P33-T14, P33-T06 | Tests: clicks change the request and redraw from the response; first step has no Move; clamps at the range ends; flags render; a viewer and a Super-Admin-only role matrix; keyboard operation and accessible names; axe passes; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T16; `workflow_templates` surface added to the frontend; dev DB/API pre-P33, verified with intercepted API) |
| P33-T17 | Frontend: apply dialog (E2 → E3): automatic / choosable / "Uses its own effort figure — length not applied" / never sections, "Apply to all N projects that have not reached these stages" vs ticks, eff before → after with the R33-11 flags as notes, run-follow like a priority move, `not_applied` summary, 409 reload; the Lead times tab is editable for `workflow_templates.write` and saves through the same flow | frontend-builder | P33-T10, P33-T16 | Tests for each selection mode, the own-effort section, each flag note, the race summary, 409, 429, the Lead times tab path, an Admin (not Super Admin) able to apply, axe on the dialog; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T17; default selection for started projects = none ticked, owner to confirm; e2e spec updated, not run) |
| P33-T18 | Frontend: "+ Add category" dialog (B2): name, label, workflow, copy from (same workflow), position; refresh categories; open the new timeline | frontend-builder | P33-T11, P33-T14, P33-T16 | Tests: validation messages per error code, success refresh, the position list in rank order, gating; MEMORY entry | DONE (MEMORY 2026-11-15 P33-T18) |
| P33-T19 | Audited end-to-end on a disposable DB: migrate p33a → p33b (byte-identity checked) → p33c, run the recalc script, the owner's scenarios (A/E +1 applied to all: own-effort projects unchanged, projects without a design figure +1; a started project ticked / unticked; a wait of 3 weeks; a design ∥ design overlap; a figure cleared → follows the template; a new category between B and C with one project registered), I1–I32, stored runs byte-stable, Dashboard / Capacity / Gantt reconcile | workflow-auditor | P33-T10, P33-T11, P33-T13 | PASS in MEMORY with the served within-year count before and after each scenario (reported, not tuned) | DONE — PASS (MEMORY 2026-11-15 P33-T19; length scenario run on B/E (own-effort mix) per the orchestrator brief; non-blocking finding: recalc script reports `queued`/exit 0 when its inline run fails) |
| P33-R01 | Remediation of P33-T19 finding 1: `scripts/p33_recalc_after_timing_clear` waits for its `timing_cleared` run's outcome; a run that ends FAILED (or cancelled) exits 1 (`run_failed`) and does not count as dispatched, so a later invocation retries; still in flight when the wait ends exits 3 (`still_running`). Runbook: P33 upgrade steps (migration chain, code + p33c together, secrets incl. the field key, run the script via `docker compose run`, check exit 0) | backend-builder | P33-T13, P33-T19 | Run fails → exit 1 → second call dispatches again; completed → second call `already_dispatched`; advisory lock and audit rows unchanged; MEMORY entry | DONE (MEMORY 2026-11-15 P33-R01) |
| P33-T20 | Gate: qa, workflow, security | qa-inspector + workflow-auditor + security-auditor | all P33 tasks | Three PASSes recorded in MEMORY. Security checks in particular: Admin cannot reach `workflow_settings` writes; the apply and add-category endpoints enforce `workflow_templates.write` server-side; rate limits; audit completeness; no financial field or engineer name in the apply preview or the logs; the 410 endpoints still require auth | DONE (MEMORY 2026-11-15 "P33-T20 gate — combined result: PASS") |
| P33-F01 | Follow-up (next release): drop `duration_override_weeks`, `start_not_before_week` and `overlap_weeks` columns and remove the two 410 routes | backend-builder | P33-T20 | — | TODO (deferred) |

## P34 — Prioritization matrix: inline edit mode, gate checkboxes, change markers, fast filters

Opened 2026-11-13 (owner request, runs alongside P33 — Matrix surface only, no scheduler change).
Asks: (1) the filter row stays visible ("floating") while the View panel is stuck; (2) the VIP star
does not pin from the grid — fix; (3) scores are edited in the grid itself behind an "Edit" button
(no per-row dialog), hard gates get their own checkbox columns; (4) project search and the Hub
column filter are slow — make them instant; (5) a "changed" marker on rows changed by a saved
version, and the project count on each version in Version history; (6) the band distribution
follows every filter on the grid.

Decisions (orchestrator, 2026-11-13):
- D34-1: a grid edit session is saved as ONE `POST /scenarios/apply` (one version, notes optional),
  so every grid edit is versioned. In scenario mode the same grid edits stage into the scenario
  store instead (unchanged P5 behaviour).
- D34-2: the band distribution counts the served `suggested_band` of the rows the grid shows
  (every filter except the band pick itself). Counting served bands is not recomputing a score
  (I9 holds); the server `/priorities/distribution` stays for exports and other readers.
- D34-3: project search runs in the browser over the already-loaded rows (name and code); the
  server `q` is no longer sent by the grid. Rank stays as served for the server-filtered set.
- D34-4: matrix rows gain `last_score_version` (most recent scenario-apply version that changed
  this project's priority score, in the caller's hub scope) — see P34-T01.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P34-T01 | Backend: `PriorityMatrixRow.last_score_version: {version:int, created_at:datetime, applied_by_name:str\|null} \| null` — latest `ScenarioApplyRun` with a `priority_score` change for the project (one grouped query, no N+1, hub-scoped like the version endpoints); also on `GET /priorities/{id}`; `ScenarioApplyRunSummary.project_count` (distinct project_ids) on the versions list and detail; tests | backend-builder | — | pytest green; contract test; no financial field touched; MEMORY entry | DONE |
| P34-T02 | Frontend: items (1)–(6) above per D34-1..D34-4: sticky filter row always visible; VIP star fix (root-caused, test); grid Edit mode (score cells → 0–5 inputs, gate checkbox columns, Save/Cancel, unsaved-changes guard, one apply); pencil column + row dialog removed from the grid; instant search / hub text (client-side, deferred, memoised); changed-marker icon + version count; distribution from shown rows | frontend-builder | P34-T01 (marker only) | tsc, eslint, vitest green; tests per item; MEMORY entry | DONE |
| P34-T03 | Backend: `PriorityMatrixRow.external_code: str \| null` (served on `GET /priorities` and `/priorities/{id}`), so the grid's client-side search matches the project code again (D34-3 follow-up); contract test row | backend-builder | P34-T01 | pytest + contract test green; MEMORY entry | DONE |
| P34-T04 | Gate: qa, workflow, security (Matrix-only scope: P34-T01..T03) | qa-inspector + workflow-auditor + security-auditor | P34-T03 | Three PASSes in MEMORY | DONE (MEMORY 2026-11-15 "P34 gate — combined result: PASS") |
| P34-F01 | Backend + frontend (security S34-L2): drop `tcogs_eur`, `selling_price_eur`, `gross_margin_pct`, `capex_keur`, `rm_savings_keur` from `PriorityMatrixRow` (keep in exports and Registration); contract rows | backend-builder + frontend-builder | P34-T04 | contract green; no financial field in `/priorities`; MEMORY entry | TODO |
| P34-F02 | Backend (security S34-L1): `ScenarioApplyRequest.notes` `max_length=500` server-side; 422 test | backend-builder | P34-T04 | pytest; MEMORY entry | TODO |
| P34-F03 | Frontend (workflow A1/A2/A4-adjacent): `rowBand` falls back to `'Unscored'` when scored with null band; `scored_projects` from non-null band; `share_pct` 2 dp to match the server | frontend-builder | P34-T04 | vitest; MEMORY entry | TODO |
| P34-F04 | Docs (workflow A3/A5): DOMAIN_RULES note citing D34-2 (Matrix band counts over view-only filters on served bands); API_CONTRACT_P13 rank wording "within the server-filtered set" + `matrix-table.tsx` comment; apply path `scored_at` noted (A4) | orchestrator | P34-T04 | MEMORY entry | TODO |

## P35 — Project register: inline status, actual dates, design/lab time, step exclusion (old-app parity)

Opened 2026-11-13 (owner request, with screenshots of the client's old tool's "Project Registration"
grid, source `~/.gemini/antigravity-ide/scratch/RPDCHARTERV1del/src/components/ProjectInput.jsx`).
Asks: on the project register grid, edit **status**, **actual start**, **actual end**, and **design
time / lab time** (shows the calculated value; a manual value stretches or shrinks the steps; reset
returns to calculated), and **exclude steps** per project from step chips. Plus other old-tool
features worth copying (owner to pick from the list in MEMORY 2026-11-13 P35 opened).

Decisions (orchestrator, 2026-11-13):
- D35-1: the old tool's `customDesignTime` / `customLabTime` ARE our `design_effort_weeks` /
  `lab_effort_weeks` (ADR 0041 R1/R2: the figure is split over the kind's steps and drives span and
  load). No new scheduler concept; ADR 0048 is not touched (no per-step timing). "Calculated" =
  Σ eff of the kind's steps with no figure (the project's own template copy), served by the backend,
  never recomputed in the browser. "↺ reset" = clear the figure (P33 E4 "figure cleared" path).
- D35-2: the grid gets an **Edit** mode like the Matrix (P34 D34-1 pattern): Save / Cancel,
  unsaved-changes guard; rows outside the caller's write scope stay read-only.
- D35-3: actual dates are entered as dates and stored as week numbers, like `actual_start_week`
  today. `actual_end_week` is new; end < start is a 422 `ACTUAL_END_BEFORE_START`.
- D35-4: per-project **step exclusion** is a new scheduler input (`eff = 0` for an excluded step;
  the effort figure re-splits over the remaining steps of the kind). It amends DOMAIN_RULES §B and
  the R2 split, so it needs ADR 0049 + a workflow-auditor ruling, and it lands after P33-T02/T08
  (same predicate and split code). Owner answered OQ #81–#83 on 2026-11-13 (exclude only; Not Started + In Progress excludable, Done not; recalc on Save) → ADR 0049 Proposed.
- D35-5 (owner, OQ #83): a register Save goes through one batch endpoint and dispatches ONE greedy run (P35-T01 scope extended), like a priority move.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P35-T01 | Backend: `projects.actual_end_week` (nullable int ≥ 1, migration, audit on change), on PATCH / detail / list; 422 `ACTUAL_END_BEFORE_START`; list rows serve `design_weeks_calculated` / `lab_weeks_calculated` (Σ eff of the kind ignoring the project's own figure, same predicate as the scheduler) next to the figures, so the grid can show auto vs manual; no N+1 + (owner scope addition 2026-11-13, OQ #83) `POST /projects/register-edits` batch save, one greedy run per Save | backend-builder | — | pytest green; contract test; migration round-trip; audit row on change; MEMORY entry | DONE |
| P35-T02 | Frontend: Projects register grid Edit mode (D35-2): Status select (allowed transitions only, server errors shown inline), Actual start / end date inputs (week stored), Design time / Lab time inputs: calculated value in green with "auto: N wk" tooltip, manual value in orange with "↺ reset"; end-before-start warning; Save sends one PATCH per changed row, shows the "schedule stale — recalculate" affordance already used elsewhere | frontend-builder | P35-T01 | tsc, eslint, vitest green; tests: auto vs manual rendering, reset clears the figure, status error shown, read-only rows for out-of-scope projects, unsaved guard; axe passes; MEMORY entry | DONE (MEMORY 2026-11-13 P35-T02/T08: one batch POST /projects/register-edits instead of one PATCH per row, per D35-5) |
| P35-T03 | ADR 0049 (step exclusion) drafted from the owner's answers to OQ #81–#83; workflow-auditor ruling (I5 14-row shape kept, R2 split over non-excluded steps, excluded vs started/Done steps, effect on I26) | orchestrator + workflow-auditor | owner answers | ADR Accepted with R-items; DOMAIN_RULES §B amended; MEMORY entry | DONE (MEMORY 2026-11-13 P35-T03: ACCEPT WITH CHANGES, R35-1..R35-12, I33–I36; DOMAIN_RULES §B edit folded at P35-T04 to avoid colliding with P33-T02) |
| P35-T04 | Scheduler: `EffortStepInput` exclusion field in `effort_split` (R35-3, split over S′), I33–I36 in the validator; no new `StepTimingInput` field (R35-9); golden files byte-identical with no exclusions | algorithm-engineer | P35-T03, P33-T02 (its MEMORY entry) | Scheduling suite ≥ 85 %; tests per R-item; MEMORY entry | DONE (MEMORY 2026-11-15 P35-T04: I33/I34 (i) live-row checks in `scheduling.demand`, I35 in the validator; DB-side I34 (ii)/(iii) and I36 handed to P35-T05) |
| P35-T05 | Backend: step exclusion flag (not named bare `excluded` in payloads) per R35-2/4/5/6/7/8/10/11; builder maps excluded → `lead_weeks = 0` (R35-9); saved through the P35-T01 batch; calculated design/lab weeks honour exclusions (R35-12) | backend-builder | P35-T04, P33-T08, P35-T01 | Tests; I26 holds with exclusions; MEMORY entry | TODO |
| P35-T06 | Frontend: step chips column (click to exclude / include, current step ringed, lab green / design indigo, N/A greyed), in Edit mode only | frontend-builder | P35-T05 | Tests; keyboard + accessible names; MEMORY entry | TODO |
| P35-T08 | Frontend: owner-picked extras — bulk-edit bar on ticked rows (design resource, req dept, design/lab time, status; step exclusions once T06 lands) saved through the same batch; status-vs-current-step mismatch outline (red, tooltip names the expected status); "Unassigned ⚠" highlight on rows with no design resource; per-user column show/hide + drag-resize (persisted per user in localStorage, safe when unavailable) | frontend-builder | P35-T02 | Tests per item; axe passes; MEMORY entry | DONE except: step exclusions in the bulk bar (→ P35-T06) and the status-mismatch outline DONE 2026-11-15 on the OQ #84 assumption (P35-T08b backend + frontend cell; known gap: a row served On Hold/Cancelled gets no warning when edited to an active status until saved, because `expected_status` is null for exempt statuses — fold into P35-T05) |
| P35-T07 | Gate: qa, workflow, security | three gatekeepers | all P35 tasks | Three PASSes in MEMORY; I26 rev. 2 and I33–I36 asserted with at least one excluded In Progress step and one excluded step the split had zeroed | TODO |

## P36 — Rank within a priority band (ADR 0050)

Opened 2026-11-15 (owner request with a Priority board screenshot): reorder projects inside a
priority column ("move one P1 project to 2nd position so it is the 2nd highest priority in P1"), and
filter the board for easy shifting. Owner answers 2026-11-15: the position **drives scheduling**;
a re-rank uses the **priority-move preview popup + recalc**; the existing **board-wide filters** are
enough (no per-column filter), and re-ranking must work on a filtered board.

Decisions (orchestrator, 2026-11-15):
- D36-1: `projects.band_rank` (nullable, dense 1..n per band), new scheduling key after priority,
  before status (ADR 0050 §3). Backfilled from today's in-band order so the schedule does not move.
- D36-2: the write is relative (`before_project_id`), so a filtered drop is well-defined.
- D36-3: cross-column moves append last in the target band; board cards sort by scheduling keys 4–7.
- D36-4: keyboard: Left/Right choose a column (as today), Up/Down move within the column.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P36-T01 | ADR 0050 workflow-auditor ruling (backfill identity, CP-SAT, plan import, lifecycle of rank, I37) | workflow-auditor | — | Ruling in MEMORY; ADR folded to Accepted | DONE (MEMORY 2026-11-15 P36-T01: ACCEPT WITH CHANGES R36-1..R36-10; OQ #86, #87) |
| P36-T02 | Scheduler: `ProjectInput.band_rank`, sort key 4 in greedy / CP-SAT / Monte Carlo / What-if, I37 in the validator; golden files byte-identical when every `band_rank` is None | algorithm-engineer | P36-T01 | Scheduling suite ≥ 85 %; I37 tests; MEMORY entry | DONE (MEMORY 2026-11-15 P36-T02: 636 passed, scheduling 96 %; helper scheduling/band_rank.py) |
| P36-T03 | Backend: migration + backfill, builder maps `band_rank`, rank lifecycle (priority move appends, non-schedulable clears, renumber), `POST /projects/{id}/band-rank[/preview]`, audit, board sort + `band_rank` on cards, contract doc `docs/API_CONTRACT_P36.md` | backend-builder | P36-T01, P36-T02 (field name) | pytest green; migration round-trip; backfill-identity test; contract test; MEMORY entry | DONE (MEMORY 2026-11-15 P36-T03: 2347+ passed, 3 fixed post-run; contract 231) |
| P36-T04 | Frontend: drag within a column (drop indicator between cards), keyboard Up/Down, position chip, preview dialog reuse, works on filtered board and List layout; read-only roles see order only | frontend-builder | P36-T03 contract | tsc, eslint, vitest green; axe; MEMORY entry | DONE (MEMORY 2026-11-15 P36-T04: 680 vitest passed; built to contract, not yet run against T03) |
| P36-R01 | Remediation (security M-1, L-2, I-8): lookup + authz + rate limit before the band-rank advisory lock on PATCH / priority POST / register-edits; `SET LOCAL lock_timeout` → coded 503; re-authorize after refresh in `move_project_band_rank`; tests: unauthorized writes never take the lock, 401 / Executive Viewer / Auditor / confirm-out-of-hub | backend-builder | security leg | pytest green; security-auditor re-check; MEMORY entry | DONE (MEMORY 2026-11-15 "P36 gate CLOSED") |
| P36-R02 | Remediation (workflow W36-1): the rank dialog / keyboard announcement never shows "of M" (full-band rank vs scoped count); test with hub filter + hub-scoped user | frontend-builder | workflow leg | vitest green; workflow-auditor re-check of W36-1; MEMORY entry | DONE (MEMORY 2026-11-15 P36-R02: no "of M"; hub-filter + Hub Planner test; awaiting workflow-auditor re-check) |
| P36-R03 | Remediation (frontend for P36-R01): show contract §5 503 `BAND_RANK_BUSY` copy on priority/rank moves, registration save/submit and the register batch save; rollback kept, no auto-retry | frontend-builder | P36-R01 | tsc, eslint, vitest green; MEMORY entry | DONE (MEMORY 2026-11-15 P36-R03) |
| P36-T05 | Gate: qa-inspector, workflow-auditor (re-derive order incl. I37), security-auditor (RBAC/hub scope on the new endpoint) | gate | T02–T04 | Three PASS in MEMORY | DONE (MEMORY 2026-11-15 "P36 gate CLOSED") |

## P37 — The current week follows the calendar (ADR 0052)

Opened 2026-11-16 (owner request). The header reads "Week 42 · 10 wks left · 16 Nov 2026" on
ISO week 47, because `backend/domain_constants.py` reads `CURRENT_WEEK` once at import (default 42,
ADR 0024 §3) and the frontend carries its own `CURRENT_WEEK = 42` / `PLAN_YEAR = 2026` (P32
workflow finding F9). Contract: `docs/API_CONTRACT_P37.md`. DOMAIN_RULES "Horizon constants"
(2026-11-16 amendment), proposed invariants I38–I41. Owner questions OQ #88–#92.

**Status at P37-T02 (2026-11-17).**
- ADR 0052 is Accepted with ruling R37-1..R37-10. DOMAIN_RULES, the contract and the invariants (I9,
  I13, I19, I24, I38–I41) are final.
- The owner answered OQ #88–#92: "no problem, now we don't need to show dummy data, so make the week
  follow". Every assumption is accepted; the release is not gated on the T07 figures.
- R37-6 changes D37-4: the rollover compares weeks with "==" / "≠", and is `not_needed` with no
  active run. R37-8: state decides each tick, and the table only counts queued attempts. R37-9: the
  ticker can be turned off and is off in the test suites.
- Repo: multi-select merge committed (9a41987); migration head p33c (dev DB at p33c). P37's
  migration revises `p33c`, unless another phase lands first.

Decisions (orchestrator, 2026-11-16; confirmed at P37-T02):
- D37-1: one clock (`services/plan_clock.py`): ISO week of today in Europe/Athens, read per request
  (FastAPI dependency) and per solve dispatch, never at import, no defaulted parameters;
  `RPD_CURRENT_WEEK` stays as a validated pin (1..52; tests pin 31).
- D37-2: `RPD_PLAN_YEAR` (default 2026) is served; ISO W53 → 52; after the plan year → 52 +
  `plan_year_closed` (OQ #88 decides the real rollover); stored weeks are never re-based by the clock.
- D37-3: calendar week for facts (check-in stamps, tracking), new solves, run-independent figures
  (remaining supply/demand, Capacity `remaining_weeks`) and "now" markers; run week for interpreting
  a stored run (I13/I14).
- D37-4: weekly rollover: one idempotent `ensure_week_rollover()` called by a Celery beat entry
  (Mon 00:05 Athens + every 15 min) and an in-app lifespan ticker (5 min; hosted/dev run greedy
  inline without beat, P32-R01); greedy, `trigger_reason="week_rollover"`, system actor, ADR 0023
  lifecycle, ≤ 3 attempts/week ≥ 30 min apart, no per-project `schedule_stale`. CP-SAT replacement
  follows P32-R12 / OQ #89.
- D37-5: header = calendar week + served Athens date; "Plan from W*n* · recalculating / failed" chip
  and the same notice on Gantt, Dashboard, Capacity, Workspace while the active run is behind.
- D37-6: seed progress derivation pinned to `SEED_STATUS_WEEK = 42`.
- D37-7: ~~deploy only after the owner has seen P37-T07's figures~~. Superseded 2026-11-17: the owner
  accepted the drop (OQ #92), so the release follows the normal gate.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P37-T01 | **Ruling** on ADR 0052 Q1–Q5: the calendar-week / run-week split and the Appendix reader list; tracking "due" while the plan is behind; I13/I19 restatement; the rollover's queued / deferred / not_needed rule vs ADR 0023 (I24) and no per-project stale; W53 and `plan_year_closed` clamps vs unconstrained finish, anchored tails (Gate ruling 10) and Done intervals past the week; invariants I38–I41 confirmed or amended with exact text | workflow-auditor | — | MEMORY entry with accept / amend per Q1–Q5 and any R37-items; no code | DONE (MEMORY 2026-11-16 P37-T01: ACCEPT WITH AMENDMENTS, R37-1..R37-10; measured 135 → 114 within-year at W47) |
| P37-T02 | Fold the ruling in: ADR 0052 → Accepted (with R-items); DOMAIN_RULES 2026-11-16 amendment loses "PROPOSED"; contract updated; dependencies re-checked | orchestrator | P37-T01 | ADR, DOMAIN_RULES and contract consistent with the ruling; MEMORY entry | DONE (MEMORY 2026-11-17 P37-T02; owner answers OQ #88–#92 folded in) |
| P37-T03 | Scheduler: `ScheduleInput.current_week` has no import-time default (required, or a sentinel the builder must replace); validation `1 ≤ current_week ≤ within_year_week`; What-if, plan import, Monte Carlo and the unconstrained finish read only the input; I38 in the validator (run row week = input week); `scheduling/_selftest*` take the week explicitly; **pin condition (ii): no new field in `canonical_schedule_input_asdict` (keyword-only field or a sentinel validation rejects)** | algorithm-engineer (`backend/scheduling/` only) | P37-T02 | All golden files, input hashes and re-serialised stored runs byte-identical (suites pin 31); scheduling suite ≥ 85 %; tests: a solve at W47 vs W42 on the same input differs only through the week, two solves at the same week byte-identical (I8), out-of-range week rejected; MEMORY entry | DONE (MEMORY 2026-11-17 P37-T03; range check split: engine 1..horizon, I41 1..52 via `require_plan_week` / validator — see entry) |
| P37-T04 | Backend: `services/plan_clock.py` (`PlanClock`, injectable `now`, Europe/Athens, pin, `RPD_PLAN_YEAR`, clamps per D37-2) + request dependency + startup validation of both env vars; replace every reader in ADR 0052 Appendix (direct reads, import-bound defaults made required, run-week fallbacks → calendar week); Capacity `remaining_weeks` and engineer-utilization `current_week` → calendar week + `run_week`; check-ins stamp the calendar week; `/me` fields per contract §1 (except `plan_week.status` values that need T05, served as `current` / `pending` until then); `SEED_STATUS_WEEK = 42` in the seed; a test that no module outside `plan_clock` and test fixtures reads `RPD_CURRENT_WEEK` or a module-level week; **R37-1** due rule (planned start ≤ week, due-since = planned start); **R37-2** week read once at `create_queued_schedule_run` / synchronous request, worker builds with `current_week=run.current_week`, every builder caller in the ADR Appendix "Added at P37-T02"; **R37-4** `baseline_week` / `run_week` on the changes response; **R37-5** seed summary and first run at the calendar week; **R37-10** `POST /check-ins` 409 `PLAN_YEAR_CLOSED`; P1 capacity fill at the calendar week | backend-builder | P37-T02, P37-T03 | pytest green with clock-injected tests: Mon 16 Nov 2026 → 47 / 5 left; Sun 15 Nov 23:30 Athens → 46; Sun 22:30 UTC on 15 Nov (= Mon 00:30 Athens) → 47; 28 Dec 2026 and 3 Jan 2027 → 52; 4 Jan 2027 → 52 + closed; pin 31 wins; pin 0 / 53 / "x" fails startup; I40 (one week per response) on /me, capacity, check-ins due; **R37-2 test: a run queued Sunday 23:59 Athens and executed Monday stores and solves at the Sunday week**; R37-1 test (a stage planned W43 is still due at W47; identical to the old rule when weeks match); closed-year 409; contract test rows; MEMORY entry | DONE (MEMORY 2026-11-17 P37-T04; /me `failed` status waits on T05) |
| P37-T05 | Backend: `ensure_week_rollover()` per D37-4 (dispatch advisory lock; migration for `plan_week_rollovers(plan_year, week, attempts, last_attempt_at, last_run_id, status)`; audit `schedule.week_rollover`; system actor), Celery beat entry, FastAPI lifespan ticker with jitter and clean shutdown; `/me.plan_week` status values; decision per DOMAIN_RULES 2026-11-17 text (R37-6 equality, R37-7 no active run, R37-8 state decides, table counts queued attempts only, never CP-SAT, `not_needed` while closed); **R37-9** `RPD_WEEK_ROLLOVER_TICKER` (false in both conftests), beat on Europe/Athens | backend-builder | P37-T04 | Tests: two concurrent callers → one run (I39); **R37-6** lowered pin (active run W47, pin 31) → one run, status not `current`; **R37-7** no active run → `not_needed`, `plan_week` null; active run with no schedulable project → `queued`; **R37-8** `deferred` / `not_needed` then a later tick queues, DISPATCH_FAILED and ABANDONED count as failures, a follow-up does not consume the budget; **R37-9** `TestClient` lifespan with the setting false dispatches nothing; repeated ticks → none; in-flight run at the old week → `deferred` + exactly one follow-up at the new week (I24); in-flight run already at the new week → `not_needed`; no schedulable project → `not_needed`; failed run → retried ≤ 3 times ≥ 30 min apart, then `failed`; unchanged pin → nothing; migration round-trip; no financial field or engineer name in the audit row; MEMORY entry | TODO |
| P37-T06 | Frontend: header from served `current_week`, `weeks_left_in_year`, `as_of_date` (no browser date); "Plan from W*n*" chip + Recalculate where permitted; same notice on Gantt, Dashboard, Capacity, Workspace; remove `CURRENT_WEEK` / `PLAN_YEAR` (and derived years) from `lib/domain-constants.ts` — every reader in ADR 0052 Appendix uses the served values (Gantt today line, heatmap, What-if import geometry, completion strip, upcoming completions, planning toolbar, plan-week-date); refetch `/me` at `week_ends_at` and on focus, invalidating run-derived queries when the active run version changes; "Planning year closed" state; **R37-3**: notice also on the check-in page and the What-if / plan-import results ("Simulated from W*c*; the active plan is from W*n*"), and every reader added to the ADR Appendix at P37-T02 (`gantt-legend`, `gantt-coordinates`, `plan-month`, `format.ts`, every `SPILLOVER_YEAR` / `CARRY_OVER_YEAR` label); **R37-4**: change list labelled "includes the move from W*a* to W*b*"; check-in submit shows 409 `PLAN_YEAR_CLOSED` | frontend-builder | P37-T04 (contract), P37-T05 (status values) | tsc, eslint, vitest green; grep finds no week/year constant outside fixtures; tests: W47 header text, behind/recalculating/failed chips, closed year, refetch at `week_ends_at` (fake timers), Gantt today line at the served week; axe on header and notice; MEMORY entry (closes P32 finding F9) | DONE (MEMORY 2026-11-17 P37-T06; gap: What-if simulate/solve responses carry no `current_week`, UI uses `/me`) |
| P37-T07 | Audited run on a disposable copy of the dev DB: active run at W42 vs rollover run at W47 — within-year, spillover, left-out, blocked counts overall and per hub, and the change list size (**reported, not tuned**); I1–I41 on the new run; stored runs byte-stable; two ticks → one run; clock-injected W52, W53 and 4 Jan 2027 runs; count of check-in rows stamped 42 after 19 Oct (OQ #90) and of stages turning `overdue` | workflow-auditor | P37-T03, P37-T04, P37-T05 | PASS in MEMORY with the figures (informational; the owner accepted the drop, OQ #92) | TODO |
| P37-T08 | Gate: qa, workflow, security | qa-inspector + workflow-auditor + security-auditor | all P37 tasks | Three PASSes recorded in MEMORY. Security in particular: the ticker and beat job run with no user context and cannot be triggered by a request; startup env validation; no secret or financial field in rollover audit rows or logs; `/me` new fields leak nothing hub-scoped | TODO |
| P37-F01 | Open planning year 2027 (OQ #88 (a): "until an Admin opens 2027"): ADR covering re-basing stored plan weeks by −52 or an equivalent, 2026 runs kept as history, within-year and horizon for 2027, the Admin action and its RBAC; then its own phase | orchestrator (ADR) + owner | P37-T08 | ADR drafted and the phase planned **before 28 Dec 2026**. From 4 Jan 2027 the app is closed and refuses check-ins until this lands | TODO |

## P38 — Deactivate engineers instead of deleting them (ADR 0053)

Opened 2026-11-17. Owner request, 2026-11-16: "rather than deleting an engineer add an option to
deactivate them, so in older projects in which they were assigned it shows them". Owner ruling,
2026-11-17: "it is Frigoglass's headache for engineer, but give a popup when deactivating: show the
list of active assigned projects and then ask to change the leader too".

Today `DELETE /engineers/{id}` (Hub Planner own hub, Admin, Super Admin) almost always returns 409.
Three FKs with no ON DELETE block it: `projects.leader_engineer_id`,
`project_workflow_steps.assigned_engineer_id` and `schedule_run_project_steps.assigned_engineer_id`.
There is no "active" concept anywhere: the scheduler input, supply, pickers, What-if and plan
import all use every engineer.

- Contract: `docs/API_CONTRACT_P38.md`.
- DOMAIN_RULES: "Engineer deactivation" (2026-11-17) and the "Capacity supply" amendment.
- Proposed invariants: I42–I44.
- Owner questions: OQ #93–#99.

Decisions (orchestrator, 2026-11-17; confirmed and amended by the P38-T01 ruling R38-1..R38-9, folded in at P38-T02 — ADR 0053 is Accepted; where a decision below differs from the ruling, the ruling wins: frozen projects must get a leader (R38-3), the run also fires when the active run books the engineer after `d` (R38-5), T03 is NEEDED (R38-2)):
- D38-1: Deactivate / Reactivate replace Delete. DELETE returns 410. Admin and Super Admin only
  until OQ #93. The reason is a code, never free text. There is no purge (OQ #95).
- D38-2: the popup lists every open project the engineer leads (any status except Commercialized
  or Cancelled):
  - each row has a picker of eligible active engineers of the project's capacity hub;
  - "Use one leader for all" fills the empty rows;
  - rows left empty are allowed after a "Deactivate anyway" warning, and those projects get
    `leader_engineer_id = NULL` (the existing "No leader" marker, `LEFT_OUT no_leader`);
  - per the owner, that outcome is Frigoglass's responsibility.
  One transaction, then one greedy run (`engineer_deactivated`, ADR 0023) if a schedulable
  project changed leader.
- D38-3: supply is pro rata on active weeks. The deactivation week counts as worked, and an
  `engineer_inactive_periods` table drives it (ADR 0053 §4; OQ #94 confirms).
- D38-4: the scheduler is unchanged. The builder leaves inactive engineers out of the input, and
  `scheduling/` is touched only if T01 says so (P38-T03 is conditional).
- D38-5: history keeps the name, with an "Inactive" tag and a served `active` flag beside every
  served name. `project_leader_history` gives a Workspace "Former leader" line.
- D38-6: the linked login is not touched (OQ #96). There is no future-dated deactivation
  (OQ #99).

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P38-T01 | **Ruling** on ADR 0053 Q1–Q6: the pro rata supply formula and week convention vs ADR 0008 / I17 / I19 / P1 fill; the builder filter (What-if baseline, plan import, Monte Carlo, demand I25, excluded projects); the open set and clearing to NULL (frozen projects, readers that assume a leader); the `engineer_deactivated` run vs ADR 0023 / I24 and `not_needed`; exact text of I42–I44; whether a project-level "Former leader" satisfies I44; whether `scheduling/` changes (T03 needed or skipped) | workflow-auditor | — | MEMORY entry with accept / amend per Q1–Q6 and any R38-items; no code | DONE (MEMORY 2026-11-17 P38-T01: ACCEPT WITH AMENDMENTS R38-1..R38-9; T03 NEEDED) |
| P38-T02 | Fold the ruling in: ADR 0053 → Accepted (with R-items); DOMAIN_RULES 2026-11-17 amendment loses "PROPOSED"; contract updated; T03 marked needed or SKIPPED; add this reader to the ADR 0052 Appendix list if P37-T04 has not landed | orchestrator | P38-T01 | ADR, DOMAIN_RULES, contract and plan consistent with the ruling; MEMORY entry | DONE (MEMORY 2026-11-17 P38-T02; OQ #101–#103 added) |
| P38-T03 | **NEEDED (R38-2).** `backend/scheduling/` only: a supply-only field on `WhatIfBaseline` (**not** `ScheduleInput`; canonical input and hash unchanged) carrying per-engineer active weeks (hub, FTE, covered weeks) for every counted engineer with an inactive period, inactive or reactivated; `whatif._supply` (estimate before/after, simulate `utilization_before`) and the `plan_import` weekly supply series apply the R38-1 helper `A_e` (a covered week supplies 0; exact Decimal/Fraction); greedy, CP-SAT and the validator unchanged | algorithm-engineer | P38-T02 | With the field empty, every golden file, What-if and plan-import output byte-identical (R38-9); tests: a deactivated engineer and a reactivated one give What-if `capacity_before` equal to the R38-1 hub figure (year and remaining) and a weekly series with 0 in covered weeks; scheduling suite ≥ 85 %; field name published for T05; MEMORY entry | DONE (MEMORY 2026-11-17 P38-T03; field `WhatIfBaseline.engineer_active_weeks`) |
| P38-T04 | Backend, data and engineer endpoints: migration (`engineers.active`, `deactivated_at`, `deactivated_week`, `deactivated_plan_year`, `deactivated_by_user_id`, `deactivation_reason` + CHECK; `engineer_inactive_periods` with a partial unique open-period index; `project_leader_history`; backfill every engineer active, no periods); `EngineerRead` fields and `?status=`; `GET …/deactivation-preview` (eligible capacity-hub candidates, supply effect, `led_projects_token`), `POST …/deactivate` (exact-set check → 409 `LED_PROJECTS_CHANGED`, per-row leader or NULL, one transaction, audit, leader history, `schedule_stale`, one greedy run via `run_dispatch` or `not_needed`), `POST …/reactivate`; DELETE → 410; PATCH on inactive → name only; `LEADER_INACTIVE` on registration, PATCH, register batch, bulk edit, user-engineer link; lookup + authz before locks, coded 503 on lock timeout; week read through the request's week accessor | backend-builder | P38-T02 | pytest green; *(T02 additions)* preview serves `frozen`, `progress_tracked`, `done_stages`, `in_flight_lab` and candidates by the `greedy._cat_not_allowed` predicate; null row on a frozen project → 422 `FROZEN_NEEDS_LEADER`; reopen (out of Commercialized / Cancelled) with an inactive stored leader and no leader in the write → 422 `LEADER_INACTIVE` on PATCH, register batch, bulk edit, re-import and seed (R38-4); dispatch iff schedulable leader change OR the active run has a design row of the engineer ending after `d`, else `not_needed` (R38-5, both branches tested); lock order engineer row → projects by id, concurrent leader PATCH vs deactivate in both orders, busy → 503 `ENGINEER_STATUS_BUSY`; `deactivated_week` / periods from `plan_clock` (calendar), `plan_year` served, closed year → (plan_year, 52) (R38-7); `project_leader_history` written on **every** leader-change path (R38-6); band rank unchanged by a leader change or clear (R38-8); I42 incl. the open-period uniqueness; migration round-trip; tests: Hub Planner 403, Admin OK; mixed reassign / NULL rows → exactly one run, `left_without_leader` ids correct; only On Hold changed → `not_needed`; a project assigned to the engineer between preview and confirm → 409; concurrent leader PATCH naming the engineer → `LEADER_INACTIVE` after commit; reactivate restores no project and dispatches nothing; audit rows hold no financial field and no reason text; DELETE 410 creates no audit row; I42 checked after every write path; contract test rows; MEMORY entry | DONE (MEMORY 2026-11-17 P38-T04; migration p38a after p40a; `?status=` roster filter included) |
| P38-T05 | Backend, readers: builder excludes inactive engineers (`schedule_persistence`); supply per ADR 0053 §4 in `capacity_supply` / `capacity_hubs`, P1 fill, per-engineer YearRemaining, `/capacity-summary`, `inactive_engineers` count; utilization matrix, engineer utilization and resource load with `?include_inactive=` and 0 capacity after `d`; What-if pool and plan import (match all names, strip " (inactive)", warn `ENGINEER_INACTIVE`, auto-assign, never a new hypothetical engineer); `leader_active` / `assigned_engineer_active` / `active` on every served name per contract §4; `former_leaders` on the Workspace; exports `Name (inactive)`; leader filter options with inactive last and a `no_leader` option | backend-builder | P38-T04, P38-T03 | pytest green; *(T02 additions)* one `A_e` helper (R38-1) feeding year, remaining, per-engineer, P1 fill `C` (fill's own FTE query retired) and the T03 `WhatIfBaseline` field; `design_capacity()` takes year and remaining Σfte separately; no-period path is today's `fte_sum` (same float); engineer capacity 0 in every covered week; counted / not_counted active-only + `inactive_engineers` summing to the roster; `test_p18_r02` gains an inactive and a reactivated engineer; plan-import keep-leader branch active-only; explicit NULL-leader tests for export, Matrix, cards and the leader filter; history readers never filter by `active` (R38-6); with no inactive engineer every supply figure, the live input hash and golden runs are byte-identical (I43); supply tests for deactivate at W47, deactivate + reactivate in the same week (no change), across a plan-year boundary, `counts_in_capacity = false` (no effect); the input built after deactivation has no inactive engineer; stored runs byte-stable (I44); name-withholding tests unchanged and the flag withheld with the name; contract test rows; MEMORY entry | TODO |
| P38-T06 | Frontend, roster and dialogs: Capacity Planning roster Delete → Deactivate / Reactivate (Admin / Super Admin only, by role as with `counts_in_capacity`); Show filter Active (default) / Inactive / All; Inactive tag, no write actions on inactive rows except Reactivate and name; the Deactivate dialog per ADR 0053 §3: open-project list, per-row picker of the served candidates, "Use one leader for all", reason select, supply effect line, linked-login note (yes/no), button switches to "Deactivate anyway" with the warning listing projects left without a leader, 409 `LED_PROJECTS_CHANGED` refreshes the list keeping choices, success toast with run status and a link to the register filtered to "No leader" | frontend-builder | P38-T04 (contract) | tsc, eslint, vitest green; *(T02 additions)* frozen rows are marked required and cannot be left empty (no candidate on a frozen row → message "Unfreeze this project on the Gantt first", confirm disabled); the contract §2 warning copy verbatim, the second sentence only when an empty row is `progress_tracked` or `in_flight_lab`; rows show done-stage count / lab-in-flight; tests: all rows filled → plain "Deactivate"; one empty → "Deactivate anyway" + warning naming it; "one leader for all" fills only empty rows; empty candidate list message; 409 refresh; Hub Planner sees no action; axe on the dialog (keyboard-scrollable list, P33-R02); MEMORY entry | DONE (MEMORY 2026-11-17 P38-T06; built to the contract with mocks, live check after T04) |
| P38-T07 | Frontend, everywhere else: shared `InactiveTag` next to every engineer name using the served flags (register, cards, Priority / VIP boards, Dashboard lists, Workspace incl. "Former leader", Gantt rows and stages, run changes, utilization views with an include-inactive toggle); every leader picker excludes inactive (Registration, register cell, bulk edit, Workspace, What-if, user form); leader filters list inactive in an "Inactive" group and offer "No leader"; projects cleared to NULL show the existing `NoLeaderLabel` | frontend-builder | P38-T05 (contract), P38-T06 | tsc, eslint, vitest green; grep finds no picker fed from an unfiltered engineer list; tests per surface for tag rendering and picker exclusion; bundle budget; axe on tag (text, not colour only); MEMORY entry | TODO |
| P38-T08 | Audited run on a disposable copy of the dev DB: deactivate one real engineer with open projects twice (all reassigned; some left empty), and one with none; supply before / after per capacity hub vs the formula; one run each (none for the third); within-year, spillover, left-out (`no_leader`) counts and the change list (**reported, not tuned**); I1–I44 on the new runs; stored runs byte-stable; history surfaces still name the engineer | workflow-auditor | P38-T03, P38-T04, P38-T05 | PASS in MEMORY with the figures | TODO |
| P38-T09 | Gate: qa, workflow, security | qa-inspector + workflow-auditor + security-auditor | all P38 tasks | Three PASSes recorded in MEMORY. Security in particular: Admin-only writes and hub scope on preview (no out-of-scope project or engineer revealed through candidates or `open_projects`); the `active` flag never leaks a withheld name; DELETE 410 for every role; no reason free text; audit rows complete and no financial field; the race (409) and lock-before-authz order | TODO |

## P39 — Marketing Brief is not a design step (ADR 0007 amendment 2026-11-17)

Opened 2026-11-17. Owner correction, verbatim: "also marketing is under others, not a design step".
PDD-A Marketing Brief (`MKTG_BRF`) changes kind `design` → `elapsed`.
- ADR 0007 "Amendment 2026-11-17 (P39)" has the evidence, the decision, the consequences and
  questions Q1–Q6.
- DOMAIN_RULES has the 2026-11-17 (P39) header note, the step table and the recomputed R2 examples.
- Owner question: OQ #100 (OEM-A Commercial Brief; the "Elapsed" vs "Others" label; Pr. Pr).
- No migration, so P39 adds nothing to the Alembic chain that P37 and P38 are extending.

Decisions (orchestrator, 2026-11-17; binding once P39-T01 confirms):
- **D39-1: `elapsed`, not a new kind.** A new kind would schedule identically. The old tool's word
  "Others" is at most a label (OQ #100 b).
- **D39-2: mechanism.** One transaction: kind, `rederive_all_projects` (R6), audit
  (`workflow_settings.steps_update`, system actor, plus `project.effort_rederived` per change) and
  `schedule_stale`. Then one greedy run (`step_kind_changed`, ADR 0023 lifecycle). It runs through an
  idempotent script that reuses the router's step-kind path, extracted into a service. Fresh
  installs get the kind from `domain_constants`. The script always re-derives, so a seed merge
  cannot leave a stale split.
- **D39-3: history is kept.** PDD-A stage statuses, actual dates and check-ins stay as recorded.
  Stored runs keep their snapshot kinds (I14).
- **D39-4: OEM-A Commercial Brief is not changed.** The old tool says "R&D Resource". OQ #100 a
  asks the owner.
- **D39-5: the effects.**
  - The leader is no longer booked for PDD-A.
  - Design demand drops by 1 week per PDD project without a design figure, plus any R3-raised
    PDD-A weeks.
  - Figure projects keep E, spread over B/D/E/I/J/K/M, and gain PDD-A's calendar week.
  - Booked %, within-year and the P1 fill move with the run.
  - These are reported, not tuned.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P39-T01 | **Ruling** on the ADR 0007 amendment Q1–Q6 (elapsed vs a new kind; In Progress PDD-A; script vs migration; stale `plan_weeks` on own-effort PDD-A rows and an OR-5 style re-copy; `trigger_reason` and `not_needed`; R35-5 when PDD-A was the only non-excluded design step) **plus the measured effect on a disposable copy of the dev DB** (dev DB at p33c, never touched). Pin `RPD_CURRENT_WEEK` to one week for both runs. Fresh greedy run on the copy before the change; flip PDD-A through the existing Workflow Settings steps PUT (it already re-derives); fresh greedy run after. Report per hub and overall: within-year / spillover / left-out; design demand (full year, remaining) and design booked % per capacity hub; P1 fill suggestions changed; projects whose finish moved, and how many of those carry a design figure; count of `project.effort_rederived`; I1–I44 on the new run. **Reported, not tuned.** | workflow-auditor | — | MEMORY entry with accept / amend per Q1–Q6, any R39 items, and the before / after table; the copy is dropped; no code | TODO |
| P39-T02 | Fold the ruling in: ADR 0007 amendment → Accepted (with R-items); DOMAIN_RULES P39 note loses "PROPOSED"; T04 marked needed or SKIPPED | orchestrator | P39-T01 | ADR, DOMAIN_RULES and plan consistent with the ruling; MEMORY entry | TODO |
| P39-T03 | Backend: `domain_constants.WORKFLOW_STEP_TEMPLATE_SEED` PDD-A → `elapsed`; extract the steps-PUT kind path into a service (router behaviour and audit unchanged); `scripts/p39_marketing_brief_elapsed.py` per D39-2 (dispatch advisory lock, idempotent, exit codes as the p33 script, prints counts only, no financial field read); any R39 items; update tests that assert the seeded kind (`test_domain_constants_lead_times`, `test_workflow_settings_api`, `tests/factories`) | backend-builder | P39-T02 | pytest, ruff, mypy green. Tests: the split examples in DOMAIN_RULES (B 4 → D 1, E 2, K 1; C 3 → D 1, E 1, J 1; B 8; A 18; A+ 44); a project with a Done PDD-A keeps status, actual dates and check-ins, has `effort_weeks` NULL on PDD-A, and is not raised; In Progress PDD-A books no leader in the next run; the script run twice → one `steps_update` audit and one run; a script run on a DB already `elapsed` with a stale split re-derives; frozen projects untouched (I10); excluded PDD-A unchanged; a fresh seeded DB equals a script-migrated DB on kinds; `scheduling/` untouched; MEMORY entry | TODO |
| P39-T04 | *(Conditional on OQ #100 b / T01.)* Frontend: only if the label changes ("Elapsed" → "Others") in `step-kind-meta.ts` and the legends that read it. Today no surface names PDD-A's kind outside the served data, so nothing is needed | frontend-builder | P39-T02 | tsc, eslint, vitest green; MEMORY entry | TODO |
| P39-T05 | Audited script run on a fresh disposable copy of the dev DB: the figures match T01 (or every difference is explained); second invocation dispatches nothing; audit rows as specified; I1–I44 on the run | workflow-auditor | P39-T03 | MEMORY entry with the table; copy dropped | TODO |
| P39-T06 | Gate: qa, workflow, security. **May be combined with P37-T08** if P39-T05 is DONE before P37-T08 starts (one MEMORY PASS per auditor naming both phases); otherwise its own gate | qa-inspector + workflow-auditor + security-auditor | all P39 tasks | Three PASSes recorded in MEMORY. Security in particular: the script runs with no request context, logs counts only, and the audit actor is the system | TODO |

## P40 — Project Execution Timeline: step colours, multi-select filters, compact forest view, frozen per-step dates

Opened 2026-11-17 (owner request with screenshots of the client's old tool,
`~/.gemini/antigravity-ide/scratch/RPDCHARTERV1del/src/components/Charter.jsx`). Asks:
(1) per-step Start / End week on the timeline: changing Start pushes End by the step's length;
changing End by hand squeezes / stretches the step; the typed dates override the scheduled ones;
(2) a frozen project keeps those dates and is not moved by the scheduler;
(3) a distinct colour per workflow step on the bars (old tool: a 14-colour palette by step index)
with a legend;
(4) the per-step count chips (PDD / OEM rows) and activity load coloured per step, with the
colours named;
(5) the toolbar filters (Hub, Category, Type, Status, Leader/Engineer, Step) are multi-select;
(6) Forest view shows only the project name and one execution line per project, so many
projects fit;
(7) the upper half (filters, stats) is compacted so the timeline gets the space: one row of
dropdown filters.

Items (1)–(2) partly reverse ADR 0048 (per-project timing retired, owner 2026-11-13). They wait
for the owner's confirmation of the model (OQ, asked 2026-11-17) and a new ADR. Items (3)–(7)
are presentation only and start now.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P40-T01 | Frontend: items (3)–(7): per-step colour palette (one token map keyed by step code, PDD and OEM, legend), step-count chips and activity-load strip coloured per step, multi-select Hub/Category/Type/Status/Leader/Step filters (URL state, clear-all), compact Forest view (name + one line, small row height), compact one-row toolbar with dropdown filters and collapsible stats | frontend-builder | — | tsc, eslint, vitest green; axe; colour contrast of bar labels; MEMORY entry | DONE (2026-11-17; per-step weekly counts need a backend field, see MEMORY) |
| P40-T02 | ADR 0054 + DOMAIN_RULES: frozen per-step start/end dates (model per owner answer) | orchestrator + workflow-auditor | owner answer | ADR Accepted; invariants | DONE (2026-11-17, workflow-auditor: ADR 0054 Accepted with ruling R40-1..R40-15; DOMAIN_RULES "Manual step weeks", I45–I48; MEMORY entry) |
| P40-R02 | Remediation (P40 gate, workflow-auditor FAIL 2026-11-17): the browser derives a per-step "lapsed" state (`lib/step-pin-drafts.ts::pinRunState`, `project.pin_lapsed && ms < planned_start`), against R40-13 / contract §2; it misfires on a sibling pin saved earlier than its window. Backend serves a per-step `pin_lapsed` on `GanttStepRow` (run row pinned and its window ≠ the pin in the run's `workflow_snapshot.step_pins`) and `pin_clearable`; frontend uses them; tests incl. the sibling case. Docs drift: name register-edits as a clearing writer (DOMAIN_RULES, ADR 0054 R40-4, contract §5); FTE condition on `current_length_weeks`; `pin_block_reason` with no live row; R40-13 wording for a truly lapsed pin ; plus frontend tests for the save lifecycle (queued → "Timeline updated", 403, 429) to lift step-pin-save-panel / use-step-pin-save / step-pin-edit-bar above 70% (qa note)| backend-builder → frontend-builder; orchestrator (docs) | P40-T04 | workflow-auditor re-check PASS | DONE (2026-11-17, workflow-auditor re-check PASS, MEMORY "P40-R02 re-check"; frontend half 2026-11-17, frontend-builder: `pinRunState` lapses only from `step.pin_lapsed`, Clear only from `step.pin_clearable`; sibling-case unit + page tests; save-lifecycle tests (queued → "Timeline updated" incl. loading / error / no-baseline, failed run, deferred, 403, 429 ± Retry-After); new `components/step-pin-edit-bar.test.tsx`; save-panel 100% / use-step-pin-save 100% / edit-bar 94% lines; MEMORY entry. Backend half DONE 2026-11-17, backend-builder: `GanttStepRow.pin_lapsed` / `pin_clearable`, types.ts + fixture defaults, contract §2/§5 incl. register-edits writer, FTE condition, no-live-row reason; `tests/test_p40_r02_step_pin_lapsed_clearable.py`; MEMORY entry. Next: frontend-builder switches `pinRunState`; orchestrator: DOMAIN_RULES / ADR 0054 R40-4 + R40-13 wording; workflow-auditor re-check) |
| P40-F01 | Security follow-ups (P40 gate, security-auditor S40-M1 / S40-L1 / S40-I1): per-user rate limit on `PUT /gantt/step-pins` (429 `RATE_LIMITED` + `Retry-After`, register-edits style); lock only in-scope project rows in the pin save (404 unchanged); pin-clear audit before the `sync_project_steps` delete branch; contract §1/§5 | backend-builder | P40-T04 (security leg) | pytest (P40 + rbac); contract doc; MEMORY entry | DONE (2026-11-17, backend-builder: `STEP_PINS_RATE_LIMIT` burst 10 / 1 per 6 s; `template_apply.lock_projects_in_scope`; `clear_pin_on_repoint` before delete; `tests/test_p40_f01_security_followups.py`; MEMORY entry) |
| P40-R01 | Remediation (P40-T03d FAIL, MEMORY 2026-11-17 P40-T03d): `services/register_steps.py::apply_current_step` must call `step_pin_clear.clear_pin_if_started` (cause `stage_started`) for every row leaving Not Started, under the existing lock, same transaction; test: current step moved past a pinned step clears the pin with one audit row; then re-run that audit step | backend-builder, then workflow-auditor | P40-T03d | pytest; re-audit PASS in MEMORY | DONE (2026-11-17, workflow-auditor re-audit PASS on a disposable DB copy, MEMORY "P40-T03d re-audit"; code 2026-11-17, backend-builder: `apply_current_step` clears pins via `clear_pin_if_started`; `tests/test_p40_r01_register_current_step_pins.py`; MEMORY entry) |
| P40-T03a | Scheduler per ADR 0054 ruling R40-3..R40-8, R40-12, I45–I48 (work split 'algorithm-engineer' in MEMORY P40-T02): `StepPinInput`, `ProjectInput.step_pins`, pinned placement in greedy + CP-SAT pre-booking, same-project ENG_CONFLICT, `manual_overlap` / `pin_lapsed`, invariants, byte-identity proof | algorithm-engineer | P40-T02 | golden files byte-identical with no pins; fixtures per pin type; greedy = CP-SAT on pinned rows; MEMORY entry | DONE (2026-11-17, algorithm-engineer: `StepPinInput`, `ProjectInput.step_pins`, `StepSchedule.pinned/.manual_overlap`, outcome `.manual_overlap/.pin_lapsed`; I45/I47/I48(b) + amended I1/I2/I3/I10/I21/I22/I27; 521 pre-existing tests byte-identical (6739 digests); 767 passed; MEMORY entry) |
| P40-T03b | Backend per R40-1/2/4/9/10/11/13 (work split 'backend-builder'): migration, `PUT /gantt/step-pins` batch save + audit + one greedy run, clear-on-start hooks, Admin/Super-Admin unfreeze, builder/persistence, per-week spread, Gantt payload fields, plan-import PIN_DROPPED, contract | backend-builder | P40-T02 (types from T03a) | pytest; contract doc + table; MEMORY entry | DONE (2026-11-17, backend-builder: migration p40a, `PUT /gantt/step-pins`, clear hooks, Admin-only unfreeze, builder/persistence/readers, Gantt fields + `by_step` / `current_step_counts`, PIN_DROPPED; docs/API_CONTRACT_P40.md; MEMORY entry) |
| P40-T03c | Frontend Start/End inputs per the 'frontend-builder' work split | frontend-builder | P40-T01, P40-T03b | tsc/eslint/vitest/axe; MEMORY entry | DONE (2026-11-17, frontend-builder: Start/End inputs on expanded step rows, drafts + batch Save/Cancel + leave guard, per-item errors, run outcome panel, Pinned/Manual overlap/Pin lapsed/next-run markers, Admin-only Unfreeze, `include_unplaced`, by_step strip + current-step chips; MEMORY entry) |
| P40-T03d | Audited run on a disposable DB copy: every pin type, I45–I48, greedy vs CP-SAT | workflow-auditor | T03a–c | PASS in MEMORY | DONE (2026-11-17, workflow-auditor: register-edits re-audit PASS after P40-R01, MEMORY "P40-T03d re-audit"; original FAIL 2026-11-17, workflow-auditor: every pin type, I45/I47/I48, amended I1/I2/I3/I15/I21/I22/I27, greedy = CP-SAT on pinned rows + `pin_lapsed`, I48 byte-identity, R40-13 reconciliation, audit rows and one run per save all PASS; FAIL on R40-4 / I46(c)(e): `register_steps.apply_current_step` (P35-T06) moves a stage out of Not Started without clearing its pin; remediation needed, then re-check; MEMORY entry) |
| P40-T04 | Gate: qa, workflow, security | three gatekeepers | all P40 tasks | three PASSes | DONE (MEMORY 2026-11-17 "P40 gate (P40-T04) re-run — combined result: PASS") |

## P41 — What-if import: editable Excel format, hand-picked scenarios, saved/exported scenarios across imports (ADR 0055)

Opened 2026-11-17 (owner request). Asks:
1. Admin and Super Admin can set and edit the import Excel format.
2. The Executive view gets scenarios built by ticking projects before including them, with Save and
   Export.
3. Scenarios from different imports can be compared and stay saved for future reference.

Contract: `docs/API_CONTRACT_P41.md`. No scheduler change.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P41-R01 | GATE REMEDIATION (security H-1, M-1): saved-scenario `hub_codes` = every hub in the stored request + result (capacity, designers, lab regions, plan_projects, changes, request rows, matched/excluded ids) ∪ the saver's scope; `[]` never visible to others; probe tests (unticked rows, all unticked, excluded plan project, Admin save); KPIs in own column, paged list, rate limit on list/get; exports built off the event loop | backend-builder | — | probe tests green; security re-review PASS | DONE (MEMORY 2026-11-17 P41-R01) |
| P41-T01 | ADR 0055, contract, DOMAIN_RULES amendment, OQ #104–#106 | orchestrator | — | docs written | DONE (MEMORY 2026-11-17 P41-T01) |
| P41-T02 | Backend: migration `p41a`, format GET/PUT/reset/template, parser aliases arg, `exclude_plan_project_ids` + `plan_excluded` + `plan_projects`, saved scenarios CRUD with scope, exports (scenario, current, compare), audit, limits; tests | backend-builder | T01 | pytest green, ruff/mypy clean, template round-trips through the parser, scope probe tests, formula-injection test, no-financial-keys test; MEMORY entry | DONE (MEMORY 2026-11-17 P41-T02) |
| P41-T03 | Frontend: Excel format card + Admin edit dialog, Executive Scenario bar + project picker sheet, Save / Export, saved library, cross-import Compare + export; tests | frontend-builder | T01 (contract) | tsc, eslint, vitest green; role-gated edit; MEMORY entry | DONE (MEMORY 2026-11-17 P41-T03) |
| P41-T04 | Gate: qa, workflow (reconciliation only), security | three gatekeepers | T02, T03 | three PASSes | DONE (MEMORY 2026-11-17 P41-T04 gate closed) |

## P42 — Priority bands mean something for scheduling (ADR 0056)

Opened 2026-11-17 (owner request).
- P1 "Must do this year" and P2 "Good to have this year" schedule as today.
- P3 "In queue": started P3 schedules as today. P3 still In Queue schedules with spare capacity
  only and never counts toward the year.
- P4 "Miscellaneous" is never scheduled.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P42-T01 | Ruling on ADR 0056 D1–D6 (frozen P4, CP-SAT weight, impact map of every "schedulable" site, invariants) | workflow-auditor | — | ruling R42-n in MEMORY | DONE (MEMORY 2026-11-17 P42-T01, R42-1..R42-12) |
| P42-T02 | Scheduler: P4/Q exclusion + `not_scheduled_priority`, `counts_toward_year`, CP-SAT prepare_run, What-if / plan import, validator invariants; tests | algorithm-engineer | T01 | selftests + pytest green; MEMORY entry | DONE (MEMORY 2026-11-17 P42-T02) |
| P42-T03 | Backend: band labels served, KPI / dashboard / executive / capacity demand per ruling, persistence of new result fields (migration if needed), contract `docs/API_CONTRACT_P42.md`; tests | backend-builder | T01, T02 types | pytest green, ruff/mypy clean; MEMORY entry | DONE (MEMORY 2026-11-17 P42-T03) |
| P42-T04 | Frontend: band labels, "Queued" / "Not scheduled (P4)" display, KPI copy, priority-move preview copy; tests | frontend-builder | T03 contract | tsc, eslint, vitest green; MEMORY entry | DONE (MEMORY 2026-11-17 P42-T04) |
| P42-T05 | Gate: qa, workflow, security | three gatekeepers | T02–T04 | three PASSes | DONE (MEMORY 2026-11-17 P42-T05: qa, workflow, security PASS) |

## P43 — Presentable Excel exports with a drawn Gantt chart (ADR 0057)

Opened 2026-11-17 (owner request). Presentation only.

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P43-T01 | ADR 0057, OQ #112 | orchestrator | — | docs written | DONE (MEMORY 2026-11-17 P43-T01) |
| P43-T02 | Backend: styled workbook writer for every xlsx export; drawn Gantt sheet in the Gantt, What-if import result, saved scenario and comparison exports; What-if planner export if missing; contract note `docs/API_CONTRACT_P43.md`; tests | backend-builder | T01 | pytest green; openpyxl round-trip tests (styles, fills per week, legend, frozen panes, formula guard); MEMORY entry | DONE (MEMORY 2026-11-17 P43-T02) |
| P43-T03 | Frontend: export buttons wherever a Gantt / scenario result is shown and none exists; tests | frontend-builder | T02 contract | tsc, eslint, vitest; MEMORY entry | DONE (MEMORY 2026-11-17 P43-T03) |
| P43-T04 | Gate: qa, workflow (reconciliation: drawn bars = served weeks), security | three gatekeepers | T02, T03 | three PASSes | DONE (MEMORY 2026-11-18 P43-T04: qa, workflow, security PASS; R01, R02 fixed) |

## P44 — Projects list: the row Edit button edits in place (owner request 2026-11-18)

The owner: "on clicking Edit in each project list row it shouldn't open this popup; it should allow
editing there on the list (design time, lab time and all), so no 2 edit buttons. Anyone who needs
the details opens the project folder."

This supersedes the 2026-11-17 "row Edit opens the popup" choice for the Projects list only. The
popup stays as the project folder's Edit. Frontend only: the save path is unchanged (one
`POST /projects/register-edits`, one recalculation).

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P44-T01 | Row Edit puts that row in inline edit (the P35 grid cells), a per-row Edit/Done toggle, several rows allowed, one shared Save bar; toolbar "Edit" removed; row Edit no longer opens the drawer; the project name / folder link stays; "Register project" still opens the create drawer; `?edit=<id>` deep link goes to the folder Edit or opens the row in edit; tests | frontend-builder | — | tsc, eslint, vitest, axe; MEMORY entry | DONE (MEMORY 2026-11-18 P44-T01; scope addition: step chips in the row) |
| P44-T02 | Gate: qa, security (UI only; workflow N/A — no scheduling or KPI change, recorded as such) | gatekeepers | T01 | PASSes | DONE (MEMORY 2026-11-18 P44-T02: qa, security PASS; workflow N/A) |
| P44-R01 | Owner 2026-11-18: register header row stays fixed while scrolling (sticky in the table's own scroll box, box capped to the viewport); test | frontend-builder | T01 | tsc, eslint, vitest; MEMORY entry | DONE (MEMORY 2026-11-18 P44-R01) |

## P45 — Hub demand cards: P1/P2 shading, "required to finish P1 / P2", on the Executive dashboard (owner request 2026-11-18)

Asks (screenshot of the Priority board hub strip, `priority-board/components/hub-load-strip.tsx`):
(1) show the P1 and P2 parts of each Design / Lab demand bar in different shades; (2) show the same
cards on the Executive dashboard; (3) on both, show how much design and lab is still needed to
finish the remaining P1 projects and then the P2 projects. If the P1 projects all fit, don't show a
P1 line, only what is still missing to get through P2.

Decisions (orchestrator, 2026-11-18):
- D45-1: shading splits the bar's existing figure (full-year demand, I25) by live priority band:
  P1 darkest, P2 mid, the rest (P3, P4, Q) lightest, all in the bar's booking-status hue. The split
  is served and sums to the served total (I19 style); the browser draws, never derives.
- D45-2: "required to finish" works on REMAINING demand vs REMAINING capacity of the year (both
  already served, `*_load_remaining_weeks` / `*_capacity_remaining`):
  `need_p1 = max(0, R(P1) − C_rem)`, `need_p1_p2 = max(0, R(P1) + R(P2) − C_rem)`, per kind. Design
  per capacity hub; lab per lab region (repeated on each hub of the region, as today). This is the
  aggregate capacity view, not the scheduler's verdict: the run can still leave a project out
  because of sequencing or eligibility. The UI says so in a tooltip.
- D45-3: display: if `need_p1 > 0` show "To finish P1: +X wks"; always show "To finish P1 + P2: +Y
  wks" when Y > 0; when both are 0, show "P1 and P2 fit in the remaining capacity". Units are weeks
  (man-weeks for design, chamber-weeks for lab), like the bars (OQ #86 asks if the client wants
  hours).
- D45-4: the Executive dashboard shows the same component, hub-filtered like the rest of the view,
  if the Executive role can read Capacity; otherwise the backend gate decides (OQ #87).

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P45-T01 | Backend: on `HubCapacityRow` (`GET /capacity/hub-load`): `design_demand_by_priority` / `lab_demand_by_priority` (`{P1,P2,P3,P4,Queue}` weeks, full-year demand basis, summing to `design_load_weeks` / `lab_load_weeks` via `split_to_total`), `design_remaining_by_priority` / `lab_remaining_by_priority` (remaining-demand basis, summing to `*_load_remaining_weeks`), and `design_need_p1_weeks`, `design_need_p1_p2_weeks`, `lab_need_p1_weeks`, `lab_need_p1_p2_weeks` per D45-2 (2 dp); one grouped query, no N+1; DOMAIN_RULES note (orchestrator); RBAC check of Executive read on this endpoint reported | backend-builder | — | Tests: sums reconcile; need is 0 when P1 fits and positive otherwise; P1+P2 ≥ P1; lab repeated per region; hub scoping; statement count; contract test row; MEMORY entry | DONE |
| P45-T02 | Frontend: shaded P1 / P2 / rest segments in each bar (legend "P1 · P2 · other", accessible text); "To finish" lines per D45-3 with the D45-2 tooltip; the strip also on the Executive dashboard | frontend-builder | P45-T01 (field names fixed here) | Tests: segment widths from served figures, hidden P1 line when 0, both-zero message, Executive placement, axe; tsc, eslint, vitest; MEMORY entry | DONE |
| P45-T03 | Workflow-auditor check: the demand split reconciles with I25 and the Capacity surface; need figures re-derived independently on the seed | workflow-auditor | P45-T01 | PASS in MEMORY | DONE (MEMORY 2026-11-18 P45-T03: PASS; need_p1 9.5 / need_p1_p2 12.5 on the edge fixture, seed all 0) |
| P45-R01 | Frontend: hub demand strip legend explains bar colours — status hue (Full / Near full / Available from `BOOKING_STATUS_META`, served thresholds) and priority shade (P1 / P2 / P3+ other); tooltip updated | frontend-builder | P45-T02 | Tests: legend text + swatch classes, tooltip; tsc, eslint, vitest; MEMORY entry | DONE |

## P46 — Two test logins (password = username); destructive actions Super Admin only (ADR 0058)

Opened 2026-11-18 (owner request, relaying the client). Only two logins, `superadmin` and `admin`,
each with its password equal to its username. Admin edits everything, but cannot cancel a project,
remove a category or step, delete a chamber, deactivate an engineer, deactivate a user, revoke
access, cancel a run, delete others' scenarios, or reset the import format. The target is the hosted
Render demo (dev mode).

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P46-T01 | ADR 0058, plan, OQ #113 | orchestrator | — | docs | DONE (MEMORY 2026-11-18 P46-T01) |
| P46-T02 | Backend: dev-mode startup provisioning of the 2 accounts, `/me/dev-users` = those 2, `POST /me/dev-login` (constant-time, generic 401, rate limit), `SUPER_ADMIN_ONLY` guards per ADR 0058 D1 on every write path; tests | backend-builder | T01 | 403 probes as Admin + positive as Super Admin for every D1 item; login tests; pytest/ruff/mypy; MEMORY | DONE (MEMORY 2026-11-18 P46-T02) |
| P46-T03 | Frontend: login screen with the 2 accounts via `/me/dev-login` (username or email), retire the shared password; hide/disable D1 controls for non-Super-Admin ("Super Admin only"); tests | frontend-builder | T01 | tsc/eslint/vitest; MEMORY | DONE (MEMORY 2026-11-18 P46-T03) |
| P46-T04 | Gate: qa, workflow, security | three gatekeepers | T02, T03 | three PASSes | DONE (MEMORY 2026-11-18 P46-T04 gate closed) |
| P46-R01 | Security follow-ups: M-1 revoke delegate bypass (global Admin always `SUPER_ADMIN_ONLY`; ADR 0012 delegate kept for non-Admin managers), L-1 dev-login limiter keyed on left-most `X-Forwarded-For`, bucket dict bounded (LRU 10k) | backend-builder | T04 | chain test + delegate tests; XFF / LRU tests; p46, project_access, user-admin suites; ruff/mypy; MEMORY | DONE (MEMORY 2026-11-18 P46-R01) |

## P47 — Concurrent edits: field-level conflict check, no silent overwrite (ADR 0059)

Opened 2026-11-18 (owner): several users now edit the hosted demo at once. Two people saving the
same field must not silently overwrite each other. No schema or data change is allowed (standing
decision, 2026-11-18).

| ID | Task | Owner | Depends on | Acceptance | Status |
|---|---|---|---|---|---|
| P47-T01 | ADR 0059, plan, OQ #114 | orchestrator | — | docs | DONE (MEMORY 2026-11-18 P47-T01) |
| P47-T02 | Backend: `services/edit_conflict.py`; optional `base` + 409 `EDIT_CONFLICT` on every C3 endpoint (inventory them), financial values hidden, `changed_by/at` from audit; tests incl. two-client races, different-field edits both succeed, batch atomic, no-base = old behaviour | backend-builder | T01 | pytest/ruff/mypy; endpoint inventory in MEMORY | DONE (MEMORY 2026-11-18 P47-T02) |
| P47-T03 | Frontend: send `base` on every C3 edit; shared conflict dialog (Use theirs / Keep mine), batch keeps non-conflicting edits; refetch on focus + 60 s poll when idle on editable grids/forms; tests | frontend-builder | T01 (contract in ADR) | tsc/eslint/vitest; MEMORY | DONE (MEMORY 2026-11-18 P47-T03) |
| P47-T04 | Gate: qa, workflow, security | three gatekeepers | T02, T03 | three PASSes | DONE (MEMORY 2026-11-18 P47-T04 gate closed) |
| P47-R01 | Security gate follow-ups: M-1 authorise before `check_base` on every C3 endpoint (users PATCH, project PATCH cancel / hub move, unfreeze, chamber region); M-2 financial fields `null` in PATCH / freeze responses and 422 `FINANCIAL_FIELDS_HIDDEN` in edit or `base` for a caller without Project Registration READ; L-1 VIP link `changed_by` only from rows naming a visible project, no entity fallback; I-1 VIP pin re-authorised after the lock | backend-builder | T04 (security) | `tests/test_p47_r01_security.py`; p47 + related suites; ruff/mypy; MEMORY | DONE (MEMORY 2026-11-18 P47-R01) |
| P47-R02 | `hard_gates` written only when sent (`PUT /priorities/{id}`, `POST /scenarios/apply`): a scores-only save keeps the stored gates, `[]` clears, a new score starts with none | backend-builder | T02 | `tests/test_p47_r02_hard_gates.py`; priorities / scenario / matrix / p47 suites; ruff/mypy; MEMORY | DONE (MEMORY 2026-11-18 P47-R02) |
| P47-R03 | Frontend QA fixes: QA-1 stage-row PATCH sends only the changed fields, each with its `base`; QA-2 `hard_gates` in body and `base` only when the gates change (served list as base), else omitted (Matrix grid, compare dialog, workspace scoring, scenario Apply); test that a concurrent gate change survives a scores-only save | frontend-builder | T04 (qa), R02 | Matrix / workspace / scoring vitest; tsc/eslint; MEMORY | DONE (MEMORY 2026-11-18 P47-R03) |

## P48 — Capacity planning health check; saved import scenarios on the Import (Excel) step (owner request 2026-11-18)

Owner: "make sure capacity planning is working properly; also the What-if scenarios come up when we import Excel, but add an option where older scenarios show in the import Excel place also." The hosted data is the client's (standing decision): checks against Render are read-only (GET only), and no migration or data change is allowed.

| ID | Task | Owner | Depends | Verification | Status |
|---|---|---|---|---|---|
| P48-T01 | Capacity planning health check: run the capacity / planning / what-if backend and frontend suites; read-only GET probes of the live capacity planning endpoints; report defects as R-tasks | qa-inspector | — | test output + live probe results in MEMORY | DONE (MEMORY 2026-11-18 P48-T01) |
| P48-T02 | Frontend: "Saved scenarios" panel on the Import plan (Excel) upload step, listing every saved scenario visible to the user (the existing paged list, grouped by source file and date) with Open (read-only stored result, no file needed), Export, Rename / Delete when `can_edit`, and Add to compare; reuse the P41 library; tests | frontend-builder | — | tsc/eslint/vitest; MEMORY | DONE (MEMORY 2026-11-18 P48-T02) |
| P48-T03 | Gate: qa, workflow, security | three gatekeepers | T01, T02 | three PASSes | DONE (MEMORY 2026-11-18 P48-T03 gate closed) |
| P48-R01 | QA48-2: opening or comparing a saved scenario from the upload panel while a workbook is parsed but not simulated must not simulate and must show the view (route to results whenever a scenario view or panel compare is open; skip the results effect then); tests incl. the 422 variant | frontend-builder | T03 (qa) | whatif vitest; tsc/eslint; MEMORY | DONE (MEMORY 2026-11-18 P48-R01) |

## P49 — Auto logout on browser close and after 30 min idle; auto reload on a new version (ADR 0060)

| ID | Task | Owner | Depends | Verification | Status |
|---|---|---|---|---|---|
| P49-T01 | ADR 0060, plan | orchestrator | — | docs | DONE (MEMORY 2026-11-18 P49-T01) |
| P49-T02 | Frontend: L1 sessionStorage-only login + BroadcastChannel tab handshake + remove Remember me + purge old localStorage key; L2 30-min idle logout with 2-min warning across tabs, notice on login page, full page load on sign-in; R1 `version.json` build id, 5-min / on-visible check, reload when not editing else banner, chunk-load-failure reload with loop guard; tests | frontend-builder | T01 | tsc/eslint/vitest; vite build emits version.json; MEMORY | DONE (MEMORY 2026-11-18 P49-T02) |
| P49-T03 | Gate: qa, workflow, security | three gatekeepers | T02 | three PASSes | DONE (MEMORY 2026-11-19 P49-T03 gate closed) |
| P49-R01 | Workflow W49-1: auto reload waits for all pending work. `isSafeToReload` also requires no pending mutation, no followed run, no what-if request pending; register inline drafts / Save-then-recalc, priority-move panel running/updated, What-if planner scenario/request, Matrix scenario staged edits register with the edit session; tests per state. Also A2 (idle sign-out reaches login with the inactivity notice even with a leave guard) and S49-L1 (remove the dead "Remembered" row in profile.tsx) | frontend-builder | T03 (workflow) | targeted vitest; tsc/eslint; MEMORY | DONE (MEMORY 2026-11-19 P49-R01) |

## P50 — What-if plan import for the client's 2027 project list: band columns → priority, "Plan from" / "Plan until" weeks (ADR 0061; ruling R49-1..R49-21, I54–I56; owner 2026-11-19)

The ruling is labelled R49 (written before the phase number was assigned; P49 is ADR 0060).

| ID | Task | Owner | Depends on | Status |
|---|---|---|---|---|
| P50-T01 | Parser band columns (R49-1..6, I55); schema/service `plan_from_week` / `plan_until_week`, served labels, `PLAN_FROM_LATER` (service-emitted), saved scenarios / compare / export / audit (R49-13, R49-19) | backend-builder | — | done (MEMORY 2026-11-19) |
| P50-T02 | Engine: plan-from floor and anchor (I54), plan-until cut-off / horizon / windows (I56) | algorithm-engineer | — | done (MEMORY 2026-11-19) |
| P50-T03 | What-if import: "Plan from" / "Plan until" pickers, server labels, "band" source, banners, cut-off reads served `plan_until_week` | frontend-builder | T01, T02 | done (MEMORY 2026-11-19) |
| P50-T04 | Display: no week ≥ 53 on any surface — next-year weeks read W1.. with the year on hover (owner 2026-11-18) | frontend-builder | — | done (MEMORY 2026-11-19) |
| P50-T05 | Gate: qa-inspector, workflow-auditor, security-auditor | — | T01–T04 | done — gate PASS (qa, workflow, security; MEMORY 2026-11-19) |

## P51 — Timeline shows 2027/2028 with a year header row; project search wildcards (owner 2026-11-19; ADR 0062)

| ID | Task | Owner | Depends on | Status |
|---|---|---|---|---|
| P51-T01 | Timeline + What-if import Gantt run to the horizon (W78 / up to W130) with a 2026/2027/2028 year row; weekly active counts served to HORIZON_WEEKS | frontend-builder (+ orchestrator one-line `gantt.py`) | — | done (MEMORY 2026-11-19) |
| P51-T02 | Search: `*` / `?` wildcards, every other character literal, one helper server + browser | backend-builder | — | done (MEMORY 2026-11-19) |
| P51-T03 | Lab chamber stages: old app also lets chambers run PDD-J (Pr. Pr) and PDD-L (Pilot); the client's 2027 Process-steps sheet counts lab = F + H only | owner decision | — | on hold (owner: decide later) |
| P51-T04 | Gate: qa-inspector, workflow-auditor, security-auditor | — | T01, T02 | done — gate PASS (MEMORY 2026-11-19) |

## P52 — "Effort & Timeline Planning": one Excel-style matrix on the Workflow page, like the client's old app (owner 2026-11-19)

Presentation over existing capabilities (ADR 0007 kinds, ADR 0045–0048 templates/apply, P33). No new domain rule.

| ID | Task | Owner | Depends on | Status |
|---|---|---|---|---|
| P52-T01 | Matrix tab: PDD + OEM grids (categories × steps, editable weeks), Resource row (Design/Lab/Other = kind), Total W + D/L, per-category timeline previews with gap ±, B-equivalent, Apply to App; Chambers tab lists every lab-kind step | frontend-builder | — | done (MEMORY 2026-11-19 P52-T01) |
| P52-T02 | Gate | — | T01 | done — gate PASS (qa, workflow, security; MEMORY 2026-11-19) |
