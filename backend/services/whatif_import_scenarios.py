"""Saved What-if import scenarios and the scenario exports (P41-T02, ADR 0055
D3–D5, docs/API_CONTRACT_P41.md C and D).

**Server-computed only.** Save and the "current result" export re-run the
import simulate on the request (`whatif_import.do_import_simulate`, the same
path as `/whatif/import/simulate`, at the request's plan clock). A result
sent by the browser is never accepted, persisted or echoed.

**Frozen record.** A saved row keeps the request, the served response, the
week it was simulated at, the active run version and the hubs it touches. It
never feeds the live plan.

**Visibility (ADR 0055 D3), enforced in the queries here:**
- Admin and Super Admin see every scenario.
- Anyone else with What-if access sees a scenario when their hub scope
  covers every one of its `hub_codes` (`hub_codes <@ scope`), and always
  sees the ones they saved themselves (they computed it; P41-T02 clarification).
- An invisible scenario is answered exactly like a missing one (404).
- Rename / delete: the creator, Admin or Super Admin (403 for anyone else who
  can see it).

**Audit.** Save, rename, delete and export write one row each, with the id,
the name and counts only. Never the request or the result.

**Snapshots carry no financial field.** `ImportSimulateRequest` and
`ImportSimulateResponse` have no customer, TCOGS, margin or price field.
"""

from __future__ import annotations

import json
import re
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import ColumnElement, and_, delete, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_413, HTTP_422, CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from models.enums import RoleName
from models.import_scenario import WhatifImportScenario
from models.user import User
from schemas.import_scenarios import (
    SavedScenarioOut,
    SavedScenarioSummary,
    ScenarioPatchIn,
    ScenarioSaveIn,
)
from schemas.whatif_import import (
    BreakdownBucketOut,
    ImportKpisOut,
    ImportSimulateRequest,
    ImportSimulateResponse,
)
from services.active_run import get_active_run
from services.export_builder import ExportSheets, neutralise_formula, xlsx_bytes
from services.whatif_baseline import Scope, WhatIfContext, principal_audit_hub_id, resolve_scope
from services.whatif_import import do_import_simulate, safe_file_name

#: ADR 0055 D3.
MAX_SCENARIOS_PER_USER = 200
MAX_SCENARIOS_TOTAL = 2000
MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024
#: API_CONTRACT_P41 D.
#: P41-R01 (M-1): list paging.
DEFAULT_LIST_LIMIT = 50
MAX_LIST_LIMIT = 200
MIN_COMPARE = 2
MAX_COMPARE = 4

SCENARIO_LIMIT = "SCENARIO_LIMIT"
SCENARIO_TOO_LARGE = "SCENARIO_TOO_LARGE"
SCENARIO_NOT_FOUND = "SCENARIO_NOT_FOUND"
SCENARIO_FORBIDDEN = "SCENARIO_FORBIDDEN"
INVALID_COMPARE = "INVALID_COMPARE"

_ADMIN_ROLES = frozenset({RoleName.ADMIN, RoleName.SUPER_ADMIN})

XLSX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def is_admin(principal: Principal) -> bool:
    return bool(principal.roles & _ADMIN_ROLES)


def not_found() -> CodedHTTPException:
    return CodedHTTPException(404, SCENARIO_NOT_FOUND, "Saved scenario not found.")


# --- visibility ---------------------------------------------------------------------------------


def _visible_clause(principal: Principal, scope: Scope) -> ColumnElement[bool] | None:
    """None = no filter (Admin, Super Admin, an all-hubs caller)."""

    if is_admin(principal) or scope.all_hubs:
        return None
    # P41-R01 (security H-1): an empty `hub_codes` never grants visibility
    # (`'{}' <@ x` is true for every x); such a row is creator / Admin only.
    return or_(
        WhatifImportScenario.created_by == principal.user_id,
        and_(
            func.cardinality(WhatifImportScenario.hub_codes) > 0,
            WhatifImportScenario.hub_codes.contained_by(sorted(scope.hubs)),
        ),
    )


