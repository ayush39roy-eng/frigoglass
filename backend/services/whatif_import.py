"""What-if plan import service (P32-T04, ADR 0044, docs/API_CONTRACT_P32.md B2/B3).

Glue between the HTTP layer, the pure workbook parser
(`services.plan_import_xlsx`) and the pure engine
(`scheduling.plan_import.run_plan_import`):

* **parse**: the plan context (roster, matchable projects, workflows, lead
  times) comes from the What-if baseline (`services.whatif_baseline`). Only
  projects in the caller's hub scope are matchable; the scope query goes
  through `services.hub_scope`. The roster returned is the caller's in-scope
  designers plus any designer a file row named.
* **simulate**: rows (as returned by parse, possibly edited) are validated
  against the plan, turned into the engine's frozen dataclasses, and run in
  the What-if worker pool under the What-if time cap (`run_capped`). The
  WHOLE-PLAN result is then narrowed to the caller's scope: plan projects of
  other hubs are dropped, every KPI is recomputed from what is kept, capacity
  rows are served only for in-scope hubs / lab regions. The file's own rows
  are always returned (the caller supplied them).

Nothing is persisted. The only write is the audit row (counts and digests,
never names or file content).
"""

from __future__ import annotations

import dataclasses
import hashlib
from collections.abc import Callable, Sequence
from datetime import date
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.enums import HubName, ProjectStatus
from models.hub import Hub
from models.project import Project
from scheduling import is_not_scheduled_priority
from scheduling.plan_import import (
    IN_PROGRESS_ON_IMPORT,
    ImportNewEngineer,
    ImportProject,
    PlanImportProject,
    PlanImportRequest,
    PlanImportResult,
    StepEdit,
    _ancestors,
    run_plan_import,
)
from scheduling.workflow import (
    STATUS_BLOCKED,
    STATUS_DONE,
    STATUS_IN_PROGRESS,
    Workflow,
    build_lead_time_table,
    build_workflows,
    effective_lead_weeks,
    is_step_skipped,
)
from schemas.whatif_import import (
    MAX_SIMULATED_FILE_PROJECTS,
    BreakdownBucketOut,
    BreakdownOut,
    BreakdownOutcomesOut,
    BreakdownYearOut,
    CapacityWindowOut,
    DesignerCapacityOut,
    DesignerWindowOut,
    FinishQuarterOut,
    HubCapacityOut,
    ImportBreakdownsOut,
    ImportCapacityOut,
    ImportChangeOut,
    ImportChangesOut,
    ImportCounts,
    ImportIssue,
    ImportKpisOut,
    ImportParseResponse,
    ImportProjectOut,
    ImportRow,
    ImportSimulateRequest,
    ImportSimulateResponse,
    ImportStepOut,
    LabRegionCapacityOut,
    LeaderExisting,
    LeaderNew,
    LeadTimeRowOut,
    PlanProjectOut,
    PlanWeekChoiceOut,
    RosterEntryOut,
    SimIssueOut,
    StepMetaOut,
    WeeklyCapacityOut,
    WeeklySeriesOut,
    WindowLoadOut,
)
from services.categories import unknown_category_error
from services.hub_scope import hub_scope_filter
from services.plan_import_xlsx import (
    BASE_YEAR,
    MatchableProject,
    ParseContext,
    ParseResult,
    RosterEntry,
    StepMeta,
)
from services.whatif import (
    WHATIF_DEADLINE_SECONDS,
    WHATIF_TIME_CAP_SECONDS,
    audit_whatif,
    digest_of,
    run_capped,
)
from services.whatif_baseline import WhatIfContext

IMPORT_FORMAT = "IMPORT_FORMAT"
INVALID_IMPORT = "INVALID_IMPORT"


def invalid_import(message: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, INVALID_IMPORT, message)


# --- the plan window: "Plan from" f and "Plan until" u (ADR 0061, R49-7, R49-15) ------------

#: The last week a plan window may reach (base year + 1, W52; R49-15).
MAX_PLAN_WEEK = 2 * dc.WEEKS_IN_YEAR
PLAN_FROM_LATER = "PLAN_FROM_LATER"
PLAN_FROM_RAISED = "PLAN_FROM_RAISED"
PLAN_UNTIL_RAISED = "PLAN_UNTIL_RAISED"
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")


def week_year(week: int) -> tuple[int, int]:
    """(calendar year, week 1..52) of an absolute week (53 = base year + 1, W1)."""

    offset, in_year = divmod(week - 1, dc.WEEKS_IN_YEAR)
    return BASE_YEAR + offset, in_year + 1


def week_monday(week: int) -> date:
    """The Monday of an absolute week: ISO week `w` of its year (so 53 is
    Monday 4 Jan 2027; the ISO 2026-W53 is read as 52 by the app, R49-7)."""

    year, w = week_year(week)
    return date.fromisocalendar(year, w, 1)


def plan_week_short(week: int) -> str:
    year, w = week_year(week)
    return f"W{w} {year}"


def plan_week_label(week: int) -> str:
    """The label "W1 2027 (4 Jan 2027)": the server-made label of an absolute week (I40)."""

    d = week_monday(week)
    return f"{plan_week_short(week)} ({d.day} {_MONTHS[d.month - 1]} {d.year})"


def plan_week_choices(current_week: int) -> list[PlanWeekChoiceOut]:
    """Every week a "Plan from" / "Plan until" picker may offer: cw..104."""

    return [
        PlanWeekChoiceOut(week=w, label=plan_week_label(w))
        for w in range(current_week, MAX_PLAN_WEEK + 1)
    ]


@dataclasses.dataclass(frozen=True)
class PlanWindow:
    """The resolved window of one import simulation (R49-7, R49-15)."""

    current_week: int
    #: f: file projects start from it.
    from_week: int
    #: u: the cut-off of every "within" figure.
    until_week: int
    #: The request gave a `plan_until_week` other than the preset (R49-18:
    #: the window label is served).
    until_given: bool
    #: R49-13 / R49-19: re-run raised a stored week (the week asked for).
    from_raised_from: int | None = None
    until_raised_from: int | None = None


def resolve_plan_window(ctx: WhatIfContext, body: ImportSimulateRequest) -> PlanWindow:
    """`cw <= f <= u <= 104`, else 422 `INVALID_IMPORT` (no clamping). On a
    re-run (`plan_window_rerun`) f := max(f, cw), then u := max(u, f)."""

    cw = ctx.baseline.schedule.current_week
    f = cw if body.plan_from_week is None else body.plan_from_week
    u = body.plan_year_end_week if body.plan_until_week is None else body.plan_until_week
    from_raised = until_raised = None
    if f < cw:
        if not body.plan_window_rerun:
            raise invalid_import(
                f"plan_from_week {f} is before the current week {cw}; file projects can start "
                f"from week {cw} ({plan_week_label(cw)}) at the earliest."
            )
        from_raised, f = f, cw
    if u < f:
        if not body.plan_window_rerun:
            raise invalid_import(
                f"the plan window must end on or after the week file projects start from "
                f"(plan_until_week {u} < plan_from_week {f})."
            )
        until_raised, u = u, f
    if u > MAX_PLAN_WEEK:  # pragma: no cover - the schema bounds it
        raise invalid_import(f"plan_until_week must be at most {MAX_PLAN_WEEK}.")
    return PlanWindow(
        current_week=cw,
        from_week=f,
        until_week=u,
        # R49-18: u equal to the preset reads as the plan year (so a saved
        # request, which stores the resolved u, re-simulates identically).
        until_given=body.plan_until_week is not None and u != body.plan_year_end_week,
        from_raised_from=from_raised,
        until_raised_from=until_raised,
    )


