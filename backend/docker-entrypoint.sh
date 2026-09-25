#!/bin/sh
# Entrypoint for ALL THREE backend Docker Compose services that share
# `../Dockerfile`'s image: `api`, `worker`, `solver-worker` (none of them
# override `entrypoint:` in `../docker-compose.yml` — migrations must be
# safe to run redundantly, and Alembic no-ops on an up-to-date schema, so
# whichever container starts first applies them and the others are harmless
# idempotent re-runs; see `docker-compose.yml`'s `worker` service comment for
# why an `entrypoint: []` override was deliberately NOT added).
#
# Two responsibilities, in order:
#   1. Resolve secrets (P6-T04): read Docker Compose `secrets:`-mounted files
#      (`/run/secrets/<name>`, wired via `_FILE`-suffixed env vars — see
#      `docker-compose.yml`'s `x-backend-image` anchor) into the plain env
#      vars this app's existing code already reads
#      (`os.environ.get("RPD_DATABASE_URL")` in `api/db.py`/`alembic/env.py`/
#      `workers/*.py`; `os.environ.get("RPD_FIELD_ENCRYPTION_KEY")` in
#      `models/types.py`; `pydantic-settings` `BaseSettings` subclasses for
#      `RPD_MINIO_*` in `core/minio_config.py` — `BaseSettings` reads
#      `os.environ` the same way). No application code changes needed: this
#      shim runs before anything Python starts, so by the time `alembic` or
#      `gunicorn`/`celery` starts, the resolved env vars are just... set.
#   2. Run pending Alembic migrations, then `exec "$@"` (the container's real
#      command), so a fresh `docker compose up` (or an image redeploy with
#      new migrations) always brings the schema current without a separate
#      manual step. Fails loudly (`set -e`) rather than starting against a
#      stale/missing schema or a missing secret.
set -e

# Generic "_FILE convention" resolver: if `<NAME>_FILE` is set (a path,
# typically `/run/secrets/<secret>` from Compose's `secrets:` mount), read
# its contents into `<NAME>` and export it, UNLESS `<NAME>` is already set
# directly (lets a developer override with a plain env var / root `.env`
# value without touching secrets files at all — e.g. local `docker compose
# run` debugging). Trailing newlines from `cat`/command substitution are
# stripped automatically by POSIX shell word-splitting inside `$(...)`.
#
# POSIX `sh`-compatible (no bash `${!var}` indirection) via `eval`, since this
# script's shebang is `#!/bin/sh` (the runtime image's `/bin/sh` is Debian's
# `dash`, not bash).
resolve_secret() {
    var_name="$1"
    file_var_name="${var_name}_FILE"
    current_value=$(eval "printf '%s' \"\${$var_name:-}\"")
    if [ -n "$current_value" ]; then
        return 0
    fi
    file_path=$(eval "printf '%s' \"\${$file_var_name:-}\"")
    if [ -z "$file_path" ]; then
        return 0
    fi
    if [ ! -f "$file_path" ]; then
        echo "docker-entrypoint: ${file_var_name}=${file_path} does not exist" >&2
        exit 1
    fi
    value=$(cat "$file_path")
    export "$var_name"="$value"
}

echo "docker-entrypoint: resolving secrets..."
resolve_secret RPD_FIELD_ENCRYPTION_KEY
resolve_secret RPD_MINIO_ACCESS_KEY
resolve_secret RPD_MINIO_SECRET_KEY
resolve_secret POSTGRES_PASSWORD
# Future slot (P6-T03, currently BLOCKED — docs/OPEN_QUESTIONS.md #9): once a
# confidential OIDC client secret exists, this line alone is enough to wire
# it through once `docker-compose.yml` sets `RPD_OIDC_CLIENT_SECRET_FILE` and
# `core/oidc.py`'s `OIDCSettings` gains a `client_secret` field — no shim
# changes needed.
resolve_secret RPD_OIDC_CLIENT_SECRET
# P7-T06: off-host backup-mirror credentials (see
# `core/backup_mirror_config.py::BackupMirrorSettings` /
# `secrets/README.md`'s "Future slot: off-host backup mirror" section).
# Harmless no-op today: neither `_FILE` var is set anywhere in
# `docker-compose.yml` yet (the destination is Frigoglass's own
# infrastructure decision, not yet made) — this line only starts doing
# anything once an operator adds
# `secrets/backup_mirror_access_key.txt`/`secrets/backup_mirror_secret_key.txt`
# and wires the matching `RPD_BACKUP_MIRROR_ACCESS_KEY_FILE`/
# `RPD_BACKUP_MIRROR_SECRET_KEY_FILE` env vars into `docker-compose.yml`,
# exactly the same "add later, zero shim changes" pattern as the OIDC slot
# immediately above.
resolve_secret RPD_BACKUP_MIRROR_ACCESS_KEY
resolve_secret RPD_BACKUP_MIRROR_SECRET_KEY

# Build RPD_DATABASE_URL from components if not already set directly (the
# password never appears in `docker-compose.yml`'s `environment:` block —
# see that file's `x-backend-image` anchor — so it can only be assembled
# in-process, after the secret above has been resolved).
if [ -z "${RPD_DATABASE_URL:-}" ]; then
    : "${POSTGRES_USER:?POSTGRES_USER must be set}"
    : "${POSTGRES_DB:?POSTGRES_DB must be set}"
    : "${POSTGRES_HOST:=postgres}"
    : "${POSTGRES_PORT:=5432}"
    : "${POSTGRES_PASSWORD:?POSTGRES_PASSWORD (or POSTGRES_PASSWORD_FILE) must be set}"
    export RPD_DATABASE_URL="postgresql+asyncpg://${POSTGRES_USER}:${POSTGRES_PASSWORD}@${POSTGRES_HOST}:${POSTGRES_PORT}/${POSTGRES_DB}"
fi

echo "docker-entrypoint: running 'alembic upgrade head'..."
alembic upgrade head

echo "docker-entrypoint: migrations applied, starting: $*"
exec "$@"