def snapshot_hub_codes(
    ctx: WhatIfContext, request: ImportSimulateRequest, result: ImportSimulateResponse
) -> list[str]:
    """P41-R01 (security H-1): every hub the stored request and result touch,
    together with the saver's hub scope (every hub for an all-hubs saver).

    - result: `projects[].hub` / `capacity_hub`, `plan_projects[].hub`,
      `capacity.hubs[].hub`, `capacity.designers[].hub`, `weekly.hubs` keys,
      `changes[*].hub`, and each served lab region as hubs (the saver's
      in-scope hubs of that region; every hub of the region when none, which
      cannot happen since a region is served only to a scope that has one);
    - request: `rows[].hub` (ticked or not) and the hubs of every
      `matched_project_id` and `exclude_plan_project_ids` in the baseline;
    - the saver's scope.

    A viewer sees the scenario only when their scope covers all of these, so
    no field of the snapshot holds data their own simulate would not."""

    scope = ctx.scope
    hubs: set[str] = set(scope.hubs)
    hubs.update(p.hub for p in result.projects)
    hubs.update(p.capacity_hub for p in result.projects)
    hubs.update(p.hub for p in result.plan_projects)
    cap = result.capacity
    hubs.update(h.hub for h in cap.hubs)
    hubs.update(d.hub for d in cap.designers)
    hubs.update(cap.weekly.hubs)
    regions = {r.region for r in cap.lab_regions} | set(cap.weekly.lab_regions)
    for region in regions:
        members = {h for h, reg in dc.HUB_LAB_REGION.items() if reg == region}
        mine = members & scope.hubs
        hubs.update(mine or members)
    for change in (
        *result.changes.newly_slipping,
        *result.changes.recovered,
        *result.changes.moved,
    ):
        hubs.add(change.hub)
    hubs.update(r.hub for r in request.rows)
    for pid in (
        *(r.matched_project_id for r in request.rows if r.matched_project_id),
        *request.exclude_plan_project_ids,
    ):
        hub = ctx.project_hub.get(pid)
        if hub is not None:
            hubs.add(hub)
    hubs.discard("")
    return sorted(hubs)


def _can_edit(principal: Principal, row_created_by: uuid.UUID | None) -> bool:
    return is_admin(principal) or (
        row_created_by is not None and row_created_by == principal.user_id
    )


async def _get_visible(
    db: AsyncSession, principal: Principal, scenario_id: uuid.UUID
) -> WhatifImportScenario:
    scope = await resolve_scope(db, principal)
    stmt = select(WhatifImportScenario).where(WhatifImportScenario.id == scenario_id)
    clause = _visible_clause(principal, scope)
    if clause is not None:
        stmt = stmt.where(clause)
    row = (await db.execute(stmt)).scalar_one_or_none()
    if row is None:
        raise not_found()
    return row


async def _creator_name(db: AsyncSession, user_id: uuid.UUID | None) -> str | None:
    if user_id is None:
        return None
    return (await db.execute(select(User.full_name).where(User.id == user_id))).scalar_one_or_none()


def _summary(
    principal: Principal, row: WhatifImportScenario, kpis: Any, creator: str | None
) -> dict[str, Any]:
    return {
        "id": row.id,
        "name": row.name,
        "note": row.note,
        "source_file_name": row.source_file_name,
        "source_file_sha256": row.source_file_sha256,
        "imported_at": row.imported_at,
        "created_at": row.created_at,
        "created_by_name": creator,
        "can_edit": _can_edit(principal, row.created_by),
        "mode": row.mode,
        "plan_year_end_week": row.plan_year_end_week,
        "simulated_week": row.simulated_week,
        "plan_version": row.plan_version,
        "hub_codes": list(row.hub_codes),
        "kpis": ImportKpisOut.model_validate(kpis),
    }


async def scenario_out(
    db: AsyncSession, principal: Principal, row: WhatifImportScenario
) -> SavedScenarioOut:
    creator = await _creator_name(db, row.created_by)
    return SavedScenarioOut(
        **_summary(principal, row, row.kpis, creator),
        request=ImportSimulateRequest.model_validate(row.request),
        result=ImportSimulateResponse.model_validate(row.result),
    )


# --- audit ---------------------------------------------------------------------------------------


def _audit(
    db: AsyncSession,
    principal: Principal,
    action: str,
    entity_id: str,
    after: dict[str, Any],
    before: dict[str, Any] | None = None,
) -> None:
    """Id, name and counts only (ADR 0055 D3). Never a payload."""

    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=f"whatif_scenario.{action}",
            entity_type="WhatifImportScenario",
            entity_id=entity_id,
            hub_id=principal_audit_hub_id(principal),
            before_state=before,
            after_state=after,
        )
    )


