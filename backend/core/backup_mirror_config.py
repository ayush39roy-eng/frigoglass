"""Off-host MinIO backup-mirror configuration (P7-T06) — env-driven, same
`RPD_<AREA>_` `pydantic-settings` `BaseSettings` convention as
`core/minio_config.py::MinioSettings` / `core/config.py::OIDCSettings`.

**Deliberately optional/unconfigured by default**, unlike `MinioSettings`
(which has no default `endpoint` and fails loudly at first use). The
off-host mirror destination is Frigoglass's own infrastructure decision
(`docs/IMPLEMENTATION_PLAN.md` P7-T06's own acceptance criteria: "destination
host/credentials are Frigoglass's infra decision — implement against a
configurable target, do not hardcode one") and has not been made as of this
task. A nightly Celery beat schedule that hard-crashed every night until an
operator picks a destination would be strictly worse than one that no-ops
with a clear log line — see `workers/backup_mirror_tasks.py`'s own docstring
for how `is_configured` below is used to decide that.

Read `docs/HANDOVER/BACKUP_RESTORE.md` §4 (updated by this task) for the
operator-facing explanation of what this mirrors and how to turn it on.
"""

from __future__ import annotations

from functools import lru_cache

from minio import Minio
from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class BackupMirrorSettings(BaseSettings):
    """Every field defaults to empty/unset — `is_configured` is `False`
    until an operator sets all four of `endpoint`/`bucket`/`access_key`/
    `secret_key`. This intentionally mirrors "all-or-nothing" rather than
    partial configuration silently mirroring to an incomplete target.
    """

    model_config = SettingsConfigDict(env_prefix="RPD_BACKUP_MIRROR_", extra="ignore")

    #: `host:port` only, same convention as `MinioSettings.endpoint` (no
    #: `http://`/`https://` scheme — `secure` below controls the scheme).
    #: This is intentionally a bare MinIO-client-style endpoint rather than
    #: a full URL so the SAME `minio` Python SDK already used for the
    #: primary bucket (`core/minio_config.py`) can talk to ANY
    #: S3-compatible off-host target Frigoglass picks (a second MinIO
    #: instance, AWS S3, or any other S3-compatible object store) — nothing
    #: in this module or `workers/backup_mirror_tasks.py` assumes the
    #: destination is MinIO specifically.
    endpoint: str = Field(default="")

    access_key: str = Field(default="")
    secret_key: str = Field(default="")

    #: Destination bucket name. Not required to match
    #: `MinioSettings.backups_bucket` ("rpd-backups") — the off-host target
    #: may be a shared bucket/account Frigoglass already operates for other
    #: backup purposes, with its own naming convention.
    bucket: str = Field(default="")

    #: `True` by default — unlike `MinioSettings.secure=False` (internal
    #: Docker-network traffic, TLS terminated at the edge), an off-host
    #: mirror target by definition leaves this deployment's own network, so
    #: TLS is the safe default here; an operator can override to `False`
    #: only if their chosen destination genuinely has no TLS endpoint.
    secure: bool = Field(default=True)

    @property
    def is_configured(self) -> bool:
        return bool(self.endpoint and self.access_key and self.secret_key and self.bucket)


@lru_cache
def get_backup_mirror_settings() -> BackupMirrorSettings:
    """Cached singleton — see `core.minio_config.get_minio_settings`'s
    identical rationale. Tests that need a different value call
    `.cache_clear()` first (same pattern already established by
    `tests/test_workers_backup_tasks.py`'s neighbours).
    """

    return BackupMirrorSettings()


#: Lazily-constructed, module-level singleton `Minio` client for the
#: off-host mirror DESTINATION — mirrors `core.minio_config`'s
#: `_minio_client` convention exactly, including the "importing this module
#: never requires env vars to be set, only actually calling the getter
#: does" property. `None` whenever the destination is not configured.
_backup_mirror_client: Minio | None = None


def get_backup_mirror_client() -> Minio | None:
    """Returns `None` (not an exception) when
    `BackupMirrorSettings.is_configured` is `False` — see this module's own
    docstring for why this path is deliberately non-fatal, unlike
    `core.minio_config.get_minio_client`."""

    global _backup_mirror_client
    settings = get_backup_mirror_settings()
    if not settings.is_configured:
        return None
    if _backup_mirror_client is None:
        _backup_mirror_client = Minio(
            settings.endpoint,
            access_key=settings.access_key,
            secret_key=settings.secret_key,
            secure=settings.secure,
        )
    return _backup_mirror_client
