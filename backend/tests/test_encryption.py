"""Scenario #5 — encrypted columns (`customer_name`, `tcogs_eur`,
`selling_price_eur`, `gross_margin_pct` on `Project`) actually round-trip
through the ORM, and are opaque (ciphertext, not plaintext/greppable) at the
raw SQL level.
"""

from __future__ import annotations

from decimal import Decimal

from sqlalchemy import select, text

from models import Project
from tests.factories import make_hub, make_project


async def test_encrypted_fields_round_trip_via_orm(db_session):
    hub = await make_hub(db_session)
    project = await make_project(
        db_session,
        hub,
        customer_name="Coca-Cola Hellenic",
        tcogs_eur=Decimal("1234.56"),
        selling_price_eur=Decimal("2500.00"),
        gross_margin_pct=Decimal("42.5"),
    )
    project_id = project.id

    # Force a genuine re-fetch from the database (not just the identity map
    # handing back the same in-memory Python object we just wrote) by
    # expiring every attribute on every object in the session, then
    # re-querying — this round-trips through EncryptedString/EncryptedNumeric's
    # process_bind_param (write) and process_result_value (read) for real.
    db_session.expire_all()
    result = await db_session.execute(select(Project).where(Project.id == project_id))
    fetched = result.scalar_one()

    assert fetched.customer_name == "Coca-Cola Hellenic"
    assert fetched.tcogs_eur == Decimal("1234.56")
    assert fetched.selling_price_eur == Decimal("2500.00")
    assert fetched.gross_margin_pct == Decimal("42.5")


async def test_encrypted_fields_are_opaque_at_raw_sql_level(db_session):
    hub = await make_hub(db_session)
    project = await make_project(
        db_session,
        hub,
        customer_name="Coca-Cola Hellenic",
        tcogs_eur=Decimal("1234.56"),
        selling_price_eur=Decimal("2500.00"),
        gross_margin_pct=Decimal("42.5"),
    )

    row = (
        await db_session.execute(
            text(
                "SELECT customer_name, tcogs_eur, selling_price_eur, gross_margin_pct "
                "FROM projects WHERE id = :id"
            ),
            {"id": project.id},
        )
    ).one()

    # text() queries bypass the ORM's EncryptedString/EncryptedNumeric
    # TypeDecorator, so these are the genuinely raw bytes stored in Postgres.
    assert isinstance(row.customer_name, (bytes, bytearray))
    assert isinstance(row.tcogs_eur, (bytes, bytearray))
    assert isinstance(row.selling_price_eur, (bytes, bytearray))
    assert isinstance(row.gross_margin_pct, (bytes, bytearray))

    # Not plaintext, not a trivially recoverable encoding of the plaintext.
    assert b"Coca-Cola" not in bytes(row.customer_name)
    assert b"1234.56" not in bytes(row.tcogs_eur)
    assert b"2500.00" not in bytes(row.selling_price_eur)
    assert b"42.5" not in bytes(row.gross_margin_pct)

    # Fernet tokens are versioned/base64url — a quick structural sanity check
    # that this is genuinely ciphertext, not e.g. accidental double
    # utf-8-encoding of the plaintext.
    import base64

    decoded_prefix_byte = base64.urlsafe_b64decode(bytes(row.customer_name) + b"==")[:1]
    assert decoded_prefix_byte == b"\x80"  # Fernet version byte


async def test_null_encrypted_fields_round_trip_as_null(db_session):
    hub = await make_hub(db_session)
    project = await make_project(
        db_session,
        hub,
        customer_name=None,
        tcogs_eur=None,
        selling_price_eur=None,
        gross_margin_pct=None,
    )
    row = (
        await db_session.execute(
            text("SELECT customer_name, tcogs_eur FROM projects WHERE id = :id"), {"id": project.id}
        )
    ).one()
    assert row.customer_name is None
    assert row.tcogs_eur is None

    result = await db_session.execute(select(Project).where(Project.id == project.id))
    fetched = result.scalar_one()
    assert fetched.customer_name is None
    assert fetched.tcogs_eur is None