def _counts(result: ImportSimulateResponse) -> dict[str, int]:
    k = result.kpis
    return {
        "projects": len(result.projects),
        "file_projects": k.file_projects,
        "plan_projects": k.plan_projects,
        "plan_excluded": k.plan_excluded,
        "within_plan_year": k.within_plan_year,
    }


# --- save / list / read / patch / delete ---------------------------------------------------------


def _json_size(value: Any) -> int:
    return len(json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))


async def save_scenario(
    db: AsyncSession, principal: Principal, ctx: WhatIfContext, body: ScenarioSaveIn
) -> SavedScenarioOut:
    mine = (
        await db.execute(
            select(func.count())
            .select_from(WhatifImportScenario)
            .where(WhatifImportScenario.created_by == principal.user_id)
        )
    ).scalar_one()
    if mine >= MAX_SCENARIOS_PER_USER:
        raise CodedHTTPException(
            HTTP_422,
            SCENARIO_LIMIT,
            f"You have {MAX_SCENARIOS_PER_USER} saved scenarios, the most allowed. "
            "Delete some before saving another.",
        )
    total = (await db.execute(select(func.count()).select_from(WhatifImportScenario))).scalar_one()
    if total >= MAX_SCENARIOS_TOTAL:
        raise CodedHTTPException(
            HTTP_422,
            SCENARIO_LIMIT,
            f"{MAX_SCENARIOS_TOTAL} scenarios are saved, the most allowed. "
            "Ask an Admin to delete old ones.",
        )
    # ADR 0055 D3: recompute; a browser-supplied result is never stored.
    result = await do_import_simulate(ctx, body.request)
    request_json = body.request.model_dump(mode="json")
    result_json = result.model_dump(mode="json")
    if _json_size(request_json) + _json_size(result_json) > MAX_SNAPSHOT_BYTES:
        raise CodedHTTPException(
            HTTP_413,
            SCENARIO_TOO_LARGE,
            "This scenario is larger than 8 MB once computed and cannot be saved.",
        )
    active = await get_active_run(db)
    row = WhatifImportScenario(
        id=uuid.uuid4(),
        # Set here (not the server default, which is the transaction start)
        # so "newest first" holds inside one transaction too.
        created_at=datetime.now(UTC),
        name=body.name.strip() or body.name,
        note=body.note,
        created_by=principal.user_id,
        source_file_name=safe_file_name(body.source_file_name),
        source_file_sha256=body.source_file_sha256,
        imported_at=body.imported_at,
        mode=result.mode,
        plan_year_end_week=result.plan_year_end_week,
        simulated_week=result.current_week,
        plan_version=None if active is None else active.version,
        hub_codes=snapshot_hub_codes(ctx, body.request, result),
        request=request_json,
        result=result_json,
        kpis=result_json["kpis"],
    )
    db.add(row)
    await db.flush()
    await db.refresh(row)
    _audit(
        db,
        principal,
        "saved",
        str(row.id),
        {"id": str(row.id), "name": row.name, "counts": _counts(result)},
    )
    return await scenario_out(db, principal, row)


async def list_scenarios(
    db: AsyncSession,
    principal: Principal,
    source_file_sha256: str | None,
    *,
    limit: int = DEFAULT_LIST_LIMIT,
    offset: int = 0,
) -> tuple[list[SavedScenarioSummary], int]:
    """One page, newest first, and the visible total. Never reads the
    request / result JSONB (P41-R01 M-1): the KPIs have their own column."""

    scope = await resolve_scope(db, principal)
    s = WhatifImportScenario
    stmt = (
        select(
            s.id,
            s.name,
            s.note,
            s.source_file_name,
            s.source_file_sha256,
            s.imported_at,
            s.created_at,
            s.created_by,
            s.mode,
            s.plan_year_end_week,
            s.simulated_week,
            s.plan_version,
            s.hub_codes,
            s.kpis,
            User.full_name,
        )
        .outerjoin(User, User.id == s.created_by)
        .order_by(s.created_at.desc(), s.id)
    )
    count_stmt = select(func.count()).select_from(s)
    clause = _visible_clause(principal, scope)
    if clause is not None:
        stmt = stmt.where(clause)
        count_stmt = count_stmt.where(clause)
    if source_file_sha256 is not None:
        stmt = stmt.where(s.source_file_sha256 == source_file_sha256)
        count_stmt = count_stmt.where(s.source_file_sha256 == source_file_sha256)
    total = (await db.execute(count_stmt)).scalar_one()
    stmt = stmt.limit(limit).offset(offset)
    out: list[SavedScenarioSummary] = []
    for r in (await db.execute(stmt)).all():
        out.append(
            SavedScenarioSummary(
                id=r.id,
                name=r.name,
                note=r.note,
                source_file_name=r.source_file_name,
                source_file_sha256=r.source_file_sha256,
                imported_at=r.imported_at,
                created_at=r.created_at,
                created_by_name=r.full_name,
                can_edit=_can_edit(principal, r.created_by),
                mode=r.mode,
                plan_year_end_week=r.plan_year_end_week,
                simulated_week=r.simulated_week,
                plan_version=r.plan_version,
                hub_codes=list(r.hub_codes),
                kpis=ImportKpisOut.model_validate(r.kpis),
            )
        )
    return out, total


