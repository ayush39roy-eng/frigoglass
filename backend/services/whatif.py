"""What-if planner service (P18-T02, ADR 0031, docs/API_CONTRACT_P18.md).

Glue between the HTTP layer and the pure engine `scheduling.whatif`:

1. `to_engine_scenario` turns the strict Pydantic request into the engine's
   frozen `Scenario`.
2. `check_scope` makes a restricted caller's scenario touch only their hubs,
   regions, designers, chambers and projects. A reference to a hub or lab
   region outside the scope is 403 `SCENARIO_OUT_OF_SCOPE`; an engineer,
   chamber or project id outside the scope is answered exactly like an unknown
   id (422), so no id leaks existence.
3. The engine runs in a worker thread under a wall-clock cap (the priority
   preview pattern): `PREVIEW`-style 503 when exceeded. A Python thread cannot
   be killed, so an overrunning job finishes in the background and its result
   is discarded; the pool size bounds how many can exist. CP-SAT is never run
   here and nothing is written (the only write of a what-if is its audit row).
4. `scope_*` narrow the engine's WHOLE-PLAN result to what the caller may see,
   and recompute every total from the rows that are left, so no figure of
   another hub leaks through a sum or a text line. Lab-region rows stay
   region-wide, as on the Capacity surface (chambers are shared).
5. `audit_whatif` writes one coalesced audit row per user, kind and scenario
   digest per minute. It stores the scenario SHAPE (hubs, categories, counts,
   ids), never names, never a financial field.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import re
import threading
from collections import Counter
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.audit import AuditLogEntry
from scheduling.whatif import (
    OUTCOME_CLASSES,
    AddChamber,
    AddEngineer,
    AddProject,
    AnalyticRequirements,
    ChamberDowntimeChange,
    MinimumAdditionsResult,
    RemoveEngineerCount,
    Scenario,
    SimulationResult,
    WhatIfBudgetExceeded,
    analytic_requirements,
    simulate,
    solve_minimum_additions,
)
from schemas.whatif import (
    AdditionsOut,
    BasisLiteral,
    ChamberAdditionOut,
    DesignerAdditionOut,
    EstimateResponse,
    HubDesignRequirementOut,
    LabRegionRequirementOut,
    ProjectChangeOut,
    ProjectResultOut,
    ScenarioDiffOut,
    ScopeInfo,
    SimulateResponse,
    SolveResponse,
    TargetLiteral,
    UnattainableProjectOut,
    UtilizationRowOut,
)
from services.whatif_baseline import Scope, WhatIfContext, principal_audit_hub_id

#: Wall-clock caps (seconds). One greedy run on ~250 projects is about 20 ms:
#: estimate is formulas only, simulate is two runs, solve at most 60. The caps
#: only protect the request from a pathological input.
WHATIF_TIME_CAP_SECONDS = 20.0
WHATIF_SOLVE_TIME_CAP_SECONDS = 40.0
#: Cooperative deadlines handed to the engine (S18-M1), a little under the HTTP
#: caps so the worker thread stops itself instead of running on unseen.
WHATIF_DEADLINE_SECONDS = 18.0
WHATIF_SOLVE_DEADLINE_SECONDS = 38.0
#: Heavy jobs one user may have running at once. The pool has two threads for
#: everybody; one job per user means one user cannot occupy it (S18-M1).
WHATIF_MAX_IN_FLIGHT_PER_USER = 1

#: Dedicated pool so a slow what-if cannot starve the priority preview's pool.
_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="whatif")

INVALID_SCENARIO = "INVALID_SCENARIO"
OUT_OF_SCOPE = "SCENARIO_OUT_OF_SCOPE"
TIMEOUT = "WHATIF_TIMEOUT"


# --- request -> engine -------------------------------------------------------------------


def to_engine_scenario(req: Any) -> Scenario:
    """`req` is a `ScenarioRequest` or `ChatScenario` (the latter lacks the two
    id-based lists)."""

    return Scenario(
        add_projects=tuple(
            AddProject(
                hub=p.hub,
                category=p.category,
                count=p.count,
                project_type=p.project_type,
                status=p.status,
                priority=p.priority,
                score=p.score,
                workflow_id=p.workflow_id,
                certification_testing_required=p.certification_testing_required,
            )
            for p in req.add_projects
        ),
        add_engineers=tuple(
            AddEngineer(
                hub=e.hub,
                fte=e.fte,
                count=e.count,
                allowed_categories=tuple(e.allowed_categories)
                if e.allowed_categories is not None
                else None,
            )
            for e in req.add_engineers
        ),
        remove_engineers=tuple(getattr(req, "remove_engineers", ())),
        remove_engineer_counts=tuple(
            RemoveEngineerCount(hub=r.hub, count=r.count) for r in req.remove_engineer_counts
        ),
        add_chambers=tuple(
            AddChamber(
                lab_region=c.lab_region,
                count=c.count,
                platforms=c.platforms,
                efficiency=c.efficiency,
                maintenance_weeks=c.maintenance_weeks,
                breakdown_weeks=c.breakdown_weeks,
                calibration_weeks=c.calibration_weeks,
                allowed_stages=tuple(c.allowed_stages) if c.allowed_stages is not None else None,
            )
            for c in req.add_chambers
        ),
        chamber_downtime=tuple(
            ChamberDowntimeChange(
                chamber_id=d.chamber_id,
                maintenance_weeks=d.maintenance_weeks,
                breakdown_weeks=d.breakdown_weeks,
                calibration_weeks=d.calibration_weeks,
            )
            for d in req.chamber_downtime
        ),
        priority_overrides=tuple(
            (o.project_id, o.priority) for o in getattr(req, "priority_overrides", ())
        ),
    )


def invalid_scenario(message: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, INVALID_SCENARIO, message)


def check_scope(ctx: WhatIfContext, sc: Scenario) -> None:
    """Raise unless `sc` stays inside the caller's scope (module docstring)."""

    # P29-T06 (ADR 0042): designers sit on capacity hubs. Adding or removing
    # designers on a member hub (OEM-HCK, OEM-Seitek) is a 422 for everyone:
    # its design work is done by its capacity hub's engineers.
    designer_hubs = [ae.hub for ae in sc.add_engineers]
    designer_hubs += [rc.hub for rc in sc.remove_engineer_counts]
    for designer_hub in designer_hubs:
        parent = dc.HUB_CAPACITY_HUB.get(designer_hub)
        if parent is not None:
            raise invalid_scenario(
                f"{designer_hub} has no designers of its own; its design work is done by "
                f"{parent}'s engineers. Add or remove designers on {parent}."
            )
    scope = ctx.scope
    if scope.all_hubs:
        return

    def deny(what: str) -> CodedHTTPException:
        return CodedHTTPException(
            status.HTTP_403_FORBIDDEN,
            OUT_OF_SCOPE,
            f"The scenario names {what} outside your hub scope.",
        )

    for ap in sc.add_projects:
        if not scope.hub_ok(ap.hub):
            raise deny("a hub")
    for ae in sc.add_engineers:
        if not scope.hub_ok(ae.hub):
            raise deny("a hub")
    for rc in sc.remove_engineer_counts:
        if not scope.hub_ok(rc.hub):
            raise deny("a hub")
    for ac in sc.add_chambers:
        if not scope.region_ok(ac.lab_region):
            raise deny("a lab region")
    for eid in sc.remove_engineers:
        hub = ctx.engineer_hub.get(eid)
        if hub is None or not scope.hub_ok(hub):
            raise invalid_scenario(f"unknown engineer id {eid!r}")
    for dt in sc.chamber_downtime:
        region = ctx.chamber_region.get(dt.chamber_id)
        if region is None or not scope.region_ok(region):
            raise invalid_scenario(f"unknown chamber id {dt.chamber_id!r}")
    for pid, _prio in sc.priority_overrides:
        hub = ctx.project_hub.get(pid)
        if hub is None or not scope.hub_ok(hub):
            raise invalid_scenario(f"unknown project id {pid!r}")


