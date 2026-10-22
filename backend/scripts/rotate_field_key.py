"""One-off rotation of the field encryption key (`RPD_FIELD_ENCRYPTION_KEY`).

P27 / S26-H1 (final security gate). Re-encrypts every value of every
encrypted column (`models.types.EncryptedString` / `EncryptedNumeric`) from
the old Fernet key to a new one with `MultiFernet([new, old]).rotate()`, in ONE
database transaction, then verifies the result before committing:

- every non-null value decrypts with the NEW key alone, to the same plaintext
  it had before (compared by SHA-256 digest, so plaintext is never kept);
- no value still decrypts with the OLD key alone;
- per column, the rotated count equals the non-null count (counted separately
  with `COUNT(column)`).

Any failure rolls the whole transaction back and nothing changes. `--dry-run`
does all of the above, then rolls back.

Keys never come from argv (they would show in `ps` and shell history). Each key
comes from exactly one of:

    RPD_FIELD_KEY_OLD        or  RPD_FIELD_KEY_OLD_FILE   (path to a file with the key)
    RPD_FIELD_KEY_NEW        or  RPD_FIELD_KEY_NEW_FILE

The database is `RPD_DATABASE_URL` (the app's own async DSN). Output is counts
only: the script never prints or logs a key, a plaintext or a ciphertext, and
the engine hides SQL parameters in error messages (`hide_parameters=True`).

Usage (from `backend/`, services stopped, a fresh backup taken; see
docs/HANDOVER/KEY_ROTATION.md):

    RPD_DATABASE_URL=... RPD_FIELD_KEY_OLD_FILE=/run/secrets/old \\
    RPD_FIELD_KEY_NEW_FILE=/run/secrets/new python -m scripts.rotate_field_key --dry-run

    ... python -m scripts.rotate_field_key

The column list is the constant `ENCRYPTED_COLUMNS` below. It is checked
against the models at start-up (`discover_encrypted_columns`), and the script
refuses to run if they differ, so a new encrypted column cannot be missed
silently. All SQL is built with SQLAlchemy Core from that constant; there is
no string interpolation of any input.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import os
import sys
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

import sqlalchemy as sa
from cryptography.fernet import Fernet, InvalidToken, MultiFernet
from sqlalchemy.ext.asyncio import AsyncConnection, create_async_engine

#: Every encrypted column, as (table, column). Must equal
#: `discover_encrypted_columns()`; the script refuses to run otherwise.
ENCRYPTED_COLUMNS: tuple[tuple[str, str], ...] = (
    ("projects", "customer_name"),
    ("projects", "gross_margin_pct"),
    ("projects", "selling_price_eur"),
    ("projects", "tcogs_eur"),
)

OLD_KEY_ENV = "RPD_FIELD_KEY_OLD"
NEW_KEY_ENV = "RPD_FIELD_KEY_NEW"
AUDIT_ACTION = "field_encryption_key.rotate"


class RotationError(Exception):
    """A refusal or a failed verification. The message never holds a key,
    a plaintext or a ciphertext."""


# --- Column list ---------------------------------------------------------------------


def discover_encrypted_columns() -> tuple[tuple[str, str], ...]:
    """(table, column) of every column whose type is an encrypted type, from
    the models' metadata."""

    import models  # noqa: F401  (registers every model on Base.metadata)
    from models.base import Base
    from models.types import EncryptedNumeric, EncryptedString

    return tuple(
        sorted(
            (table.name, column.name)
            for table in Base.metadata.sorted_tables
            for column in table.columns
            if isinstance(column.type, (EncryptedString, EncryptedNumeric))
        )
    )


def check_column_list() -> None:
    found = discover_encrypted_columns()
    if found != tuple(sorted(ENCRYPTED_COLUMNS)):
        missing = sorted(set(found) - set(ENCRYPTED_COLUMNS))
        extra = sorted(set(ENCRYPTED_COLUMNS) - set(found))
        raise RotationError(
            "ENCRYPTED_COLUMNS does not match the models "
            f"(in the models only: {missing}; in the script only: {extra}). "
            "Update the constant before rotating."
        )


def _has_updated_at(table_name: str) -> bool:
    from models.base import Base

    return "updated_at" in Base.metadata.tables[table_name].columns


def _check_primary_key(table_name: str) -> None:
    from models.base import Base

    pk = [c.name for c in Base.metadata.tables[table_name].primary_key.columns]
    if pk != ["id"]:
        raise RotationError(f"{table_name}: expected a single `id` primary key, found {pk}")


# --- Keys ----------------------------------------------------------------------------


