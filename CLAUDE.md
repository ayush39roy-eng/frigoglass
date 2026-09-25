# RPD Web Application — Frigoglass

We are building the RPD Web Application for Frigoglass, a commercial refrigeration manufacturer
(HQ Athens; R&D and production hubs in Greece, India and Romania). It replaces a spreadsheet-based
process for planning their annual R&D and Product Development portfolio. It is delivered to the
client and hosted on Frigoglass's own servers, on-premise, behind their corporate network — not a
SaaS product. The application manages ~236 active projects across 6 hubs, and its central function
is a resource-constrained scheduling engine that assigns 14 workflow steps per project to engineers
and lab chambers across a 78-week horizon, then reports which projects will complete inside the
calendar year. Full detail: `docs/PROJECT_AND_STACK.md`.

## The Memory Protocol (hard rule)

Before starting ANY task, in this order, read:

1. `docs/DOMAIN_RULES.md` — the business logic contract
2. `docs/MEMORY.md` — what has already been decided, built, and broken
3. `docs/IMPLEMENTATION_PLAN.md` — the task you are about to do and its dependencies

After completing ANY task, append an entry to `docs/MEMORY.md`. Never edit or delete existing
entries — the file is append-only. Never mark a task complete in `docs/IMPLEMENTATION_PLAN.md`
without a corresponding `docs/MEMORY.md` entry.

## The Gate Protocol

No phase advances until `qa-inspector`, `workflow-auditor` and `security-auditor` have each
recorded a PASS for that phase in `docs/MEMORY.md`. The orchestrator enforces this. A FAIL blocks
the phase and creates a remediation task at the top of the current phase.

## The Delegation Rule

The orchestrator does not write application code. It plans, delegates to subagents, reviews their
output against `docs/DOMAIN_RULES.md`, and enforces gates.

## Non-negotiables

- The scheduler's behaviour is defined by `docs/DOMAIN_RULES.md`, never by the prototype. During P2
  the prototype is used as a differential oracle: every divergence between our implementation and
  its output must be classified as either an intentional fix (ADR required) or a bug in our port.
  Undocumented divergence fails the gate; documented divergence does not. The oracle is retired
  when P2 closes.
- Never run CP-SAT inside the FastAPI process.
- No secrets in the repo. No `dangerouslySetInnerHTML`. No raw SQL string interpolation.
- Financial fields (TCOGS, gross margin, selling price, customer name) are commercially sensitive —
  encrypted at rest, never logged.
- Engineer-level utilization data is GDPR personal data. See `docs/OPEN_QUESTIONS.md` #8.

## Stack summary (full detail + justification: `docs/PROJECT_AND_STACK.md` §3)

**Backend:** Python 3.13, FastAPI, Pydantic v2 (strict), PostgreSQL 17, SQLAlchemy 2.0 (async) +
Alembic, Redis 7, Celery, MinIO, OR-Tools CP-SAT, Gunicorn + Uvicorn.

**Frontend:** React 19 + TypeScript + Vite, TanStack Query + Zustand, TanStack Table + Virtual,
Tailwind + shadcn/ui (21st.dev), Framer Motion, Lottie (scoped: empty states / solver progress /
success only), ECharts + Recharts, custom hand-built Gantt (no commercial Gantt library). three.js
is NOT used in v1 — future-flagged for a 3D cooler viewer on Project Registration only, never on
Dashboard/Capacity/Matrix/Gantt/Planning.

**Infra & security:** Docker Compose (not Kubernetes), OIDC SSO (Entra ID primary, Keycloak
fallback), RBAC + row-level hub scoping in the data access layer, immutable append-only audit log,
Nginx/Traefik + TLS 1.3 + HSTS + ModSecurity/OWASP CRS, Vault or Docker secrets.

## Repo layout

```
CLAUDE.md
docs/
  PROJECT_AND_STACK.md      full spec
  DOMAIN_RULES.md           the executable business-logic contract
  IMPLEMENTATION_PLAN.md    phased task list (P0–P7)
  MEMORY.md                 append-only task log + standing decisions
  OPEN_QUESTIONS.md         numbered client questions, blocking where noted
  ORACLE_DIVERGENCE.md      P2-only, deleted at P2 close
  ADR/                      architecture decision records
.claude/
  agents/                   subagent definitions
  skills/                   opinionated how-to references
  commands/                 start-task, close-task, gate-check
  settings.json
reference/                  client deck + prototype — reference only, not the spec
backend/                    (created in P1)
  scheduling/               algorithm-engineer owns this and only this
frontend/                   (created in P4)
```

## Standard commands

- `make dev` — start the full stack (Docker Compose) for local development.
- `make test` — run backend (pytest) and frontend (Vitest) test suites.
- `make lint` — ruff + mypy (backend), eslint + tsc (frontend).

These targets are created in P1 (backend) and P4 (frontend); this bootstrap session creates no
`Makefile` since there is no application code yet to run, lint, or test.
