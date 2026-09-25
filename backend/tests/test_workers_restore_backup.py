"""`workers/restore_backup.py` — the restore-drill script
(`deploy/backup/restore_from_minio.sh`'s Python half). MinIO client and
`pg_restore` subprocess are both mocked — hermetic unit coverage of this
script's OWN control flow (object-key resolution, argv/env shape,
success/failure return codes), not a substitute for the real, live-verified
restore drill against actual Postgres + MinIO (see `docs/MEMORY.md`'s
P6-T06 entry).
"""

from __future__ import annotations

from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from workers.restore_backup import _resolve_object_key, main


def _fake_object(name: str, modified_at: datetime):
    return SimpleNamespace(object_name=name, last_modified=modified_at)


def test_resolve_object_key_passthrough_when_explicit():
    client = MagicMock()
    key = _resolve_object_key(client, "rpd-backups", "postgres/rpd-20260101T000000Z.dump")
    assert key == "postgres/rpd-20260101T000000Z.dump"
    client.list_objects.assert_not_called()


def test_resolve_object_key_picks_most_recently_modified_for_latest():
    client = MagicMock()
    client.list_objects.return_value = [
        _fake_object("postgres/rpd-old.dump", datetime(2026, 1, 1, tzinfo=UTC)),
        _fake_object("postgres/rpd-new.dump", datetime(2026, 6, 1, tzinfo=UTC)),
    ]

    key = _resolve_object_key(client, "rpd-backups", "latest")

    assert key == "postgres/rpd-new.dump"


def test_resolve_object_key_raises_when_bucket_empty():
    client = MagicMock()
    client.list_objects.return_value = []

    with pytest.raises(RuntimeError):
        _resolve_object_key(client, "rpd-backups", "latest")


@pytest.fixture
def _restore_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "postgres-drill")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_USER", "rpd")
    monkeypatch.setenv("POSTGRES_DB", "rpd_restore_drill")
    monkeypatch.setenv("POSTGRES_PASSWORD", "not-a-real-password")
    monkeypatch.setenv("RESTORE_OBJECT_KEY", "postgres/rpd-20260101T000000Z.dump")


def test_main_downloads_and_restores_on_success(_restore_env):
    fake_client = MagicMock()

    with (
        patch("workers.restore_backup.get_minio_client", return_value=fake_client),
        patch("workers.restore_backup.ensure_backups_bucket", return_value="rpd-backups"),
        patch("workers.restore_backup.subprocess.run") as mock_run,
        patch("workers.restore_backup.os.path.getsize", return_value=999),
    ):
        mock_run.return_value = MagicMock(returncode=0, stderr="")

        exit_code = main()

    assert exit_code == 0
    fake_client.fget_object.assert_called_once()
    assert fake_client.fget_object.call_args.args[0] == "rpd-backups"
    assert fake_client.fget_object.call_args.args[1] == "postgres/rpd-20260101T000000Z.dump"

    pg_restore_argv = mock_run.call_args.args[0]
    assert "pg_restore" in pg_restore_argv
    assert "--clean" in pg_restore_argv
    assert "--if-exists" in pg_restore_argv
    assert "not-a-real-password" not in pg_restore_argv
    assert mock_run.call_args.kwargs["env"]["PGPASSWORD"] == "not-a-real-password"


def test_main_returns_nonzero_on_pg_restore_failure(_restore_env):
    fake_client = MagicMock()

    with (
        patch("workers.restore_backup.get_minio_client", return_value=fake_client),
        patch("workers.restore_backup.ensure_backups_bucket", return_value="rpd-backups"),
        patch("workers.restore_backup.subprocess.run") as mock_run,
    ):
        mock_run.return_value = MagicMock(returncode=1, stderr="pg_restore: some error")

        exit_code = main()

    assert exit_code == 1
