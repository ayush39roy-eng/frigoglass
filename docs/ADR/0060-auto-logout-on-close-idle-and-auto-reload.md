# ADR 0060 — Auto logout on browser close and on inactivity; auto reload on a new version

- **Status:** Accepted (2026-11-18, orchestrator, owner request).
- **Amends:** P31-R01 "Remember me" (the dev login kept in `localStorage`).
- **Constraint:** frontend only. No data change. Hosted data rule (MEMORY standing decision) applies.

## Context

The owner asked for three things:
- the user is signed out when the browser is closed;
- the user is signed out after a long time without activity;
- the app reloads itself so users are not left on an old version, which is why the client saw stale
  screens after today's deploys.

Today the dev login is kept in `localStorage` when "Remember me" is ticked (the default), so it
survives a browser restart, and an open tab runs its old bundle until someone reloads it.

## Decision

**L1 — Signed out when the browser closes.**
- The signed-in user is kept only in `sessionStorage`. Nothing that signs a user in is written to
  `localStorage` any more. The "Remember me" option is removed, and any existing `localStorage`
  login key is deleted on startup, so current remembered logins end at the next load.
- **Tabs:** a new tab opened while another tab of the app is signed in gets the session from that
  tab through a `BroadcastChannel` handshake (ask, then the first open tab answers within ~300 ms).
  When no other tab is open, the new tab shows the login page. Closing every tab or the browser
  therefore ends the session.
- Sign-out in one tab signs out every tab (broadcast).

**L2 — Signed out after 30 minutes of inactivity.**
- Activity means pointer, key, wheel, touch or scroll in any tab of the app. The last activity time is
  shared across tabs (a timestamp in `localStorage`, which is not a credential).
- At 28 minutes a dialog warns: "You will be signed out in 2:00 for inactivity", with a countdown and a
  "Stay signed in" button.
- At 30 minutes every tab signs out, using the existing sign-out path, and shows the login page with
  the notice "You were signed out after 30 minutes of inactivity." Unsaved edits are lost, the same
  as any sign-out; the warning gives the chance to save.
- The timeout is one constant (`IDLE_TIMEOUT_MS`), so it is easy to change.
- **Sign-in always does a full page load,** so whoever signs in gets the newest deployed version.

**R1 — Auto reload on a new version.**
- The build writes `version.json` (the build id) next to `index.html`, and the bundle knows its own
  build id. The app fetches `version.json` with `cache: 'no-store'` every 5 minutes and whenever the
  tab becomes visible.
- When the id differs, the app reloads if nothing is being edited (the edit-session store is empty
  and no dialog is open). Otherwise it shows a bar: "A new version is available — Reload", and reloads
  on its own as soon as the edits are saved or discarded.
- A lazy-chunk load failure after a deploy (a chunk that no longer exists) also triggers one reload,
  with a guard against a loop.

## Consequences

- Users sign in more often: after closing the browser, and after 30 minutes away.
- This is a convenience and shared-computer measure, not a security control. On the dev-mode demo, the
  API still trusts the `X-Dev-User-Email` header (OQ #113).
- Gate: qa (unit tests for each rule, using fake timers), security (no credential in `localStorage`,
  cross-tab messages carry only the user id/email and come from the same origin), workflow (a reload
  or logout never fires a save or a run).
