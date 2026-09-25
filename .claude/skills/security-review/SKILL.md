---
name: security-review
description: OWASP ASVS L2 checklist mapped onto the RPD Web Application stack — RBAC/hub-scoping test matrix, secret scanning, dependency/container scanning, security headers, CSP for a Vite SPA, audit-log immutability, encrypted-column verification, GDPR checklist. Load before every security-auditor gate review.
---

# Security review checklist — mapped to this stack

## OWASP ASVS L2, mapped

Frigoglass's requirement is L2 (standard for applications handling business-sensitive data —
financial project figures, personnel scheduling data — without being a high-value target like
payments infrastructure). Focus areas, in priority order for this app:

1. **V4 Access Control** — RBAC + hub-scoping is this app's single most important control, since a
   Hub Planner seeing another hub's financials or an Engineer seeing audit logs is a direct
   confidentiality failure, not a theoretical risk.
2. **V5 Validation** — Pydantic v2 strict mode at every boundary; never trust a client-supplied hub
   ID, project ID, or role claim without re-deriving it server-side from the authenticated session.
3. **V8 Data Protection** — encrypted financial columns, no PII in logs, GDPR handling of
   per-engineer data.
4. **V9 Communications** — TLS 1.3, HSTS.
5. **V7 Error Handling & Logging** — audit log immutability, structured logs with no secrets/PII.

## RBAC / hub-scoping test matrix

Test every (role × surface × hub) combination that should be **denied**, not just the ones that
should succeed — a test suite that only proves "Hub Planner can see their own hub" proves nothing
about whether they can see others'. Minimum matrix:

| Actor | Attempted access | Expected |
|---|---|---|
| Hub Planner (Hub A) | GET project in Hub B | 403 or filtered out, never 200 with data |
| Hub Planner (Hub A) | PATCH project in Hub B via crafted request body with Hub B's project ID | 403 |
| Engineer | GET audit log | 403 |
| Engineer | GET another engineer's utilization detail | 403 or scoped to self only, per GDPR resolution |
| Executive Viewer | PATCH anything | 403 |
| Auditor | PATCH anything | 403 |
| Any authenticated role | Access with an expired/tampered token | 401 |
| Unauthenticated | Any API endpoint except health check | 401 |

The critical test class is **parameter tampering**: a Hub Planner's own valid session token, but a
request body or query param naming a resource outside their hub. This is the realistic attack
surface for an internal RBAC failure, more so than token forgery.

## Secret scanning

- Pre-commit hook (per `.claude/settings.json`) blocking commits containing common secret patterns
  (API keys, private keys, connection strings with embedded credentials).
- `git log -p | grep`-style history scan (or `trufflehog`/`gitleaks` if available) before any
  external handover, in case a secret was committed and later removed but remains in history.
- `.env` files never committed — verify `.gitignore` covers them from the first commit, not added
  retroactively.

## Dependency and container scanning

- `pip-audit` on every backend dependency change.
- `npm audit` on every frontend dependency change.
- Trivy scan on every built container image (api, worker, solver-worker, frontend) before it's
  considered deployable — scan the actual built image, not just the base image tag, since
  application dependencies introduce their own CVEs.

## Security headers and CSP for a Vite SPA

Minimum header set at the reverse proxy:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline';
  img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'
Strict-Transport-Security: max-age=31536000; includeSubDomains
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: strict-origin-when-cross-origin
```

`style-src 'unsafe-inline'` is a pragmatic allowance for Tailwind's generated styles and
shadcn/ui's inline style usage in some primitives — tighten to a nonce-based policy if a stricter
CSP becomes a requirement; note that decision as an ADR if changed. `connect-src 'self'` must
include the SSE endpoint's origin (same-origin here, since this is on-premise single-deployment —
no cross-origin API calls expected).

## CSRF on mutations

Since this is a same-origin SPA behind SSO (not a public multi-origin API), CSRF risk is lower but
not zero — the browser still sends cookies automatically. Use a double-submit CSRF token or
`SameSite=Strict` session cookies (preferred, simpler) plus origin header verification on all
state-changing (`POST`/`PATCH`/`DELETE`) endpoints.

## Encrypted-column verification

Don't just check the model declares an encrypted type — verify by inspecting raw bytes in Postgres
directly (`SELECT tcogs FROM projects LIMIT 1` at the SQL level, bypassing the ORM's decryption) and
confirming the stored value is ciphertext, not plaintext. This is the actual test; a passing
application-level read test doesn't prove the disk-at-rest data is protected.

## Audit log immutability test

Attempt an `UPDATE` or `DELETE` against the audit log table directly (as the application's own DB
role, not just via the API) and confirm it's rejected — immutability should be enforced at the
database layer (e.g., a trigger, or a role with `INSERT`-only grant on that table), not merely by
"no endpoint exposes it," since an application-layer-only guarantee is trivially bypassed by a bug
elsewhere in the codebase.

## GDPR checklist for per-engineer utilization data

Per `docs/OPEN_QUESTIONS.md` #8 — blocking for any feature (P4-T08) exposing named-engineer
utilization:

- Confirm lawful basis is documented (legitimate interest for resource planning is the likely basis,
  but this is the DPO's call, not an engineering assumption).
- Confirm data minimization — does the utilization view need to show the engineer's name, or would
  an anonymized/aggregated view satisfy the same planning need for roles other than the engineer's
  own manager?
- Confirm retention — utilization history should have a defined retention period, not accumulate
  indefinitely (ties to the Versions & History feature's storage design).
- Confirm the audit log itself doesn't leak more personal data than necessary (e.g., logging "user
  X viewed engineer Y's utilization" is itself personal data about both X and Y).
- Do not ship any UI or API response exposing named-engineer-level utilization until the DPO has
  signed off — this gates P4-T08 specifically, not the rest of P4.
