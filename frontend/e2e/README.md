# Playwright E2E harness (P4-T09)

Runs the six P4 surfaces (Dashboard, Capacity, Matrix, Timeline/Gantt, Registration, Planning)
against a REAL backend — FastAPI + Postgres 17 + Keycloak — not a mock. `playwright.config.ts`
only starts the frontend side (`pnpm run build:e2e && pnpm run preview:e2e`, port `5183`); the
backend/Postgres/Keycloak/Redis stack is **not** started by Playwright and must be stood up first,
by hand, as disposable infrastructure. This file is the missing operational how-to that
`playwright.config.ts` and `global-setup.ts` both already reference by name.

## 1. Stand up disposable infra

From the repo root:

```bash
# Postgres 17 (any free host port; example uses 55433)
docker run -d --name qa-e2e-pg -e POSTGRES_USER=rpd -e POSTGRES_PASSWORD=rpd \
  -e POSTGRES_DB=rpd -p 55433:5432 postgres:17

# Redis 7 — required even though this suite never exercises SSE/Celery directly:
# `backend/api/routers/schedule_runs.py` imports `workers/celery_app.py` at module load,
# which eagerly constructs `RedisSettings()` and fails startup with no `RPD_REDIS_URL` set.
docker run -d --name qa-e2e-redis -p 56380:6379 redis:7

# Keycloak (realm/client/six test users auto-imported from dev/keycloak/rpd-realm.json)
docker compose -f docker-compose.auth.dev.yml -p qa-e2e-auth up -d
```

The Keycloak container's own `HEALTHCHECK` (a raw `/dev/tcp` probe) is flaky in some sandboxed
Docker environments and can sit at `starting`/`unhealthy` indefinitely even once the realm has
imported successfully — don't gate on `docker inspect`'s health status; poll
`curl http://localhost:8080/realms/rpd/.well-known/openid-configuration` (expect `200`) instead.

## 2. Migrate + seed the backend

From `backend/`, with this repo's `.venv` active:

```bash
export RPD_DATABASE_URL="postgresql+asyncpg://rpd:rpd@localhost:55433/rpd"
export RPD_FIELD_ENCRYPTION_KEY="$(python -c 'from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())')"

python -m alembic upgrade head
python -m seed.seed_demo_data       # 46 projects, 644 steps, 14 engineers, 8 chambers
python -m seed.seed_currency_rates  # 3 currency rows (EUR/USD/INR)
python -m seed.seed_dev_users       # 6 local User/Role rows matching the Keycloak realm's 6 test users
```

## 3. Start the backend

```bash
export RPD_OIDC_ISSUER="http://localhost:8080/realms/rpd"
export RPD_OIDC_AUDIENCE="rpd-backend"
export RPD_OIDC_CLIENT_ID="rpd-backend"
export RPD_REDIS_URL="redis://localhost:56380/0"
# RPD_DATABASE_URL / RPD_FIELD_ENCRYPTION_KEY from step 2, same shell.

python -m uvicorn api.main:app --host 0.0.0.0 --port 8010
```

Confirm with `curl http://localhost:8010/healthz` (expect `200`).

## 4. Seed an active `ScheduleRun` (required — do this before running the suite)

Every surface except Matrix and Registration reads from the **active** `ScheduleRun` snapshot.
`global-setup.ts` only mints Keycloak tokens — it does **not** trigger a schedule run. Without
this step, Gantt renders zero rows (its Freeze button never appears — `gantt.spec.ts`'s own flow
test will fail with a "no Freeze button found" timeout) and Dashboard/Capacity render their
no-active-run empty states instead of real figures. Trigger one manually as Admin before every
suite run:

```bash
ADMIN_TOKEN=$(curl -s -X POST http://localhost:8080/realms/rpd/protocol/openid-connect/token \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -d 'grant_type=password&client_id=rpd-backend&username=frank.admin&password=TestPass123!' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['access_token'])")

curl -s -X POST -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:8010/schedule-runs/greedy-recalc
```

Expect `project_count: 46` on a freshly-seeded database. If this ever returns a 422 naming a
project with `priority: None`, see "Known non-idempotency" below before debugging further.

## 5. Run the suite

From `frontend/`:

```bash
RPD_E2E_BACKEND_URL="http://localhost:8010" RPD_E2E_KEYCLOAK_URL="http://localhost:8080" \
  npx playwright test
```

(`RPD_E2E_BACKEND_URL`/`RPD_E2E_KEYCLOAK_URL` default to `http://localhost:8010`/`:8080`
respectively — the exports above are only needed if you used different host ports in step 1/3.)

## Known non-idempotency — re-seed between runs

**This suite is not safe to re-run against the same database without re-seeding.**
`registration.spec.ts`'s flow test creates a real project via `POST /projects`, fills the 7
hard-gate fields required to leave Draft (leader, category, type, actual_start_week, tcogs,
selling_price, gross_margin) and submits it into `In Queue` — but **`priority` is not one of
those 7 fields**, and nothing in the create/submit path sets it. `backend/scheduling/greedy.py`'s
input validation (via `build_schedule_input_from_db`) requires every project whose status
participates in scheduling to have a `priority` in `{P1, P2, P3, P4, Q}`; a leftover
E2E-created project therefore makes **every subsequent** `POST /schedule-runs/greedy-recalc`
call 422 for the *entire portfolio*, not just that one project — including step 4's own
prerequisite command and `planning.spec.ts`'s Apply Logic test on the next run. This was found by
this task's own live run (see `docs/MEMORY.md`'s P4-T09 entry) — it is a real, independently
confirmed application-level data-hygiene gap (Registration's hard-gate contract vs. the
scheduler's own precondition), not a flaw in this harness's design, and is out of qa-inspector's
remit to fix (it touches Registration's hard-gate field list and/or the scheduler's validation
contract). Drop and recreate the database (`DROP DATABASE rpd; CREATE DATABASE rpd OWNER rpd;`)
and repeat steps 2–4 before every fresh suite run until that gap is resolved upstream.

## Teardown

```bash
docker rm -f qa-e2e-pg qa-e2e-redis
docker compose -f ../docker-compose.auth.dev.yml -p qa-e2e-auth down -v
```

Also stop the `uvicorn` process (foreground `Ctrl-C`, or `pkill -f "uvicorn api.main:app"` if
backgrounded).

## Auth technique

There is no browser-side OIDC redirect flow yet (P6-T03). `global-setup.ts` mints real,
validly-signed Keycloak tokens via the direct-access-grant (password) flow for the six dev users
once per run, writing them to gitignored `e2e/.tokens.json`; `fixtures.ts`'s `loginAs(page, role)`
installs a Playwright network route on `/api/**` that attaches `Authorization: Bearer <token>` to
every request. `backend/core/oidc.py` still performs real signature/issuer/audience verification
on every request — this is a test-only way of obtaining a legitimate credential, not an auth
bypass.

## Accessibility gate

`fixtures.ts::seriousAxeViolations(page)` runs a full-page `@axe-core/playwright` scan and returns
only `serious`/`critical`-impact violations (the `qa-testing` skill's documented gate — moderate
and below are logged but don't fail the build). Every spec file has a dedicated
`'has no serious/critical axe violations'` test. See `docs/MEMORY.md`'s P4-T09 entry for the
current violation inventory and severity.