# --- engine in a thread ------------------------------------------------------------------


_IN_FLIGHT: dict[str, int] = {}
_IN_FLIGHT_LOCK = threading.Lock()


def in_flight_count(user_key: str) -> int:
    with _IN_FLIGHT_LOCK:
        return _IN_FLIGHT.get(user_key, 0)


def _acquire_slot(user_key: str) -> bool:
    if not user_key:
        return True
    with _IN_FLIGHT_LOCK:
        n = _IN_FLIGHT.get(user_key, 0)
        if n >= WHATIF_MAX_IN_FLIGHT_PER_USER:
            return False
        _IN_FLIGHT[user_key] = n + 1
        return True


def _release_slot(user_key: str) -> None:
    if not user_key:
        return
    with _IN_FLIGHT_LOCK:
        n = _IN_FLIGHT.get(user_key, 0) - 1
        if n > 0:
            _IN_FLIGHT[user_key] = n
        else:
            _IN_FLIGHT.pop(user_key, None)


async def run_capped[T](fn: Callable[[], T], cap_seconds: float, *, user_key: str = "") -> T:
    """Run a pure engine call off the event loop. `ValueError` (a bad
    scenario) is 422; overrunning the cap, or the engine's own cooperative
    deadline (`WhatIfBudgetExceeded`), is 503 `WHATIF_TIMEOUT`.

    One heavy job per user at a time (S18-M1): a second while the first still
    occupies a pool thread is 429 with `Retry-After`. The slot is released when
    the THREAD finishes, not when the request gives up, because a Python
    thread cannot be killed; the engine's deadline bounds that."""

    if not _acquire_slot(user_key):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=(
                "A what-if calculation of yours is still running. "
                "Please wait for it to finish before starting another."
            ),
            headers={"Retry-After": "2"},
        )
    try:
        cf = _EXECUTOR.submit(fn)
    except BaseException:
        _release_slot(user_key)
        raise
    cf.add_done_callback(lambda _f: _release_slot(user_key))
    try:
        return await asyncio.wait_for(asyncio.wrap_future(cf), timeout=cap_seconds)
    except (TimeoutError, WhatIfBudgetExceeded) as exc:
        raise CodedHTTPException(
            status.HTTP_503_SERVICE_UNAVAILABLE,
            TIMEOUT,
            "Calculating the scenario took too long. Please simplify it and try again.",
        ) from exc
    except ValueError as exc:
        raise invalid_scenario(str(exc)) from exc