def load_key(env_name: str, environ: dict[str, str] | None = None) -> bytes:
    """The key from `env_name` or from the file named by `<env_name>_FILE`
    (exactly one). Validated as a Fernet key. Errors never echo the value."""

    environ = dict(os.environ) if environ is None else environ
    direct = environ.get(env_name, "").strip()
    file_var = f"{env_name}_FILE"
    path = environ.get(file_var, "").strip()
    if direct and path:
        raise RotationError(f"Set only one of {env_name} and {file_var}.")
    if path:
        try:
            direct = Path(path).read_text(encoding="utf-8").strip()
        except OSError as exc:
            raise RotationError(
                f"{file_var}: cannot read the key file ({type(exc).__name__})."
            ) from None
    if not direct:
        raise RotationError(f"{env_name} (or {file_var}) is not set.")
    key = direct.encode("utf-8")
    try:
        Fernet(key)
    except (ValueError, TypeError):
        raise RotationError(f"{env_name} is not a valid Fernet key.") from None
    return key


def load_keys(environ: dict[str, str] | None = None) -> tuple[bytes, bytes]:
    old, new = load_key(OLD_KEY_ENV, environ), load_key(NEW_KEY_ENV, environ)
    if old == new:
        raise RotationError("The old and the new key are the same.")
    return old, new


# --- Rotation ------------------------------------------------------------------------


@dataclass
class ColumnReport:
    table: str
    column: str
    non_null: int = 0
    rotated: int = 0
    verified: int = 0


@dataclass
class RotationReport:
    columns: list[ColumnReport] = field(default_factory=list)

    @property
    def rotated(self) -> int:
        return sum(c.rotated for c in self.columns)

    @property
    def non_null(self) -> int:
        return sum(c.non_null for c in self.columns)


def _raw_table(table_name: str, columns: list[str]) -> sa.TableClause:
    """A lightweight Core table over the raw ciphertext (`LargeBinary`), so
    the app's decrypting TypeDecorators never run here."""

    cols = [sa.column("id"), *(sa.column(c, sa.LargeBinary) for c in columns)]
    if _has_updated_at(table_name):
        cols.append(sa.column("updated_at"))
    return sa.table(table_name, *cols)


def _digest(plaintext: bytes) -> bytes:
    return hashlib.sha256(plaintext).digest()


async def rotate_field_key(
    conn: AsyncConnection,
    old_key: bytes,
    new_key: bytes,
    *,
    columns: tuple[tuple[str, str], ...] = ENCRYPTED_COLUMNS,
) -> RotationReport:
    """Re-encrypt every non-null value of `columns` under `new_key` and verify.

    Runs inside the caller's transaction and never commits or rolls back
    itself; it raises `RotationError` on any failure, and the caller rolls
    back (see `run`).
    """

    multi = MultiFernet([Fernet(new_key), Fernet(old_key)])
    new_only, old_only = Fernet(new_key), Fernet(old_key)

    by_table: dict[str, list[str]] = defaultdict(list)
    for table_name, column_name in columns:
        by_table[table_name].append(column_name)

    report = RotationReport()
    for table_name, column_names in by_table.items():
        _check_primary_key(table_name)
        tbl = _raw_table(table_name, column_names)
        reports = {c: ColumnReport(table_name, c) for c in column_names}
        #: (row id, column) -> SHA-256 of the plaintext before rotation.
        digests: dict[tuple[uuid.UUID, str], bytes] = {}

        rows = (
            await conn.execute(
                sa.select(tbl.c.id, *(tbl.c[c] for c in column_names))
                .order_by(tbl.c.id)
                .with_for_update()
            )
        ).all()
        updates: list[dict[str, object]] = []
        for row in rows:
            values: dict[str, object] = {"_id": row.id}
            changed = False
            for c in column_names:
                token = row._mapping[tbl.c[c]]
                if token is None:
                    values[f"_{c}"] = None
                    continue
                token = bytes(token)
                try:
                    digests[(row.id, c)] = _digest(multi.decrypt(token))
                    values[f"_{c}"] = multi.rotate(token)
                except InvalidToken:
                    raise RotationError(
                        f"{table_name}.{c} row {row.id}: the value does not decrypt with "
                        "the old or the new key."
                    ) from None
                reports[c].rotated += 1
                changed = True
            if changed:
                updates.append(values)

        if updates:
            stmt = (
                sa.update(tbl)
                .where(tbl.c.id == sa.bindparam("_id"))
                .values({c: sa.bindparam(f"_{c}") for c in column_names})
            )
            if "updated_at" in tbl.c:
                # A re-encryption is not a data change: keep `updated_at`.
                stmt = stmt.values(updated_at=tbl.c.updated_at)
            await conn.execute(stmt, updates)

        # --- Verify, still inside the transaction -----------------------------------
        for c in column_names:
            reports[c].non_null = (
                await conn.execute(sa.select(sa.func.count(tbl.c[c])))
            ).scalar_one()
        after = (await conn.execute(sa.select(tbl.c.id, *(tbl.c[c] for c in column_names)))).all()
        for row in after:
            for c in column_names:
                token = row._mapping[tbl.c[c]]
                if token is None:
                    continue
                token = bytes(token)
                try:
                    plaintext = new_only.decrypt(token)
                except InvalidToken:
                    raise RotationError(
                        f"{table_name}.{c} row {row.id}: does not decrypt with the new key alone."
                    ) from None
                if digests.get((row.id, c)) != _digest(plaintext):
                    raise RotationError(
                        f"{table_name}.{c} row {row.id}: plaintext changed during rotation."
                    )
                try:
                    old_only.decrypt(token)
                except InvalidToken:
                    pass
                else:
                    raise RotationError(
                        f"{table_name}.{c} row {row.id}: still decrypts with the old key."
                    )
                reports[c].verified += 1
        for c in column_names:
            r = reports[c]
            if not (r.rotated == r.non_null == r.verified):
                raise RotationError(
                    f"{table_name}.{c}: rotated {r.rotated}, non-null {r.non_null}, "
                    f"verified {r.verified}; counts differ."
                )
            report.columns.append(r)

    await _write_audit_row(conn, report)
    return report


