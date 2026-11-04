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
from collections.abc import Callable
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

import domain_constants as dc
from api.errors import HTTP_422, CodedHTTPException
from core.principal import Principal
from models.enums import HubName, ProjectStatus
from models.hub import Hub
from models.project import Project
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
    RosterEntryOut,
    SimIssueOut,
    StepMetaOut,
    WeeklyCapacityOut,
    WeeklySeriesOut,
    WindowLoadOut,
)
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


async def matchable_projects(
    db: AsyncSession, principal: Principal, ctx: WhatIfContext
) -> tuple[MatchableProject, ...]:
    """Projects of the caller's hub scope that are in the baseline."""

    stmt = select(Project.id, Project.external_code).join(Hub, Project.hub_id == Hub.id)
    pred = hub_scope_filter(principal, Project.hub_id)
    if pred is not None:
        stmt = stmt.where(pred)
    codes = {str(pid): code for pid, code in (await db.execute(stmt)).all()}
    return tuple(
        MatchableProject(
            project_id=p.project_id,
            name=p.name,
            external_code=codes[p.project_id],
            hub=p.hub,
            priority=p.priority,
            leader_engineer_id=p.leader_engineer_id,
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


def _norm_name(name: str) -> str:
    return " ".join(name.split()).casefold()


def to_engine_request(ctx: WhatIfContext, body: ImportSimulateRequest) -> EngineRequest:
    """Validate the reviewed rows against the plan and the caller's scope and
    build the engine request. Anything wrong is 422 `INVALID_IMPORT`; a
    project or engineer id the caller may not see is answered exactly like
    an unknown one (no existence leak)."""

    scope = ctx.scope
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
    for r in rows:
        where = f"row {r.key!r}"
        if r.key in keys:
            raise invalid_import(f"{where}: duplicated row key")
        keys.add(r.key)
        wf = dc.WORKFLOW_ID_FOR_OEM_HUB if r.hub in dc.OEM_HUBS else dc.WORKFLOW_ID_FOR_NON_OEM_HUB
        oem_cat = r.category in dc.OEM_CATEGORIES
        if oem_cat != (wf == dc.WORKFLOW_ID_FOR_OEM_HUB):
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
                    rank=r.rank,
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
        ),
        file_keys=file_keys,
        new_names={ne.key: ne.name for ne in new_engs},
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
            progress = {r.step_id: r.status for r in p.step_progress}
            ok = p.category is not None and not p.frozen and p.status in dc.SCHEDULABLE_STATUS_ORDER
            skipped = frozenset(
                sid
                for sid, st in wf_opt.steps_by_id.items()
                if progress.get(sid) == STATUS_DONE
                or is_step_skipped(
                    lead_weeks=table.get((p.workflow_id, p.category or "", sid), 0),
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
    )


# --- served breakdowns (P32-R05, docs/API_CONTRACT_P32.md C1) ---------------------------------

_NOT_PLACED_OUTCOMES = frozenset({"left_out", "blocked", "data_error"})
_PLACED_OUTCOMES = frozenset({"within_year", "spillover"})
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
    rows are only in `all`."""

    if p.outcome in _NOT_PLACED_OUTCOMES:
        return "not_placed"
    if p.outcome not in _PLACED_OUTCOMES or p.finish_week is None:
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
        c = counts.setdefault(key, [0, 0, 0, 0])
        c[0] += 1
        if p.outcome in _NOT_PLACED_OUTCOMES:
            c[3] += 1
        elif p.outcome in _PLACED_OUTCOMES:
            c[1 if p.within_plan_year else 2] += 1
    rank = {k: i for i, k in enumerate(order)}
    keys = sorted(counts, key=lambda k: (k == UNKNOWN_BUCKET, rank.get(k, len(rank)), k))
    return [
        BreakdownBucketOut(
            key=k,
            total=counts[k][0],
            within_year=counts[k][1],
            spillover=counts[k][2],
            not_placed=counts[k][3],
        )
        for k in keys
    ]


def breakdown_of(projects: list[ImportProjectOut]) -> BreakdownOut:
    oc = dict.fromkeys(
        ("within_year", "spillover", "left_out", "blocked", "data_error", "excluded"), 0
    )
    quarters: dict[tuple[int, int], int] = {}
    for p in projects:
        oc[p.outcome] += 1
        if p.outcome in _PLACED_OUTCOMES and p.finish_week is not None:
            yq = finish_quarter(p.finish_week)
            quarters[yq] = quarters.get(yq, 0) + 1
    return BreakdownOut(
        total=len(projects),
        file=sum(1 for p in projects if p.source == "file"),
        plan=sum(1 for p in projects if p.source == "plan"),
        outcomes=BreakdownOutcomesOut(**oc),
        by_category=_buckets(projects, lambda p: p.category, dc.CATEGORY_ORDER),
        by_hub=_buckets(projects, lambda p: p.hub, _HUB_ORDER),
        by_priority=_buckets(projects, lambda p: p.priority, dc.PRIORITY_ORDER),
        by_status=_buckets(projects, lambda p: p.status, _STATUS_ORDER),
        by_source=_buckets(projects, lambda p: p.source, _SOURCE_ORDER),
        by_finish_quarter=[
            FinishQuarterOut(key=f"{y}-Q{q}", label=f"Q{q} '{y % 100:02d}", count=n)
            for (y, q), n in sorted(quarters.items())
        ],
    )


def import_breakdowns(projects: list[ImportProjectOut]) -> ImportBreakdownsOut:
    """C1: every chart figure of the Executive tab, over exactly the served
    (already scoped) `projects`, so the charts reconcile with the list."""

    years = breakdown_years()
    by_key: dict[str, list[ImportProjectOut]] = {y.key: [] for y in years}
    by_key["all"] = list(projects)
    for p in projects:
        key = breakdown_year_key(p)
        if key is not None:
            by_key[key].append(p)
    return ImportBreakdownsOut(years=years, by_year={k: breakdown_of(v) for k, v in by_key.items()})


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
    excluded_plan_in_scope = (
        sum(
            1
            for bp in ctx.baseline.schedule.projects
            if bp.project_id not in replaced
            and bp.project_id not in served_plan
            and scope.hub_ok(bp.hub)
        )
        if merge
        else 0
    )

    rows = file_rows + plan_rows
    oc = {
        k: 0 for k in ("within_year", "spillover", "left_out", "blocked", "excluded", "data_error")
    }
    for p in rows:
        oc[p.outcome] += 1
    oc["excluded"] += excluded_plan_in_scope

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
            f"Plan year ends week {raw.plan_year_end_week}; search horizon week "
            f"{raw.horizon_weeks}; today is week {raw.current_week}.",
            f"Finishing within the plan year (your hubs and your file): {kpis.within_plan_year} "
            f"(file {kpis.file_within_plan_year} of {kpis.file_scheduled} scheduled)"
            + (
                f"; existing {kpis.before_within_plan_year} -> "
                f"{kpis.after_within_plan_year_existing}."
                if merge
                else "."
            ),
        ]
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
        breakdowns=import_breakdowns(served),
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


async def do_import_simulate(
    ctx: WhatIfContext, body: ImportSimulateRequest
) -> ImportSimulateResponse:
    ctx = without_projects(ctx, removed_project_ids(ctx, body))
    er = to_engine_request(ctx, body)
    raw = await run_capped(
        lambda: _run_or_error(ctx, er.request), WHATIF_TIME_CAP_SECONDS, user_key=ctx.user_key
    )
    if isinstance(raw, ValueError):
        raise invalid_import(str(raw))
    return scope_import_result(ctx, er, raw)


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
        "request_digest": digest_of(body.model_dump(mode="json")),
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
