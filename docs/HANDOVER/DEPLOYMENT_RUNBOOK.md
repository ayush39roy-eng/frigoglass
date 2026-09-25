# Deployment Runbook — RPD Web Application (Frigoglass)

**Audience:** Frigoglass on-premise ops team (infrastructure/IT staff operating the corporate
network the stack is deployed behind).

**Scope of this document:** stand up, operate, redeploy, and troubleshoot the production Docker
Compose stack. This is one half of P7-T03 (`docs/IMPLEMENTATION_PLAN.md`); the admin guide (how to
use the six application surfaces as a Hub Planner/Portfolio Manager/Admin/Auditor) is a separate
document owned by `frontend-builder`, not covered here. Backup and restore procedures are split out
into `docs/HANDOVER/BACKUP_RESTORE.md`.

**This document contains no secrets, credentials, or example real values.** Every secret is
referenced by file name only (`secrets/<name>.txt`, `.env`) — see `secrets/README.md` for what each
one is and how to generate it.

---

## 1. What this is, at a glance

This is an on-premise, single-tenant deployment (not SaaS, not Kubernetes) run entirely via Docker
Compose on Frigoglass's own servers, behind their corporate network. It is **not** internet-facing
in the way a SaaS product would be — there is no public-CA/ACME certificate flow assumed; TLS
certificates come from Frigoglass IT.

Two Compose files exist in the repo root:

- **`docker-compose.yml`** — the production stack. This is the one this runbook describes.
- **`docker-compose.auth.dev.yml`** — a narrow, dev-only Keycloak identity provider used for local
  OIDC testing during development. It is **not** part of the production topology and must not be
  run alongside `docker-compose.yml` expecting the two to interconnect in production. See §5 for
  the current, honest state of SSO/OIDC in this deployment.

## 2. Service topology

```
                                   Internet / corporate network
                                              |
                                     [ nginx ]  (ONLY container that publishes host ports: 80, 443)
                                    /    |     \
                          80->443       |       (redirects, HSTS)
                                        |
                    +-------------------+-------------------+
                    |                                        |
             [ waf-api ]                              [ waf-frontend ]
        (ModSecurity + OWASP CRS)                 (ModSecurity + OWASP CRS)
                    |                                        |
                [ api ]                                 [ frontend ]
       (FastAPI, Gunicorn + Uvicorn                (built static SPA, served
        workers, port 8000 internal)                by its own nginx, internal)

  /healthz bypasses the WAF hop and is routed from the edge `nginx` straight
  to `api` (see deploy/nginx/default.conf) — this is intentional, not a gap.

        [ worker ]            [ solver-worker ]           [ beat ]
   (Celery: exports,      (Celery: CP-SAT + greedy      (Celery beat —
    notifications,          scheduler runs only —         schedules the
    nightly backup job       isolated container,           nightly backup
    — see §7)                own resource limits:          task onto
                              mem_limit 4g,                `worker`'s queue;
                              mem_reservation 1g,           executes nothing
                              cpus 2.0)                     itself)

        [ postgres ]              [ redis ]              [ minio ]
     (Postgres 17,           (Redis 7 — Celery       (S3-compatible object
      primary datastore)      broker/result backend    storage: exports +
                               + solver-progress SSE     nightly backups,
                               pub/sub, AOF persistence   separate buckets)
                               enabled)
```