def plan_window_issues(w: PlanWindow) -> list[SimIssueOut]:
    """File-level info issues (R49-12, R49-13, R49-19); none when f = cw and
    nothing was raised (so the response stays as before)."""

    out: list[SimIssueOut] = []
    if w.from_raised_from is not None:
        out.append(
            SimIssueOut(
                ref=None,
                severity="info",
                code=PLAN_FROM_RAISED,
                message=(
                    f"The saved scenario started file projects from "
                    f"{plan_week_short(w.from_raised_from)}, which has passed; they start from "
                    f"{plan_week_label(w.from_week)}."
                ),
            )
        )
    if w.until_raised_from is not None:
        out.append(
            SimIssueOut(
                ref=None,
                severity="info",
                code=PLAN_UNTIL_RAISED,
                message=(
                    f"The saved scenario's plan window ended {plan_week_short(w.until_raised_from)}"
                    f", before file projects now start; it ends {plan_week_label(w.until_week)}."
                ),
            )
        )
    if w.from_week != w.current_week:
        out.append(
            SimIssueOut(
                ref=None,
                severity="info",
                code=PLAN_FROM_LATER,
                message=(
                    f"Simulated from W{w.current_week}; file projects start from "
                    f"{plan_week_label(w.from_week)}. Live plan projects keep their own start rules (their finishes can still move as capacity frees up)."
                ),
            )
        )
    return out


def plan_window_label(w: PlanWindow) -> str | None:
    """The window label "W48 2026 – W20 2027" when the request set `plan_until_week` (R49-18)."""

    if not w.until_given:
        return None
    return f"{plan_week_short(w.from_week)} – {plan_week_short(w.until_week)}"


def apply_plan_window(result: ImportSimulateResponse, w: PlanWindow) -> None:
    """Serve the window fields of `result` (R49-7, R49-15, R49-18)."""

    result.plan_from_week = w.from_week
    result.plan_from_min_week = w.current_week
    result.plan_from_label = plan_week_label(w.from_week)
    result.plan_until_week = w.until_week
    result.plan_window_label = plan_window_label(w)
    result.plan_week_choices = plan_week_choices(w.current_week)


def import_format_error(message: str) -> CodedHTTPException:
    return CodedHTTPException(HTTP_422, IMPORT_FORMAT, message)


# --- the plan context -------------------------------------------------------------------------


def steps_meta(ctx: WhatIfContext) -> tuple[StepMeta, ...]:
    return tuple(
        StepMeta(
            workflow=t.workflow_id,
            step_id=t.step_id,
            name=t.name,
            kind=t.kind,
            sequence_order=t.sequence_order,
            predecessor_ids=tuple(sorted(t.predecessor_ids)),
        )
        for t in sorted(
            ctx.baseline.schedule.workflow_steps, key=lambda t: (t.workflow_id, t.sequence_order)
        )
    )


def roster_of(ctx: WhatIfContext) -> tuple[RosterEntry, ...]:
    """Designers a row can name: FTE > 0 and counted in capacity (ADR 0044 §5)."""

    return tuple(
        RosterEntry(
            engineer_id=e.engineer_id,
            name=e.name,
            hub=e.hub,
            capacity_hub=dc.capacity_hub_name(e.hub),
            fte=float(e.fte),
        )
        for e in sorted(ctx.baseline.schedule.engineers, key=lambda e: (e.hub, e.name))
        if e.counts_in_capacity and e.fte > 0
    )


def app_lead_times(ctx: WhatIfContext) -> dict[tuple[str, str], dict[str, int]]:
    out: dict[tuple[str, str], dict[str, int]] = {}
    for lt in ctx.baseline.schedule.lead_times:
        out.setdefault((lt.workflow_id, lt.category), {})[lt.step_id] = lt.weeks
    return out


def plan_current_steps(ctx: WhatIfContext) -> dict[str, str | None]:
    """project_id -> the plan project's current step: the first step, in the
    workflow's walk order, that is neither Done nor skipped (ADR 0044
    amendment 2026-11-05, P32-R06: the fallback for a blank stage)."""

    si = ctx.baseline.schedule
    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    out: dict[str, str | None] = {}
    for p in si.projects:
        wf = workflows.get(p.workflow_id)
        if wf is None or p.category is None:
            out[p.project_id] = None
            continue
        timing = {t.step_id: t.duration_override_weeks for t in p.step_timing}
        rows = {t.step_id: t for t in p.step_timing}
        progress = {r.step_id: r.status for r in p.step_progress}
        out[p.project_id] = next(
            (
                sid
                for sid in wf.walk_order
                if progress.get(sid) != STATUS_DONE
                and not is_step_skipped(
                    # P33-T08 (R33-1): the builder's per-project lead.
                    lead_weeks=effective_lead_weeks(
                        rows.get(sid), table.get((p.workflow_id, p.category, sid), 0)
                    ),
                    kind=wf.steps_by_id[sid].kind,
                    certification_testing_required=p.certification_testing_required,
                    override_weeks=timing.get(sid),
                )
            ),
            None,
        )
    return out


async def matchable_projects(
    db: AsyncSession, principal: Principal, ctx: WhatIfContext
) -> tuple[MatchableProject, ...]:
    """Projects of the caller's hub scope that are in the baseline."""

    stmt = select(Project.id, Project.external_code).join(Hub, Project.hub_id == Hub.id)
    pred = hub_scope_filter(principal, Project.hub_id)
    if pred is not None:
        stmt = stmt.where(pred)
    codes = {str(pid): code for pid, code in (await db.execute(stmt)).all()}
    current = plan_current_steps(ctx)
    return tuple(
        MatchableProject(
            project_id=p.project_id,
            name=p.name,
            external_code=codes[p.project_id],
            hub=p.hub,
            priority=p.priority,
            leader_engineer_id=p.leader_engineer_id,
            status=p.status,
            category=p.category,
            current_step_id=current.get(p.project_id),
        )
        for p in ctx.baseline.schedule.projects
        if p.project_id in codes and ctx.scope.hub_ok(p.hub)
    )