async def get_scenario(
    db: AsyncSession, principal: Principal, scenario_id: uuid.UUID
) -> SavedScenarioOut:
    return await scenario_out(db, principal, await _get_visible(db, principal, scenario_id))


def _forbidden() -> CodedHTTPException:
    return CodedHTTPException(
        403,
        SCENARIO_FORBIDDEN,
        "Only the person who saved this scenario, an Admin or a Super Admin can change it.",
    )


async def patch_scenario(
    db: AsyncSession, principal: Principal, scenario_id: uuid.UUID, body: ScenarioPatchIn
) -> SavedScenarioOut:
    row = await _get_visible(db, principal, scenario_id)
    if not _can_edit(principal, row.created_by):
        raise _forbidden()
    before = {"id": str(row.id), "name": row.name}
    changed: list[str] = []
    if "name" in body.model_fields_set:
        if body.name is None:
            raise CodedHTTPException(HTTP_422, "INVALID_SCENARIO_NAME", "A name is required.")
        if body.name != row.name:
            row.name = body.name
            changed.append("name")
    if "note" in body.model_fields_set and body.note != row.note:
        row.note = body.note
        changed.append("note")
    if changed:
        await db.flush()
        await db.refresh(row)
        _audit(
            db,
            principal,
            "renamed",
            str(row.id),
            {"id": str(row.id), "name": row.name, "changed": changed},
            before=before,
        )
    return await scenario_out(db, principal, row)


async def delete_scenario(db: AsyncSession, principal: Principal, scenario_id: uuid.UUID) -> None:
    row = await _get_visible(db, principal, scenario_id)
    if not _can_edit(principal, row.created_by):
        raise _forbidden()
    rid, name = row.id, row.name
    # ADR 0055 D3: a real delete, no soft delete.
    await db.execute(delete(WhatifImportScenario).where(WhatifImportScenario.id == rid))
    _audit(db, principal, "deleted", str(rid), {"id": str(rid), "name": name})


async def visible_rows(
    db: AsyncSession, principal: Principal, ids: Sequence[uuid.UUID]
) -> list[WhatifImportScenario]:
    """Every id visible to the caller, in the given order; else 404."""

    out = [await _get_visible(db, principal, i) for i in ids]
    return out


# --- export (ADR 0055 D5) -----------------------------------------------------------------------


def safe_download_name(name: str | None, fallback: str) -> str:
    base = re.sub(r"[^A-Za-z0-9 ._-]+", "_", name or "").strip(" ._")[:80]
    return (base or fallback) + ".xlsx"


def _kv(rows: list[tuple[str, Any]]) -> tuple[list[str], list[dict[str, Any]]]:
    return ["Item", "Value"], [{"Item": k, "Value": v} for k, v in rows]


def _kpi_rows(k: ImportKpisOut) -> list[tuple[str, Any]]:
    return [(name, getattr(k, name)) for name in ImportKpisOut.model_fields]


def _bucket_rows(
    year: str, dimension: str, buckets: list[BreakdownBucketOut]
) -> list[dict[str, Any]]:
    return [
        {
            "year": year,
            "dimension": dimension,
            "key": b.key,
            "total": b.total,
            "within_year": b.within_year,
            "spillover": b.spillover,
            "not_placed": b.not_placed,
            "queued": b.queued,
        }
        for b in buckets
    ]