# --- scope: narrowing the whole-plan result -----------------------------------------------


def within_year_bucket(within_year: bool, outcome: str) -> bool:
    """The Dashboard's within-year bucket (`api.routers.dashboard`,
    `completing_within_year`: `within_year AND NOT blocked`, ADR 0030 keeps
    Commercialized projects, whose outcome class is `excluded`). One definition
    for every What-if count (I9)."""

    return within_year and outcome != "blocked"


def scope_info(scope: Scope) -> ScopeInfo:
    return ScopeInfo(
        all_hubs=scope.all_hubs,
        hubs=sorted(scope.hubs),
        lab_regions=sorted(scope.lab_regions),
    )


def _keep_line(line: str, scope: Scope) -> bool:
    """A workings line is kept if it is general, or about an in-scope hub or
    lab region. A line that starts with another hub / region is dropped."""

    for hub in dc.HUB_LAB_REGION:
        if line.startswith(f"{hub}: "):
            # P29-T06 (ADR 0042): hub lines are capacity-hub lines.
            return scope.capacity_row_ok(hub)
    if scope.all_hubs:
        return True
    for region in set(dc.HUB_LAB_REGION.values()):
        if line.startswith(f"{region} lab: ") or line.startswith(f"{region}: "):
            return scope.region_ok(region)
    return True


def scope_estimate(raw: AnalyticRequirements, scope: Scope) -> EstimateResponse:
    """Every row is kept if in scope; the four headline totals sum the visible
    rows that are ALSO touched by the scenario (D2b): never the engine's own
    totals, which cover other hubs. Zero scenario: touched is empty, totals 0."""

    # P29-T06 (ADR 0042): design rows are capacity hubs only (no OEM row).
    touched_hubs = [h for h in raw.touched_hubs if scope.capacity_row_ok(h)]
    touched_regions = [r for r in raw.touched_lab_regions if scope.region_ok(r)]
    design = [
        HubDesignRequirementOut(**{k: getattr(r, k) for k in HubDesignRequirementOut.model_fields})
        for r in raw.design
        if scope.capacity_row_ok(r.hub)
    ]
    lab = [
        LabRegionRequirementOut(**{k: getattr(r, k) for k in LabRegionRequirementOut.model_fields})
        for r in raw.lab
        if scope.region_ok(r.lab_region)
    ]
    t_design = [r for r in design if r.hub in touched_hubs]
    t_lab = [r for r in lab if r.lab_region in touched_regions]
    return EstimateResponse(
        scope=scope_info(scope),
        touched_hubs=touched_hubs,
        touched_lab_regions=touched_regions,
        basis=raw.basis,
        target_below_pct=raw.target_below_pct,
        extra_design_weeks_total=sum(r.extra_design_weeks for r in t_design),
        extra_lab_weeks_total=sum(r.extra_lab_weeks for r in t_lab),
        min_extra_designers_total=sum(r.min_extra_designers for r in t_design),
        min_extra_chambers_total=sum(r.min_extra_chambers for r in t_lab),
        design=design,
        lab=lab,
        workings=[ln for ln in raw.workings if _keep_line(ln, scope)],
    )


