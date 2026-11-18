"""P47 (ADR 0059 C1): the field-level optimistic check behind every edit.

An edit may carry `base`, the value the user started from for each field it
changes (`schemas.edit_conflict.EditBase`). The caller locks the row(s) first
(`FOR UPDATE`, or the lock that already serialises that field), then calls
`find_conflicts` / `check_base`:

- only fields present both in the request and in `base` are checked; a field
  the request does not send is never checked, so two people editing
  different fields of the same record both succeed;
- a field whose requested value equals the stored one is not a change and is
  never a conflict (both people wanted the same value);
- otherwise, a stored value that differs from `base[field]` is a conflict.

Values are compared after `normalise`, which reduces them to the JSON the
read endpoints serve: enums to their value, UUIDs and dates to strings,
every number to an exact `Decimal` (so `12`, `12.0` and `Decimal("12.00")`
are equal), a blank string to null, and a list of scalars to a sorted list
(every list an edit sends is a set: tags, roles, hub ids, predecessors,
categories, linked projects, hard gates).

On any conflict `raise_edit_conflict` answers 409 `EDIT_CONFLICT` with
`conflicts = [{entity, id, label, field, your_value, current_value,
changed_by, changed_at}]` (`schemas.edit_conflict.EditConflict`). The caller
has written nothing yet, so nothing is stored, audited, marked stale or
dispatched; the request's session ends without a commit.

`changed_by` / `changed_at` come from the latest audit row of that entity
whose before/after state changed the field (`AuditRef.matches`), else the
latest audit row of the entity. `changed_by` is the actor's full name, null
for a system row, and null when the row was written in a hub outside the
caller's scope (the entity's current hub is always in reach: the caller was
just authorised to edit it there).

Financial fields (`models.types.FINANCIAL_FIELD_NAMES`: TCOGS, gross margin,
selling price, customer name) are compared but never echoed: both values are
`"<hidden>"`. Nothing here logs a value.
"""

from __future__ import annotations

import math
import uuid
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from enum import Enum
from typing import Any, NoReturn

from fastapi import status
from sqlalchemy import and_, literal, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import ScenarioEntityType
from models.scenario import ScenarioApplyChange, ScenarioApplyRun
from models.types import FINANCIAL_FIELD_NAMES
from models.user import User
from schemas.edit_conflict import (
    EDIT_CONFLICT,
    EDIT_CONFLICT_MESSAGE,
    HIDDEN_VALUE,
    EditConflict,
)
from services.hub_scope import is_hub_in_scope

#: How many of an entity's newest audit rows are searched for the field.
AUDIT_SEARCH_LIMIT = 200
#: `AuditLogEntry.entity_type` of a priority score row.
PRIORITY_SCORE_ENTITY = "PriorityScore"

Matcher = Callable[[Mapping[str, Any] | None, Mapping[str, Any] | None], bool]

_MISSING = object()


# --- normalisation ------------------------------------------------------------------