def scenario_sheets(
    result: ImportSimulateResponse,
    *,
    name: str | None,
    source: dict[str, Any] | None,
) -> ExportSheets:
    """Summary, Breakdown, Projects, Steps, Capacity: served fields only."""

    summary: list[tuple[str, Any]] = [("name", name or "Current result")]
    if source is not None:
        summary.extend(source.items())
    summary.extend(
        [
            ("mode", result.mode),
            ("plan_year_end_week", result.plan_year_end_week),
            ("simulated_week", result.current_week),
            ("horizon_weeks", result.horizon_weeks),
            ("base_year", result.base_year),
        ]
    )
    summary.extend(_kpi_rows(result.kpis))

    breakdown: list[dict[str, Any]] = []
    for year in result.breakdowns.years:
        block = result.breakdowns.by_year.get(year.key)
        if block is None:
            continue
        for dimension in ("by_category", "by_hub", "by_priority", "by_status", "by_source"):
            breakdown.extend(_bucket_rows(year.label, dimension[3:], getattr(block, dimension)))
    breakdown_headers = [
        "year", "dimension", "key", "total", "within_year", "spillover", "not_placed",
        "queued",
    ]  # fmt: skip

    project_headers = [
        "ref", "source", "name", "hub", "capacity_hub", "category", "priority", "status",
        "outcome", "within_plan_year", "start_week", "finish_week", "before_outcome",
        "before_finish_week", "leader_name", "leader_auto_assigned", "replaces_project_id",
        "file_row", "data_error", "counts_toward_year", "not_scheduled_priority",
    ]  # fmt: skip
    projects = [p.model_dump(mode="json", include=set(project_headers)) for p in result.projects]

    step_headers = [
        "ref", "project", "step_id", "kind", "sequence_order", "start_week", "end_week",
        "duration_weeks", "span_weeks", "skipped", "done_before_import", "status",
        "engineer_name", "chamber_code",
    ]  # fmt: skip
    steps: list[dict[str, Any]] = []
    for p in result.projects:
        for st in p.steps:
            row = st.model_dump(mode="json")
            row["ref"] = p.ref
            row["project"] = p.name
            steps.append(row)

    cap_headers = [
        "kind", "name", "window", "load_weeks", "capacity_weeks", "booked_pct", "status",
        "booked_span_weeks",
    ]  # fmt: skip
    capacity: list[dict[str, Any]] = []
    cap = result.capacity
    for h in cap.hubs:
        for w in h.windows:
            capacity.append(
                {"kind": "hub", "name": h.hub, "window": w.key, "load_weeks": w.load_weeks,
                 "capacity_weeks": w.capacity_weeks, "booked_pct": w.booked_pct,
                 "status": w.status}
            )  # fmt: skip
    for r in cap.lab_regions:
        for w in r.windows:
            capacity.append(
                {"kind": "lab_region", "name": r.region, "window": w.key,
                 "load_weeks": w.load_weeks, "capacity_weeks": w.capacity_weeks,
                 "booked_pct": w.booked_pct, "status": w.status}
            )  # fmt: skip
    for d in cap.designers:
        for dw in d.windows:
            capacity.append(
                {"kind": "designer", "name": d.name, "window": dw.key,
                 "load_weeks": dw.booked_weeks, "capacity_weeks": dw.available_weeks,
                 "booked_pct": dw.booked_pct, "status": dw.status,
                 "booked_span_weeks": dw.booked_span_weeks}
            )  # fmt: skip

    return {
        "Summary": _kv(summary),
        "Breakdown": (breakdown_headers, breakdown),
        "Projects": (project_headers, projects),
        "Steps": (step_headers, steps),
        "Capacity": (cap_headers, capacity),
    }


def _source_of(row: WhatifImportScenario) -> dict[str, Any]:
    return {
        "note": row.note,
        "source_file_name": row.source_file_name,
        "source_file_sha256": row.source_file_sha256,
        "imported_at": row.imported_at.isoformat(),
        "saved_at": row.created_at.isoformat(),
        "plan_version": row.plan_version,
    }


def saved_scenario_xlsx(row: WhatifImportScenario) -> bytes:
    result = ImportSimulateResponse.model_validate(row.result)
    return xlsx_bytes(scenario_sheets(result, name=row.name, source=_source_of(row)))


def current_result_xlsx(result: ImportSimulateResponse, name: str | None) -> bytes:
    return xlsx_bytes(scenario_sheets(result, name=name, source=None))