def _util_ok(row_scope: str, key: str, scope: Scope) -> bool:
    # P29-T06 (ADR 0042): hub utilization rows are capacity hubs only.
    return scope.capacity_row_ok(key) if row_scope == "hub" else scope.region_ok(key)


def _change_out(c: Any) -> ProjectChangeOut:
    return ProjectChangeOut(
        project_id=c.project_id,
        name=c.name,
        hub=c.hub,
        kind=c.kind,
        before_outcome=c.before_outcome,
        after_outcome=c.after_outcome,
        before_finish_week=c.before_finish_week,
        after_finish_week=c.after_finish_week,
    )


def scope_simulation(raw: SimulationResult, scope: Scope) -> SimulateResponse:
    """Narrow a whole-plan simulation to the scope. Every count is recomputed
    from the kept projects. An existing project's BEFORE outcome is its
    `before_outcome` when it appears in the diff, else it is unchanged (the
    engine lists every existing project whose result changed)."""

    projects = [p for p in raw.projects if scope.hub_ok(p.hub)]
    changes = [*raw.diff.newly_slipping, *raw.diff.recovered, *raw.diff.moved]
    before_class = {c.project_id: c.before_outcome for c in changes}
    existing = [p for p in projects if not p.is_new]
    after_counts = Counter(p.outcome for p in projects)
    before_counts = Counter(before_class.get(p.project_id, p.outcome) for p in existing)
    kept = {p.project_id for p in projects}

    # D1 (I9): "within the year" is the Dashboard's bucket, `within_year AND
    # NOT blocked` of the project's flag, NOT the `within_year` outcome CLASS
    # (which drops Commercialized projects, classed `excluded` but counted).
    # An existing project's BEFORE flag is its flag now unless it is in the
    # diff, where the flag before is "its before class was within_year" (a
    # project that changed cannot have been excluded).
    def counts(p: Any) -> bool:
        return within_year_bucket(p.within_year, p.outcome)

    new_total = sum(1 for p in projects if p.is_new)
    new_wy = sum(1 for p in projects if p.is_new and counts(p))
    ex_after = sum(1 for p in existing if counts(p))
    ex_before = sum(
        1
        for p in existing
        if (
            before_class[p.project_id] == "within_year"
            if p.project_id in before_class
            else counts(p)
        )
    )
    wy_after = ex_after + new_wy

    def lst(items: Any) -> list[ProjectChangeOut]:
        return [_change_out(c) for c in items if scope.hub_ok(c.hub)]

    diff = ScenarioDiffOut(
        within_year_before=ex_before,
        within_year_after=wy_after,
        within_year_delta=wy_after - ex_before,
        existing_within_year_before=ex_before,
        existing_within_year_after=ex_after,
        new_projects_total=new_total,
        new_projects_within_year=new_wy,
        newly_slipping=lst(raw.diff.newly_slipping),
        recovered=lst(raw.diff.recovered),
        moved=lst(raw.diff.moved),
    )

    def util(rows: Any) -> list[UtilizationRowOut]:
        return [
            UtilizationRowOut(**{k: getattr(r, k) for k in UtilizationRowOut.model_fields})
            for r in rows
            if _util_ok(r.scope, r.key, scope)
        ]

    ub, ua = util(raw.utilization_before), util(raw.utilization_after)
    wy_line = (
        f"Within-year projects: {ex_before} -> {wy_after} ({wy_after - ex_before:+d}); "
        f"existing {ex_before} -> {ex_after}; new {new_wy} of {new_total}."
    )
    workings = [
        "Greedy SGS re-run on a copy of the plan with the scenario applied "
        "(the plan itself is not changed).",
        wy_line,
        f"{len(diff.newly_slipping)} existing project(s) newly slipping, "
        f"{len(diff.recovered)} recovered, {len(diff.moved)} otherwise moved.",
    ]
    return SimulateResponse(
        scope=scope_info(scope),
        projects=[
            ProjectResultOut(**{k: getattr(p, k) for k in ProjectResultOut.model_fields})
            for p in projects
        ],
        outcome_counts_before={o: before_counts.get(o, 0) for o in OUTCOME_CLASSES},
        outcome_counts_after={o: after_counts.get(o, 0) for o in OUTCOME_CLASSES},
        utilization_before=ub,
        utilization_after=ua,
        diff=diff,
        new_project_ids=[i for i in raw.new_project_ids if i in kept],
        added_engineer_ids=list(raw.added_engineer_ids),
        added_chamber_ids=list(raw.added_chamber_ids),
        removed_engineer_ids=list(raw.removed_engineer_ids),
        reassigned_project_ids=[i for i in raw.reassigned_project_ids if i in kept],
        greedy_runs=raw.greedy_runs,
        workings=workings,
    )


