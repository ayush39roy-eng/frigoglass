# ADR 0058 — Two test logins (password = username) and Super-Admin-only destructive actions

- **Status:** Accepted (2026-11-18, orchestrator, owner request and answers).
- **Amends:** the dev-mode test login (2026-10-01, `frontend/src/lib/auth/test-logins.ts`, ADR 0010 §4)
  and the RBAC matrix in `backend/core/rbac.py` (ADR 0010).

## Context

The owner relayed the client's request on 2026-11-18. The app is in development, and the client
wants to change data themselves. There are to be only **two** logins:

- **Super Admin:** has every right.
- **Admin:** can edit everything but cannot delete a project, a category or "important things".

Owner answers:
- **Sign-in:** dev test login. Only these two accounts, each with **password = username**.
- **Destructive actions** that become Super Admin only, all four groups:
  - cancel a project;
  - remove categories or steps;
  - delete a lab chamber and deactivate an engineer;
  - deactivate users and revoke access, cancel schedule runs, delete other people's saved scenarios,
    reset the import format.
- **Target:** the hosted Render demo, which runs with `RPD_DEV_MODE=true`.

## Decision

**L1 — Exactly two test logins (dev mode only).**

| Username | Email | Role | Hubs | Password |
|---|---|---|---|---|
| `superadmin` | `superadmin@example.com` | Super Admin | all | `superadmin` |
| `admin` | `admin@example.com` | Admin | all | `admin` |

- **Provisioning.** The accounts are created idempotently at API startup **only when
  `is_dev_mode()`**. A missing user, a missing role or an inactive account is repaired. Nothing
  else is changed, and nothing runs outside dev mode. A hosted redeploy therefore provisions them.
- **`GET /me/dev-users`** lists only these two accounts. The other seeded users stay in the database
  because they own data (engineers, hub planners, history). They can no longer sign in from the
  login screen.
- **`POST /me/dev-login`** `{username, password}`:
  - dev mode only; outside dev mode it is a 404;
  - the server compares with constant time and accepts the username or the email;
  - success returns the `DevUser`; any failure returns one generic 401;
  - it is rate-limited per IP.

  The browser no longer checks the password, and the shared `rpd-test-2026` password is retired.
- **Not security.** In dev mode the API can still act as any seeded user through the
  `X-Dev-User-Email` header (ADR 0010 §4). Other tooling and agents rely on that, and it is
  unchanged. Before go-live, OIDC SSO replaces all of this (OQ #9). OQ #113 records the risk of a
  public dev-mode demo.

**D1 — Super Admin only (403 `SUPER_ADMIN_ONLY` for every other role, Admin included).**

1. **Set a project's status to Cancelled,** through every API write path: project PATCH, register
   inline status and batch, bulk edit, Matrix inline edit, the registration form, and any other path
   found. Leaving Cancelled is an edit and is not restricted. Seed and maintenance scripts are not
   restricted.
2. **Remove or retire a category or a workflow step** (Workflow templates or Workflow Settings), and
   any future delete of a project or category. Adding a category and editing lengths stay Admin
   rights. A per-project step exclusion (ADR 0049) is a reversible edit and is not restricted.
3. **Delete a lab chamber. Deactivate an engineer.** Reactivating an engineer stays an Admin right.
4. **The remaining group:**
   - deactivate a user (`is_active → false`) or remove a role from a user;
   - revoke a project access grant through Admin rights (the ADR 0012 manager delegation is
     unchanged);
   - cancel a schedule run;
   - delete a saved import scenario saved by someone else (deleting one's own stays allowed);
   - `POST /whatif/import/format/reset`.

Every other Admin right is unchanged, so Admin keeps write access everywhere it has it today.
Workflow Settings write was already Super Admin only. The frontend hides or disables each of these
controls for anyone who is not Super Admin, with the hint "Super Admin only". The server is the
authority.

## Consequences

- One helper (`require_super_admin` / `is_super_admin(principal)`) is used at each guarded point,
  and each gets a 403 probe test as Admin plus a positive test as Super Admin.
- Hub Planner and Portfolio Manager also lose the right to cancel a project and to delete a chamber
  where they had it. The rule is "only Super Admin destroys".
- The login screen shows two accounts. Docs and the README's test-login note are updated.
