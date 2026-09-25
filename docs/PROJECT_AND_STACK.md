# RPD Web Application — Project and Stack

## 1. Business context

Frigoglass is a commercial refrigeration manufacturer headquartered in Athens, with R&D and
production hubs in Greece, India and Romania. The RPD (Research, Product Development) Web
Application replaces a spreadsheet-based process for planning their annual R&D and Product
Development portfolio — currently ~236 active projects across 6 hubs.

The application's central function is a resource-constrained scheduling engine that assigns the
14-step PDD workflow to engineers (design steps) and lab chambers (lab steps) across a 78-week
horizon, then reports which projects will complete inside the current calendar year and which will
spill over or be left out entirely.

It is delivered to the client and **hosted on Frigoglass's own servers, on-premise, behind their
corporate network.** It is not a SaaS product, not multi-tenant, and has no external internet-facing
surface beyond the corporate network boundary.

**Users:**

- **Portfolio Manager** — owns the overall project portfolio, applies priorities, reviews the
  Global Dashboard and Prioritization Matrix.
- **Hub Planner** — manages capacity (engineers, chambers) and project registration for one or more
  hubs; scoped to their assigned hub(s) via RBAC row-level filtering.
- **Engineer** — appears as a scheduling resource (design steps); may have limited read access to
  their own assignments.
- **Executive Viewer** — read-only access to Dashboard, Matrix and Gantt, typically across all hubs,
  for portfolio-level reporting to leadership.
- **Auditor** — read-only access to the audit log and historical versions, for compliance review.
- **Admin** — manages users, roles, hub scoping, and system configuration (currency rates,
  category multipliers if ever made configurable, IdP settings).

## 2. The seven surfaces

### Global RPD Dashboard

Portfolio-wide overview. Pipeline totals split by spillover / newly registered / total; status
overview cards (In Buyoff / Under Industrialization / In Development / In Queue); a hub × type
pipeline summary table; a completing-within-year table (see Invariant I9 — this count must be
derived from the current schedule run, never independently calculated); a pipeline-vs-completing
chart; and an analytics breakdown with filters (by hub, category, status, priority).

### RPD Capacity

Design and lab capacity vs. load per hub. A class breakdown (A+/A/B/C) of deliverable vs. left-out
projects. Load-vs-capacity charts per hub. A global resource utilization matrix (engineers × weeks,
chambers × weeks). Per `docs/DOMAIN_RULES.md`, FTE scaling and chamber efficiency currently do not
affect scheduling itself (known prototype defects, pending ADR) — this surface's capacity
*reporting* must still show FTE-scaled and efficiency-scaled figures where the source data provides
them, but must not silently imply the scheduler already accounts for them until an ADR says
otherwise.

### Prioritization Matrix

The 13-dimension scoring grid (`docs/DOMAIN_RULES.md` — Prioritization scoring). A portfolio decision
summary. A currency toggle (EUR/USD/INR) applied to financial columns, which are additionally split
by new-models vs. RM-saving projects. A scenario simulation mode (edit inputs without committing,
see P5). An "Apply Priorities" action that re-runs the band assignment (P1–P4, with hard-gate
overrides) and, downstream, re-triggers scheduling.

### Project Execution Timeline (the Gantt)

Week-bucketed, per-project expandable to per-step rows. Solid bars = planned; hatched bars =
actual + delay; a red connector = delay; badges for `ENG_CONFLICT` / `OVERLAP` / `LEFT_OUT`. An
activity-load bottleneck strip beneath the timeline. A freeze toggle per project (locks
`actual_start`, excludes the project from re-scheduling per the booking rules in
`docs/DOMAIN_RULES.md`).

### Project Registration

Create/edit projects: assign leader, category (A+/A/B/C), type, hub, actual start date, financial
fields (TCOGS, gross margin, selling price — commercially sensitive, encrypted at rest, never
logged). Hard gates enforce required fields before a project can leave draft status.

### Capacity Planning

Configure engineers (FTE, `allowed_categories`) and chambers (`platforms`, `efficiency`,
`weeks_per_chamber`, `max` concurrent, `allowed_stages`) per hub. An "Apply Logic" action and an
"Auto-assign" action for bulk resource assignment.

### Project Workspace

A dedicated page for a **single project**, reached by clicking any project row on the Dashboard,
Prioritization Matrix or Gantt. Everything about one project lives here: its details, its files, its
conversation, and how far along it actually is. The other six surfaces are a *planner* — they say
what should happen. This surface makes the application a *tracker* — it records what did happen and
feeds that back into the plan.

