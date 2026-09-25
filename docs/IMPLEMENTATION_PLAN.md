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
