# Docker Compose secrets (P6-T04)

This directory holds the **real secret material** that `docker-compose.yml`'s
top-level `secrets:` block mounts into containers at `/run/secrets/<name>`.

**Nothing in this directory is ever committed** except this README and
`.gitkeep` (see the root `.gitignore`: `secrets/*` is ignored, with explicit
`!secrets/README.md` / `!secrets/.gitkeep` exceptions). Any real file you
create here (`postgres_password.txt`, etc.) stays on the deploying host only.

## Config vs. secret — the line this app draws

| Category | Examples | Where it lives |
|---|---|---|
| **Config** (fine as plain `environment:` / `.env`) | hostnames, ports (`HTTP_PORT`, `POSTGRES_DB`, `POSTGRES_USER`, `RPD_MINIO_ENDPOINT`), feature flags, OIDC issuer/audience/client ID (`RPD_OIDC_ISSUER`, `RPD_OIDC_AUDIENCE`, `RPD_OIDC_CLIENT_ID` — a public OAuth2 client id, not a secret, per `backend/core/oidc.py`'s own docstring), TLS cert/key **paths** (the files themselves are file-mounted, not passed as env values) | `.env` / `docker-compose.yml` `environment:` |
| **Secret** (must go through this directory) | Postgres password, the field-encryption Fernet key (`RPD_FIELD_ENCRYPTION_KEY` — protects TCOGS/gross margin/selling price/customer name per `docs/DOMAIN_RULES.md` + `CLAUDE.md`), MinIO access/secret key pair, and — once P6-T03 lands (currently BLOCKED, `docs/OPEN_QUESTIONS.md` #9) — an OIDC confidential-client secret | `secrets/*.txt` (this directory), referenced via Compose `secrets:` |

The rule of thumb: if a value grants access to data or lets someone
impersonate/decrypt something, it is a secret. If it's just "where do I
connect" or "which issuer do I trust", it's config.

## Files an operator must generate before `docker compose up`

Create each of the following as a **single line, no surrounding quotes, no
trailing newline required** (trailing newlines are stripped automatically by
the resolution shim — see `backend/docker-entrypoint.sh`):

| File | Contents | How to generate |
|---|---|---|
| `secrets/postgres_password.txt` | Postgres password for the `rpd` role | `openssl rand -base64 32` |
| `secrets/field_encryption_key.txt` | A urlsafe-base64 32-byte Fernet key | `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` |
| `secrets/minio_access_key.txt` | MinIO root/access key (also used as the app's S3 client access key — one credential pair, not two, per `docker-compose.yml`'s own comment) | `openssl rand -hex 16` |
| `secrets/minio_secret_key.txt` | MinIO root/secret key | `openssl rand -base64 32` |

**Do not reuse dev-generated values in production.** For local development
only, `make dev` runs `deploy/secrets/generate-dev-secrets.sh` automatically,
which creates throwaway random values here if they don't already exist —
never treat these as anything but disposable local test credentials.

Recommended (not enforced by this app): `chmod 600 secrets/*.txt` on the
deploying host so only the user running Docker can read them.

## Future slot: OIDC client secret (P6-T03, not yet wired)

P6-T03 (full OIDC SSO cutover) is currently **blocked** pending client IdP
confirmation (`docs/OPEN_QUESTIONS.md` #9) and is explicitly out of scope for
this task. When it lands and a confidential OIDC client is configured, add
`secrets/oidc_client_secret.txt` here and follow the exact same pattern
already wired in `docker-compose.yml`'s `x-backend-image` anchor (commented
out today) — `RPD_OIDC_CLIENT_SECRET_FILE` — plus add a `client_secret` field
to `OIDCSettings` (`backend/core/oidc.py`) that reads `RPD_OIDC_CLIENT_SECRET`.
The generic `_FILE` resolution shim in `backend/docker-entrypoint.sh` already
handles this convention for any variable name — no shim changes needed.

## Future slot: off-host backup mirror (P7-T06, not yet wired)

`backend/workers/backup_mirror_tasks.py` (P7-T06) can mirror the nightly
`rpd-backups` bucket to a second, off-host S3-compatible target on a Celery
beat schedule — see `docs/HANDOVER/BACKUP_RESTORE.md` §4 for what it does and
why it exists (the nightly backup otherwise lives on the same host as the
primary database, a single point of failure). **The destination is
Frigoglass's own infrastructure decision and has not been made as of this
task** — until it is, leave `RPD_BACKUP_MIRROR_ENDPOINT`/
`RPD_BACKUP_MIRROR_BUCKET` blank in `.env` (the shipped default) and skip
this section entirely; the nightly mirror task no-ops safely when
unconfigured.

Once Frigoglass picks a destination, enable it by:

1. Setting `RPD_BACKUP_MIRROR_ENDPOINT` (`host:port`, no scheme),
   `RPD_BACKUP_MIRROR_BUCKET`, and optionally `RPD_BACKUP_MIRROR_SECURE`
   (`.env`/`docker-compose.yml` — config, not secret).
2. Creating `secrets/backup_mirror_access_key.txt` and
   `secrets/backup_mirror_secret_key.txt` here, same single-line/no-quotes
   convention as the table above — this is the credential pair for the
   *destination* S3-compatible store, a separate credential from this
   deployment's own `minio_access_key.txt`/`minio_secret_key.txt`.
3. Uncommenting the matching `RPD_BACKUP_MIRROR_ACCESS_KEY_FILE`/
   `RPD_BACKUP_MIRROR_SECRET_KEY_FILE` lines in `docker-compose.yml`'s
   `x-backend-image` anchor, and adding `backup_mirror_access_key`/
   `backup_mirror_secret_key` to both the top-level `secrets:` map and that
   anchor's own `secrets:` list — the generic `_FILE` resolution shim in
   `backend/docker-entrypoint.sh` already handles this convention for any
   variable name (same as the OIDC client-secret slot above), no shim
   changes needed.

Not wired into `docker-compose.yml`'s required `secrets:` list by default,
unlike the four secrets in the table above: Compose refuses to bring up
**any** service if a listed secret's `file:` is missing on the deploying
host, and this destination genuinely does not exist yet for every current
deployment — requiring two placeholder credential files just to run
`docker compose up` would be a needless new precondition until step 2 above
actually applies.

## Why Docker Compose secrets and not Vault

This is a single-client, on-premise Docker Compose deployment (not
Kubernetes, not a multi-tenant SaaS) with no existing HashiCorp Vault
install. Standing up Vault would add an unseal/init/policy-management/HA
burden with no corresponding benefit here — there is no dynamic secret
leasing, no multi-service/multi-team secret-sharing requirement, and no
existing Vault operational expertise implied by this deployment's scale
(`docs/PROJECT_AND_STACK.md` §6: Docker Compose, not Kubernetes). Docker
Compose's native `secrets:` construct gets the two things that actually
matter for this deployment shape — secret material off the process
environment table (not visible in `docker inspect`'s `Config.Env`, not
inherited by child processes that don't need it) and out of shell history /
`.env` files — with zero additional infrastructure, and composes cleanly with
the "clean seams" precedent already set by P6-T01/T02.