**Why it carries weight beyond its size.** The most important element on the page is **per-stage
progress capture**, because it closes a real gap in the scheduling model. Today the scheduler has
only two modes for a project: schedule it from scratch, or `frozen` it at a fixed `actual_start`
(Gantt surface, `docs/DOMAIN_RULES.md` — Booking rules). There is no middle ground. But the tool
goes live at `CURRENT_WEEK = 31` — most real projects will be part-way through a stage on day one.
Without progress capture, the first real data load produces a visibly wrong schedule and users stop
trusting it. With progress capture, stages marked done become fixed history that is not
rescheduled, stages in progress schedule only their remaining time, and stages not started schedule
normally — and the crude `frozen` flag becomes mostly unnecessary.

The scheduler-facing rules for how stage status/percent/actuals/remaining feed a re-solve (the
`Done` / `In Progress` / `Blocked` / `Not Started` handling, weighted roll-up, and the
"reschedule is explicit, never automatic" rule) are **domain logic and must be specified in
`docs/DOMAIN_RULES.md`, not here** — see the follow-up recorded in `docs/MEMORY.md` for this
addition. This section defines the *surface*; `docs/DOMAIN_RULES.md` owns the *contract*.

**Layout** — four regions, two-column, with a sticky header.

*Header (sticky).* Project name + ID · hub · category · type · priority badge · **health badge** ·
assigned leader · a "Recalculate schedule" button (dispatches the solver as a background job per §4,
writing a new immutable schedule version). The health badge is **derived from the current schedule
run, never entered** (consistent with Invariant I9 — no independent calculation):

| Badge | Meaning |
|---|---|
| 🟢 On Track | projected finish ≤ week 52 (`WITHIN_YEAR_WEEK`), no overdue stages |
| 🟡 At Risk | projected finish ≤ 52 but a stage is running over its planned duration |
| 🔴 Off Track | projected finish > week 52 |
| ⚫ Left Out | no feasible slot inside the horizon (`LEFT_OUT`) |

*Left column — Details & Progress.*

- **Details panel** — every field from Project Registration, inline-editable: name, hub, leader,
  category, type, status, actual start, customer, registration year, the financial fields (TCOGS,
  selling price, gross margin, CAPEX, RM savings — commercially sensitive, encrypted at rest, never
  logged), the three hard-gate checkboxes, and the 13 scoring dimensions
  (`docs/DOMAIN_RULES.md` — Prioritization scoring).
- **Progress panel** — the 14 PDD stages as a vertical list. A roll-up project progress bar sits at
  the top, **weighted by stage duration** (not a 14-way average — Design Detailing is 4× the size of
  Commercialization). Per stage row:

  | Field | Editable | Notes |
  |---|---|---|
  | Stage ID + name | no | PDD-A … PDD-N |
  | Status | yes | Not Started / In Progress / Blocked / Done |
  | Percent complete | yes | 0–100, slider + number input |
  | Planned start / end week | no | from the scheduler |
  | Actual start / end week | yes | |
  | Remaining weeks | yes | auto-derived, manually overridable |
  | Assigned engineer or chamber | no in v1 | display only in v1; see §7 |
  | Blocked reason | yes | required when status is Blocked; surfaces on Notifications |

*Right column — Files & Activity.*

- **Files panel** — drag-and-drop upload zone. Each file has a **display name** (editable, separate
  from the on-disk filename), a category tag, a description, uploader, timestamp, size, and version
  number. Re-uploading against an existing display name creates **v2**, not a duplicate. Categories:
  Drawing · Test Report · Certification · Costing · Supplier Doc · Photo · Other. Stored in MinIO
  (§3), not on the local filesystem.
- **Activity & Comments panel** — one reverse-chronological feed mixing two kinds of entry:
  - *Comments* — free text, Markdown, `@mentions` that trigger notifications. Editable by the author
    for 15 minutes, then locked. Soft-deleted, never hard-deleted. (No `dangerouslySetInnerHTML` —
    Markdown is rendered through a sanitising pipeline.)
  - *System events* — auto-generated, not editable, sourced from the append-only audit log:
    "Priority changed P3 → P1 by A. Roy", "PDD-F marked Done", "Schedule recalculated — finish moved
    week 44 → week 49", "certification_report_v2.pdf uploaded".

  Mixing them is deliberate: the question users ask is "why did this slip?", and the answer is
  usually a comment sitting next to the system event that caused it.

