"""MinIO (S3-compatible object storage) configuration — env-driven, per
CLAUDE.md's "no secrets in the repo" rule and this repo's established
`RPD_<AREA>_` `pydantic-settings` `BaseSettings` convention (see
`core/config.py`'s `OIDCSettings` / `core/celery_config.py`'s
`RedisSettings`: no default for anything that must be explicitly configured
per-environment, `lru_cache`-wrapped singleton settings getter, lazy
module-level singleton client).

**Used by (P5-T04, CSV/XLSX export)**: `services/export_builder.py` never
imports this module (the synchronous, in-request export path never touches
MinIO at all — see that module's docstring); only `workers/export_tasks.py`
(the async "large export" Celery path, `worker` process per
`docs/PROJECT_AND_STACK.md` §6) and `api/routers/exports.py`'s
job-status/download endpoints construct a client. This means the large
majority of this task's tests (every synchronous CSV/XLSX export) never
require a running MinIO server or these env vars to be set at all — only the
handful of tests that exercise the async job path do, mirroring
`tests/test_workers_progress.py`'s "own dedicated throwaway container,
settings/client reset via `.cache_clear()` + poking the module-level
singleton back to `None`" pattern for Redis.

**Why `minio` (the official MinIO Python SDK) and not `boto3`**: `minio>=7.2`
was already declared in `pyproject.toml` ahead of this task (see that file's
own P5-T04 comment) — a lighter-weight, purpose-built client for exactly this
S3-compatible-object-storage use case, avoiding `boto3`'s much larger surface
area (full AWS SDK) for a single self-hosted MinIO bucket.
"""

from __future__ import annotations

from functools import lru_cache

from minio import Minio
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class MinioSettings(BaseSettings):
    """No default `endpoint`/`access_key`/`secret_key` — must be explicitly
    configured (env or `.env`), mirroring `RPD_DATABASE_URL`/`RPD_REDIS_URL`'s
    "fail loudly at first use, not silently default to localhost" convention.
    """

    model_config = SettingsConfigDict(env_prefix="RPD_MINIO_", extra="ignore")

    #: `host:port` only (no `http://`/`https://` scheme) — the `minio-py`
    #: client's own convention; `secure` below controls the scheme instead.
    #: e.g. `minio:9000` (Docker Compose service name, production/P6-T01) or
    #: `localhost:9000` (a local dev MinIO container).
    endpoint: str

    access_key: str
    secret_key: str

    #: TLS on/off for the MinIO connection itself. `False` by default since
    #: the on-premise deployment topology (`docs/PROJECT_AND_STACK.md` §6)
    #: puts MinIO behind the same internal Docker network as `api`/`worker`
    #: — TLS termination happens at the Nginx/Traefik edge for
    #: browser-facing traffic, not between internal services, unless a
    #: specific deployment overrides this.
    secure: bool = Field(default=False)

    #: Bucket used for CSV/XLSX exports specifically. A distinct, dedicated
    #: bucket (not shared with attachments/`pg_dump` backups/other future
    #: MinIO uses per `docs/PROJECT_AND_STACK.md` §6) so an export-retention
    #: lifecycle policy can be applied to it independently.
    exports_bucket: str = Field(default="rpd-exports")

    #: P6-T06: nightly `pg_dump` backups (`workers/backup_tasks.py`) land
    #: here — a SEPARATE bucket from `exports_bucket`, per
    #: `docs/PROJECT_AND_STACK.md` §6's own "Nightly `pg_dump` to MinIO
    #: (separate bucket, lifecycle-policy retained)" wording, so a
    #: backup-retention lifecycle policy (`backup_retention_days` below) is
    #: never accidentally applied to a customer-facing export instead.
    backups_bucket: str = Field(default="rpd-backups")

    #: Days a backup object is retained before MinIO's own lifecycle
    #: `Expiration` rule deletes it (`ensure_backups_bucket` below). §6 says
    #: "lifecycle-policy retained" without naming a number; 30 days is a
    #: reasonable operator-overridable default for a nightly backup
    #: cadence (one month of nightly recovery points) — not a client-
    #: specified requirement.
    backup_retention_days: int = Field(default=30, ge=1)


@lru_cache
def get_minio_settings() -> MinioSettings:
    """Cached singleton — see `core.config.get_oidc_settings`'s identical
    rationale. Tests that need a different value call `.cache_clear()` first.
    """

    return MinioSettings()


#: Lazily-constructed, module-level singleton `Minio` client — mirrors
#: `workers/progress.py`'s `_redis_client` convention exactly, so importing
#: this module never requires `RPD_MINIO_*` to already be set (only actually
#: calling `get_minio_client()` does). Tests reset this the same way
#: `tests/test_workers_progress.py` resets `workers.progress._redis_client`:
#: poke `core.minio_config._minio_client = None` directly after changing env
#: vars / calling `get_minio_settings.cache_clear()`.
_minio_client: Minio | None = None


def get_minio_client() -> Minio:
    global _minio_client
    if _minio_client is None:
        settings = get_minio_settings()
        _minio_client = Minio(
            settings.endpoint,
            access_key=settings.access_key,
            secret_key=settings.secret_key,
            secure=settings.secure,
        )
    return _minio_client


def ensure_bucket(client: Minio, bucket: str) -> None:
    """Idempotent bucket creation — safe to call on every export (cheap
    `HEAD`-style existence check), rather than assuming ops has pre-provisioned
    the bucket via a Docker Compose init step (P6-T01, not yet built).
    """

    if not client.bucket_exists(bucket):
        client.make_bucket(bucket)


def ensure_backups_bucket(client: Minio) -> str:
    """Idempotent creation of the dedicated backups bucket
    (`MinioSettings.backups_bucket`), PLUS applying a lifecycle-retention
    policy — per `docs/PROJECT_AND_STACK.md` §6: "Nightly `pg_dump` to MinIO
    (separate bucket, lifecycle-policy retained)". Called by
    `workers/backup_tasks.py`'s nightly backup task before every upload
    (idempotent: re-applying the same lifecycle config is a no-op), the same
    "don't assume ops pre-provisioned it" reasoning as `ensure_bucket`
    above, extended to cover the lifecycle policy too.

    Returns the bucket name for convenience at the call site.
    """

    # Local import: `minio.lifecycleconfig`/`minio.commonconfig` are only
    # needed by this one function; keeping them out of this module's
    # top-level imports means `get_minio_client()`/`ensure_bucket()` (used
    # by the export path, `workers/export_tasks.py`) have zero extra import
    # surface for a feature (backups) they don't use.
    from minio.commonconfig import ENABLED, Filter
    from minio.lifecycleconfig import Expiration, LifecycleConfig, Rule

    settings = get_minio_settings()
    bucket = settings.backups_bucket
    ensure_bucket(client, bucket)

    client.set_bucket_lifecycle(
        bucket,
        LifecycleConfig(
            [
                Rule(
                    ENABLED,
                    rule_filter=Filter(prefix=""),
                    rule_id="rpd-backup-retention",
                    expiration=Expiration(days=settings.backup_retention_days),
                ),
            ]
        ),
    )
    return bucket
