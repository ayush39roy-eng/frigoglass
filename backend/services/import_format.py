"""The stored What-if import format (P41-T02, ADR 0055 D1, API_CONTRACT_P41 A).

One row (`import_format_settings.id = 1`) holds the header aliases per parser
field. No row means the built-in aliases (`plan_import_xlsx._FIELDS`) at
version 0. Admin and Super Admin change it with an optimistic `version`;
every change writes an audit row with the before and after alias lists (no
financial field is involved). The parser stays pure: the aliases are passed in
(`parse_plan_workbook(..., aliases=...)`).
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.import_scenario import ImportFormatSettings
from models.user import User
from schemas.import_scenarios import ImportFormatFieldOut, ImportFormatOut
from services.export_builder import xlsx_bytes
from services.plan_import_xlsx import (
    FIELD_KEYS,
    STEP_LETTERS,
    WORKFLOWS,
    default_field_aliases,
    norm_alias,
)
from services.whatif_baseline import principal_audit_hub_id
from services.xlsx_writer import SheetBook

#: ADR 0055 D1 / API_CONTRACT_P41 A: fixed plain-English labels.
FIELD_LABELS: dict[str, str] = {
    "sn": "S/N",
    "code": "Project code",
    "plant": "Plant",
    "expenses": "Expenses",
    "priority": "Priority",
    "name": "Project name",
    "hub": "Hub",
    "category": "Category",
    "stage": "Stage",
    "status": "Status",
    "engineer": "Design engineer",
    "spillover": "Spillover",
    "num_projects": "Number of projects",
    "must_do": "Must do",
    "complexity": "Complexity",
    "est_duration": "Estimated duration (months)",
    # ADR 0061 (R49-1): the band columns set the row's priority.
    "band_p1": "Must do (P1)",
    "band_p2": "Good to have (P2)",
    "band_p3": "In queue (P3)",
    "band_p4": "Not approved / on hold / no priority (P4)",
}
assert tuple(FIELD_LABELS) == FIELD_KEYS

MAX_ALIASES_PER_FIELD = 10
MAX_ALIAS_LENGTH = 60

FORMAT_UNKNOWN_FIELD = "FORMAT_UNKNOWN_FIELD"
FORMAT_ALIAS_INVALID = "FORMAT_ALIAS_INVALID"
FORMAT_ALIAS_DUPLICATE = "FORMAT_ALIAS_DUPLICATE"
FORMAT_REQUIRED_MISSING = "FORMAT_REQUIRED_MISSING"
FORMAT_TOO_MANY_ALIASES = "FORMAT_TOO_MANY_ALIASES"
FORMAT_VERSION_CONFLICT = "FORMAT_VERSION_CONFLICT"

EDITOR_ROLES: frozenset[RoleName] = frozenset({RoleName.ADMIN, RoleName.SUPER_ADMIN})


def can_edit_format(principal: Principal) -> bool:
    return bool(principal.roles & EDITOR_ROLES)


def _err(code: str, message: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, code, message)


def _stored_aliases(row: ImportFormatSettings | None) -> dict[str, tuple[str, ...]]:
    """The stored aliases, completed with the built-in set for any key a row
    lacks (a key added to the parser later) and stripped of unknown keys."""

    out = default_field_aliases()
    if row is None:
        return out
    stored = row.field_aliases or {}
    for key in FIELD_KEYS:
        value = stored.get(key)
        # An empty list is stored on purpose (Status or Hub may be empty).
        if isinstance(value, list) and all(isinstance(a, str) for a in value):
            out[key] = tuple(value)
    return out


async def _row(db: AsyncSession, *, lock: bool = False) -> ImportFormatSettings | None:
    stmt = select(ImportFormatSettings).where(ImportFormatSettings.id == 1)
    if lock:
        stmt = stmt.with_for_update()
    return (await db.execute(stmt)).scalar_one_or_none()


async def current_aliases(db: AsyncSession) -> dict[str, tuple[str, ...]]:
    """The aliases the parser uses now (the stored format, else built-in)."""

    return _stored_aliases(await _row(db))


async def format_out(db: AsyncSession, principal: Principal) -> ImportFormatOut:
    row = await _row(db)
    aliases = _stored_aliases(row)
    defaults = default_field_aliases()
    updated_by_name: str | None = None
    if row is not None and row.updated_by is not None:
        updated_by_name = (
            await db.execute(select(User.full_name).where(User.id == row.updated_by))
        ).scalar_one_or_none()
    return ImportFormatOut(
        version=0 if row is None else row.version,
        is_default=row is None or aliases == defaults,
        fields=[
            ImportFormatFieldOut(
                key=key,
                label=FIELD_LABELS[key],
                required=key == "name",
                aliases=list(aliases[key]),
                default_aliases=list(defaults[key]),
            )
            for key in FIELD_KEYS
        ],
        updated_at=None if row is None else row.updated_at,
        updated_by_name=updated_by_name,
        can_edit=can_edit_format(principal),
    )


def validate_aliases(
    current: Mapping[str, Sequence[str]], changes: Mapping[str, Sequence[str]]
) -> dict[str, tuple[str, ...]]:
    """ADR 0055 D1 validation. `changes` replaces the given keys; a key left
    out keeps its `current` aliases. Returns the normalised full set in
    FIELD_KEYS order. Every alias is normalised the way the parser normalises
    a header cell (casefold, single spaces); duplicates inside one field are
    folded."""

    unknown = sorted(k for k in changes if k not in FIELD_KEYS)
    if unknown:
        raise _err(FORMAT_UNKNOWN_FIELD, f"Unknown field(s): {', '.join(unknown)}.")
    merged: dict[str, tuple[str, ...]] = {}
    for key in FIELD_KEYS:
        raw = changes[key] if key in changes else current.get(key, ())
        if len(raw) > MAX_ALIASES_PER_FIELD:
            raise _err(
                FORMAT_TOO_MANY_ALIASES,
                f"{FIELD_LABELS[key]}: at most {MAX_ALIASES_PER_FIELD} header names.",
            )
        normed: list[str] = []
        for alias in raw:
            n = norm_alias(alias)
            if not n or len(n) > MAX_ALIAS_LENGTH or not n.isprintable():
                raise _err(
                    FORMAT_ALIAS_INVALID,
                    f"{FIELD_LABELS[key]}: a header name must be 1 to {MAX_ALIAS_LENGTH} "
                    "printable characters.",
                )
            if n not in normed:
                normed.append(n)
        merged[key] = tuple(normed)
    if not merged["name"]:
        raise _err(FORMAT_REQUIRED_MISSING, "Project name needs at least one header name.")
    if not merged["status"] and not merged["hub"]:
        raise _err(FORMAT_REQUIRED_MISSING, "Status or Hub needs at least one header name.")
    for key, aliases in merged.items():
        if not aliases and key not in ("status", "hub"):
            raise _err(FORMAT_ALIAS_INVALID, f"{FIELD_LABELS[key]}: give at least one header name.")
    owner: dict[str, str] = {}
    for key, aliases in merged.items():
        for alias in aliases:
            if alias in owner:
                raise _err(
                    FORMAT_ALIAS_DUPLICATE,
                    f"The header name {alias!r} is given for both "
                    f"{FIELD_LABELS[owner[alias]]} and {FIELD_LABELS[key]}.",
                )
            owner[alias] = key
    return merged


def _version_conflict() -> CodedHTTPException:
    return CodedHTTPException(
        409,
        FORMAT_VERSION_CONFLICT,
        "Someone else changed the import format. Reload and try again.",
    )


async def _write(
    db: AsyncSession,
    principal: Principal,
    *,
    expected_version: int,
    aliases: Mapping[str, Sequence[str]] | None,
    action: str,
) -> None:
    """Store `aliases` (None = reset to built-in) under the optimistic lock
    and write the audit row. The caller commits."""

    row = await _row(db, lock=True)
    version = 0 if row is None else row.version
    if expected_version != version:
        raise _version_conflict()
    before = _stored_aliases(row)
    after = (
        default_field_aliases() if aliases is None else {k: tuple(v) for k, v in aliases.items()}
    )
    payload: dict[str, Any] = {k: list(after[k]) for k in FIELD_KEYS}
    if row is None:
        row = ImportFormatSettings(
            id=1, version=1, field_aliases=payload, updated_by=principal.user_id
        )
        db.add(row)
    else:
        row.version = version + 1
        row.field_aliases = payload
        row.updated_by = principal.user_id
        row.updated_at = datetime.now(UTC)
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=action,
            entity_type="ImportFormatSettings",
            entity_id="1",
            hub_id=principal_audit_hub_id(principal),
            before_state={
                "version": version,
                "field_aliases": {k: list(before[k]) for k in FIELD_KEYS},
            },
            after_state={"version": version + 1, "field_aliases": payload},
        )
    )
    await db.flush()


async def update_format(
    db: AsyncSession,
    principal: Principal,
    *,
    version: int,
    changes: Mapping[str, Sequence[str]],
) -> None:
    current = await current_aliases(db)
    merged = validate_aliases(current, changes)
    await _write(
        db, principal, expected_version=version, aliases=merged, action="import_format.updated"
    )


async def reset_format(db: AsyncSession, principal: Principal, *, version: int) -> None:
    await _write(
        db, principal, expected_version=version, aliases=None, action="import_format.reset"
    )


# --- the blank template ----------------------------------------------------------------------


def _title(alias: str) -> str:
    return alias.title()


def template_xlsx(aliases: Mapping[str, Sequence[str]]) -> bytes:
    """API_CONTRACT_P41 A: sheet `Projects` with the first alias of each field
    (Title Case, FIELD_KEYS order) as its header row; sheet `Process steps`
    with one PDD and one OEM section in the layout `_read_steps_sheet` reads
    (the 14 step codes) and an empty category row under each. Built through
    `export_builder.xlsx_bytes`, so every cell is a text cell."""

    headers = [_title(aliases[k][0]) for k in FIELD_KEYS if aliases.get(k)]
    # (A field with no alias, Status or Hub, has no template column.)
    first = "PD RoadMap Steps -->"
    pdd_codes = [f"PDD-{letter}" for letter in STEP_LETTERS]
    steps_headers = [first, *pdd_codes]

    def blank() -> dict[str, Any]:
        return {h: None for h in steps_headers}

    def category_header() -> dict[str, Any]:
        return {**blank(), first: "Project Category", pdd_codes[0]: "Lead Times (wks) per Phase"}

    # PDD section: the header row is the section row; then the category
    # header row and one empty category row to fill in.
    steps_rows: list[dict[str, Any]] = [category_header(), blank()]
    for wf in WORKFLOWS[1:]:
        section = {first: "OEM Development Steps -->"}
        for pdd, letter in zip(pdd_codes, STEP_LETTERS, strict=True):
            section[pdd] = f"{wf}-{letter}"
        steps_rows.extend([blank(), section, category_header(), blank()])
    # P43 (ADR 0057 D1): the header styling only. No title block and the
    # headers exactly as given, so the parser reads the template unchanged.
    return xlsx_bytes(
        SheetBook(
            {"Projects": (headers, []), "Process steps": (steps_headers, steps_rows)},
            title_block=False,
            raw_headers=True,
        )
    )
