"""Encrypted column types for commercially sensitive financial fields.

Per CLAUDE.md's non-negotiables and docs/DOMAIN_RULES.md: TCOGS, gross margin,
selling price and customer name are commercially sensitive — encrypted at rest,
never logged. Every model column holding one of those four fields MUST use
`EncryptedString` or `EncryptedNumeric` from this module. Nothing else in this
codebase should reach for `cryptography.fernet` directly.

Key management: the encryption key is read from the `RPD_FIELD_ENCRYPTION_KEY`
environment variable (a urlsafe-base64 32-byte Fernet key). In production this
must come from Vault or Docker secrets (P6-T04), never a committed `.env` file —
this module only knows how to *read* the key from the environment, it does not
generate, rotate or provision one. Do not `print`, `log`, `repr()` or otherwise
surface the decrypted value of any column using these types — that would defeat
the point of encrypting it.
"""

from __future__ import annotations

import os
from decimal import Decimal, InvalidOperation
from functools import lru_cache

import sqlalchemy as sa
from sqlalchemy.types import TypeDecorator

_ENV_VAR = "RPD_FIELD_ENCRYPTION_KEY"


@lru_cache(maxsize=1)
def _fernet():
    """Lazily constructed, process-cached Fernet instance.

    Cached rather than re-read per call so a missing/invalid key fails fast and
    loudly the first time a mutation touches an encrypted column, rather than
    silently varying between calls. Import is local to keep `cryptography` an
    optional-at-import-time dependency for tooling that only needs the plain
    (non-encrypted) models (e.g. a future read-only reporting script) — though in
    practice it's a hard runtime dependency for this app.
    """
    from cryptography.fernet import Fernet

    key = os.environ.get(_ENV_VAR)
    if not key:
        raise RuntimeError(
            f"{_ENV_VAR} is not set. Financial/PII columns cannot be read or "
            "written without a field encryption key. See "
            "backend/models/types.py module docstring."
        )
    return Fernet(key.encode("utf-8"))


def _encrypt(plaintext: str) -> bytes:
    return _fernet().encrypt(plaintext.encode("utf-8"))


def _decrypt(ciphertext: bytes) -> str:
    return _fernet().decrypt(ciphertext).decode("utf-8")


class EncryptedString(TypeDecorator):
    """Application-level encrypted text column (Fernet, authenticated
    symmetric encryption). Use for `customer_name` and any other free-text
    commercially-sensitive field. Stored as `LargeBinary` — ciphertext is not
    human-readable or greppable in a `psql` session, which is intentional.
    """

    impl = sa.LargeBinary
    cache_ok = True

    def process_bind_param(self, value: str | None, dialect) -> bytes | None:  # noqa: ANN001
        if value is None:
            return None
        return _encrypt(value)

    def process_result_value(self, value: bytes | None, dialect) -> str | None:  # noqa: ANN001
        if value is None:
            return None
        return _decrypt(value)


class EncryptedNumeric(TypeDecorator):
    """Application-level encrypted numeric column. Use for `tcogs_eur`,
    `selling_price_eur`, `gross_margin_pct` and any other commercially-sensitive
    numeric field. Values round-trip through `Decimal` (never `float`, to avoid
    binary floating-point rounding on financial figures) serialised as a decimal
    string before encryption.
    """

    impl = sa.LargeBinary
    cache_ok = True

    def process_bind_param(self, value: Decimal | int | float | None, dialect) -> bytes | None:  # noqa: ANN001
        if value is None:
            return None
        return _encrypt(str(Decimal(str(value))))

    def process_result_value(self, value: bytes | None, dialect) -> Decimal | None:  # noqa: ANN001
        if value is None:
            return None
        try:
            return Decimal(_decrypt(value))
        except InvalidOperation as exc:  # pragma: no cover - defensive
            raise ValueError("Decrypted value is not a valid Decimal") from exc


#: Field names that must never appear in audit-log before/after JSON snapshots,
#: application logs, or error messages, per CLAUDE.md's non-negotiable. P3's
#: audit-writing code (AuditLogEntry, backend/models/audit.py) must redact these
#: keys from any dict it serialises. Kept here, next to the encrypted types, so
#: there is exactly one place that has to be kept in sync with which columns are
#: encrypted.
FINANCIAL_FIELD_NAMES: frozenset[str] = frozenset(
    {"tcogs_eur", "selling_price_eur", "gross_margin_pct", "customer_name"}
)