def scope_solution(raw: MinimumAdditionsResult, scope: Scope, ctx: WhatIfContext) -> SolveResponse:
    achieved = scope_simulation(raw.achieved, scope) if raw.achieved is not None else None
    hub_of = {p.project_id: p for p in (raw.achieved.projects if raw.achieved else ())}
    unattainable_ids = [
        i for i in raw.unattainable_project_ids if i in hub_of and scope.hub_ok(hub_of[i].hub)
    ]
    unmet = [
        i
        for i in raw.unmet_project_ids
        if scope.all_hubs
        or (i in hub_of and scope.hub_ok(hub_of[i].hub))
        or (i in ctx.project_hub and scope.hub_ok(ctx.project_hub[i]))
    ]
    met, met_attainable = raw.met, raw.met_attainable
    if not scope.all_hubs and raw.target == "no_existing_slips":
        # The engine judged every hub; a restricted caller is told about their
        # own projects only (assumption recorded in the MEMORY entry).
        met = met_attainable = not unmet
    workings = [
        ln
        for ln in raw.workings
        if _keep_line(ln, scope)
        and not (
            not scope.all_hubs
            and raw.target == "no_existing_slips"
            and ln.startswith("0 additions:")
        )
    ]
    return SolveResponse(
        scope=scope_info(scope),
        target=raw.target,
        met=met,
        met_attainable=met_attainable,
        unattainable_project_ids=unattainable_ids,
        unattainable_projects=[
            UnattainableProjectOut(
                project_id=i,
                name=hub_of[i].name,
                hub=hub_of[i].hub,
                category=hub_of[i].category,
                unconstrained_end_week=hub_of[i].unconstrained_end_week,
            )
            for i in unattainable_ids
        ],
        capped=raw.capped,
        exact=raw.exact,
        additions=AdditionsOut(
            designers=[
                DesignerAdditionOut(hub=h, count=n)
                for h, n in raw.additions.designers
                if scope.capacity_row_ok(h)
            ],
            chambers=[
                ChamberAdditionOut(lab_region=r, count=n)
                for r, n in raw.additions.chambers
                if scope.region_ok(r)
            ],
            total=raw.additions.total,
        ),
        unmet_project_ids=unmet,
        runs_used=raw.runs_used,
        run_cap=raw.run_cap,
        searched_designer_hubs=[
            h for h in raw.searched_designer_hubs if scope.capacity_row_ok(h)
        ],
        searched_chamber_regions=[r for r in raw.searched_chamber_regions if scope.region_ok(r)],
        achieved=achieved,
        workings=workings,
    )


# --- the three operations (shared by the endpoints and the chat tools) --------------------


async def do_estimate(
    ctx: WhatIfContext, req: Any, *, basis: BasisLiteral, designer_fte: float
) -> EstimateResponse:
    sc = to_engine_scenario(req)
    check_scope(ctx, sc)
    raw = await run_capped(
        lambda: analytic_requirements(
            ctx.baseline,
            sc,
            basis=basis,
            designer_fte=designer_fte,
            deadline_s=WHATIF_DEADLINE_SECONDS,
        ),
        WHATIF_TIME_CAP_SECONDS,
        user_key=ctx.user_key,
    )
    return scope_estimate(raw, ctx.scope)


async def do_simulate(ctx: WhatIfContext, req: Any) -> SimulateResponse:
    sc = to_engine_scenario(req)
    check_scope(ctx, sc)
    raw = await run_capped(
        lambda: simulate(ctx.baseline, sc, deadline_s=WHATIF_DEADLINE_SECONDS),
        WHATIF_TIME_CAP_SECONDS,
        user_key=ctx.user_key,
    )
    return scope_simulation(raw, ctx.scope)


