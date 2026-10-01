# ADR 0010: A Super Admin role with every right; the frontend gates navigation and write controls on server-declared permissions

## Status

Accepted (2026-09-27). Extends `docs/PROJECT_AND_STACK.md` §5.

## Context

The backend has enforced the §5 role matrix per request since P3-T02/T03, but (a) there is no way to
administer users and roles except a seed script, (b) the frontend has no notion of who is signed in
— in dev mode every request silently runs as the seeded Admin and every write control is rendered
for everyone — and (c) the client asked for "role-based access, and the superadmin has all the
rights".

## Decision

1. **`RoleName.SUPER_ADMIN = "Super Admin"`** is added. It has READ + WRITE on every `Surface`,
   including the two new ones (`PROJECT_WORKSPACE`, `WORKFLOW_SETTINGS`), and is the only role that
   may grant or revoke `Admin`/`Super Admin` or edit Workflow Settings (lead times, precedence,
   calendars, chamber downtime). `Admin` keeps its existing row (R/W on the seven surfaces, R on
   Audit Log, R/W User/Role Admin for the non-admin roles) plus READ on Workflow Settings. At least
   one active Super Admin must always exist; the server refuses the change that would remove the
   last one.
2. **`GET /me`** returns the principal: user, roles, hub scope and the resolved
   `permissions[surface] = {read, write}` table. The frontend calls it once on boot, keeps it in a
   `session` store, hides nav items the caller cannot read, disables/hides write controls where
   `write` is false, and shows a "read-only" notice on surfaces it can see but not edit. The
   server remains the enforcement point — the UI gating is convenience, never security.
3. **User/Role Admin** endpoints (`/users`, `/roles`) and a surface: list/search users, set
   `is_active`, assign roles, set `hub_scope_all` / hub scopes, link to an `Engineer`. Users are
   provisioned by OIDC JIT-link (P3-T02) or created here with an email; there are no passwords.
4. **Dev-mode user switching.** Only when `RPD_DEV_MODE=true`, an `X-Dev-User-Email` header selects
   which seeded user an unauthenticated request runs as; the frontend exposes a role switcher in dev
   builds only. The header is ignored (and the switcher absent) outside dev mode —
   `security-auditor` verifies this on the P9 gate.

## Consequences

- `core/rbac.py` gains two surfaces and one role; `PROJECT_AND_STACK.md` §5 gains the Super Admin
  row and the Workflow Settings column; the Project Workspace column is enforced for the first time.
- `seed_dev_users.py` adds `sam.super@example.com` (Super Admin).
- Audit rows are written for every role/scope change and record actor + target.
- OQ#8 (GDPR) is untouched: the User/Role Admin surface shows names/emails of *users*, which is
  ordinary account administration, not the engineer-utilisation data OQ#8 covers.
