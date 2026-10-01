# ADR 0012: Project-level access grants (Viewer / Editor / Admin) and manager delegation

## Status

Accepted (2026-09-30). Extends ADR 0010 and `docs/PROJECT_AND_STACK.md` §5. Opens P10.

## Context

ADR 0010 gave every principal a single global role (Portfolio Manager, Hub Planner, Engineer,
Executive Viewer, Auditor, Admin, Super Admin) with a fixed surface-level matrix and, for Hub
Planner, row-level *hub* scoping. That is coarse-grained: it cannot express "give this one person
access to this one project, regardless of their hub or role" — which is exactly what the project
owner asked for on 2026-09-30: an engineer added to a project should get access to *that project
only*, a manager should be able to grant that access to their own reports without being Super
Admin, and Super Admin should be able to do all of this plus everything else.

This is additive to ADR 0010's matrix, not a replacement. The seven existing roles, the surface
matrix and hub scoping are unchanged and still the *first* source of a principal's access to a
project. This ADR adds a second, narrower source that can grant access a role/hub alone would not.

## Decision

### 1. Project roles (new, distinct from `RoleName`)

Three project-scoped roles, stored per `(project, user)`:

- **Viewer** — read the Project Workspace (Details, Progress, Files, Activity & Comments) and the
  project's Gantt/Matrix/Dashboard rows. No write of any kind.
- **Editor** — Viewer, plus write on *selected* fields only: stage progress (`PATCH
  /projects/{id}/stages/{step_code}`), file upload, and posting comments. Editor may NOT edit
  Project Registration's charter fields, may not freeze/unfreeze, may not change workflow
  precedence, and may not grant/revoke anyone else's access.
- **Admin** (project-scoped, not to be confused with the global `RoleName.ADMIN`) — full read/write
  on that project's Workspace and Registration, and may grant/revoke Viewer/Editor/Admin on that
  *same* project to/from their own direct reports (see delegation, below). Cannot touch Workflow
  Settings, other projects, or the User/Role Admin surface — those remain gated by the existing
  global-role matrix.

### 2. `ProjectAccessGrant` — new table

`(project_id, user_id, project_role, granted_by_user_id, created_at, revoked_at NULL)`. A grant
with `revoked_at IS NULL` is active. Grants are additive only: they can give a principal access
they would not otherwise have; a grant is never used to take away access a global role/hub scope
already provides. Revoking a grant returns a principal to whatever their global role/hub scope
alone would give them — never below it.

### 3. Effective project access — the single resolver

One function, used by every endpoint that needs project-grain authorization (Project Workspace,
Registration record, Gantt row detail, the new Ask-the-agent endpoint), taking the MAX of every
applicable rule below (never the first match — a principal never loses access one rule would give
them because another rule alone would deny it):

1. `Super Admin` → Admin, unconditionally, on every project.
2. `Admin` (global) or `Portfolio Manager` → Admin, unconditionally (matches their existing
   unscoped R/W per the ADR 0010 matrix).
3. `Hub Planner`, project's hub in the caller's hub scope → Admin (matches their existing
   own-hub R/W).
4. `Executive Viewer` → Viewer, unconditionally (matches their existing all-hubs R).
5. An active `ProjectAccessGrant` for `(user, project)` → that grant's `project_role`.
6. `Engineer`, linked to an `Engineer` row assigned to at least one `ProjectWorkflowStep` on the
   project → Viewer ("own assignments", unchanged from ADR 0010/the existing matrix — this is not
   a grant and is not revocable via `ProjectAccessGrant`).
7. Otherwise → none.

This function is the *only* place project-grain access is decided. It composes with, and never
duplicates, `core/rbac.py`'s existing `role_allows` (surface-level) and P3-T03's hub-scope
filtering (list-grain) — those still gate which surfaces exist and which *rows* appear in a list at
all; this resolver additionally gates the *detail* of one specific project once a row is already
visible, and is the sole basis for granting access to a project a principal's role/hub would not
otherwise surface.

### 4. Manager delegation

`User.manager_id` (new, nullable self-FK, no cycles enforced at the DB CHECK + API level — a
manager cannot be their own descendant). A principal `M` may create or revoke a
`ProjectAccessGrant(project=P, user=U, role=R)` if and only if:

- `U.manager_id == M.id` (U is M's *direct* report — no transitive delegation in v1), and
- `M`'s own effective access on `P` (via the resolver above) is Admin, and
- `R` is Viewer, Editor, or Admin (M can grant any of the three — M's own Admin-level access on
  `P` is the ceiling already implied by requiring M to have Admin there).

Super Admin bypasses both conditions and may grant/revoke any `(project, user, role)` triple. A
global `Admin` may also always grant/revoke (their unconditional project-Admin access from rule 2
above satisfies the second condition on every project), independent of `manager_id`.

`POST /users/{id}` (existing User/Role Admin endpoint, ADR 0010 §3) gains `manager_id` so Super
Admin can set reporting lines; a manager cannot set their own `manager_id` or anyone else's — that
stays Super-Admin/Admin-only, same as role assignment.

### 5. Frontend

One surface handles both: the existing `/admin/users` User/Role Admin page gains a **Project
Access** tab. Super Admin sees every grant across every project and can add/remove any triple. A
non-Super-Admin, non-global-Admin manager sees the same tab scoped server-side to only the projects
and reports the delegation rule above allows them to touch — the UI has no separate "manager mode";
the same request just returns a narrower list and the write endpoint enforces the same rule, so
there is exactly one code path to review, not two.

## Consequences

- `core/rbac.py`'s existing surface matrix and hub scoping are untouched. Nothing about ADR 0010
  changes; this only adds a finer grain on top.
- The Engineer "own assignments" rule (item 6) stays exactly as it already worked — it is not
  migrated onto `ProjectAccessGrant` rows, because it is derived (from `ProjectWorkflowStep`
  assignment), not granted, and should disappear automatically when an assignment is removed
  rather than needing an explicit revoke.
- Financial fields (TCOGS, gross margin, selling price, customer name) are unaffected by this ADR:
  whatever role/scope rule already withheld them from a principal still does, at the same schemas
  layer, regardless of project-grant level. A project Admin grant does not imply financial-field
  visibility.
- Every grant/revoke is audit-logged (actor, target user, project, role, action), per the existing
  append-only audit log.
- `security-auditor` must specifically test: a manager cannot grant a role to a non-report; a
  manager cannot grant on a project they don't have Admin-level effective access to; a manager
  cannot grant themselves a higher project role; revoking a grant never drops a principal below
  what their global role/hub scope alone provides.