def normalise(value: Any) -> Any:
    """`value` as the read endpoints serve it, in a comparable form (module
    docstring)."""

    if value is None:
        return None
    if isinstance(value, Enum):
        return normalise(value.value)
    if isinstance(value, bool):
        return value
    if isinstance(value, int | Decimal):
        return Decimal(value)
    if isinstance(value, float):
        return Decimal(repr(value)) if math.isfinite(value) else repr(value)
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime | date):
        return value
    if isinstance(value, str):
        return value if value.strip() else None
    if isinstance(value, Mapping):
        return {str(k): normalise(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        items = [normalise(v) for v in value]
        if all(not isinstance(v, dict | list) for v in items):
            return sorted(items, key=_sort_key)
        return items
    return value


def _sort_key(value: Any) -> tuple[str, str]:
    if isinstance(value, Decimal):
        return ("n", format(value.normalize(), "f"))
    return (type(value).__name__, str(value))


def _as_decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, Decimal):
        return value
    if isinstance(value, str):
        try:
            return Decimal(value.strip())
        except InvalidOperation:
            return None
    return None


def _as_datetime(value: Any) -> datetime | date | None:
    if isinstance(value, datetime | date):
        return value
    if isinstance(value, str):
        try:
            return datetime.fromisoformat(value.strip())
        except ValueError:
            try:
                return date.fromisoformat(value.strip())
            except ValueError:
                return None
    return None


def _equal(a: Any, b: Any) -> bool:
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, Decimal) or isinstance(b, Decimal):
        da, db_ = _as_decimal(a), _as_decimal(b)
        return da is not None and db_ is not None and da == db_
    if isinstance(a, datetime | date) or isinstance(b, datetime | date):
        ta, tb = _as_datetime(a), _as_datetime(b)
        return ta is not None and tb is not None and ta == tb
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_equal(a[k], b[k]) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_equal(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, str) and isinstance(b, str):
        return a == b or _uuid_equal(a, b)
    return bool(a == b)


def _uuid_equal(a: str, b: str) -> bool:
    try:
        return uuid.UUID(a) == uuid.UUID(b)
    except ValueError:
        return False


def same(a: Any, b: Any) -> bool:
    """Whether two values are equal after `normalise`."""

    return _equal(normalise(a), normalise(b))


def to_json(value: Any) -> Any:
    """A value as JSON for `your_value` / `current_value`."""

    if value is None or isinstance(value, bool | str):
        return value
    if isinstance(value, Enum):
        return to_json(value.value)
    if isinstance(value, int):
        return value
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, uuid.UUID):
        return str(value)
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, list | tuple | set | frozenset):
        return [to_json(v) for v in value]
    return str(value)


def is_financial(field_name: str) -> bool:
    """A financial field, also as the last segment of a dotted name."""

    return field_name.rsplit(".", 1)[-1] in FINANCIAL_FIELD_NAMES


# --- audit references ---------------------------------------------------------------


def dig(state: Mapping[str, Any] | None, path: str) -> Any:
    """The value at a dotted `path` of an audit state, or `_MISSING`."""

    node: Any = state
    for part in path.split("."):
        if not isinstance(node, Mapping) or part not in node:
            return _MISSING
        node = node[part]
    return node