async def build_parse_context(
    db: AsyncSession, principal: Principal, ctx: WhatIfContext
) -> ParseContext:
    return ParseContext(
        roster=roster_of(ctx),
        projects=await matchable_projects(db, principal, ctx),
        steps=steps_meta(ctx),
        app_lead_times=app_lead_times(ctx),
        current_week=ctx.baseline.schedule.current_week,
        base_year=BASE_YEAR,
        categories={c.code: c.workflow_id for c in ctx.baseline.schedule.categories},
    )


def steps_meta_out(meta: tuple[StepMeta, ...]) -> list[StepMetaOut]:
    return [
        StepMetaOut(
            workflow=m.workflow,
            step_id=m.step_id,
            name=m.name,
            kind=m.kind,
            sequence_order=m.sequence_order,
            predecessor_ids=list(m.predecessor_ids),
        )
        for m in meta
    ]


def parse_response(
    file_name: str, pctx: ParseContext, res: ParseResult, ctx: WhatIfContext
) -> ImportParseResponse:
    visible = [
        e
        for e in pctx.roster
        if ctx.scope.capacity_row_ok(e.capacity_hub) or e.engineer_id in res.matched_engineer_ids
    ]
    rows = []
    for r in res.rows:
        leader: dict[str, Any]
        if r.leader.kind == "existing":
            leader = {
                "kind": "existing",
                "engineer_id": r.leader.engineer_id,
                "name": r.leader.name or "",
            }
        elif r.leader.kind == "new":
            leader = {"kind": "new", "name": (r.leader.name or "")[:100]}
        else:
            leader = {"kind": "auto"}
        rows.append(
            ImportRow.model_validate(
                {
                    "key": r.key,
                    "file_row": r.file_row,
                    "sn": r.sn,
                    "code": r.code,
                    "plant": r.plant,
                    "name": r.name,
                    "hub": r.hub,
                    "hub_raw": r.hub_raw,
                    "category": r.category,
                    "category_raw": r.category_raw,
                    "lead_time_label": r.lead_time_label,
                    "status": r.status,
                    "status_raw": r.status_raw,
                    "stage_step_id": r.stage_step_id,
                    "stage_raw": r.stage_raw,
                    "rank": r.rank,
                    "priority": r.priority,
                    "priority_source": r.priority_source,
                    "engineer_raw": r.engineer_raw,
                    "leader": leader,
                    "matched_project_id": r.matched_project_id,
                    "matched_project_name": r.matched_project_name,
                    "match_by": r.match_by,
                    "num_projects": r.num_projects,
                    "must_do": r.must_do,
                    "spillover_from_previous": r.spillover_from_previous,
                    "complexity": r.complexity,
                    "est_duration_months": r.est_duration_months,
                    "certification_testing_required": r.certification_testing_required,
                    "step_weeks": dict(r.step_weeks),
                    "include": r.include,
                    "file_band": r.file_band,
                }
            )
        )
    return ImportParseResponse(
        file_name=file_name,
        projects_sheet=res.projects_sheet,
        steps_sheet=res.steps_sheet,
        base_year=pctx.base_year,
        current_week=pctx.current_week,
        lead_times=[
            LeadTimeRowOut(workflow=lt.workflow, label=lt.label, weeks=dict(lt.weeks))
            for lt in res.lead_times
        ],
        steps_meta=steps_meta_out(pctx.steps),
        roster=[
            RosterEntryOut(
                engineer_id=e.engineer_id,
                name=e.name,
                hub=e.hub,
                capacity_hub=e.capacity_hub,
                fte=e.fte,
            )
            for e in visible
        ],
        rows=rows,
        issues=[
            ImportIssue(
                row_key=i.row_key,
                file_row=i.file_row,
                field=i.field,
                severity=i.severity,
                code=i.code,
                message=i.message,
            )
            for i in res.issues
        ],
        counts=ImportCounts(**vars(res.counts)),
        plan_from_min_week=pctx.current_week,
        plan_week_choices=plan_week_choices(pctx.current_week),
    )


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


async def audit_parse(
    db: AsyncSession, principal: Principal, file_sha256: str, res: ParseResult
) -> None:
    issue_counts: dict[str, int] = {}
    for i in res.issues:
        issue_counts[i.code] = issue_counts.get(i.code, 0) + 1
    await audit_whatif(
        db,
        principal,
        "import_parse",
        {"file_sha256": file_sha256, "counts": vars(res.counts)},
        extra={"issue_counts": issue_counts, "steps_sheet": res.steps_sheet is not None},
    )


def safe_file_name(name: str | None) -> str:
    """Echoed back to the uploader only (never audited or logged)."""

    base = (name or "upload.xlsx").replace("\\", "/").rsplit("/", 1)[-1]
    cleaned = "".join(ch for ch in base if ch.isprintable())[:200]
    return cleaned or "upload.xlsx"


# --- simulate: request -> engine ---------------------------------------------------------------


@dataclasses.dataclass(frozen=True)
class EngineRequest:
    request: PlanImportRequest
    #: file keys of the request (after expansion)
    file_keys: frozenset[str]
    #: new designer key -> name
    new_names: dict[str, str]
    #: The resolved plan window (R49-7, R49-15).
    window: PlanWindow | None = None


def _norm_name(name: str) -> str:
    return " ".join(name.split()).casefold()