async def _write_audit_row(conn: AsyncConnection, report: RotationReport) -> None:
    """One `field_encryption_key.rotate` audit row, counts only (no actor: an
    operator-run script, like other system rows)."""

    from models.audit import AuditLogEntry

    await conn.execute(
        sa.insert(AuditLogEntry).values(
            id=uuid.uuid4(),
            actor_user_id=None,
            action=AUDIT_ACTION,
            entity_type="field_encryption_key",
            entity_id="RPD_FIELD_ENCRYPTION_KEY",
            before_state=None,
            after_state={
                "columns": {f"{r.table}.{r.column}": r.rotated for r in report.columns},
                "rows_rotated": report.rotated,
                "non_null": report.non_null,
            },
            notes="One-off Fernet key rotation (scripts/rotate_field_key.py).",
        )
    )


# --- Entry point ---------------------------------------------------------------------


async def run(
    database_url: str, old_key: bytes, new_key: bytes, *, dry_run: bool
) -> RotationReport:
    """One transaction: rotate + verify, then commit (or roll back on
    `dry_run` or on any error)."""

    engine = create_async_engine(database_url, echo=False, hide_parameters=True)
    try:
        async with engine.connect() as conn:
            trans = await conn.begin()
            try:
                report = await rotate_field_key(conn, old_key, new_key)
            except BaseException:
                await trans.rollback()
                raise
            if dry_run:
                await trans.rollback()
            else:
                await trans.commit()
            return report
    finally:
        await engine.dispose()


def _print_report(report: RotationReport, *, dry_run: bool) -> None:
    for r in report.columns:
        print(
            f"  {r.table}.{r.column}: non-null {r.non_null}, rotated {r.rotated}, "
            f"verified with the new key {r.verified}"
        )
    print(f"Total: rotated {report.rotated} of {report.non_null} non-null values.")
    if dry_run:
        print("DRY RUN: verified, then rolled back. Nothing was changed.")
    else:
        print(
            "Committed. Now set RPD_FIELD_ENCRYPTION_KEY to the new key and restart "
            "the API and every worker."
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m scripts.rotate_field_key",
        description=(
            "Re-encrypt every encrypted column from the old to the new Fernet key in one "
            f"transaction. Keys come from {OLD_KEY_ENV}[_FILE] and {NEW_KEY_ENV}[_FILE], "
            "the database from RPD_DATABASE_URL. Never pass keys as arguments."
        ),
    )
    parser.add_argument("--dry-run", action="store_true", help="rotate and verify, then roll back")
    args = parser.parse_args(argv)

    try:
        check_column_list()
        old_key, new_key = load_keys()
        database_url = os.environ.get("RPD_DATABASE_URL", "").strip()
        if not database_url:
            raise RotationError("RPD_DATABASE_URL is not set.")
        print(
            f"Rotating {len(ENCRYPTED_COLUMNS)} encrypted columns"
            f"{' (dry run)' if args.dry_run else ''}:"
        )
        report = asyncio.run(run(database_url, old_key, new_key, dry_run=args.dry_run))
    except RotationError as exc:
        print(f"ERROR: {exc} Rolled back; nothing was changed.", file=sys.stderr)
        return 1
    except sa.exc.SQLAlchemyError as exc:
        # Parameters are hidden by the engine; print the error class only.
        print(
            f"ERROR: database error ({type(exc).__name__}). Rolled back; nothing was changed.",
            file=sys.stderr,
        )
        return 1
    _print_report(report, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
