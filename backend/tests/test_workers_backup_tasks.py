"""`workers/backup_tasks.py` — the nightly pg_dump-to-MinIO Celery task
(P6-T06). `subprocess.run` (the `pg_dump` invocation) and the MinIO client
are both mocked here — this is a fast, hermetic unit test of the task's OWN
control flow (env-var handling, object-key naming, success/failure result
shape), not a substitute for this task's real, live-verified backup/restore
drill against actual Postgres + MinIO containers (see `docs/MEMORY.md`'s
P6-T06 entry for that).

`.apply()` (not `.delay()`) runs the task synchronously in-process with no
broker connection needed — same technique as
`tests/test_workers_celery_app.py`'s tasks, extended here to actually invoke
the task body.
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from workers.backup_tasks import BACKUP_OBJECT_PREFIX, nightly_pg_dump_backup


@pytest.fixture
def _postgres_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("POSTGRES_HOST", "postgres")
    monkeypatch.setenv("POSTGRES_PORT", "5432")
    monkeypatch.setenv("POSTGRES_USER", "rpd")
    monkeypatch.setenv("POSTGRES_DB", "rpd")
    monkeypatch.setenv("POSTGRES_PASSWORD", "not-a-real-password")


def test_nightly_pg_dump_backup_uploads_to_backups_bucket_on_success(_postgres_env, tmp_path):
    fake_client = MagicMock()

    with (
        patch("workers.backup_tasks.subprocess.run") as mock_run,
        patch("workers.backup_tasks.get_minio_client", return_value=fake_client),
        patch("workers.backup_tasks.ensure_backups_bucket", return_value="rpd-backups"),
        patch("workers.backup_tasks.os.path.getsize", return_value=12345),
    ):
        mock_run.return_value = MagicMock(returncode=0, stderr="")

        result = nightly_pg_dump_backup.apply()

    assert result.state == "SUCCESS"
    payload = result.result
    assert payload["status"] == "completed"
    assert payload["bucket"] == "rpd-backups"
    assert payload["object_key"].startswith(f"{BACKUP_OBJECT_PREFIX}/rpd-")
    assert payload["object_key"].endswith(".dump")
    assert payload["size_bytes"] == 12345

    # The dump was actually uploaded via `fput_object`, to the resolved
    # bucket/object key, not some other path.
    fake_client_call = fake_client.fput_object.call_args
    assert fake_client_call.args[0] == "rpd-backups"
    assert fake_client_call.args[1] == payload["object_key"]

    # pg_dump's own argv never contains the password (PGPASSWORD is an env
    # var, not a CLI argument) — a real, checkable assertion of this
    # module's own "never logs/exposes the password as an argument" claim.
    pg_dump_argv = mock_run.call_args.args[0]
    assert "not-a-real-password" not in pg_dump_argv
    assert mock_run.call_args.kwargs["env"]["PGPASSWORD"] == "not-a-real-password"


def test_nightly_pg_dump_backup_raises_and_never_uploads_on_pg_dump_failure(_postgres_env):
    fake_client = MagicMock()

    with (
        patch("workers.backup_tasks.subprocess.run") as mock_run,
        patch("workers.backup_tasks.get_minio_client", return_value=fake_client),
        patch("workers.backup_tasks.ensure_backups_bucket", return_value="rpd-backups"),
    ):
        mock_run.return_value = MagicMock(returncode=1, stderr="pg_dump: some error")

        result = nightly_pg_dump_backup.apply()

    assert result.state == "FAILURE"
    fake_client.fput_object.assert_not_called()


def test_nightly_pg_dump_backup_requires_postgres_env_vars(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv("POSTGRES_PASSWORD", raising=False)
    monkeypatch.delenv("POSTGRES_USER", raising=False)
    monkeypatch.delenv("POSTGRES_DB", raising=False)

    result = nightly_pg_dump_backup.apply()

    assert result.state == "FAILURE"