def to_engine_request(
    ctx: WhatIfContext, body: ImportSimulateRequest, window: PlanWindow | None = None
) -> EngineRequest:
    """Validate the reviewed rows against the plan and the caller's scope and
    build the engine request. Anything wrong is 422 `INVALID_IMPORT`; a
    project or engineer id the caller may not see is answered exactly like
    an unknown one (no existence leak)."""

    scope = ctx.scope
    if window is None:
        window = resolve_plan_window(ctx, body)
    wf_steps: dict[str, set[str]] = {}
    for t in ctx.baseline.schedule.workflow_steps:
        wf_steps.setdefault(t.workflow_id, set()).add(t.step_id)
    roster_ids = {e.engineer_id for e in roster_of(ctx)}

    # Owner rule (2026-11-04): a non-schedulable row is never simulated, even
    # with include=true (its plan project, if matched, is removed upstream:
    # `removed_project_ids`).
    rows = [r for r in body.rows if r.include and r.status in dc.SCHEDULABLE_STATUS_ORDER]
    base_ids = {p.project_id for p in ctx.baseline.schedule.projects}
    keys: set[str] = set()
    new_keys: dict[tuple[str, str], ImportNewEngineer] = {}
    projects: list[ImportProject] = []

    def copies(r: ImportRow) -> int:
        return r.num_projects if body.expand_multi and r.num_projects else 1

    total = sum(copies(r) for r in rows)
    if total > MAX_SIMULATED_FILE_PROJECTS:
        raise invalid_import(
            f"the file gives {total} projects after expanding Num of Projects; at most "
            f"{MAX_SIMULATED_FILE_PROJECTS} can be simulated. Exclude rows, lower Num of "
            "Projects or turn off the expansion."
        )
    category_workflow = {
        c.code: c.workflow_id
        for c in sorted(ctx.baseline.schedule.categories, key=lambda c: c.rank)
    }
    body_index = {id(r): i for i, r in enumerate(body.rows)}
    for r in rows:
        where = f"row {r.key!r}"
        if r.key in keys:
            raise invalid_import(f"{where}: duplicated row key")
        keys.add(r.key)
        wf = dc.WORKFLOW_ID_FOR_OEM_HUB if r.hub in dc.OEM_HUBS else dc.WORKFLOW_ID_FOR_NON_OEM_HUB
        # P33-T07 (ADR 0047 §5, contract B3): categories come from the input
        # (the `categories` table); an unknown code is the 422 the enum gave.
        if r.category not in category_workflow:
            raise unknown_category_error(
                [r.category],
                loc=("body", "rows", body_index[id(r)], "category"),
                allowed=list(category_workflow),
            )
        if category_workflow[r.category] != wf:
            raise invalid_import(f"{where}: category {r.category} does not fit hub {r.hub}")
        if r.stage_step_id is not None and not r.stage_step_id.startswith(wf + "-"):
            raise invalid_import(f"{where}: stage {r.stage_step_id} is not a step of {wf}")
        if set(r.step_weeks) != wf_steps.get(wf, set()):
            raise invalid_import(f"{where}: step_weeks must give the 14 steps of {wf}")
        if r.matched_project_id is not None:
            hub = ctx.project_hub.get(r.matched_project_id)
            if hub is None or not scope.hub_ok(hub):
                raise invalid_import(f"{where}: unknown project id {r.matched_project_id!r}")
        leader: str | None
        if isinstance(r.leader, LeaderExisting):
            if r.leader.engineer_id not in roster_ids:
                raise invalid_import(f"{where}: unknown engineer id {r.leader.engineer_id!r}")
            leader = r.leader.engineer_id
        elif isinstance(r.leader, LeaderNew):
            name = " ".join(r.leader.name.split())
            if not name:
                raise invalid_import(f"{where}: a new designer needs a name")
            cap = dc.capacity_hub_name(r.hub)
            dk = (_norm_name(name), cap)
            if dk not in new_keys:
                new_keys[dk] = ImportNewEngineer(
                    key=f"new:{len(new_keys) + 1}", name=name, hub=cap, fte=1.0
                )
            leader = new_keys[dk].key
        else:
            leader = None
        # Owner rule 2026-11-04: n copies "<name> (k/n)" keyed "<key>-<k>";
        # only copy 1 replaces the matched plan project.
        n = copies(r)
        for k in range(1, n + 1):
            projects.append(
                ImportProject(
                    key=r.key if n == 1 else f"{r.key}-{k}",
                    name=r.name if n == 1 else f"{r.name} ({k}/{n})",
                    hub=r.hub,
                    category=r.category,
                    status=r.status,
                    priority=r.priority,
                    # P32-R06: "Running" is rank 0 (first); the engine takes
                    # 1..9999, so every rank is shifted by one (order kept;
                    # 9998 and 9999 then tie and fall back to the file row).
                    rank=None if r.rank is None else min(r.rank + 1, 9999),
                    file_row=r.file_row,
                    leader=leader,
                    current_step_id=r.stage_step_id,
                    step_weeks=tuple(sorted(r.step_weeks.items())),
                    certification_testing_required=r.certification_testing_required,
                    replaces_project_id=(
                        r.matched_project_id
                        if k == 1 and r.matched_project_id in base_ids
                        else None
                    ),
                )
            )
    file_keys = frozenset(p.key for p in projects)
    edits = applicable_edits(ctx, body, projects)
    new_engs = tuple(new_keys.values())
    return EngineRequest(
        request=PlanImportRequest(
            projects=tuple(projects),
            new_engineers=new_engs,
            edits=tuple(edits),
            mode=body.mode,
            plan_year_end_week=body.plan_year_end_week,
            # ADR 0061: f and u, resolved (the engine re-validates them).
            plan_from_week=window.from_week,
            plan_until_week=window.until_week,
        ),
        file_keys=file_keys,
        new_names={ne.key: ne.name for ne in new_engs},
        window=window,
    )


def applicable_edits(
    ctx: WhatIfContext, body: ImportSimulateRequest, projects: list[ImportProject]
) -> list[StepEdit]:
    """The Gantt edits that still apply to this simulation (orchestrator ruling,
    P32-T04). The browser keeps edits across review changes, so an edit whose
    subject has gone (a row un-included or re-keyed, a plan project replaced by
    a match, out of scope, or not simulated in file_only mode), or whose step
    can no longer take that value (now done before the import, skipped, not
    scheduled, Done, frozen; a floor / overlap on a step that has started), is
    DROPPED (or narrowed to its duration) rather than failing the whole run.
    The mirror of the engine's rules (`scheduling.plan_import._apply_edit`).
    What is left that the engine still rejects is malformed (an overlap on a
    workflow's first step): 422 `INVALID_IMPORT`. An unknown or out-of-scope
    project id is dropped exactly like any other stale reference (no leak)."""

    si = ctx.baseline.schedule
    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    merge = body.mode == "merge"
    replaced = (
        {p.replaces_project_id for p in projects if p.replaces_project_id} if merge else set()
    )

    # ref -> (workflow, skipped steps, started steps, schedulable)
    subjects: dict[str, tuple[Workflow, frozenset[str], frozenset[str], bool]] = {}
    for fp in projects:
        wf_id = dc.WORKFLOW_ID_FOR_OEM_HUB if fp.hub in dc.OEM_HUBS else "PDD"
        wf = workflows[wf_id]
        done = _ancestors(wf, fp.current_step_id) if fp.current_step_id else frozenset()
        weeks = dict(fp.step_weeks)
        skipped = frozenset(
            sid
            for sid, st in wf.steps_by_id.items()
            if sid in done
            or is_step_skipped(
                lead_weeks=table.get((wf_id, fp.category, sid), 0),
                kind=st.kind,
                certification_testing_required=fp.certification_testing_required,
                override_weeks=weeks.get(sid),
            )
        )
        schedulable = fp.status in dc.SCHEDULABLE_STATUS_ORDER
        started: frozenset[str] = frozenset()
        if schedulable and fp.status in IN_PROGRESS_ON_IMPORT:
            first = next((sid for sid in wf.walk_order if sid not in skipped), None)
            started = frozenset({first}) if first else frozenset()
        subjects[fp.key] = (wf, skipped, started, schedulable)
    if merge:
        for p in si.projects:
            if p.project_id in replaced or not ctx.scope.hub_ok(p.hub):
                continue
            wf_opt = workflows.get(p.workflow_id)
            if wf_opt is None:
                continue
            timing = {t.step_id: t.duration_override_weeks for t in p.step_timing}
            rows = {t.step_id: t for t in p.step_timing}
            progress = {r.step_id: r.status for r in p.step_progress}
            ok = p.category is not None and not p.frozen and p.status in dc.SCHEDULABLE_STATUS_ORDER
            skipped = frozenset(
                sid
                for sid, st in wf_opt.steps_by_id.items()
                if progress.get(sid) == STATUS_DONE
                or is_step_skipped(
                    # P33-T08 (R33-1): the builder's per-project lead.
                    lead_weeks=effective_lead_weeks(
                        rows.get(sid), table.get((p.workflow_id, p.category or "", sid), 0)
                    ),
                    kind=st.kind,
                    certification_testing_required=p.certification_testing_required,
                    override_weeks=timing.get(sid),
                )
            )
            started = frozenset(
                sid for sid, stt in progress.items() if stt in (STATUS_IN_PROGRESS, STATUS_BLOCKED)
            )
            subjects[p.project_id] = (wf_opt, skipped, started, ok)

    out: list[StepEdit] = []
    for e in body.edits:
        subject = subjects.get(e.project_ref)
        if subject is None:
            continue
        wf, skipped, started, schedulable = subject
        if not schedulable or e.step_id not in wf.steps_by_id or e.step_id in skipped:
            continue
        floor, overlap = e.start_not_before_week, e.overlap_weeks
        if e.step_id in started:
            floor, overlap = None, None
            if e.duration_weeks is None:
                continue
        out.append(
            StepEdit(
                project_ref=e.project_ref,
                step_id=e.step_id,
                duration_weeks=e.duration_weeks,
                start_not_before_week=floor,
                overlap_weeks=overlap,
            )
        )
    return out