def compare_sheets(rows: Sequence[WhatifImportScenario]) -> ExportSheets:
    """KPIs (one column per scenario plus a delta against the first) and
    Outcome changes (a project whose outcome differs, matched by `ref`)."""

    results = [ImportSimulateResponse.model_validate(r.result) for r in rows]
    # Column headers carry user-typed names: numbered so they are unique, and
    # neutralised like any text cell.
    cols = [neutralise_formula(f"S{i + 1}: {r.name}") for i, r in enumerate(rows)]
    deltas = [neutralise_formula(f"S{i + 1} - S1") for i in range(1, len(rows))]
    kpi_headers = ["KPI", *cols, *deltas]
    meta_rows: list[dict[str, Any]] = []
    metas = [
        {
            "source_file_name": r.source_file_name,
            "imported_at": r.imported_at.isoformat(),
            "simulated_week": r.simulated_week,
            "plan_version": r.plan_version,
            "mode": r.mode,
            "plan_year_end_week": r.plan_year_end_week,
        }
        for r in rows
    ]
    for label in metas[0]:
        meta_rows.append({"KPI": label, **{c: m[label] for c, m in zip(cols, metas, strict=True)}})

    def served_total(res: ImportSimulateResponse, year: str) -> int | None:
        block = res.breakdowns.by_year.get(year)
        return None if block is None else block.total

    # P41-R01 addendum (workflow A4): the Compare tab's "Projects scheduled"
    # and "Not placed" rows (frontend `COMPARE_KPIS`), served figures only.
    derived: list[tuple[str, list[int]]] = [
        (
            "Projects scheduled",
            [
                t if (t := served_total(res, "all")) is not None else res.kpis.projects_total
                for res in results
            ],
        ),
        (
            "Not placed",
            [
                t if (t := served_total(res, "not_placed")) is not None else res.kpis.left_out
                for res in results
            ],
        ),
    ]
    for label, ints in derived:
        line0: dict[str, Any] = {"KPI": label, **dict(zip(cols, ints, strict=True))}
        for d, v in zip(deltas, ints[1:], strict=True):
            line0[d] = v - ints[0]
        meta_rows.append(line0)
    for name in ImportKpisOut.model_fields:
        values = [getattr(res.kpis, name) for res in results]
        line: dict[str, Any] = {"KPI": name, **dict(zip(cols, values, strict=True))}
        first = values[0]
        for d, v in zip(deltas, values[1:], strict=True):
            line[d] = v - first if isinstance(v, int) and isinstance(first, int) else None
        meta_rows.append(line)

    by_ref: list[dict[str, Any]] = [{p.ref: p for p in res.projects} for res in results]
    refs: list[str] = []
    seen: set[str] = set()
    for m in by_ref:
        for ref in m:
            if ref not in seen:
                seen.add(ref)
                refs.append(ref)
    change_headers = ["ref", "name", "hub"]
    for c in cols:
        change_headers.extend([f"{c} outcome", f"{c} finish_week"])
    changes: list[dict[str, Any]] = []
    for ref in refs:
        present = [m.get(ref) for m in by_ref]
        outcomes = {None if p is None else p.outcome for p in present}
        if len(outcomes) <= 1:
            continue
        first_p = next(p for p in present if p is not None)
        line = {"ref": ref, "name": first_p.name, "hub": first_p.hub}
        for c, p in zip(cols, present, strict=True):
            line[f"{c} outcome"] = "not in scenario" if p is None else p.outcome
            line[f"{c} finish_week"] = None if p is None else p.finish_week
        changes.append(line)
    return {"KPIs": (kpi_headers, meta_rows), "Outcome changes": (change_headers, changes)}


def compare_xlsx(rows: Sequence[WhatifImportScenario]) -> bytes:
    return xlsx_bytes(compare_sheets(rows))


def audit_export(
    db: AsyncSession,
    principal: Principal,
    kind: str,
    *,
    ids: Sequence[uuid.UUID] = (),
    names: Sequence[str] = (),
    projects: int,
) -> None:
    entity = str(ids[0]) if len(ids) == 1 else kind
    _audit(
        db,
        principal,
        "exported",
        entity,
        {
            "kind": kind,
            "ids": [str(i) for i in ids],
            "names": list(names),
            "counts": {"scenarios": len(ids), "projects": projects},
        },
    )
