---
name: qa-testing
description: pytest/testcontainers Postgres fixtures, factory patterns for domain objects, the golden-file comparison helper, Vitest + Testing Library conventions, Playwright page objects for the six surfaces, axe integration, coverage thresholds, gate report format. Load before writing any test.
---

# Testing conventions

## Backend: pytest + pytest-asyncio + testcontainers Postgres

- One `testcontainers` Postgres instance per test session (not per test — too slow at this scale),
  with each test wrapped in a transaction that rolls back, so tests are isolated without paying
  container-startup cost repeatedly.
- Async tests use `pytest-asyncio` with `asyncio_mode = "auto"` in config — don't require `@pytest.
  mark.asyncio` on every single test function, it's boilerplate noise at this volume.
- Factory pattern for domain objects (factory-boy or a hand-rolled equivalent): a `ProjectFactory`,
  `EngineerFactory`, `ChamberFactory` etc. producing valid domain objects with sensible defaults,
  overridable per test. This keeps individual test bodies focused on the one field/relationship
  under test rather than re-specifying a full valid `Project` every time.
- Test the hub-scoping layer directly with the RBAC matrix from the `security-review` skill —
  qa-inspector and security-auditor's test suites should share fixtures where the matrix overlaps,
  not duplicate factory definitions.

## Golden-file comparison helper

A shared helper (`tests/helpers/golden.py` or similar) that:

1. Loads an expected `ScheduleOutput` fixture (JSON or a Python literal, whichever is more
   diff-readable in code review — prefer Python dataclass literals for small P2-T05 fixtures since
   they're more self-documenting than raw JSON).
2. Runs the scheduler against the fixture's input.
3. Asserts structural equality, and on failure, produces a **readable diff** — which project, which
   step, which field differed, not just "assertion failed." A raw dataclass `!=` failure message is
   not enough at 236-project scale; write a custom diff renderer that pinpoints the divergent
   field(s).

This same helper structure was used for the P2-T02/T03 oracle diff before `tests/oracle/` was
deleted — reuse the diff-rendering logic, not the oracle fixtures themselves.

## Frontend units: Vitest + Testing Library

- Query by role/label text (Testing Library philosophy) — not by CSS class or test-id where an
  accessible query exists, since that also serves as a light accessibility check for free.
- Mock TanStack Query at the network boundary (MSW — Mock Service Worker) rather than mocking the
  hooks themselves, so tests exercise the real query/cache behavior.
- Zustand store tests are plain unit tests against the store's actions — no rendering needed for
  pure state-transition logic (e.g., undo/redo stack behavior).

## Playwright page objects for the six surfaces

One page object per surface (`DashboardPage`, `CapacityPage`, `MatrixPage`, `GanttPage`,
`ProjectRegistrationPage`, `CapacityPlanningPage`), encapsulating locators and common actions
(`applyPriorities()`, `expandProject(id)`, `toggleCurrency('USD')`). Test files compose page-object
methods rather than raw locators, so a UI refactor updates one page object instead of every test
file that touches that surface.

Cover at minimum per surface: initial load renders expected data, the primary user action (apply/
register/expand) works end-to-end against a real backend (not mocked, for these E2E tests — use a
seeded test database), and the empty/loading/error states from the `rpd-visual-bar` skill actually
render when triggered.

## Accessibility (axe) integration

Run `axe-core` (via `@axe-core/playwright`) against every surface as part of its Playwright suite —
not a separate manual pass. Fail the test on any `serious` or `critical` axe violation; `moderate`
and below are logged but don't fail the build (track them, don't ignore them, but don't block on
them either — calibrate against ASVS-level severity so accessibility gating matches the same
severity philosophy as the security gate).

## Coverage thresholds

- **≥85% on `backend/scheduling/`** — the correctness-critical core, per `docs/IMPLEMENTATION_PLAN.
  md` P2-T09.
- **≥70% elsewhere** (backend outside scheduling, frontend).

Enforce via CI coverage gate (`pytest --cov` with `--cov-fail-under`, Vitest's coverage threshold
config), not manual eyeballing of a report.

## Writing a gate report

Every phase-gate PASS/FAIL written to `docs/MEMORY.md` by qa-inspector includes, at minimum:

- Coverage percentage per area (scheduling vs. elsewhere), with the enforced threshold stated
  alongside so a future reader doesn't need to look it up.
- Test suite pass/fail counts, and for any failure, which test and a one-line reason.
- Golden-file test status (all green, or which fixture failed and how).
- Contract test status (OpenAPI schema vs. TS types match).
- Axe violation summary (count by severity, with the actual violated rule IDs for anything that
  failed the gate).

A bare "PASS" or "FAIL" line is not an acceptable gate report — per the `qa-inspector` agent
definition, always report specifics.