async def do_solve(
    ctx: WhatIfContext,
    req: Any,
    *,
    target: TargetLiteral,
    designer_fte: float,
    max_runs: int = 60,
    max_units_per_dimension: int = 25,
) -> SolveResponse:
    sc = to_engine_scenario(req)
    check_scope(ctx, sc)
    raw = await run_capped(
        lambda: solve_minimum_additions(
            ctx.baseline,
            sc,
            target,
            max_runs=max_runs,
            designer_fte=designer_fte,
            max_units_per_dimension=max_units_per_dimension,
            deadline_s=WHATIF_SOLVE_DEADLINE_SECONDS,
        ),
        WHATIF_SOLVE_TIME_CAP_SECONDS,
        user_key=ctx.user_key,
    )
    return scope_solution(raw, ctx.scope, ctx)


# --- audit ---------------------------------------------------------------------------------


def scenario_shape(req: Any) -> dict[str, Any]:
    """The audit-safe description of a scenario: hubs, categories, counts and
    ids only. No names, no financial field; designer ids are replaced by a
    count (engineer-level data is personal data, OQ #8)."""

    return {
        "add_projects": [
            {"hub": p.hub, "category": p.category, "count": p.count} for p in req.add_projects
        ],
        "add_engineers": [
            {"hub": e.hub, "count": e.count, "fte": e.fte} for e in req.add_engineers
        ],
        "remove_engineer_counts": [
            {"hub": r.hub, "count": r.count} for r in req.remove_engineer_counts
        ],
        "remove_engineers_count": len(getattr(req, "remove_engineers", ())),
        "add_chambers": [{"lab_region": c.lab_region, "count": c.count} for c in req.add_chambers],
        "chamber_downtime": [d.chamber_id for d in req.chamber_downtime],
        "priority_overrides": [
            {"project_id": o.project_id, "priority": o.priority}
            for o in getattr(req, "priority_overrides", ())
        ],
    }


def digest_of(payload: Any) -> str:
    blob = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()[:16]


async def audit_whatif(
    db: AsyncSession,
    principal: Principal,
    kind: str,
    shape: dict[str, Any],
    *,
    extra: dict[str, Any] | None = None,
    coalesce: bool = True,
) -> None:
    """One audit row per user, kind and scenario digest per minute (the P15
    coalescing pattern: a burst of identical runs must not grow the
    append-only table without bound). The caller commits."""

    digest = digest_of(shape)
    action = f"whatif.{kind}"
    if coalesce:
        recent = (
            await db.execute(
                select(AuditLogEntry.id)
                .where(
                    AuditLogEntry.actor_user_id == principal.user_id,
                    AuditLogEntry.action == action,
                    AuditLogEntry.occurred_at >= datetime.now(UTC) - timedelta(minutes=1),
                    AuditLogEntry.after_state["digest"].astext == digest,
                )
                .limit(1)
            )
        ).first()
        if recent is not None:
            return
    db.add(
        AuditLogEntry(
            actor_user_id=principal.user_id,
            action=action,
            entity_type="WhatIf",
            entity_id=kind,
            hub_id=principal_audit_hub_id(principal),
            before_state=None,
            after_state={"digest": digest, "scenario": shape, **(extra or {})},
        )
    )


# A number: with thousands separators ("1,078" is one number), or plain.
_NUMBER_RE = re.compile(r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?")

_UNITS = (
    "two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|"
    "sixteen|seventeen|eighteen|nineteen"
)
_TENS = "twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety"
# "one" is left out: it is also a pronoun ("no one", "one of"), and flagging it
# would reject ordinary sentences. Everything else that names a quantity is in.
_WORD_NUMBER_RE = re.compile(
    rf"\b(?:(?:{_TENS})(?:[- ](?:one|{_UNITS}))?|{_UNITS}|hundred|thousand|million|billion|dozen)"
    r"(?:[- ]?fold|s)?\b",
    re.IGNORECASE,
)


def numbers_in(text: str) -> list[str]:
    return _NUMBER_RE.findall(text)


def number_value(token: str) -> float:
    return float(token.replace(",", ""))


def spelled_numbers_in(text: str) -> list[str]:
    """Spelled-out numbers ("twelve", "twenty-five", "two hundred" gives
    "two" and "hundred", "thirteenfold")."""

    return [m.group(0) for m in _WORD_NUMBER_RE.finditer(text)]
