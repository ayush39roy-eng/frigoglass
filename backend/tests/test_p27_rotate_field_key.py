"""P27 / S26-H1 support: `scripts/rotate_field_key.py`.

Runs on disposable databases only: a fresh database created inside the
session's testcontainers Postgres (migrated to head, dropped afterwards) for
the end-to-end runs of the real script (subprocess, committed transactions),
and the usual rolled-back `db_session` for the in-transaction cases.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys
from decimal import Decimal
from pathlib import Path

import pytest
import pytest_asyncio
import sqlalchemy as sa
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

import models.types as model_types
from models import AuditLogEntry, Project
from scripts.rotate_field_key import (
    AUDIT_ACTION,
    ENCRYPTED_COLUMNS,
    NEW_KEY_ENV,
    OLD_KEY_ENV,
    RotationError,
    discover_encrypted_columns,
    load_key,
    load_keys,
    rotate_field_key,
)
from tests.conftest import run_alembic
from tests.factories import make_hub, make_project

BACKEND = Path(__file__).resolve().parents[1]
ROTATION_DB = "rpd_p27_key_rotation"
FINANCIALS = ("customer_name", "tcogs_eur", "selling_price_eur", "gross_margin_pct")
PLAINTEXTS = ("Coca-Cola Hellenic", "1234.56", "2500.00", "42.5", "Heineken", "777.70")


@pytest.fixture
def restore_app_key():
    """Tests that point the app at another key restore the process key."""

    saved = os.environ["RPD_FIELD_ENCRYPTION_KEY"]
    yield
    os.environ["RPD_FIELD_ENCRYPTION_KEY"] = saved
    model_types._fernet.cache_clear()


def _use_app_key(key: bytes) -> None:
    os.environ["RPD_FIELD_ENCRYPTION_KEY"] = key.decode()
    model_types._fernet.cache_clear()


# --- Column list and key loading ---------------------------------------------------


def test_constant_column_list_matches_every_encrypted_model_column():
    found = discover_encrypted_columns()
    assert found == tuple(sorted(ENCRYPTED_COLUMNS))
    # At least the 4 named financial fields; any future one fails this test
    # until the constant is updated.
    assert {("projects", f) for f in FINANCIALS} <= set(found)


def test_load_key_from_env_and_file(tmp_path):
    key = Fernet.generate_key()
    assert load_key(OLD_KEY_ENV, {OLD_KEY_ENV: key.decode()}) == key
    f = tmp_path / "k"
    f.write_text(key.decode() + "\n")
    assert load_key(OLD_KEY_ENV, {f"{OLD_KEY_ENV}_FILE": str(f)}) == key


@pytest.mark.parametrize(
    ("environ", "message"),
    [
        ({}, "is not set"),
        ({OLD_KEY_ENV: "not-a-fernet-key-SECRETVALUE"}, "not a valid Fernet key"),
        ({OLD_KEY_ENV: "x", f"{OLD_KEY_ENV}_FILE": "/nope"}, "only one"),
        ({f"{OLD_KEY_ENV}_FILE": "/nonexistent/key"}, "cannot read"),
    ],
)
def test_load_key_refusals_never_echo_the_value(environ, message):
    with pytest.raises(RotationError, match=message) as info:
        load_key(OLD_KEY_ENV, environ)
    assert "SECRETVALUE" not in str(info.value)
    assert info.value.__cause__ is None


def test_same_old_and_new_key_is_refused():
    key = Fernet.generate_key().decode()
    with pytest.raises(RotationError, match="same"):
        load_keys({OLD_KEY_ENV: key, NEW_KEY_ENV: key})


# --- In one (rolled-back) transaction ----------------------------------------------


async def _raw(conn, project_id) -> dict[str, bytes | None]:
    t = sa.table("projects", sa.column("id"), *(sa.column(c, sa.LargeBinary) for c in FINANCIALS))
    row = (
        await conn.execute(sa.select(*(t.c[c] for c in FINANCIALS)).where(t.c.id == project_id))
    ).one()
    return {c: (bytes(v) if v is not None else None) for c, v in zip(FINANCIALS, row, strict=True)}


async def test_rotate_in_transaction_then_app_decrypts_with_new_key(db_session, restore_app_key):
    old = os.environ["RPD_FIELD_ENCRYPTION_KEY"].encode()
    new = Fernet.generate_key()
    hub = await make_hub(db_session)
    full = await make_project(
        db_session,
        hub,
        name="Full",
        customer_name="Coca-Cola Hellenic",
        tcogs_eur=Decimal("1234.56"),
        selling_price_eur=Decimal("2500.00"),
        gross_margin_pct=Decimal("42.5"),
    )
    partial = await make_project(db_session, hub, name="Partial", tcogs_eur=Decimal("10.00"))
    await make_project(db_session, hub, name="Empty")
    conn = await db_session.connection()
    before = await _raw(conn, full.id)
    raw = sa.table("projects", *(sa.column(c, sa.LargeBinary) for c in FINANCIALS))
    non_null = {
        c: (await conn.execute(sa.select(sa.func.count(raw.c[c])))).scalar_one() for c in FINANCIALS
    }

    report = await rotate_field_key(conn, old, new)

    by_col = {r.column: r for r in report.columns}
    for c in FINANCIALS:
        assert by_col[c].rotated == by_col[c].non_null == by_col[c].verified == non_null[c]
    assert report.rotated == report.non_null == sum(non_null.values())
    after = await _raw(conn, full.id)
    for c in FINANCIALS:
        assert after[c] != before[c]
        Fernet(new).decrypt(after[c])
        with pytest.raises(InvalidToken):
            Fernet(old).decrypt(after[c])
    assert (await _raw(conn, partial.id))["customer_name"] is None  # null stays null

    audit = (
        await db_session.execute(
            sa.select(AuditLogEntry).where(AuditLogEntry.action == AUDIT_ACTION)
        )
    ).scalar_one()
    assert audit.after_state["rows_rotated"] == report.rotated
    assert "Coca" not in str(audit.after_state)

    # The app, now on the new key alone, reads the same values.
    _use_app_key(new)
    fetched = (
        await db_session.execute(
            sa.select(Project)
            .where(Project.id == full.id)
            .execution_options(populate_existing=True)
        )
    ).scalar_one()
    assert fetched.customer_name == "Coca-Cola Hellenic"
    assert (fetched.tcogs_eur, fetched.selling_price_eur, fetched.gross_margin_pct) == (
        Decimal("1234.56"),
        Decimal("2500.00"),
        Decimal("42.5"),
    )


async def test_a_value_under_an_unknown_key_fails_and_changes_nothing(db_session):
    old = os.environ["RPD_FIELD_ENCRYPTION_KEY"].encode()
    hub = await make_hub(db_session)
    good = await make_project(db_session, hub, name="Good", customer_name="Kept")
    stray = await make_project(db_session, hub, name="Stray")
    conn = await db_session.connection()
    t = sa.table("projects", sa.column("id"), sa.column("customer_name", sa.LargeBinary))
    await conn.execute(
        sa.update(t)
        .where(t.c.id == stray.id)
        .values(customer_name=Fernet(Fernet.generate_key()).encrypt(b"other key"))
    )
    before = await _raw(conn, good.id)
    with pytest.raises(RotationError, match="does not decrypt") as info:
        async with conn.begin_nested():
            await rotate_field_key(conn, old, Fernet.generate_key())
    assert "other key" not in str(info.value)
    assert await _raw(conn, good.id) == before
    count = (
        await conn.execute(
            sa.select(sa.func.count())
            .select_from(AuditLogEntry.__table__)
            .where(AuditLogEntry.__table__.c.action == AUDIT_ACTION)
        )
    ).scalar_one()
    assert count == 0


# --- End to end: the real script on a fresh disposable database ---------------------


@pytest.fixture(scope="module")
def rotation_db_url(database_url: str) -> str:
    """A fresh database in the session's throwaway container, migrated to
    head and dropped at the end of the module."""

    admin = make_url(database_url).set(database="postgres")
    target = make_url(database_url).set(database=ROTATION_DB)

    async def _ddl(statement: str) -> None:
        engine = create_async_engine(admin, isolation_level="AUTOCOMMIT")
        try:
            async with engine.connect() as conn:
                await conn.execute(sa.text(statement))
        finally:
            await engine.dispose()

    asyncio.run(_ddl("DROP DATABASE IF EXISTS rpd_p27_key_rotation"))
    asyncio.run(_ddl("CREATE DATABASE rpd_p27_key_rotation"))
    url = target.render_as_string(hide_password=False)
    result = run_alembic(["upgrade", "head"], url)
    assert result.returncode == 0, result.stderr
    yield url
    asyncio.run(_ddl("DROP DATABASE IF EXISTS rpd_p27_key_rotation WITH (FORCE)"))


@pytest_asyncio.fixture
async def seeded(rotation_db_url, restore_app_key):
    """Commits 3 projects under a fresh "old" key; returns (url, old key, ids)."""

    old = Fernet.generate_key()
    _use_app_key(old)
    engine = create_async_engine(rotation_db_url)
    try:
        async with async_sessionmaker(engine, expire_on_commit=False)() as session:
            hub = await make_hub(session)
            a = await make_project(
                session,
                hub,
                name="A",
                customer_name="Coca-Cola Hellenic",
                tcogs_eur=Decimal("1234.56"),
                selling_price_eur=Decimal("2500.00"),
                gross_margin_pct=Decimal("42.5"),
            )
            b = await make_project(
                session, hub, name="B", customer_name="Heineken", tcogs_eur=Decimal("777.70")
            )
            await make_project(session, hub, name="C")
            await session.commit()
    finally:
        await engine.dispose()
    return rotation_db_url, old, (a.id, b.id)


def _run_script(url: str, env_keys: dict[str, str], *args: str) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if not k.startswith("RPD_FIELD_KEY_")}
    env.pop("RPD_FIELD_ENCRYPTION_KEY", None)
    env["RPD_DATABASE_URL"] = url
    env.update(env_keys)
    return subprocess.run(
        [sys.executable, "-m", "scripts.rotate_field_key", *args],
        cwd=BACKEND,
        env=env,
        capture_output=True,
        text=True,
        timeout=180,
    )


async def _snapshot(url: str) -> dict:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            t = sa.table(
                "projects", sa.column("id"), *(sa.column(c, sa.LargeBinary) for c in FINANCIALS)
            )
            rows = (await conn.execute(sa.select(t.c.id, *(t.c[c] for c in FINANCIALS)))).all()
            audits = (
                await conn.execute(
                    sa.select(sa.func.count())
                    .select_from(AuditLogEntry.__table__)
                    .where(AuditLogEntry.__table__.c.action == AUDIT_ACTION)
                )
            ).scalar_one()
    finally:
        await engine.dispose()
    return {
        "rows": {r[0]: tuple(bytes(v) if v is not None else None for v in r[1:]) for r in rows},
        "audits": audits,
    }


def _assert_no_secrets(proc: subprocess.CompletedProcess, *keys: bytes) -> None:
    out = proc.stdout + proc.stderr
    for k in keys:
        assert k.decode() not in out
    for p in PLAINTEXTS:
        assert p not in out
    assert "gAAAAA" not in out  # no Fernet token


async def test_script_dry_run_then_rotation_end_to_end(seeded, tmp_path):
    url, old, (a_id, b_id) = seeded
    new = Fernet.generate_key()
    keys = {OLD_KEY_ENV: old.decode(), NEW_KEY_ENV: new.decode()}
    before = await _snapshot(url)
    non_null = sum(v is not None for row in before["rows"].values() for v in row)
    assert non_null == 6

    # Dry run: verified, rolled back, nothing changed.
    dry = _run_script(url, keys, "--dry-run")
    assert dry.returncode == 0, dry.stderr
    assert "DRY RUN" in dry.stdout
    assert f"rotated {non_null} of {non_null}" in dry.stdout
    _assert_no_secrets(dry, old, new)
    assert await _snapshot(url) == before

    # Real run, keys from files this time.
    (tmp_path / "old").write_text(old.decode())
    (tmp_path / "new").write_text(new.decode())
    real = _run_script(
        url,
        {
            f"{OLD_KEY_ENV}_FILE": str(tmp_path / "old"),
            f"{NEW_KEY_ENV}_FILE": str(tmp_path / "new"),
        },
    )
    assert real.returncode == 0, real.stderr
    assert f"rotated {non_null} of {non_null}" in real.stdout
    _assert_no_secrets(real, old, new)
    after = await _snapshot(url)
    assert after["audits"] == before["audits"] + 1
    rotated = 0
    for pid, row in after["rows"].items():
        for old_token, new_token in zip(before["rows"][pid], row, strict=True):
            assert (old_token is None) == (new_token is None)
            if new_token is None:
                continue
            rotated += 1
            assert new_token != old_token
            assert Fernet(new).decrypt(new_token) == Fernet(old).decrypt(old_token)
            with pytest.raises(InvalidToken):
                Fernet(old).decrypt(new_token)
    assert rotated == non_null

    # The app with the new key alone decrypts every value.
    _use_app_key(new)
    engine = create_async_engine(url)
    try:
        async with async_sessionmaker(engine)() as session:
            a = (await session.execute(sa.select(Project).where(Project.id == a_id))).scalar_one()
            b = (await session.execute(sa.select(Project).where(Project.id == b_id))).scalar_one()
            assert (a.customer_name, a.tcogs_eur, a.selling_price_eur, a.gross_margin_pct) == (
                "Coca-Cola Hellenic",
                Decimal("1234.56"),
                Decimal("2500.00"),
                Decimal("42.5"),
            )
            assert (b.customer_name, b.tcogs_eur, b.selling_price_eur) == (
                "Heineken",
                Decimal("777.70"),
                None,
            )
    finally:
        await engine.dispose()

    # A run with the wrong key pair (the values are now under `new`, which is
    # in neither slot) fails and rolls back.
    again = _run_script(
        url, {OLD_KEY_ENV: old.decode(), NEW_KEY_ENV: Fernet.generate_key().decode()}
    )
    assert again.returncode == 1
    assert "nothing was changed" in again.stderr
    assert await _snapshot(url) == after


def test_script_never_takes_keys_from_argv():
    proc = subprocess.run(
        [sys.executable, "-m", "scripts.rotate_field_key", "--old-key", "x"],
        cwd=BACKEND,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 2
    assert "unrecognized arguments" in proc.stderr


def test_script_refuses_without_keys(tmp_path):
    proc = _run_script("postgresql+asyncpg://u:p@127.0.0.1:1/none", {}, "--dry-run")
    assert proc.returncode == 1
    assert "RPD_FIELD_KEY_OLD" in proc.stderr
