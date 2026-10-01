# ADR 0013: An explicit login page — no silent identity fallback

## Status

Accepted (2026-09-30). Extends ADR 0010 §4. Part of P10.

## Context

ADR 0010's dev-mode design lets an unauthenticated request run as a seeded fallback user
(`frank.admin@example.com`) the instant `RPD_DEV_MODE=true`, with a small header switcher tucked
into the app shell to change identity afterward. There has never been a page you land on *before*
being signed in — the app shell renders immediately, already "signed in" as Admin. That was
reasonable for a dev environment where every request needs an actor, but it is the wrong first
screen now that P10 introduces a real Super Admin/manager delegation model: the first thing a
person should see is a place to establish who they are, not an app that already assumed Admin on
their behalf.

## Decision

1. **New `/login` route**, rendered by the router *before* `SessionGate` attempts `GET /me`, not
   after it fails. Landing on the app with no session takes you here, full stop — there is no
   silent fallback identity anymore, in dev mode or otherwise.
2. **Production path (real OIDC configured):** one "Sign in with [organisation SSO]" button that
   redirects into the standard OIDC authorization-code flow (`RPD_OIDC_*`, unchanged from ADR 0010
   /P3-T02). This path is exercised against the dev Keycloak stack today and is IdP-agnostic per
   `core/config.py`'s existing docstring; it becomes real the day OQ #9 is answered.
3. **Dev-mode path (`RPD_DEV_MODE=true`, no real IdP session):** the page instead lists every
   seeded user (reusing the existing `GET /dev/users` endpoint and `setDevUserEmail`/
   `X-Dev-User-Email` mechanism verbatim — no new backend auth mechanism), grouped by role, so
   picking **Sam Super** (Super Admin) is the obvious first action for anyone starting fresh. This
   replaces the old behaviour of *already* being Frank Admin by default; the header switcher
   (`dev-role-switcher.tsx`) still exists for switching identity *after* landing on the app, this
   page is only the front door. Selecting a user here does exactly what the switcher already did:
   write `sessionStorage`, load `/me`, land on the app shell.
4. Both paths remain governed by the exact same server-side gate as before: `dev_mode: true` on
   `/me`'s payload is the only thing that can make the dev-user list exist at all (unchanged from
   ADR 0010 §4 — `security-auditor` already verifies this and continues to).
5. `SessionGate`'s `unauthorized` empty state (the "Sign in to continue" card with a "Try again"
   button) is replaced by a redirect to `/login` — "try again" was never going to succeed without
   an actual sign-in action, so that state was always a dead end in practice.

## Consequences

- No behavioural change to the OIDC verification itself (`core/oidc.py`), the dev-mode header
  mechanism, or `core/rbac.py`. This is a frontend-only change plus the removal of the "start
  already signed in" default in dev mode's *presentation*, not its underlying gate.
- A fresh dev/demo environment now requires one explicit click (pick a user) before anything
  renders, instead of zero. This is a deliberate small amount of friction in exchange for the app
  never silently deciding who you are.
- No new backend endpoint is required; `GET /dev/users` already exists and already only returns
  data when `RPD_DEV_MODE=true`.
