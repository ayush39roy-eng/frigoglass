#!/bin/sh
# Restore-drill / disaster-recovery script for P6-T06's nightly pg_dump-to-
# MinIO backups (`backend/workers/backup_tasks.py`). Deliberately a MANUAL
# operator script — never wired to run automatically, unlike the backup task
# itself (Celery beat, `docker-compose.yml`'s `beat` service). Restoring
# over a database is destructive; it must always be a deliberate,
# human-triggered action.
#
# Usage (from the repo root, with the production stack's `.env` /
# `secrets/*.txt` already populated — same prerequisites as `make dev`):
#
#   ./deploy/backup/restore_from_minio.sh [OBJECT_KEY] [TARGET_HOST] [TARGET_PORT] [TARGET_DB] [TARGET_USER]
#
#   OBJECT_KEY   Defaults to "latest" (most-recently-uploaded object under
#                the `postgres/` prefix in the backups bucket, by MinIO's
#                own `last_modified` metadata — see
#                `backend/workers/restore_backup.py`). Pass an explicit key
#                (e.g. `postgres/rpd-20260905T020000Z.dump`) to restore a
#                specific, older backup instead.
#   TARGET_HOST  Defaults to "postgres" (THIS STACK'S OWN Compose service —
#                i.e. this will overwrite the live database unless you pass
#                a different host). For a non-destructive restore DRILL,
#                point this at a separate, disposable Postgres container on
#                the same `rpd-internal` network instead (see this repo's
#                MEMORY.md P6-T06 entry for the exact drill steps this
#                script was used for).
#   TARGET_PORT/TARGET_DB/TARGET_USER default to 5432/rpd/rpd.
#
# Runs INSIDE a throwaway container built from the SAME `rpd-backend:latest`
# image `api`/`worker`/`solver-worker` already use — it already has
# `pg_restore` (postgresql-client) and this app's own configured
# `RPD_MINIO_*` credentials/settings wired through the same
# `docker-compose.yml` secrets this stack already uses, so there is no
# second credential path to maintain for this script.
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

OBJECT_KEY="${1:-latest}"
TARGET_HOST="${2:-postgres}"
TARGET_PORT="${3:-5432}"
TARGET_DB="${4:-${POSTGRES_DB:-rpd}}"
TARGET_USER="${5:-${POSTGRES_USER:-rpd}}"

echo "restore_from_minio: object_key=${OBJECT_KEY} target=${TARGET_USER}@${TARGET_HOST}:${TARGET_PORT}/${TARGET_DB}"

docker compose run --rm --no-deps \
  -e RESTORE_OBJECT_KEY="$OBJECT_KEY" \
  -e POSTGRES_HOST="$TARGET_HOST" \
  -e POSTGRES_PORT="$TARGET_PORT" \
  -e POSTGRES_DB="$TARGET_DB" \
  -e POSTGRES_USER="$TARGET_USER" \
  worker \
  python -m workers.restore_backup
