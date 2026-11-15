"""Adding a category (P33-T11; ADR 0047 §2 as amended at P33-T01;
DOMAIN_RULES "Category templates" §E; contract P33 B2).

One transaction, owned by the caller (`api.routers.workflow_templates`):

1. every category row is locked (`FOR UPDATE`, code order), so two adds and
   an apply serialise; the table is read again after the lock;
2. validation: `code` trimmed, 1..16 of `[A-Za-z0-9+\\- ]`, not `OEM`
   (422 `BAD_CATEGORY_CODE`), unique case-insensitively (409
   `CATEGORY_EXISTS`); `copy_from` an existing category of `workflow_id`
   (422 `BAD_COPY_SOURCE`); `insert_after` an existing code or null (422
   `BAD_POSITION`);
3. ranks renumbered densely with the new code right after `insert_after`
   (first for null), in ONE `UPDATE … SET rank = CASE …` (the rank unique
   constraint is checked at statement end); the relative order of the
   existing categories is unchanged;
4. the new row (`template_version = 1`, `copied_from_code`, `created_by`) and
   the 14 template rows copied from the source (`weeks`, `gap_weeks`,
   `effort_weight_weeks`: the immutable R2 weights are copied, never
   re-based on `weeks`);
5. every engineer whose `allowed_categories` contains `copy_from` gets the new
   code appended (rows locked, id order). An engineer with the blanket `OEM`
   value already covers a new OEM-workflow category (CAT_NOT_ALLOWED reads
   the category's `workflow_id`), so nothing is appended for that.

Nothing is marked stale and no run is dispatched: no project has the
category yet. Audit rows are the caller's (`category.created`, one
`engineer.allowed_categories_extended` per engineer, lists only).
"""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from typing import Any

from sqlalchemy import any_, case, literal, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from api.errors import HTTP_422, CodedHTTPException
from models.category import (
    CATEGORY_CODE_MAX_LENGTH,
    CATEGORY_CODE_PATTERN,
    RESERVED_ELIGIBILITY_CODE,
    Category,
)
from models.engineer import Engineer
from models.workflow import Workflow as WorkflowRow
from models.workflow import WorkflowLeadTime

_CODE_RE = re.compile(CATEGORY_CODE_PATTERN)


@dataclass(frozen=True)
class EngineerExtension:
    engineer_id: uuid.UUID
    hub_id: uuid.UUID
    before: list[str]
    after: list[str]


@dataclass(frozen=True)
class CategoryAdded:
    category: Category
    #: Every category in rank order after the insert.
    ordered: list[Category]
    template_rows: list[dict[str, Any]]
    engineers: list[EngineerExtension]


def _code_error(message: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, "BAD_CATEGORY_CODE", message)


def normalise_code(raw: str) -> str:
    """The trimmed code, or 422 `BAD_CATEGORY_CODE`."""

    code = raw.strip()
    if not 1 <= len(code) <= CATEGORY_CODE_MAX_LENGTH:
        raise _code_error(f"code must be 1..{CATEGORY_CODE_MAX_LENGTH} characters")
    if not _CODE_RE.match(code):
        raise _code_error("code may contain only letters, digits, '+', '-' and spaces")
    if code.upper() == RESERVED_ELIGIBILITY_CODE:
        raise _code_error(f"{RESERVED_ELIGIBILITY_CODE!r} is reserved and cannot be a category")
    return code


async def add_category(
    db: AsyncSession,
    *,
    code: str,
    label: str | None,
    workflow_id: str,
    copy_from: str,
    insert_after: str | None,
    actor_user_id: uuid.UUID | None,
) -> CategoryAdded:
    """Steps 1–5 of the module docstring; flushes, never commits."""

    code = normalise_code(code)
    label = (label or "").strip() or code

    locked = (
        (
            await db.execute(
                select(Category)
                .order_by(Category.code)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    by_code = {c.code: c for c in locked}
    if any(c.code.lower() == code.lower() for c in locked):
        raise CodedHTTPException(
            409, "CATEGORY_EXISTS", f"A category {code!r} already exists (codes ignore case)."
        )
    workflow_exists = (
        await db.execute(select(WorkflowRow.id).where(WorkflowRow.id == workflow_id))
    ).scalar_one_or_none()
    source = by_code.get(copy_from)
    if workflow_exists is None or source is None or source.workflow_id != workflow_id:
        raise CodedHTTPException(
            HTTP_422,
            "BAD_COPY_SOURCE",
            f"copy_from must be an existing category of workflow {workflow_id!r}",
        )
    if insert_after is not None and insert_after not in by_code:
        raise CodedHTTPException(
            HTTP_422, "BAD_POSITION", "insert_after must be an existing category code or null"
        )

    ordered_codes = [c.code for c in sorted(locked, key=lambda c: (c.rank, c.code))]
    position = 0 if insert_after is None else ordered_codes.index(insert_after) + 1
    new_order = [*ordered_codes[:position], code, *ordered_codes[position:]]
    new_rank = {c: i for i, c in enumerate(new_order, start=1)}
    moved = {c: new_rank[c] for c in ordered_codes if by_code[c].rank != new_rank[c]}
    if moved:
        await db.execute(
            update(Category)
            .where(Category.code.in_(sorted(moved)))
            .values(rank=case(moved, value=Category.code))
            .execution_options(synchronize_session=False)
        )

    category = Category(
        code=code,
        label=label,
        workflow_id=workflow_id,
        rank=new_rank[code],
        template_version=1,
        copied_from_code=copy_from,
        active=True,
        created_by=actor_user_id,
    )
    db.add(category)
    await db.flush()

    source_rows = (
        (
            await db.execute(
                select(WorkflowLeadTime)
                .where(
                    WorkflowLeadTime.workflow_id == workflow_id,
                    WorkflowLeadTime.category == copy_from,
                )
                .order_by(WorkflowLeadTime.step_id)
            )
        )
        .scalars()
        .all()
    )
    copied: list[dict[str, Any]] = []
    for r in source_rows:
        db.add(
            WorkflowLeadTime(
                workflow_id=workflow_id,
                category=code,
                step_id=r.step_id,
                weeks=r.weeks,
                gap_weeks=r.gap_weeks,
                effort_weight_weeks=r.effort_weight_weeks,
            )
        )
        copied.append(
            {
                "step_id": r.step_id,
                "weeks": r.weeks,
                "gap_weeks": r.gap_weeks,
                "effort_weight_weeks": r.effort_weight_weeks,
            }
        )

    engineers = (
        (
            await db.execute(
                select(Engineer)
                .where(literal(copy_from) == any_(Engineer.allowed_categories))
                .order_by(Engineer.id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    extended: list[EngineerExtension] = []
    for e in engineers:
        before = list(e.allowed_categories or [])
        if code in before:  # pragma: no cover - the code is new, the trigger forbids it
            continue
        after = [*before, code]
        e.allowed_categories = after
        extended.append(
            EngineerExtension(engineer_id=e.id, hub_id=e.hub_id, before=before, after=after)
        )
    await db.flush()

    ordered = (
        (
            await db.execute(
                select(Category)
                .order_by(Category.rank, Category.code)
                .execution_options(populate_existing=True)
            )
        )
        .scalars()
        .all()
    )
    return CategoryAdded(
        category=category,
        ordered=list(ordered),
        template_rows=copied,
        engineers=extended,
    )