**Non-negotiable this topology enforces structurally:** CP-SAT never runs inside the FastAPI
process. `api` only ever runs Gunicorn/Uvicorn (see `backend/Dockerfile`'s `CMD`); CP-SAT is invoked
exclusively from `workers/schedule_tasks.py`, which only `solver-worker`'s Celery command actually
executes, in its own container with its own resource ceiling. Do not change this when redeploying —
never add a CP-SAT-invoking code path to the `api` container's command.

`api`, `worker`, and `solver-worker` all build from the **same** `backend/Dockerfile` image — one
build produces all three; what each container does is determined entirely by the `command:` it is
given in `docker-compose.yml`. This guarantees the three processes can never silently drift onto
different code versions of the same release.

Only `nginx` (the edge) publishes ports to the host (80 redirect-only, 443 TLS). Every other
service — including `waf-api`/`waf-frontend`, `postgres`, `redis`, `minio` — is reachable only from
inside the `rpd-internal` Docker bridge network. MinIO in particular is never exposed to the host;
the browser never talks to it directly, only the `api` service does (proxied/signed access).

## 3. Prerequisites

- A host (or hosts) inside Frigoglass's corporate network with Docker Engine and the Docker Compose
  plugin installed.
- A real TLS certificate + private key (PEM format) for the deployment's internal hostname, issued
  by Frigoglass IT. There is no automated certificate issuance in this stack (no ACME/Let's
  Encrypt flow) — this is an on-premise deployment behind the corporate network, not a public
  internet service.
- Network access from the deploying host to wherever Frigoglass's real identity provider will
  eventually live (see §5 — this is not yet wired up for production).
- Enough local disk for three named Docker volumes: `postgres-data`, `redis-data`, `minio-data`,
  plus `celerybeat-data` (small — a scheduler bookkeeping file only). Size these against
  Frigoglass's actual data volume (~236 active projects today, growing) and MinIO's retained
  export + backup objects (see `docs/HANDOVER/BACKUP_RESTORE.md` for the backup-specific sizing
  note).

## 4. First-time deployment

Run all commands from the repository root, on the deploying host.

1. **Copy and fill in the environment template.**
   ```
   cp .env.example .env
   ```
   Fill in every value `.env.example`'s own comments call out as required — most are non-secret
   config (hostnames Compose resolves internally are already correct; do not change service names).
   Two categories need real values before `docker compose up` will succeed:
   - `RPD_OIDC_ISSUER` / `RPD_OIDC_AUDIENCE` — these are hard-required (Compose fails loudly via
     `${VAR:?...}` interpolation if unset). See §5 for what to point them at **today**.
   - `RPD_TLS_CERT_PATH` / `RPD_TLS_KEY_PATH` — host filesystem paths to the real PEM cert/key
     Frigoglass IT supplies. **Do not deploy to production with the `.env.example` defaults**,
     which point at a throwaway self-signed dev pair generated by `deploy/tls/generate-dev-cert.sh`
     for local `make dev` use only.

   Never commit a real `.env` file. It is git-ignored by design (see the root `.gitignore`).

2. **Populate secrets.** Do **not** put secret material in `.env`. Follow `secrets/README.md`
   exactly: it lists the four files this stack requires (`secrets/postgres_password.txt`,
   `secrets/field_encryption_key.txt`, `secrets/minio_access_key.txt`,
   `secrets/minio_secret_key.txt`) and the recommended command to generate each one. **Generate
   fresh, real values for this deployment — never reuse the throwaway values
   `deploy/secrets/generate-dev-secrets.sh` creates for local development.**

   The field-encryption key (`secrets/field_encryption_key.txt`) is the single most operationally
   critical secret in this deployment: it is what decrypts TCOGS, gross margin, selling price, and
   customer name on every project row. **Read `docs/HANDOVER/BACKUP_RESTORE.md` §2 before going
   live** — losing this file after real data has been written makes that data permanently
   unrecoverable, independent of any Postgres backup.

   Recommended: `chmod 600 secrets/*.txt` on the deploying host so only the user running Docker can
   read them.

3. **Build and start the stack.**
   ```
   docker compose build
   docker compose up -d
   ```
   `docker compose` will refuse to start (loudly, with a clear error naming the missing variable)
   if a required `.env` value or a required volume-mount path (TLS cert/key) is missing — this is
   intentional; there is no silent-default path for these.

   Database schema migrations run automatically: the backend image's entrypoint runs
   `alembic upgrade head` before starting `api`/`worker`/`solver-worker`'s actual command. This is
   idempotent — a `worker`/`solver-worker` container starting before `api` (e.g. during a partial
   restart) will also attempt it and no-op harmlessly if the schema is already current.

4. **Verify.**
   ```
   docker compose ps
   ```
   Confirm `postgres`, `redis`, `minio`, `api`, `nginx` all show a `healthy` status (see §9 for two
   known, non-functional healthcheck quirks before treating anything as an incident).
   ```
   curl -k https://<deployment-hostname>/healthz
   ```
   should return a healthy response. `/healthz` is deliberately routed straight to `api`, bypassing
   the WAF hop (see `deploy/nginx/default.conf`'s own comment on why) — this is intentional, not a
   gap in WAF coverage for real traffic.

5. **First-login / provisioning.** See §5 for the current state of authentication — until
   production SSO cutover happens, this deployment authenticates against whatever OIDC issuer
   `RPD_OIDC_ISSUER`/`RPD_OIDC_AUDIENCE` point at (dev/staging Keycloak today). User
   provisioning/role assignment for the real client rollout is out of scope for this document; see
   the admin guide (frontend-builder's half of P7-T03) for RBAC role/hub-scope management once a
   user exists.

## 5. Authentication / SSO — current state (read before UAT or go-live)

**Honest status as of this writing: production SSO cutover to Frigoglass's real identity provider
has not happened and cannot yet happen.**

- `docs/PROJECT_AND_STACK.md` specifies Microsoft Entra ID as the primary IdP with Keycloak as a
  fallback. `docs/OPEN_QUESTIONS.md` #9 ("Which IdP, and can we get an app registration?") remains
  **open and unanswered by the client** — Frigoglass IT/security has not confirmed which identity
  provider to target or supplied app-registration/client credentials.
- The corresponding implementation task, **P7's predecessor P6-T03 (OIDC cutover to the real
  production IdP), is BLOCKED, not done**, per `docs/MEMORY.md`'s P6 phase-gate entry. This is not
  a defect in the code — `backend/core/oidc.py`'s OIDC verification mechanism itself was
  independently re-verified by `security-auditor` in the P6 phase gate (algorithm allow-list is
  server-config-driven and immune to header-`alg` forgery, no default issuer/audience, JWKS
  fetch/cache/kid-selection sound, full negative-auth test matrix passes against a real network JWKS
  fetch) — it is simply not yet pointed at a real, client-confirmed production IdP.
- **What is actually running today:** `RPD_OIDC_ISSUER`/`RPD_OIDC_AUDIENCE`/`RPD_OIDC_CLIENT_ID`
  point at a dev/staging Keycloak instance (`docker-compose.auth.dev.yml`, run separately from the
  production stack for local/dev OIDC testing) or at whatever non-production issuer the deploying
  team has stood up for pre-go-live testing. **Do not represent this to Frigoglass end users as
  their real corporate login.**

**TODO before real go-live (tracked, not this document's to resolve):**
1. Frigoglass IT/security answers `docs/OPEN_QUESTIONS.md` #9 (Entra ID vs. Keycloak, and supplies
   an app registration / client credentials).
2. `backend-builder` completes P6-T03: sets `RPD_OIDC_ISSUER`/`RPD_OIDC_AUDIENCE`/
   `RPD_OIDC_CLIENT_ID` to the real values, and — if a confidential OIDC client is required — adds
   `secrets/oidc_client_secret.txt` following the pattern already prepared (but commented out) in
   `docker-compose.yml`'s backend service definition and documented in `secrets/README.md`'s
   "Future slot: OIDC client secret" section.
3. Re-run a focused security check against the real IdP before UAT/go-live proceeds on it —
   per the P6 gate's own recorded judgment, real client UAT (P7-T01) and the final go-live gate
   (P7-T04) likely should not proceed against a dev IdP unless Frigoglass explicitly confirms that
   is acceptable for their sign-off purposes.

No plaintext client secret, issuer URL, or credential is recorded in this document — set the real
values directly in `.env` (config, non-secret per `secrets/README.md`'s config-vs-secret table) and
`secrets/oidc_client_secret.txt` (secret) on the deploying host only.

## 6. Secrets handling

This deployment uses **Docker Compose native secrets**, not Vault. This was a deliberate choice
(see `secrets/README.md`'s "Why Docker Compose secrets and not Vault" section): a single-client,
on-premise Compose deployment with no dynamic secret leasing or multi-team sharing requirement gets
no real benefit from Vault's unseal/init/policy-management/HA overhead. Compose secrets already
achieve what matters here — secret material never appears in `docker inspect`'s `Config.Env`, a
`/proc/<pid>/environ` dump, shell history, or `docker compose config` output, and is mounted
read-only at `/run/secrets/<name>` only inside the containers that declare it.

- The four required secret files and how to generate them: `secrets/README.md`.
- The config-vs-secret line this app draws (hostnames/ports/feature flags are config; anything that
  grants access to data or lets someone decrypt/impersonate something is a secret): same document.
- `backend/docker-entrypoint.sh` resolves each `<NAME>_FILE` variable into the plain in-process
  value before Python starts. Every secret consumer fails loudly on first use if unset — there is
  no insecure default anywhere in this chain (verified live by `security-auditor` in the P6 phase
  gate).
- **Never** set `POSTGRES_PASSWORD`, `RPD_FIELD_ENCRYPTION_KEY`, `RPD_MINIO_ACCESS_KEY`, or
  `RPD_MINIO_SECRET_KEY` directly as plain environment variables in a real deployment — only their
  `_FILE` counterparts, per the existing `docker-compose.yml` wiring. Do not "simplify" this for
  convenience; it is the entire point of the P6-T04 hardening work.
- This document does not, and will never, contain a real secret value. If you find one committed
  anywhere in this repository, treat it as a security incident, not a documentation bug.

## 7. TLS / HSTS / WAF (ModSecurity)

- TLS termination happens only at the edge `nginx` container, configured for TLS 1.2 and TLS 1.3.
  HSTS, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, and a
  baseline Content-Security-Policy are all set there (`deploy/nginx/default.conf`).
- HTTP (port 80) is redirect-only as of this stack's current configuration — it never serves
  content, only 301s to HTTPS.
- Two dedicated ModSecurity + OWASP CRS containers (`waf-api`, `waf-frontend`) sit between the edge
  `nginx` and `api`/`frontend` respectively — one WAF instance per upstream, at CRS's own
  recommended production starting point (`BLOCKING_PARANOIA=1`, the lowest false-positive paranoia
  level). This app has legitimate free-text fields (scenario notes, priority-score justification
  text) that are exactly the kind of input higher paranoia levels tend to false-positive on —
  raising it is an ops decision to be made only after observing real production traffic/audit-log
  data, not a default to change casually.
- Neither WAF container is published to the host; both are reachable only from the edge `nginx`
  over the internal Docker network.
- **Known operational gap — read before any redeploy that touches `api` or `frontend` (see §8).**

## 8. Redeploying and restarting safely

**Routine redeploy of an application-code change (`api`/`worker`/`solver-worker`, all built from
the same backend image):**

```
docker compose build api worker solver-worker
docker compose up -d api worker solver-worker
```

**Then, immediately, as a mandatory extra step — see the known gap below:**

```
docker compose restart waf-api
```

**Routine redeploy of a frontend change:**

```
docker compose build frontend
docker compose up -d frontend
docker compose restart waf-frontend
```

### Known gap this workaround exists for: WAF-to-upstream DNS/IP staleness

This is a **documented, known, not-yet-fixed operational gap**, identified live by
`security-auditor` during the P6 phase gate (`docs/MEMORY.md`, P6-T07 entry, finding #2), not a
new discovery of this runbook.

**What happens:** the `owasp/modsecurity-crs` image's embedded nginx resolves its single `BACKEND`
upstream (`api:8000` for `waf-api`, `frontend`'s internal port for `waf-frontend`) once, at its own
worker-process startup, and does not use an nginx `resolver` directive for live re-resolution. When
`api` (or `frontend`) is recreated during a routine single-service redeploy — a normal, common
operation, not an edge case — Docker Compose's embedded DNS reassigns that service a new internal
IP. `waf-api`/`waf-frontend` keep the old, now-stale IP cached and will return `502 Bad Gateway`
(confirmed error text: `connect() failed (111: Connection refused)` against the old IP) for every
request until restarted.

**Impact if missed:** any redeploy of `api` alone silently 502s the **entire API surface** until an
operator notices and manually restarts `waf-api` (same mechanism/impact for `frontend` and
`waf-frontend`). This is an availability gap, not a confidentiality/integrity issue — no
access-control, encryption, or audit-log guarantee is affected by it.

**Mitigation for this runbook (the current, real fix): always restart the corresponding WAF
container immediately after redeploying its upstream**, as shown above. This is the operational
workaround until a code-level fix lands (a `resolver 127.0.0.11 valid=10s;` + variable-based
`proxy_pass` change to the WAF image's `BACKEND` config, tracked as a non-blocking follow-up, not
yet implemented as of this document).

**If you forget this step:** a `502` on all API traffic after a backend redeploy is very likely
this issue, not a new incident. Run `docker compose restart waf-api` (or `waf-frontend`) first
before escalating.

### General restart guidance

- `docker compose restart <service>` is safe for any single stateless service (`api`, `worker`,
  `solver-worker`, `frontend`, `waf-api`, `waf-frontend`, `nginx`, `beat`).
- Restarting `worker`/`solver-worker` mid-task will let Celery's own retry/visibility-timeout
  behavior recover in-flight tasks from Redis; this is expected, not data loss.
- Restarting `postgres`, `redis`, or `minio` is a stateful-service restart — the named volumes
  (`postgres-data`, `redis-data`, `minio-data`) persist across it, but treat it as a
  higher-caution operation than restarting a stateless service, and prefer doing it outside a
  live CP-SAT solve window if one is known to be running (check `solver-worker`'s logs / an active
  schedule-run row before restarting `redis`, since Redis also backs Celery's broker and the
  solver-progress SSE pub/sub — an unplanned Redis restart mid-solve would drop that run's
  in-flight task).
- Full stack down/up (`docker compose down` / `docker compose up -d`) is safe for volumes (named
  volumes are not removed by a plain `down`), but do **not** add `-v` to `docker compose down`
  unless you genuinely intend to destroy `postgres-data`/`redis-data`/`minio-data` — there is no
  confirmation prompt.

## 9. Known issues — documented, not silently omitted

These are real, live-reproduced findings from the P6 phase-gate security audit
(`docs/MEMORY.md`, P6-T07). Both are tracked as non-blocking follow-ups and neither is fixed as of
this document. They are recorded here so ops staff recognize them and do not mistake them for new
incidents.

1. **WAF-to-`api`/`frontend` upstream DNS staleness on redeploy.** Covered in full in §8 above,
   including the required workaround (restart the corresponding WAF container after any
   `api`/`worker`/`solver-worker` or `frontend` redeploy). This is an availability issue only.

2. **`nginx` (edge) and `frontend` container Docker `HEALTHCHECK`s can report `unhealthy` even
   though the service is functioning correctly — a cosmetic monitoring defect, not a functional
   outage.** Root cause: both containers' `HEALTHCHECK` resolves `localhost` to `::1` (IPv6)
   inside the container, while their nginx configs only `listen` on the IPv4 form — so the
   healthcheck's own probe connection is refused even though real traffic (verified via `curl`
   against the actual published port, and via `wget` against the explicit IPv4 loopback address)
   succeeds throughout. **This does not indicate a real outage.** Before escalating on a
   `docker compose ps` / `docker inspect` "unhealthy" status for `nginx` or `frontend`
   specifically, first confirm real traffic actually succeeds (e.g.
   `curl -k https://<hostname>/healthz` and `curl -k https://<hostname>/`) — if it does, this is
   the known cosmetic healthcheck defect, not an incident. If your monitoring/alerting tooling
   pages on Docker health status directly, consider excluding these two specific containers from
   that alert rule until the underlying fix (adding an IPv6 `listen` directive, or changing the
   healthcheck to probe the IPv4 loopback address explicitly — `frontend/Dockerfile`'s
   `HEALTHCHECK` line and the edge `nginx` service's Compose-level healthcheck) lands. Not fixed as
   of this document.

Neither of these two issues affects RBAC/hub-scoping, financial-field encryption, or audit-log
immutability — both were explicitly assessed and confirmed unaffected during the same security
audit that found them.

## 10. Feature flags / not-yet-enabled capabilities

Two capabilities exist in the domain model or partial implementation but are **not enabled for
end users** pending client decisions. Do not represent either as available when training ops staff
or end users:

- **Per-engineer utilization detail views/exports** (`docs/OPEN_QUESTIONS.md` #8) — blocked pending
  Frigoglass's DPO/works-council determination on whether named-engineer load is GDPR personal
  data. The API withholds named-engineer utilization from every role except a self-scoped Engineer
  viewing their own data, and no named-utilization feature has shipped in the UI. This remains the
  case as of this document.
- **CP-SAT-optimized "Auto-assign"** (`docs/OPEN_QUESTIONS.md` #10) — blocked pending a client
  decision on whether the optimizer may drop a schedulable P1 project entirely to lift other
  projects within-year (a real, confirmed divergence from the greedy scheduler's behavior on the
  seed dataset, not a bug). CP-SAT dispatch continues to be exercised only via the existing
  Celery-task path described in `docs/MEMORY.md`'s P2 entries, never as a user-facing "Auto-assign"
  action, until this is resolved.

## 11. Monitoring, logs, and troubleshooting quick reference

- `docker compose logs -f <service>` (or `make dev-logs` for the whole stack, if using the
  Makefile's dev target — note the production stack does not require `make dev`'s TLS/secret
  auto-generation steps; those are dev-only conveniences).
- `api`/`worker`/`solver-worker`/`beat` all emit structured JSON logs (Gunicorn access/error logs
  and application logs alike) that deliberately exclude request bodies, query strings, and any
  financial/PII field value — see `docs/DOMAIN_RULES.md` and `CLAUDE.md`'s non-negotiable that
  financial fields (TCOGS, gross margin, selling price, customer name) are never logged. If you
  ever see one of these values in a log line, treat it as a defect, not expected behavior.
  Confirmed absent from real log output during the P6 phase-gate audit.
- A `502` from the edge on `/api/*` after a backend-only redeploy → see §8/§9 item 1 (WAF DNS
  staleness) before treating it as a new incident.
- An "unhealthy" `nginx`/`frontend` status where real traffic still succeeds (`curl`/`wget` against
  the real port or an explicit IPv4 loopback address succeeds) → see §9 item 2 (healthcheck IPv6
  mismatch), not a real outage.
- Database connectivity issues → check `postgres`'s own healthcheck (`pg_isready`) first; `api`/
  `worker`/`solver-worker` all `depends_on: postgres: condition: service_healthy`, so they will not
  start against an unhealthy Postgres.
- For anything involving the scheduler (CP-SAT / greedy) itself — behavior, invariants, correctness
  — this is `algorithm-engineer`'s domain (`backend/scheduling/`), not covered by this ops runbook;
  escalate scheduler-behavior questions through the standard project channel, not by editing
  `backend/scheduling/` directly.

---

**Related documents:** `docs/HANDOVER/BACKUP_RESTORE.md` (Postgres + MinIO backup/restore
procedure), `secrets/README.md` (secret generation), `.env.example` (full environment variable
reference with inline comments), `docs/OPEN_QUESTIONS.md` (client-blocking open items referenced
throughout this document), `docs/MEMORY.md` (P6-T07 / P6 phase gate entries — the source for every
"known issue" recorded in §9).