# --- simulate: engine -> response (scoped) ----------------------------------------------------


def _step_out(st: Any, eng_name: dict[str, str], ch_code: dict[str, str]) -> ImportStepOut:
    return ImportStepOut(
        step_id=st.step_id,
        kind=st.kind,
        sequence_order=st.sequence_order,
        start_week=st.start_week,
        end_week=st.end_week,
        duration_weeks=st.duration_weeks,
        span_weeks=st.span_weeks,
        skipped=st.skipped,
        done_before_import=st.done_before_import,
        status=st.status,
        engineer_name=eng_name.get(st.engineer_id) if st.engineer_id else None,
        chamber_code=ch_code.get(st.chamber_id) if st.chamber_id else None,
        duration_override_weeks=st.duration_override_weeks,
        start_not_before_week=st.start_not_before_week,
        overlap_weeks=st.overlap_weeks,
        editable=st.editable,
    )


def _project_out(
    p: PlanImportProject, eng_name: dict[str, str], ch_code: dict[str, str]
) -> ImportProjectOut:
    return ImportProjectOut(
        ref=p.ref,
        source=p.source,
        file_row=p.file_row,
        replaces_project_id=p.replaces_project_id,
        name=p.name,
        hub=p.hub,
        capacity_hub=p.capacity_hub,
        category=p.category,
        priority=p.priority,
        status=p.status,
        leader_name=eng_name.get(p.leader_ref) if p.leader_ref else None,
        leader_ref=p.leader_ref,
        leader_auto_assigned=p.leader_auto_assigned,
        outcome=p.outcome,
        within_plan_year=p.within_plan_year,
        start_week=p.start_week,
        end_week=p.end_week,
        finish_week=p.finish_week,
        unconstrained_end_week=p.unconstrained_end_week,
        before_outcome=p.before_outcome,
        before_finish_week=p.before_finish_week,
        eng_conflict=p.eng_conflict,
        cat_not_allowed=p.cat_not_allowed,
        lab_overlap=p.lab_overlap,
        no_leader=p.no_leader,
        no_chamber_step_id=p.no_chamber_step_id,
        data_error=p.data_error,
        steps=[_step_out(st, eng_name, ch_code) for st in p.steps],
        counts_toward_year=p.counts_toward_year,
        not_scheduled_priority=p.not_scheduled_priority,
    )


# --- served breakdowns (P32-R05, docs/API_CONTRACT_P32.md C1) ---------------------------------

_NOT_PLACED_OUTCOMES = frozenset({"left_out", "blocked", "data_error"})
_PLACED_OUTCOMES = frozenset({"within_year", "spillover"})
#: Every outcome class (`scheduling.whatif.OUTCOME_CLASSES`; P42 adds
#: `not_scheduled_priority` and `queued`), the keys of `BreakdownOutcomesOut`.
_OUTCOME_KEYS: tuple[str, ...] = (
    "within_year",
    "spillover",
    "left_out",
    "blocked",
    "data_error",
    "excluded",
    "queued",
    "not_scheduled_priority",
)
#: A project with no value for a dimension (a data-error file row) is counted
#: under this key, last, so every dimension still sums to the block's total.
UNKNOWN_BUCKET = "unknown"
_HUB_ORDER: tuple[str, ...] = tuple(h.value for h in HubName)
_STATUS_ORDER: tuple[str, ...] = tuple(s.value for s in ProjectStatus)
_SOURCE_ORDER: tuple[str, ...] = ("file", "plan")
_QUARTER_WEEKS = 13


def breakdown_year_key(p: ImportProjectOut) -> str | None:
    """The year block a served project belongs to besides `all` (C1): placed
    projects by `finish_week` (1..52 base year, 53..104 next year, > 104
    `later`); left_out / blocked / data_error are `not_placed`; excluded file
    rows are only in `all`.

    P42 (R42-6): a `queued` project goes by its finish week like a placed one
    (counted in its block's `queued` column, never in `within_year`), or to
    `not_placed` when it has no slot. `not_scheduled_priority` is only in
    `all`, like `excluded`."""

    if p.outcome in _NOT_PLACED_OUTCOMES:
        return "not_placed"
    if p.outcome == "queued" and p.finish_week is None:
        return "not_placed"
    if p.outcome not in (*_PLACED_OUTCOMES, "queued") or p.finish_week is None:
        return None
    if p.finish_week <= dc.WEEKS_IN_YEAR:
        return str(BASE_YEAR)
    if p.finish_week <= 2 * dc.WEEKS_IN_YEAR:
        return str(BASE_YEAR + 1)
    return "later"


def breakdown_years() -> list[BreakdownYearOut]:
    return [
        BreakdownYearOut(key="all", label="All projects"),
        BreakdownYearOut(key=str(BASE_YEAR), label=f"Finish in {BASE_YEAR}"),
        BreakdownYearOut(key=str(BASE_YEAR + 1), label=f"Finish in {BASE_YEAR + 1}"),
        BreakdownYearOut(key="later", label=f"Finish after {BASE_YEAR + 1}"),
        BreakdownYearOut(key="not_placed", label="Not placed"),
    ]