def path_changed(path: str) -> Matcher:
    """An audit row whose after state has `path` and whose before state does
    not, or holds another value."""

    def matches(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> bool:
        new = dig(after, path)
        if new is _MISSING:
            return False
        old = dig(before, path)
        return old is _MISSING or not same(old, new)

    return matches


def stage_changed(step_id: str, path: str) -> Matcher:
    """A project-level audit row (check-in, current step set) whose
    `stages` list changed `path` of step `step_id`."""

    def _stage(state: Mapping[str, Any] | None) -> Any:
        stages = state.get("stages") if isinstance(state, Mapping) else None
        if not isinstance(stages, list):
            return _MISSING
        for stage in stages:
            if isinstance(stage, Mapping) and stage.get("step_id") == step_id:
                return dig(stage, path)
        return _MISSING

    def matches(before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> bool:
        new = _stage(after)
        if new is _MISSING:
            return False
        old = _stage(before)
        return old is _MISSING or not same(old, new)

    return matches


def listed_change(key: str, field_name: str) -> Matcher:
    """An audit row whose after state lists `field_name` under `key` (e.g.
    the what-if scenario rename's `changed: ["name", "note"]`)."""

    def matches(_before: Mapping[str, Any] | None, after: Mapping[str, Any] | None) -> bool:
        listed = dig(after, key)
        return isinstance(listed, list) and field_name in listed

    return matches


@dataclass(frozen=True)
class AuditRef:
    """Where the audit rows of one field live. `matches=None` = any row of
    the entity."""

    entity_type: str
    entity_id: str
    matches: Matcher | None = None


def field_refs(entity_type: str, entity_id: str) -> Callable[[str], Sequence[AuditRef]]:
    """The common case: the field's own key in the entity's audit states."""

    def refs(field_name: str) -> Sequence[AuditRef]:
        return (AuditRef(entity_type, entity_id, path_changed(field_name)),)

    return refs


# --- the check ----------------------------------------------------------------------


@dataclass
class FieldConflict:
    entity: str
    entity_id: str
    label: str | None
    field: str
    your_value: Any
    current_value: Any
    refs: Sequence[AuditRef]
    #: The entity's current hub (its audit rows there are always in reach).
    hub_id: uuid.UUID | None = None
    hidden: bool = False
    #: Whether `changed_by/at` may fall back to the entity's newest audit row
    #: when no row changed the field (False where those rows can name
    #: records outside the caller's scope, P47-R01 L-1).
    fallback: bool = True


def find_conflicts(
    *,
    entity: str,
    entity_id: Any,
    label: str | None,
    base: Mapping[str, Any] | None,
    requested: Mapping[str, Any],
    current: Mapping[str, Any] | Callable[[str], Any],
    refs: Callable[[str], Sequence[AuditRef]],
    hub_id: uuid.UUID | None = None,
    fallback: bool = True,
) -> list[FieldConflict]:
    """The conflicting fields of one record (module docstring). `requested`
    holds only the fields the request sends; `current` gives the stored
    value of a field (a mapping, or a function for values that are costly or
    sensitive to read). Call it under the row lock, before any write."""

    if not base:
        return []
    out: list[FieldConflict] = []
    for name, wanted in requested.items():
        if name not in base:
            continue
        if callable(current):
            stored = current(name)
        else:
            if name not in current:
                continue
            stored = current[name]
        if same(wanted, stored) or same(base[name], stored):
            continue
        out.append(
            FieldConflict(
                entity=entity,
                entity_id=str(entity_id),
                label=label,
                field=name,
                your_value=wanted,
                current_value=stored,
                refs=tuple(refs(name)),
                hub_id=hub_id,
                hidden=is_financial(name),
                fallback=fallback,
            )
        )
    return out


#: Audit states record a free-text field by its length only.
_STAGE_AUDIT_KEYS = {"blocked_reason": "blocked_reason_length"}


def step_conflicts(
    *,
    project_id: uuid.UUID,
    project_name: str | None,
    hub_id: uuid.UUID | None,
    step_id: str,
    step_row_id: uuid.UUID,
    base: Mapping[str, Any] | None,
    requested: Mapping[str, Any],
    current: Mapping[str, Any],
) -> list[FieldConflict]:
    """`find_conflicts` for one stage of a project (stage PATCH, check-in,
    step pin). The conflict is `entity = "project_step"`, `id` = the project
    id and `field = "<step_id>.<field>"`; `base` uses the plain field names.
    The audit rows searched are the stage's own (stage PATCH, pins) and the
    project's check-in / current-step rows that list the stage."""

    if not base:
        return []
    prefix = f"{step_id}."

    def refs(name: str) -> Sequence[AuditRef]:
        plain = name[len(prefix) :]
        key = _STAGE_AUDIT_KEYS.get(plain, plain)
        return (
            AuditRef("ProjectWorkflowStep", str(step_row_id), path_changed(key)),
            AuditRef("Project", str(project_id), stage_changed(step_id, key)),
        )

    return find_conflicts(
        entity="project_step",
        entity_id=project_id,
        label=project_name,
        base={prefix + k: v for k, v in base.items()},
        requested={prefix + k: v for k, v in requested.items()},
        current={prefix + k: v for k, v in current.items()},
        refs=refs,
        hub_id=hub_id,
    )


def priority_score_conflicts(
    *,
    project_id: uuid.UUID,
    project_name: str | None,
    hub_id: uuid.UUID | None,
    score_id: uuid.UUID | None,
    stored: Mapping[str, Any] | None,
    base: Mapping[str, Any] | None,
    scores: Mapping[str, Any],
    hard_gates: Sequence[Any] | None,
) -> list[FieldConflict]:
    """`find_conflicts` for one project's priority score (`PUT
    /priorities/{id}`, Matrix scenario Apply). `stored` is the score's
    `services.audit_helpers.priority_score_audit_state` (None: no score row
    yet, every dimension unscored, no hard gate). `base` mirrors the request:
    `{"scores": {key: 0..5|null}, "hard_gates": [...]}`; conflicts are
    `field = "scores.<key>"` / `"hard_gates"`. `hard_gates=None`: the request
    did not send them."""

    if not base:
        return []
    stored_scores = (stored or {}).get("scores") or {}
    flat_base: dict[str, Any] = {}
    base_scores = base.get("scores")
    if isinstance(base_scores, Mapping):
        flat_base.update({f"scores.{k}": v for k, v in base_scores.items()})
    if "hard_gates" in base:
        flat_base["hard_gates"] = base["hard_gates"]
    requested: dict[str, Any] = {f"scores.{k}": v for k, v in scores.items()}
    current: dict[str, Any] = {f"scores.{k}": stored_scores.get(k) for k in scores}
    if hard_gates is not None:
        requested["hard_gates"] = list(hard_gates)
        current["hard_gates"] = list((stored or {}).get("hard_gates") or [])
    entity_id = str(score_id) if score_id is not None else ""
    return find_conflicts(
        entity="priority_score",
        entity_id=project_id,
        label=project_name,
        base=flat_base,
        requested=requested,
        current=current,
        refs=field_refs(PRIORITY_SCORE_ENTITY, entity_id),
        hub_id=hub_id,
    )


async def latest_change(
    db: AsyncSession,
    principal: Principal,
    refs: Sequence[AuditRef],
    *,
    entity_hub_id: uuid.UUID | None = None,
    fallback: bool = True,
) -> tuple[str | None, str | None]:
    """`(changed_by, changed_at)` for one conflicting field (module
    docstring). Bound parameters only."""

    if not refs:
        return None, None
    pairs = sorted({(r.entity_type, r.entity_id) for r in refs})
    rows: list[Any] = list(
        (
            await db.execute(
                select(
                    AuditLogEntry.entity_type,
                    AuditLogEntry.entity_id,
                    AuditLogEntry.occurred_at,
                    AuditLogEntry.actor_user_id,
                    AuditLogEntry.hub_id,
                    AuditLogEntry.before_state,
                    AuditLogEntry.after_state,
                )
                .where(
                    or_(
                        *(
                            and_(AuditLogEntry.entity_type == et, AuditLogEntry.entity_id == eid)
                            for et, eid in pairs
                        )
                    )
                )
                .order_by(AuditLogEntry.occurred_at.desc())
                .limit(AUDIT_SEARCH_LIMIT)
            )
        ).all()
    )
    score_ids = sorted({r.entity_id for r in refs if r.entity_type == PRIORITY_SCORE_ENTITY})
    if score_ids:
        # A Matrix grid / scenario Apply writes its per-score before/after
        # into `scenario_apply_changes` (one audit row per run), so those
        # count as the score's change history too.
        rows.extend(
            (
                await db.execute(
                    select(
                        literal(PRIORITY_SCORE_ENTITY).label("entity_type"),
                        ScenarioApplyChange.entity_id,
                        ScenarioApplyRun.created_at.label("occurred_at"),
                        ScenarioApplyRun.applied_by_user_id.label("actor_user_id"),
                        ScenarioApplyChange.hub_id,
                        ScenarioApplyChange.before_state,
                        ScenarioApplyChange.after_state,
                    )
                    .join(
                        ScenarioApplyRun,
                        ScenarioApplyRun.id == ScenarioApplyChange.scenario_apply_run_id,
                    )
                    .where(
                        ScenarioApplyChange.entity_type == ScenarioEntityType.PRIORITY_SCORE,
                        ScenarioApplyChange.entity_id.in_(score_ids),
                    )
                    .order_by(ScenarioApplyRun.created_at.desc())
                    .limit(AUDIT_SEARCH_LIMIT)
                )
            ).all()
        )
        rows.sort(key=lambda r: r.occurred_at, reverse=True)
    chosen = None
    for row in rows:
        if any(
            (r.entity_type, r.entity_id) == (row.entity_type, row.entity_id)
            and (r.matches is None or r.matches(row.before_state, row.after_state))
            for r in refs
        ):
            chosen = row
            break
    if chosen is None and fallback:
        primary = (refs[0].entity_type, refs[0].entity_id)
        chosen = next((r for r in rows if (r.entity_type, r.entity_id) == primary), None)
    if chosen is None:
        return None, None
    changed_at = chosen.occurred_at.isoformat() if chosen.occurred_at is not None else None
    visible = (
        chosen.hub_id is None
        or chosen.hub_id == entity_hub_id
        or is_hub_in_scope(principal, chosen.hub_id)
    )
    if chosen.actor_user_id is None or not visible:
        return None, changed_at
    name = (
        await db.execute(select(User.full_name).where(User.id == chosen.actor_user_id))
    ).scalar_one_or_none()
    return name, changed_at


async def edit_conflict_error(
    db: AsyncSession, principal: Principal, conflicts: Iterable[FieldConflict]
) -> CodedHTTPException:
    """The 409 `EDIT_CONFLICT` for `conflicts` (at least one)."""

    out: list[dict[str, Any]] = []
    cache: dict[tuple[Any, ...], tuple[str | None, str | None]] = {}
    for c in conflicts:
        key = (tuple(c.refs), c.hub_id, c.fallback)
        if key not in cache:
            cache[key] = await latest_change(
                db, principal, c.refs, entity_hub_id=c.hub_id, fallback=c.fallback
            )
        changed_by, changed_at = cache[key]
        out.append(
            EditConflict(
                entity=c.entity,
                id=c.entity_id,
                label=c.label,
                field=c.field,
                your_value=HIDDEN_VALUE if c.hidden else to_json(c.your_value),
                current_value=HIDDEN_VALUE if c.hidden else to_json(c.current_value),
                changed_by=changed_by,
                changed_at=changed_at,
            ).model_dump(mode="json")
        )
    return CodedHTTPException(
        status.HTTP_409_CONFLICT,
        EDIT_CONFLICT,
        EDIT_CONFLICT_MESSAGE,
        extra={"conflicts": out},
    )


async def raise_edit_conflict(
    db: AsyncSession, principal: Principal, conflicts: Sequence[FieldConflict]
) -> None:
    """Raise the 409 when there is any conflict; return otherwise."""

    if conflicts:
        await _raise(db, principal, conflicts)


async def _raise(
    db: AsyncSession, principal: Principal, conflicts: Sequence[FieldConflict]
) -> NoReturn:
    raise await edit_conflict_error(db, principal, conflicts)


async def check_base(
    db: AsyncSession,
    principal: Principal,
    *,
    entity: str,
    entity_id: Any,
    label: str | None,
    base: Mapping[str, Any] | None,
    requested: Mapping[str, Any],
    current: Mapping[str, Any] | Callable[[str], Any],
    refs: Callable[[str], Sequence[AuditRef]],
    hub_id: uuid.UUID | None = None,
    fallback: bool = True,
) -> None:
    """`find_conflicts` for one record, then the 409 if any."""

    await raise_edit_conflict(
        db,
        principal,
        find_conflicts(
            entity=entity,
            entity_id=entity_id,
            label=label,
            base=base,
            requested=requested,
            current=current,
            refs=refs,
            hub_id=hub_id,
            fallback=fallback,
        ),
    )
