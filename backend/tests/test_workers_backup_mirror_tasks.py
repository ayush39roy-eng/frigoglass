"""`workers/backup_mirror_tasks.py` — the off-host backup-mirror Celery task
(P7-T06). Both the source and destination MinIO clients are mocked here —
this is a fast, hermetic unit test of the task's OWN control flow
(unconfigured no-op behavior, per-object skip/copy decisions, failure
surfacing), same technique and same limits as
`tests/test_workers_backup_tasks.py`'s neighbour: no real object storage, no
real off-host target (there isn't one yet — see
`docs/HANDOVER/BACKUP_RESTORE.md` §4 / `docs/MEMORY.md`'s P7-T06 entry for
what was, and wasn't, verified against real infrastructure and why.

`.apply()` (not `.delay()`) runs the task synchronously in-process with no
broker connection needed — same technique as
`tests/test_workers_backup_tasks.py`.
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from minio.error import S3Error

from core.backup_mirror_config import get_backup_mirror_settings
from workers.backup_mirror_tasks import mirror_backups_offhost


def _fake_object(name: str, size: int):
    return SimpleNamespace(object_name=name, size=size)


@pytest.fixture(autouse=True)
def _reset_backup_mirror_settings_cache():
    """`get_backup_mirror_settings` is `lru_cache`-wrapped (same convention
    as `core.minio_config.get_minio_settings`) — must be cleared before AND
    after each test so one test's `monkeypatch.setenv` calls can't leak into
    the next (pytest's own `monkeypatch` fixture undoes the env vars
    themselves at teardown, but the cached `BaseSettings` instance built
    from them would otherwise survive).
    """

    get_backup_mirror_settings.cache_clear()
    yield
    get_backup_mirror_settings.cache_clear()


def test_mirror_skips_entirely_when_destination_not_configured():
    """The default/shipped state (`.env.example`'s blank
    `RPD_BACKUP_MIRROR_*` values, per this task's own "safe to no-op until
    Frigoglass decides on a destination" design) — this is the ONLY path
    genuinely exercised in CI/local dev, since it requires no fake target at
    all.
    """

    fake_source_client = MagicMock()
    fake_dest_client = MagicMock()

    with (
        patch("workers.backup_mirror_tasks.get_minio_client", return_value=fake_source_client),
        patch(
            "workers.backup_mirror_tasks.get_backup_mirror_client",
            return_value=fake_dest_client,
        ) as mock_get_dest_client,
    ):
        result = mirror_backups_offhost.apply()

    assert result.state == "SUCCESS"
    assert result.result == {"status": "skipped", "reason": "not_configured"}
    # Neither client was ever touched — confirms this is a genuine early
    # return, not "call everything then discover nothing to do".
    fake_source_client.list_objects.assert_not_called()
    mock_get_dest_client.assert_not_called()


@pytest.fixture
def _configured_mirror_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("RPD_BACKUP_MIRROR_ENDPOINT", "fake-offhost.example.internal:9000")
    monkeypatch.setenv("RPD_BACKUP_MIRROR_BUCKET", "rpd-backups-mirror")
    monkeypatch.setenv("RPD_BACKUP_MIRROR_ACCESS_KEY", "fake-access-key")
    monkeypatch.setenv("RPD_BACKUP_MIRROR_SECRET_KEY", "fake-secret-key")


def test_mirror_copies_only_objects_missing_at_destination(_configured_mirror_env):
    """A fake source with two objects; the destination already has one of
    them (matching size — should be SKIPPED, not re-uploaded) and is
    missing the other (should be COPIED). Verifies the "mc mirror"-style
    incremental behavior this task's docstring promises, entirely against
    fakes — this codebase does not stand up two real MinIO containers for
    this test (see docs/MEMORY.md's P7-T06 entry for why: the destination
    is Frigoglass's undecided infrastructure, not something this test suite
    can stand in for with real infra).
    """

    fake_source_client = MagicMock()
    fake_source_client.list_objects.return_value = [
        _fake_object("postgres/rpd-old.dump", size=100),
        _fake_object("postgres/rpd-new.dump", size=200),
    ]

    fake_dest_client = MagicMock()

    def fake_stat_object(bucket, key):
        if key == "postgres/rpd-old.dump":
            return SimpleNamespace(size=100)
        raise S3Error(
            code="NoSuchKey",
            message="not found",
            resource=key,
            request_id="req-1",
            host_id="host-1",
            response=MagicMock(),
        )

    fake_dest_client.stat_object.side_effect = fake_stat_object

    with (
        patch("workers.backup_mirror_tasks.get_minio_client", return_value=fake_source_client),
        patch(
            "workers.backup_mirror_tasks.get_backup_mirror_client",
            return_value=fake_dest_client,
        ),
        patch("workers.backup_mirror_tasks.ensure_backups_bucket", return_value="rpd-backups"),
        patch("workers.backup_mirror_tasks.ensure_bucket"),
    ):
        result = mirror_backups_offhost.apply()

    assert result.state == "SUCCESS"
    payload = result.result
    assert payload["status"] == "completed"
    assert payload["mirrored_count"] == 1
    assert payload["skipped_count"] == 1

    # Only the missing object was downloaded-then-uploaded; the already-
    # present one was never touched beyond the stat check.
    fake_source_client.fget_object.assert_called_once()
    assert fake_source_client.fget_object.call_args.args[1] == "postgres/rpd-new.dump"
    fake_dest_client.fput_object.assert_called_once()
    assert fake_dest_client.fput_object.call_args.args[1] == "postgres/rpd-new.dump"


def test_mirror_raises_if_any_object_fails_after_attempting_the_rest(_configured_mirror_env):
    fake_source_client = MagicMock()
    fake_source_client.list_objects.return_value = [
        _fake_object("postgres/rpd-a.dump", size=10),
        _fake_object("postgres/rpd-b.dump", size=20),
    ]
    fake_source_client.fget_object.side_effect = [None, RuntimeError("network blip")]

    fake_dest_client = MagicMock()
    fake_dest_client.stat_object.side_effect = S3Error(
        code="NoSuchKey",
        message="not found",
        resource="x",
        request_id="req-1",
        host_id="host-1",
        response=MagicMock(),
    )

    with (
        patch("workers.backup_mirror_tasks.get_minio_client", return_value=fake_source_client),
        patch(
            "workers.backup_mirror_tasks.get_backup_mirror_client",
            return_value=fake_dest_client,
        ),
        patch("workers.backup_mirror_tasks.ensure_backups_bucket", return_value="rpd-backups"),
        patch("workers.backup_mirror_tasks.ensure_bucket"),
    ):
        result = mirror_backups_offhost.apply()

    assert result.state == "FAILURE"
    # Both objects were attempted (the loop never stops early) even though
    # the SECOND one failed — confirms the "best-effort, then raise" shape.
    assert fake_source_client.fget_object.call_count == 2