**Progress edits vs. reschedules are decoupled (§4).** Editing a percentage must never silently move
fifty other projects. A progress edit is cheap and frequent; it marks the schedule stale ("Progress
updated. Schedule is now stale.") and the user presses Recalculate, which runs the solver as a
background job and writes a **new immutable schedule version** — so "what did the plan look like
before I updated this?" is always answerable.

**GDPR note.** Named per-engineer assignment on the Progress panel is display-only in v1 and is
subject to the same `docs/OPEN_QUESTIONS.md` #8 hold as the Capacity and Gantt surfaces. `@mention`
notifications and comment authorship attach personal data to project records — the DPO position on
this is in scope for the same open question.

### Plus, cross-cutting on all seven surfaces

- **Versions & History** — every schedule run and every priority application is versioned;
  historical versions are browsable and comparable.
- **Downloads** — CSV/XLSX export of every surface's current view.
- **Notifications** — in-app notification of schedule changes affecting a user's hub or assigned
  projects (delay introduced, project left out, conflict raised).

## 3. Full tech stack

Locked. Agents may not substitute alternatives without an ADR (`docs/ADR/`) recording the decision
and its rationale, per `docs/ADR/0001-record-architecture-decisions.md`.

### Backend

| Choice | Justification |
|---|---|
| Python 3.13 | Modern async support, current LTS-equivalent for the ecosystem. |
| FastAPI | Async-native, OpenAPI schema generation for contract testing against the TS frontend. |
| Pydantic v2 (strict mode) | Fast validation, strict mode catches type coercion bugs at the API boundary. |
| PostgreSQL 17 | Mature relational engine; row-level scoping and JSON columns cover the domain's needs. |
| SQLAlchemy 2.0 (async) + Alembic | Async ORM matching FastAPI's async model; Alembic for reviewable migrations. |
| Redis 7 | Cache, solver-result memoisation, rate limiting, SSE pub/sub — one dependency, four uses. |
| Celery (Redis broker) | Background jobs: solver dispatch, progress reporting, cancellation. |
| MinIO | S3-compatible, self-hosted object storage for exports, attachments, large snapshots — required since the app is on-premise with no cloud S3 access. |
| OR-Tools CP-SAT | Constraint solver for the RCPSP-shaped scheduling problem; industrial-strength, well-documented for interval/no-overlap/cumulative constraints. |
| Gunicorn + Uvicorn workers | Standard production ASGI serving pattern. |

### Frontend

| Choice | Justification |
|---|---|
| React 19 + TypeScript + Vite | Modern, fast dev loop, strong typing across a data-dense app. |
| TanStack Query (server state) + Zustand (UI/scenario state) | Clean separation: server cache vs. local scenario-editing state. |
| TanStack Table + TanStack Virtual | Matrix and large grids (236 projects × 14 steps) need virtualization for performance. |
| Tailwind CSS + shadcn/ui, sourced from 21st.dev where they fit | Utility-first styling with accessible component primitives; avoids hand-rolling common patterns. |
| Framer Motion | Transitions, layout animation, micro-interactions. |
| Lottie (`lottie-react`) — SCOPED: empty states, solver progress, success confirmations only | Motion budget kept small and purposeful; not a general animation library. |
| ECharts | Dense heatmaps and utilization matrices — handles large categorical/continuous grids well. |
| Recharts | Simple bar/donut panels — lighter weight than ECharts for simple charts. |
| Custom Gantt — hand-built virtualized SVG/Canvas | No commercial Gantt library (DHTMLX, Bryntum, Syncfusion). See Standing Decisions in `docs/MEMORY.md`. |
| three.js — NOT USED in v1 | Permitted only behind an explicit future feature flag for a 3D cooler-model viewer on Project Registration. Must never appear on Dashboard, Capacity, Matrix, Gantt, Planning or Project Workspace. |

### Infrastructure & security

| Choice | Justification |
|---|---|
| Docker Compose (nginx, api, worker, solver-worker, postgres, redis, minio) — not Kubernetes | On-premise single-site deployment; Kubernetes is unjustified operational overhead for this scale. |
| OIDC SSO against the client IdP (assume Microsoft Entra ID; Keycloak as fallback) | Client is a corporate enterprise with existing SSO; per `docs/OPEN_QUESTIONS.md` #9, IdP confirmation is pending. |
| RBAC + row-level hub scoping enforced in the data access layer | Hub Planners and Executive Viewers must not see or edit data outside their scope; enforced at the query layer, not just the UI. |
| Immutable append-only audit log | Compliance requirement for an enterprise planning tool; every mutation is traceable. |
| Nginx/Traefik reverse proxy, TLS 1.3, HSTS, ModSecurity + OWASP CRS | Standard hardened edge for an on-premise enterprise app. |
| Vault or Docker secrets. Never committed `.env` | No secrets in the repo, per Standing Decisions in `docs/MEMORY.md`. |

## 4. Architecture

**Request flow:** Browser → Nginx/Traefik (TLS termination, security headers) → FastAPI (`api`
service) for CRUD, auth, and read endpoints. Mutations that trigger re-scheduling enqueue a Celery
task on the Redis broker rather than blocking the request.

**Where the solver runs:** OR-Tools CP-SAT executes only inside a dedicated `solver-worker` Celery
worker process — **never inside the FastAPI request-handling process** (Standing Decision,
`docs/MEMORY.md`). The greedy SGS scheduler (P2-T01) may run synchronously for small/fast
recalculations if profiling shows it's cheap enough; CP-SAT runs are always async, dispatched via
Celery.

**How progress streams to the client:** Solver progress (queued → running → progress % → done/
failed) is published to Redis pub/sub by the worker and relayed to the browser over Server-Sent
Events (SSE) from a FastAPI endpoint subscribed to the same channel. No polling.

**How scenarios are snapshotted:** A "scenario" (in-progress edit to priorities, capacity, or
project data not yet committed) is held in frontend Zustand state and, on "Apply", POSTed as a
diff against the last committed version. The backend snapshots the pre-apply state to Postgres
(versioned row set) before writing the new state, so every Apply is reversible and every historical
version is queryable (Versions & History, §2).

## 5. Security model

See the Infrastructure & security table in §3 for the layer list. RBAC role/permission matrix:

| Role | Dashboard | Capacity | Matrix | Gantt | Project Workspace | Project Registration | Capacity Planning | Audit Log | User/Role Admin |
|---|---|---|---|---|---|---|---|---|---|
| Portfolio Manager | R | R | R/W | R | R/W | R/W | R | – | – |
| Hub Planner (scoped) | R (own hub) | R/W (own hub) | R (own hub) | R/W (own hub) | R/W (own hub) | R/W (own hub) | R/W (own hub) | – | – |
| Engineer | – | – | – | R (own assignments) | R (own assignments) | – | – | – | – |
| Executive Viewer | R (all hubs) | R (all hubs) | R (all hubs) | R (all hubs) | R (all hubs) | – | – | – | – |
| Auditor | – | – | – | – | – | – | – | R (all) | – |
| Admin | R/W | R/W | R/W | R/W | R/W | R/W | R/W | R | R/W |

The **Project Workspace** column is derived provisionally from the adjacent surfaces (read follows
Dashboard/Matrix/Gantt; detail + progress writes follow Project Registration and Gantt) and is
flagged for client confirmation — see the `docs/MEMORY.md` entry for this addition. Open finer-grained
question: whether an Engineer may edit progress (status / percent / actuals) on their own assigned
stages, which the current matrix does not grant.

Row-level hub scoping is enforced in the data access layer (SQLAlchemy query filters applied
per-request from the authenticated user's hub claims), not just hidden in the UI — a Hub Planner's
API calls must be rejected or filtered server-side for out-of-scope hubs, independent of what the
frontend renders.

## 6. Deployment topology

Docker Compose service graph:

```
nginx (reverse proxy, TLS termination)
  └── api (FastAPI, Gunicorn+Uvicorn workers)
  └── frontend (built static assets, served by nginx or a small static service)

worker (Celery — general background jobs: exports, notifications)
solver-worker (Celery — CP-SAT and greedy scheduler runs, isolated for resource limits)

postgres (PostgreSQL 17, primary datastore)
redis (cache, Celery broker, SSE pub/sub)
minio (S3-compatible object storage — exports, attachments, snapshots)
```

**Volumes:** `postgres-data`, `redis-data` (if persistence enabled for pub/sub durability),
`minio-data`. All named volumes, not bind mounts, for portability across the client's on-premise
hosts.

**Backup strategy:** Nightly `pg_dump` to MinIO (separate bucket, lifecycle-policy retained),
plus MinIO's own data replicated per the client's existing on-premise backup process. Backup
verification (restore drill) is a P6/P7 task, not scoped in detail here.

## 7. Non-goals for v1

- **Multi-tenant** — single client, single deployment, on-premise. No tenant isolation model needed.
- **Mobile app** — web-responsive only; no native iOS/Android app.
- **3D visualisation** — three.js gated behind a future feature flag for Project Registration only
  (§3); not part of v1's shipped surfaces.
- **Real-time collaborative editing** — scenario edits are single-user-at-a-time with an Apply/
  commit model (§4), not live multi-cursor collaboration.
- **ERP integration** — no live sync with Frigoglass's ERP system in v1; Excel import/export
  contract is itself an open question (`docs/OPEN_QUESTIONS.md` #7).