def finish_quarter(week: int) -> tuple[int, int]:
    """(calendar year, quarter) of an absolute week (53 = base year + 1, W1);
    weeks 1-13 are Q1 ... 40-52 Q4."""

    offset, in_year = divmod(week - 1, dc.WEEKS_IN_YEAR)
    return BASE_YEAR + offset, min(in_year // _QUARTER_WEEKS + 1, 4)


def _buckets(
    projects: list[ImportProjectOut],
    value: Callable[[ImportProjectOut], str | None],
    order: tuple[str, ...],
) -> list[BreakdownBucketOut]:
    counts: dict[str, list[int]] = {}
    for p in projects:
        key = value(p) or UNKNOWN_BUCKET
        c = counts.setdefault(key, [0, 0, 0, 0, 0])
        c[0] += 1
        if p.outcome in _NOT_PLACED_OUTCOMES:
            c[3] += 1
        elif p.outcome in _PLACED_OUTCOMES:
            c[1 if p.within_plan_year else 2] += 1
        elif p.outcome == "queued":
            # P42 (R42-6): never within the year, its own column.
            c[4] += 1
    rank = {k: i for i, k in enumerate(order)}
    keys = sorted(counts, key=lambda k: (k == UNKNOWN_BUCKET, rank.get(k, len(rank)), k))
    return [
        BreakdownBucketOut(
            key=k,
            total=counts[k][0],
            within_year=counts[k][1],
            spillover=counts[k][2],
            not_placed=counts[k][3],
            queued=counts[k][4],
        )
        for k in keys
    ]


def breakdown_of(
    projects: list[ImportProjectOut], category_order: tuple[str, ...] = dc.CATEGORY_ORDER
) -> BreakdownOut:
    oc = dict.fromkeys(_OUTCOME_KEYS, 0)
    quarters: dict[tuple[int, int], int] = {}
    for p in projects:
        oc[p.outcome] += 1
        if p.outcome in (*_PLACED_OUTCOMES, "queued") and p.finish_week is not None:
            yq = finish_quarter(p.finish_week)
            quarters[yq] = quarters.get(yq, 0) + 1
    return BreakdownOut(
        total=len(projects),
        file=sum(1 for p in projects if p.source == "file"),
        plan=sum(1 for p in projects if p.source == "plan"),
        outcomes=BreakdownOutcomesOut(**oc),
        by_category=_buckets(projects, lambda p: p.category, category_order),
        by_hub=_buckets(projects, lambda p: p.hub, _HUB_ORDER),
        by_priority=_buckets(projects, lambda p: p.priority, dc.PRIORITY_ORDER),
        by_status=_buckets(projects, lambda p: p.status, _STATUS_ORDER),
        by_source=_buckets(projects, lambda p: p.source, _SOURCE_ORDER),
        by_finish_quarter=[
            FinishQuarterOut(key=f"{y}-Q{q}", label=f"Q{q} '{y % 100:02d}", count=n)
            for (y, q), n in sorted(quarters.items())
        ],
    )


def import_breakdowns(
    projects: list[ImportProjectOut], category_order: tuple[str, ...] = dc.CATEGORY_ORDER
) -> ImportBreakdownsOut:
    """C1: every chart figure of the Executive tab, over exactly the served
    (already scoped) `projects`, so the charts reconcile with the list.
    `category_order`: the input's categories in rank order (P33-T07; default
    the seeded seven)."""

    years = breakdown_years()
    by_key: dict[str, list[ImportProjectOut]] = {y.key: [] for y in years}
    by_key["all"] = list(projects)
    for p in projects:
        key = breakdown_year_key(p)
        if key is not None:
            by_key[key].append(p)
    return ImportBreakdownsOut(
        years=years, by_year={k: breakdown_of(v, category_order) for k, v in by_key.items()}
    )


def scope_import_result(
    ctx: WhatIfContext, er: EngineRequest, raw: PlanImportResult
) -> ImportSimulateResponse:
    """Narrow the whole-plan result to the caller's scope (module docstring).
    Every KPI is recomputed from what is kept, so no other hub leaks through a
    count; for an unrestricted caller the figures equal the engine's."""

    scope = ctx.scope
    merge = raw.mode == "merge"
    eng_name = {e.engineer_id: e.name for e in ctx.baseline.schedule.engineers}
    eng_name.update(er.new_names)
    ch_code = {c.chamber_id: c.code for c in ctx.baseline.schedule.chambers}

    file_rows = [p for p in raw.projects if p.source == "file"]
    plan_rows = [p for p in raw.projects if p.source == "plan" and scope.hub_ok(p.hub)]
    visible_refs = {p.ref for p in file_rows} | {p.ref for p in plan_rows}

    # Plan projects of the run that are excluded (not served as rows, counted).
    replaced = {fp.replaces_project_id for fp in er.request.projects} if merge else set()
    served_plan = {p.ref for p in raw.projects if p.source == "plan"}
    hidden_plan = (
        [
            bp
            for bp in ctx.baseline.schedule.projects
            if bp.project_id not in replaced
            and bp.project_id not in served_plan
            and scope.hub_ok(bp.hub)
        ]
        if merge
        else []
    )
    excluded_plan_in_scope = len(hidden_plan)
    # P42 (R42-6): a hidden plan project that is a non-frozen P4/Q is
    # `not_scheduled_priority`, not `excluded` (P42-T02 resolution (c)).
    hidden_not_scheduled = sum(1 for bp in hidden_plan if is_not_scheduled_priority(bp))

    rows = file_rows + plan_rows
    oc = dict.fromkeys(_OUTCOME_KEYS, 0)
    for p in rows:
        oc[p.outcome] += 1
    oc["excluded"] += excluded_plan_in_scope - hidden_not_scheduled
    oc["not_scheduled_priority"] += hidden_not_scheduled

    def ch_ok(c: Any) -> bool:
        return scope.hub_ok(c.hub)

    def ch_out(c: Any) -> ImportChangeOut:
        return ImportChangeOut(
            ref=c.ref,
            name=c.name,
            hub=c.hub,
            before_finish_week=c.before_finish_week,
            after_finish_week=c.after_finish_week,
        )

    changes = ImportChangesOut(
        newly_slipping=[ch_out(c) for c in raw.changes.newly_slipping if ch_ok(c)],
        recovered=[ch_out(c) for c in raw.changes.recovered if ch_ok(c)],
        moved=[ch_out(c) for c in raw.changes.moved if ch_ok(c)],
    )
    kpis = ImportKpisOut(
        projects_total=len(rows) + excluded_plan_in_scope,
        file_projects=len(file_rows),
        plan_projects=len(plan_rows) + excluded_plan_in_scope,
        within_plan_year=oc["within_year"],
        spillover=oc["spillover"],
        left_out=oc["left_out"],
        blocked=oc["blocked"],
        excluded=oc["excluded"],
        data_error=oc["data_error"],
        file_within_plan_year=sum(1 for p in file_rows if p.outcome == "within_year"),
        file_scheduled=sum(1 for p in file_rows if p.outcome != "excluded"),
        before_within_plan_year=(
            sum(1 for p in plan_rows if p.before_outcome == "within_year") if merge else None
        ),
        after_within_plan_year_existing=(
            sum(1 for p in plan_rows if p.outcome == "within_year") if merge else None
        ),
        newly_slipping=len(changes.newly_slipping),
        recovered=len(changes.recovered),
        queued=oc["queued"],
        not_scheduled_priority=oc["not_scheduled_priority"],
    )

    cap = raw.capacity
    weekly = cap.weekly
    new_keys = set(er.new_names)
    capacity = ImportCapacityOut(
        windows=[
            CapacityWindowOut(key=w.key, label=w.label, from_week=w.from_week, to_week=w.to_week)
            for w in cap.windows
        ],
        hubs=[
            HubCapacityOut(
                hub=h.hub,
                fte=h.fte,
                windows=[WindowLoadOut(**dataclasses.asdict(f)) for f in h.windows],
            )
            for h in cap.hubs
            if scope.capacity_row_ok(h.hub)
        ],
        lab_regions=[
            LabRegionCapacityOut(
                region=r.region,
                chambers=r.chambers,
                windows=[WindowLoadOut(**dataclasses.asdict(f)) for f in r.windows],
            )
            for r in cap.lab_regions
            if scope.region_ok(r.region)
        ],
        weekly=WeeklyCapacityOut(
            weeks=list(weekly.weeks),
            hubs={
                h: WeeklySeriesOut(load=list(s.load), capacity=list(s.capacity))
                for h, s in sorted(weekly.hubs.items())
                if scope.capacity_row_ok(h)
            },
            lab_regions={
                r: WeeklySeriesOut(load=list(s.load), capacity=list(s.capacity))
                for r, s in sorted(weekly.lab_regions.items())
                if scope.region_ok(r)
            },
        ),
        designers=[
            DesignerCapacityOut(
                ref=d.ref,
                name=eng_name.get(d.ref, ""),
                hub=d.hub,
                fte=d.fte,
                is_new=d.is_new,
                windows=[
                    DesignerWindowOut(
                        key=f.key,
                        booked_weeks=f.booked_weeks,
                        booked_span_weeks=f.booked_span_weeks,
                        available_weeks=f.available_weeks,
                        booked_pct=f.booked_pct,
                        status=f.status,
                    )
                    for f in d.windows
                ],
            )
            for d in cap.designers
            if scope.capacity_row_ok(d.capacity_hub) or d.ref in new_keys
        ],
    )

    issues = [
        SimIssueOut(ref=i.ref, severity=i.severity, code=i.code, message=i.message)
        for i in raw.issues
        if i.ref is None or i.ref in visible_refs
    ]
    if scope.all_hubs:
        workings = list(raw.workings)
    else:
        workings = [
            f"Mode {raw.mode}: {kpis.file_projects} file project(s)"
            + (
                f" merged with the live plan ({kpis.plan_projects} project(s) in your hubs)."
                if merge
                else " scheduled alone on the live designers and chambers."
            ),
            (
                f"Plan year ends week {raw.plan_year_end_week}; search horizon week "
                f"{raw.horizon_weeks}; today is week {raw.current_week}."
                if er.window is None or not er.window.until_given
                else f"Plan window ends week {er.window.until_week}; search horizon week "
                f"{raw.horizon_weeks}; today is week {raw.current_week}."
            ),
            f"Finishing within the plan year (your hubs and your file): {kpis.within_plan_year} "
            f"(file {kpis.file_within_plan_year} of {kpis.file_scheduled} scheduled)"
            + (
                f"; existing {kpis.before_within_plan_year} -> "
                f"{kpis.after_within_plan_year_existing}."
                if merge
                else "."
            ),
        ]
        if er.window is not None and er.window.from_week != er.window.current_week:
            # R49-12 (the engine's own workings already say it for an
            # all-hubs caller): "Simulated from W{cw}" keeps meaning cw.
            workings.append(f"File projects start from {plan_week_label(er.window.from_week)}.")
    served = [_project_out(p, eng_name, ch_code) for p in rows]
    return ImportSimulateResponse(
        base_year=BASE_YEAR,
        current_week=raw.current_week,
        plan_year_end_week=raw.plan_year_end_week,
        horizon_weeks=raw.horizon_weeks,
        mode=raw.mode,
        kpis=kpis,
        steps_meta=steps_meta_out(steps_meta(ctx)),
        projects=served,
        capacity=capacity,
        changes=changes,
        issues=issues,
        workings=workings,
        breakdowns=import_breakdowns(
            served,
            tuple(c.code for c in sorted(ctx.baseline.schedule.categories, key=lambda c: c.rank)),
        ),
    )


def _run_or_error(ctx: WhatIfContext, req: PlanImportRequest) -> PlanImportResult | ValueError:
    """Runs in the What-if pool. An engine `ValueError` is RETURNED so it maps
    to `INVALID_IMPORT` (not `run_capped`'s `INVALID_SCENARIO`);
    `WhatIfBudgetExceeded` propagates (503 `WHATIF_TIMEOUT`)."""

    try:
        return run_plan_import(ctx.baseline, req, deadline_s=WHATIF_DEADLINE_SECONDS)
    except ValueError as exc:
        return exc


def removed_project_ids(ctx: WhatIfContext, body: ImportSimulateRequest) -> frozenset[str]:
    """Owner rule (2026-11-04): in merge mode a file row that matches a plan
    project and says it is On Hold / Cancelled / Commercialized REMOVES that
    project from the run (the file is the newer truth), whatever its include
    flag. The id must be in the caller's scope (else 422, like any unknown id)."""

    if body.mode != "merge":
        return frozenset()
    out: set[str] = set()
    for r in body.rows:
        if r.status in dc.SCHEDULABLE_STATUS_ORDER or r.matched_project_id is None:
            continue
        hub = ctx.project_hub.get(r.matched_project_id)
        if hub is None or not ctx.scope.hub_ok(hub):
            raise invalid_import(f"row {r.key!r}: unknown project id {r.matched_project_id!r}")
        out.add(r.matched_project_id)
    return frozenset(out)


def without_projects(ctx: WhatIfContext, ids: frozenset[str]) -> WhatIfContext:
    """`ctx` with `ids` taken out of the baseline (both runs, so they are
    neither scheduled, returned, nor counted). The original is untouched."""

    if not ids:
        return ctx
    si = ctx.baseline.schedule
    schedule = dataclasses.replace(
        si, projects=tuple(p for p in si.projects if p.project_id not in ids)
    )
    return dataclasses.replace(ctx, baseline=dataclasses.replace(ctx.baseline, schedule=schedule))


def excluded_plan_project_ids(
    ctx: WhatIfContext, body: ImportSimulateRequest, removed: frozenset[str]
) -> frozenset[str]:
    """ADR 0055 D2: the unticked plan projects (`exclude_plan_project_ids`)
    that this request actually takes out of both runs.

    Merge mode only (a non-empty list in file_only is 422). Each id must be
    unique and a project of the baseline in the caller's scope; an unknown or
    out-of-scope id is 422 (no existence leak). Only a tickable one (in
    `plan_projects_out` after the file's removals) is taken out. Accepted and
    counted 0 in `plan_excluded` (P41-R01 addendum, workflow A1):
    - an id that an included schedulable file row matches (that row replaces
      the project; the before run keeps it, like any replaced project);
    - an id the file already removes (On Hold / Cancelled / Commercialized row);
    - an id whose project is in scope but no longer schedulable in the live
      plan (so "Re-run on today's plan" on a saved request does not fail)."""

    ids = body.exclude_plan_project_ids
    if not ids:
        return frozenset()
    if body.mode != "merge":
        raise invalid_import("exclude_plan_project_ids applies to merge mode only")
    if len(set(ids)) != len(ids):
        raise invalid_import("exclude_plan_project_ids: duplicated project id")
    base_ids = {p.project_id for p in ctx.baseline.schedule.projects}
    for pid in ids:
        hub = ctx.project_hub.get(pid)
        if pid not in base_ids or hub is None or not ctx.scope.hub_ok(hub):
            raise invalid_import(f"exclude_plan_project_ids: unknown project id {pid!r}")
    pickable = {p.id for p in plan_projects_out(without_projects(ctx, removed), body.mode)}
    replaced = {
        r.matched_project_id
        for r in body.rows
        if r.include and r.status in dc.SCHEDULABLE_STATUS_ORDER and r.matched_project_id
    }
    return frozenset(pid for pid in ids if pid in pickable and pid not in replaced)


def plan_projects_out(ctx: WhatIfContext, mode: str) -> list[PlanProjectOut]:
    """ADR 0055 D2: every in-scope plan project that could be in the run
    (before `exclude_plan_project_ids`), for the scenario tick list: a
    baseline project in the caller's scope whose status is schedulable (On
    Hold / Cancelled / Commercialized plan projects are never run, so they
    cannot be ticked). `[]` in file_only. Order: hub, then name, then id."""

    if mode != "merge":
        return []
    rows = [
        PlanProjectOut(
            id=p.project_id,
            name=p.name,
            hub=p.hub,
            category=p.category,
            priority=p.priority,
            status=p.status,
        )
        for p in ctx.baseline.schedule.projects
        if ctx.scope.hub_ok(p.hub) and p.status in dc.SCHEDULABLE_STATUS_ORDER
    ]
    rows.sort(key=lambda r: (r.hub, r.name.casefold(), r.id))
    return rows


#: P40 (ADR 0054 R40-12): a matched plan project the file replaces loses its
#: manual pins in the simulation (the file is the newer truth).
PIN_DROPPED = "PIN_DROPPED"


def pin_dropped_issues(
    ctx: WhatIfContext, body: ImportSimulateRequest, existing: Sequence[SimIssueOut]
) -> list[SimIssueOut]:
    """One `PIN_DROPPED` info issue per included schedulable file row whose
    matched plan project carries pins in the baseline (merge mode). The ref is
    the file row's key, which the caller sees already; no pin weeks are
    disclosed. Not repeated when the engine already reported it."""

    if body.mode != "merge":
        return []
    pinned = {p.project_id for p in ctx.baseline.schedule.projects if p.step_pins}
    if not pinned:
        return []
    already = {(i.ref, i.code) for i in existing}
    out: list[SimIssueOut] = []
    for r in body.rows:
        if (
            not r.include
            or r.status not in dc.SCHEDULABLE_STATUS_ORDER
            or r.matched_project_id is None
            or r.matched_project_id not in pinned
            or (r.key, PIN_DROPPED) in already
        ):
            continue
        hub = ctx.project_hub.get(r.matched_project_id)
        if hub is None or not ctx.scope.hub_ok(hub):
            continue
        out.append(
            SimIssueOut(
                ref=r.key,
                severity="info",
                code=PIN_DROPPED,
                message=(
                    "The matched plan project has manual step weeks; the file replaces it, "
                    "so they are not used in this simulation."
                ),
            )
        )
        already.add((r.key, PIN_DROPPED))
    return out


async def do_import_simulate(
    ctx: WhatIfContext, body: ImportSimulateRequest
) -> ImportSimulateResponse:
    removed = removed_project_ids(ctx, body)
    excluded = excluded_plan_project_ids(ctx, body, removed)
    ctx = without_projects(ctx, removed)
    pickable = plan_projects_out(ctx, body.mode)
    ctx = without_projects(ctx, excluded)
    window = resolve_plan_window(ctx, body)
    er = to_engine_request(ctx, body, window)
    raw = await run_capped(
        lambda: _run_or_error(ctx, er.request), WHATIF_TIME_CAP_SECONDS, user_key=ctx.user_key
    )
    if isinstance(raw, ValueError):
        raise invalid_import(str(raw))
    result = scope_import_result(ctx, er, raw)
    result.issues.extend(pin_dropped_issues(ctx, body, result.issues))
    result.kpis.plan_excluded = len(excluded)
    result.plan_projects = pickable
    result.issues[:0] = plan_window_issues(window)
    apply_plan_window(result, window)
    return result


def request_digest_body(body: ImportSimulateRequest) -> dict[str, Any]:
    """The request as digested: the P49 window keys only when set, so a
    request without them digests as before."""

    out = body.model_dump(mode="json")
    for key, default in (
        ("plan_from_week", None),
        ("plan_until_week", None),
        ("plan_window_rerun", False),
    ):
        if out.get(key) == default:
            out.pop(key, None)
    return out


async def audit_import_simulate(
    db: AsyncSession,
    principal: Principal,
    body: ImportSimulateRequest,
    result: ImportSimulateResponse,
) -> None:
    """Counts and a digest of the request only: never a name or a row."""

    included = [r for r in body.rows if r.include]
    shape = {
        "mode": body.mode,
        "plan_year_end_week": body.plan_year_end_week,
        "expand_multi": body.expand_multi,
        "rows": len(body.rows),
        "included": len(included),
        "replacing": sum(1 for r in included if r.matched_project_id),
        "removing": sum(
            1
            for r in body.rows
            if body.mode == "merge"
            and r.matched_project_id
            and r.status not in dc.SCHEDULABLE_STATUS_ORDER
        ),
        "auto_leaders": sum(1 for r in included if r.leader.kind == "auto"),
        "new_leaders": sum(1 for r in included if r.leader.kind == "new"),
        "edits": len(body.edits),
        # P41-R01 addendum (workflow A3): the served count, not the ids sent.
        "plan_excluded": result.kpis.plan_excluded,
        # ADR 0061 (R49-13, R49-19): the resolved window.
        "plan_from_week": result.plan_from_week,
        "plan_until_week": result.plan_until_week,
        "request_digest": digest_of(request_digest_body(body)),
    }
    k = result.kpis
    await audit_whatif(
        db,
        principal,
        "import_simulate",
        shape,
        extra={
            "file_projects": k.file_projects,
            "file_within_plan_year": k.file_within_plan_year,
            "within_plan_year": k.within_plan_year,
            "newly_slipping": k.newly_slipping,
        },
    )
