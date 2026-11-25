"""P58-B: a Projects list download, edited and uploaded to the What-if import.

The Projects page download (`GET /exports/dashboard?view=register`,
`services.register_export`) is accepted by `POST /whatif/import/parse` as is.
It is found by its header row (`Project` with `Project ID`, or with `Hub`,
`Status` and `Current step`), never by sheet name or column letter.

**Matching.** `Project ID` first (a project of the caller's scope), then a
code unique in the plan and the file, then a name unique in both. Anything
else is a new project. An id the caller cannot see reads exactly like an
unknown one (no existence leak).

**Changes.** Each cell of a matched row is compared with the same cell the
download writes for that project now (`register_cells`, the one definition
both directions use), so a file uploaded without edits has no change. A row
is:
- `unchanged`: no scheduling input differs. In merge mode it is not a file
  project: the plan project stays in the run exactly as it is (progress,
  effort, exclusions, pins).
- `changed`: a scheduling input differs (name, hub, category, status,
  priority, global rank, leader, current step, design time, lab time). It replaces
  its plan project like any matched import row. Values not changed come from
  the plan project; its step weeks are the plan project's own effective
  weeks while the workflow and category are unchanged (else the app's lead
  times for the new category), and a changed Design / Lab time is split over
  that kind's steps by the ADR 0041 rule (`scheduling.effort_split`).
  A started project keeps its current step (ancestors done, the step In
  Progress at the plan-from week), as for every import row.
- `new`: no matching project; read like a new registration.

Code, type and the actual dates are listed as changes but are not
scheduling inputs (`simulated = false`). `#`, End week, Steps and Project ID
are read-only, and so is Hub rank (ADR 0068, derived from Global rank). Nothing
here logs a value; no financial column exists in the
file.
"""

from __future__ import annotations

import dataclasses
from collections import Counter
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import domain_constants as dc
from scheduling.effort_split import (
    EFFORT_STEP_MAX_WEEKS,
    EffortSplitRejected,
    EffortStepInput,
    apportion_effort,
)
from services.plan_import_xlsx import (
    _FROM_OEM,
    _INDIA,
    _NO_ENGINEER,
    _NOT_SCHEDULED,
    _SCHEDULABLE,
    _STATUS_MAP,
    _TO_OEM,
    HEADER_SCAN_ROWS,
    MAX_COLUMNS,
    MAX_DATA_ROWS,
    MAX_SHEETS,
    SEV_INFO,
    SEV_WARNING,
    ImportFormatError,
    Leader,
    ParseContext,
    ParseCounts,
    ParsedRow,
    ParseIssue,
    ParseResult,
    RosterEntry,
    RowChange,
    _hub_token,
    _norm,
    _open,
    _Roster,
    _sheet_rows,
    _text,
    _workflow_of,
)
from services.priority_applicability import (
    PRIORITY_NOT_APPLICABLE_CODE,
    PRIORITY_NOT_APPLICABLE_LABEL,
    priority_applicable,
)
from services.register_export import (
    COLUMN_BY_KEY,
    HEADER_ALIASES,
    READ_ONLY_KEYS,
    parse_number,
    parse_rank,
    parse_step,
    parse_week,
    register_cells,
)
from services.xlsx_writer import FORMULA_TRIGGERS

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

    from core.principal import Principal
    from scheduling.plan_import import ImportNewEngineer, PlanImportRequest, PlanImportResult
    from scheduling.types import ProjectInput
    from scheduling.whatif import WhatIfBaseline
    from schemas.whatif_import import ImportRow, ImportSimulateRequest
    from services.whatif_baseline import WhatIfContext

FILE_FORMAT = "projects_list"
_RAW = 100
#: Columns whose change alters the simulation. The name is listed but not
#: simulated (2026-11-23 audit B2): a rename alone keeps the plan project.
SIMULATED_KEYS: frozenset[str] = frozenset(
    {
        "hub",
        "category",
        "status",
        "leader",
        "design-time",
        "lab-time",
        "current-step",
        "priority",
        # P60 (ADR 0068): the global rank is the input; "Hub rank" is read-only.
        "global-rank",
    }
)
#: Every compared column, in screen order (charter columns included: listed,
#: never simulated).
_COMPARED: tuple[str, ...] = tuple(k for k in COLUMN_BY_KEY if k not in READ_ONLY_KEYS)
_EFFORT_KEYS: tuple[tuple[str, str], ...] = (("design-time", "design"), ("lab-time", "lab"))


# --- the context (built from the live plan, per request) -------------------------------------


@dataclass(frozen=True)
class RegisterProject:
    project_id: str
    #: In the What-if baseline (so a changed row may replace it).
    in_plan: bool
    name: str
    code: str | None
    hub: str
    workflow: str
    category: str | None
    status: str
    #: The stored priority (ADR 0067 keeps it under "Not applicable").
    priority: str | None
    band_rank: int | None
    leader_engineer_id: str | None
    certification_testing_required: bool
    current_step_id: str | None
    design_figure: float | None
    lab_figure: float | None
    #: The download's cell per column key (`register_cells`).
    cells: Mapping[str, Any]
    #: The plan project's effective weeks / own lead per step; {} if not in plan.
    plan_step_weeks: Mapping[str, int]
    own_lead: Mapping[str, int]
    started: frozenset[str] = frozenset()


@dataclass(frozen=True)
class RegisterContext:
    projects: tuple[RegisterProject, ...] = ()
    #: Every engineer of the plan with FTE > 0, counted in capacity or not.
    #: A Projects list names the plan's own leaders, so a leader that does not
    #: count in capacity is matched (and kept), never read as missing.
    engineers: tuple[RosterEntry, ...] = ()


async def build_register_context(
    db: AsyncSession, principal: Principal, ctx: WhatIfContext
) -> RegisterContext:
    """The caller's Projects list as served (hub-scoped by `analytics_projects`,
    the same read the download uses) joined with the What-if baseline."""

    from api.routers.dashboard import analytics_projects
    from scheduling.workflow import (
        build_lead_time_table,
        build_workflows,
        effective_lead_weeks,
        step_effective_weeks,
    )

    served = await analytics_projects(
        hub_id=None,
        category=None,
        status_=None,
        priority=None,
        region=None,
        q=None,
        type_=None,
        leader_engineer_id=None,
        current_step=None,
        sort="name",
        db=db,
        current_user=principal,
        clock=ctx.clock,
    )
    si = ctx.baseline.schedule
    workflows = build_workflows(si.workflow_steps)
    table = build_lead_time_table(si.lead_times)
    base = {p.project_id: p for p in si.projects}
    out: list[RegisterProject] = []
    for i, row in enumerate(served.rows, start=1):
        pid = str(row.project_id)
        p = base.get(pid)
        hub = str(getattr(row.hub, "value", row.hub))
        eff: dict[str, int] = {}
        own: dict[str, int] = {}
        started: frozenset[str] = frozenset()
        cert = True
        wf_id = _workflow_of(hub)
        if p is not None:
            cert = p.certification_testing_required
            wf_id = p.workflow_id
            wf = workflows.get(p.workflow_id)
            if wf is not None and p.category is not None:
                timing = {t.step_id: t for t in p.step_timing}
                for st in wf.steps:
                    sid = st.step_id
                    t = timing.get(sid)
                    lead = effective_lead_weeks(t, table.get((p.workflow_id, p.category, sid), 0))
                    own[sid] = lead
                    eff[sid] = min(
                        EFFORT_STEP_MAX_WEEKS,
                        step_effective_weeks(
                            lead_weeks=lead,
                            kind=st.kind,
                            certification_testing_required=cert,
                            override_weeks=None if t is None else t.duration_override_weeks,
                            # ADR 0071 (R62-2): the project's room weeks.
                            lab_hold_weeks=None if t is None else t.lab_hold_weeks,
                        ),
                    )
            started = frozenset(sp.step_id for sp in p.step_progress if sp.status != "Not Started")
        priority = getattr(row.priority, "value", row.priority)
        category = getattr(row.category, "value", row.category)
        out.append(
            RegisterProject(
                project_id=pid,
                in_plan=p is not None and ctx.scope.hub_ok(p.hub),
                name=row.project_name,
                code=row.external_code,
                hub=hub,
                workflow=wf_id,
                category=None if category is None else str(category),
                status=str(getattr(row.status, "value", row.status)),
                priority=None if priority is None else str(priority),
                band_rank=row.band_rank,
                leader_engineer_id=(
                    None if row.leader_engineer_id is None else str(row.leader_engineer_id)
                ),
                certification_testing_required=cert,
                current_step_id=row.current_step_code,
                design_figure=row.design_effort_weeks,
                lab_figure=row.lab_effort_weeks,
                cells=register_cells(row, i),
                plan_step_weeks=eff,
                own_lead=own,
                started=started,
            )
        )
    engineers = tuple(
        RosterEntry(
            engineer_id=e.engineer_id,
            name=e.name,
            hub=e.hub,
            capacity_hub=dc.capacity_hub_name(e.hub),
            fte=float(e.fte),
        )
        for e in sorted(si.engineers, key=lambda e: (e.hub, e.name))
        if e.fte > 0
    )
    return RegisterContext(projects=tuple(out), engineers=engineers)


# --- reading -------------------------------------------------------------------------------


@dataclass(frozen=True)
class _RegisterSheet:
    title: str
    cols: dict[str, int]
    rows: tuple[tuple[int, dict[str, Any]], ...]


def _header_keys(row: Sequence[Any]) -> dict[str, int]:
    found: dict[str, int] = {}
    for idx, cell in enumerate(row):
        if not isinstance(cell, str):
            continue
        key = HEADER_ALIASES.get(" ".join(cell.split()).casefold())
        if key is not None and key not in found:
            found[key] = idx
    return found


def _is_register_header(found: Mapping[str, int]) -> bool:
    if "project" not in found:
        return False
    return "project-id" in found or {"hub", "status", "current-step"} <= set(found)


def _read(data: bytes) -> _RegisterSheet | None:
    wb = _open(data)
    try:
        for ws in list(wb.worksheets)[:MAX_SHEETS]:
            header: tuple[int, dict[str, int]] | None = None
            for r_idx, row in enumerate(_sheet_rows(ws, HEADER_SCAN_ROWS), start=1):
                found = _header_keys(row)
                if _is_register_header(found):
                    header = (r_idx, found)
                    break
            if header is None:
                continue
            header_row, cols = header
            name_col = cols["project"]
            last = header_row + MAX_DATA_ROWS
            rows: list[tuple[int, dict[str, Any]]] = []
            for r_idx, row in enumerate(
                ws.iter_rows(
                    min_row=header_row + 1,
                    max_row=last + 1,
                    max_col=MAX_COLUMNS,
                    values_only=True,
                ),
                start=header_row + 1,
            ):
                name = row[name_col] if name_col < len(row) else None
                if name is None or not str(name).strip():
                    continue
                if r_idx > last:
                    raise ImportFormatError(
                        f"The projects sheet has more than {MAX_DATA_ROWS} data rows."
                    )
                rows.append(
                    (
                        r_idx,
                        {k: (_plain(row[c]) if c < len(row) else None) for k, c in cols.items()},
                    )
                )
            return _RegisterSheet(str(ws.title).strip()[:_RAW], cols, tuple(rows))
        return None
    finally:
        wb.close()


def _plain(value: Any) -> Any:
    """Undo the download's formula guard (`'` before `=`, `+`, `-`, `@`)."""

    if isinstance(value, str) and value.startswith("'") and value[1:2] in FORMULA_TRIGGERS:
        return value[1:]
    return value


# --- comparing -----------------------------------------------------------------------------


def _canon(key: str, value: Any) -> Any:
    """One comparable form per column, so "W5 2026" equals 5 and 4.0 equals 4."""

    if key in ("actual-start", "actual-end"):
        week, ok = parse_week(value)
        return week if ok else ("?", _norm(value))
    if key in ("design-time", "lab-time"):
        num, ok = parse_number(value)
        return num if ok else ("?", _norm(value))
    if key == "current-step":
        step, ok = parse_step(value)
        return step if ok else ("?", _norm(value))
    if key in ("rank", "global-rank"):
        rank, ok = parse_rank(value)
        return rank if ok else ("?", _norm(value))
    if key == "hub":
        tok, _ = _hub_token(value)
        return tok if tok is not None and tok != _INDIA else _norm(value)
    if key == "status":
        n = _norm(value)
        return _STATUS_MAP.get(n, n)
    return _norm(value)


def _shown(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    return _text(value, 200)


# --- mapping -------------------------------------------------------------------------------


def parse_register_workbook(data: bytes, ctx: ParseContext) -> ParseResult | None:
    """A `ParseResult` when `data` is a Projects list download, else None
    (the caller then reads the capacity-planning format)."""

    sheet = _read(data)
    if sheet is None:
        return None
    rctx: RegisterContext = ctx.register if ctx.register is not None else RegisterContext()
    return _map(sheet, ctx, rctx)


def _category_for(raw: Any, ctx: ParseContext) -> str | None:
    n = _norm(raw)
    if not n:
        return None
    for code in ctx.categories:
        if _norm(code) == n:
            return code
    return None


def _fit_category(category: str | None, wf: str, ctx: ParseContext, issue: Any) -> str:
    """The category on the hub's workflow: an OEM / non-OEM twin when it
    does not fit (ADR 0044 §5), else B / B-OEM with a warning."""

    if category is not None and ctx.categories.get(category) == wf:
        return category
    if category is not None:
        twin = _TO_OEM.get(category) if wf == "OEM" else _FROM_OEM.get(category)
        if twin is not None and ctx.categories.get(twin) == wf:
            issue(
                "category",
                SEV_INFO,
                "CATEGORY_MAPPED",
                f"Category {category} does not fit the {wf} workflow; {twin} is used.",
            )
            return twin
    fallback = "B-OEM" if wf == "OEM" else "B"
    issue(
        "category",
        SEV_WARNING,
        "CATEGORY_DEFAULTED",
        f"Category {'is blank' if category is None else f'{category} does not fit'}; "
        f"{fallback} is used.",
    )
    return fallback


def _step_weeks(
    *,
    wf: str,
    category: str,
    ctx: ParseContext,
    plan: RegisterProject | None,
    figures: Mapping[str, tuple[bool, float | None]],
    cert: bool,
    issue: Any,
) -> tuple[dict[str, int], str]:
    """(step -> weeks, lead-time label). The plan project's own effective
    weeks while its workflow and category are unchanged; else the app's lead
    times. `figures`: kind -> (re-split, figure) for a Design / Lab time to
    apply (ADR 0041 split, `scheduling.effort_split`)."""

    steps = sorted((s for s in ctx.steps if s.workflow == wf), key=lambda s: s.sequence_order)
    app_row = ctx.app_lead_times.get((wf, category), {})
    same = (
        plan is not None
        and plan.workflow == wf
        and plan.category == category
        and bool(plan.plan_step_weeks)
    )
    if same:
        assert plan is not None
        weeks = {s.step_id: int(plan.plan_step_weeks.get(s.step_id, 0)) for s in steps}
        lead = {s.step_id: int(plan.own_lead.get(s.step_id, 0)) for s in steps}
        label = "plan"
    else:
        weeks = {s.step_id: int(app_row.get(s.step_id, 0)) for s in steps}
        lead = dict(weeks)
        label = "app"
    started = plan.started if plan is not None and same else frozenset()
    for kind, (resplit, figure) in figures.items():
        if not resplit:
            continue
        members = [s for s in steps if s.kind == kind]
        inputs = [
            EffortStepInput(
                step_id=s.step_id,
                sequence_order=s.sequence_order,
                kind=s.kind,
                lead_weeks=lead[s.step_id],
                started=s.step_id in started,
                # A step the plan project switched off (or skips) stays off.
                excluded=same and lead[s.step_id] > 0 and weeks[s.step_id] == 0,
            )
            for s in members
        ]
        try:
            split = apportion_effort(figure, inputs, kind=kind, certification_testing_required=cert)
        except EffortSplitRejected:
            issue(
                f"{kind}_time",
                SEV_WARNING,
                "EFFORT_TOO_LARGE",
                f"The {kind} time would put a step above {EFFORT_STEP_MAX_WEEKS} weeks; it is "
                "not applied.",
            )
            continue
        if split.applied:
            weeks.update(dict(split.step_weeks))
        elif figure is None:
            # Cleared: back to the lead times of the kind (excluded stay off).
            for st in inputs:
                if not st.excluded:
                    weeks[st.step_id] = st.lead_weeks
    return weeks, label


def _map(sheet: _RegisterSheet, ctx: ParseContext, rctx: RegisterContext) -> ParseResult:
    issues: list[ParseIssue] = []
    pool = rctx.engineers or ctx.roster
    roster = _Roster(pool)
    roster_by_id = {e.engineer_id: e for e in pool if e.fte > 0}
    by_id = {p.project_id: p for p in rctx.projects}
    by_code: dict[str, list[RegisterProject]] = {}
    by_name: dict[str, list[RegisterProject]] = {}
    for p in rctx.projects:
        by_name.setdefault(_norm(p.name), []).append(p)
        if p.code:
            by_code.setdefault(_norm(p.code), []).append(p)
    file_names = Counter(_norm(v.get("project")) for _, v in sheet.rows)
    file_codes = Counter(_norm(v.get("code")) for _, v in sheet.rows if _norm(v.get("code")))
    cols = set(sheet.cols)
    claimed: dict[str, int] = {}
    rows: list[ParsedRow] = []
    matched_engineers: set[str] = set()
    in_place_keys: set[str] = set()

    for file_row, v in sheet.rows:
        key = f"row-{file_row}"

        def issue(
            fld: str | None, sev: str, code: str, msg: str, _k: str = key, _r: int = file_row
        ) -> None:
            issues.append(ParseIssue(_k, _r, fld, sev, code, msg))

        name = _text(v.get("project"), 300) or ""
        code_raw = _text(v.get("code"), 64)

        # Matching: Project ID, then a unique code, then a unique name.
        m: RegisterProject | None = None
        match_by: str | None = None
        pid = _text(v.get("project-id"), 64)
        if pid is not None:
            m = by_id.get(pid)
            if m is not None:
                match_by = "id"
            else:
                issue(
                    "project_id",
                    SEV_INFO,
                    "PROJECT_ID_UNKNOWN",
                    "The Project ID is not a project of your plan; the row is matched by code "
                    "or name.",
                )
        if m is None and code_raw is not None:
            hits = by_code.get(_norm(code_raw), [])
            if len(hits) == 1 and file_codes[_norm(code_raw)] == 1:
                m, match_by = hits[0], "code"
        if m is None:
            hits = by_name.get(_norm(name), [])
            if len(hits) == 1 and file_names[_norm(name)] == 1:
                m, match_by = hits[0], "name"
            elif hits:
                issue(
                    "name",
                    SEV_INFO,
                    "MATCH_AMBIGUOUS",
                    "The row matches more than one project or row; it is imported as a new "
                    "project.",
                )
        if m is not None and m.project_id in claimed:
            issue(
                "name",
                SEV_INFO,
                "MATCH_AMBIGUOUS",
                f"Row {claimed[m.project_id]} already matches the same project; this row is "
                "imported as a new project.",
            )
            m, match_by = None, None
        if m is not None:
            claimed[m.project_id] = file_row

        # What differs from the project as served.
        changes: list[RowChange] = []
        changed: set[str] = set()
        if m is not None:
            for k in _COMPARED:
                if k not in cols:
                    continue
                if _canon(k, v.get(k)) != _canon(k, m.cells.get(k)):
                    changed.add(k)
                    changes.append(
                        RowChange(
                            field=k,
                            label=COLUMN_BY_KEY[k].header,
                            before=_shown(m.cells.get(k)),
                            after=_shown(v.get(k)),
                            simulated=k in SIMULATED_KEYS,
                        )
                    )

        def takes(k: str, _m: RegisterProject | None = m, _changed: set[str] = changed) -> bool:
            """The file's cell decides this field (new row, or a changed cell)."""

            return k in cols and (_m is None or k in _changed)

        # Leader (first: an India hub depends on the leader's hub).
        eng_raw = _text(v.get("leader"), _RAW) if "leader" in cols else None
        leader_match = None
        leader_kind = "auto"
        if takes("leader"):
            if eng_raw is not None and _norm(eng_raw) not in _NO_ENGINEER:
                leader_match = roster.match(eng_raw)
                leader_kind = "existing" if leader_match is not None else "new"
        elif m is not None and m.leader_engineer_id in roster_by_id:
            leader_match = roster_by_id[str(m.leader_engineer_id)]
            leader_kind = "existing"

        # Hub.
        hub_raw = _text(v.get("hub"), _RAW) if "hub" in cols else None
        hub: str | None = None
        if takes("hub"):
            tok, _ = _hub_token(v.get("hub"))
            if tok == _INDIA:
                tok = (
                    "R&D-India"
                    if leader_match is not None and leader_match.capacity_hub == "R&D-India"
                    else "PD-India"
                )
            hub = tok
            if hub is None:
                hub = (
                    m.hub
                    if m is not None
                    else (leader_match.capacity_hub if leader_match is not None else "R&D-Greece")
                )
                issue(
                    "hub",
                    SEV_WARNING,
                    "HUB_DEFAULTED",
                    f"Hub {'is blank' if not hub_raw else f'{hub_raw!r} is not recognised'}; "
                    f"{hub} is used.",
                )
        elif m is not None:
            hub = m.hub
        else:
            hub = leader_match.capacity_hub if leader_match is not None else "R&D-Greece"
            issue("hub", SEV_WARNING, "HUB_DEFAULTED", f"No hub is given; {hub} is used.")
        wf = _workflow_of(hub)

        # Category.
        cat_raw = _text(v.get("category"), _RAW) if "category" in cols else None
        category: str | None
        if takes("category"):
            category = _category_for(v.get("category"), ctx)
            if category is None and cat_raw is not None:
                issue(
                    "category",
                    SEV_WARNING,
                    "CATEGORY_UNKNOWN",
                    f"Category {cat_raw!r} is not an app category"
                    + ("; the plan project's is kept." if m is not None else "."),
                )
                category = m.category if m is not None else None
        else:
            category = m.category if m is not None else None
        category = _fit_category(category, wf, ctx, issue)

        # Status.
        status_raw = _text(v.get("status"), _RAW) if "status" in cols else None
        status: str | None = None
        if takes("status"):
            status = _STATUS_MAP.get(_norm(status_raw))
            if status is None:
                status = m.status if m is not None else "In Queue"
                issue(
                    "status",
                    SEV_WARNING,
                    "STATUS_DEFAULTED",
                    "Status "
                    + ("is blank" if not status_raw else f"{status_raw!r} is not recognised")
                    + f"; {status} is used.",
                )
        elif m is not None:
            status = m.status
        else:
            status = "In Queue"
        if status == "Draft":
            status = "On Hold"
            issue(
                "status",
                SEV_INFO,
                "STATUS_DRAFT",
                "A Draft project is not scheduled; it is listed as On Hold.",
            )
        if status in _NOT_SCHEDULED:
            issue(
                "status",
                SEV_INFO,
                "STATUS_NOT_SCHEDULED",
                f"{status} — not mapped (listed for review, never simulated).",
            )

        # Current step.
        stage_raw = _text(v.get("current-step"), _RAW) if "current-step" in cols else None
        stage: str | None
        if takes("current-step"):
            stage, ok = parse_step(v.get("current-step"))
            if not ok:
                stage = m.current_step_id if m is not None else None
                issue(
                    "stage",
                    SEV_WARNING,
                    "STAGE_UNKNOWN",
                    f"Current step {stage_raw!r} is not a step code; "
                    + (
                        "the plan project's is kept."
                        if m is not None
                        else "the first step is used."
                    ),
                )
        else:
            stage = m.current_step_id if m is not None else None
        if stage is not None and not stage.startswith(wf + "-"):
            mapped = f"{wf}-{stage[-1]}"
            issue(
                "stage",
                SEV_WARNING,
                "STAGE_WORKFLOW_MISMATCH",
                f"Current step {stage} is mapped to {mapped} ({hub} follows the {wf} workflow).",
            )
            stage = mapped

        # Priority and rank.
        priority: str
        psrc: str
        cell_band = _norm(v.get("priority")).upper() if "priority" in cols else ""
        stored = m.priority if m is not None and m.priority in dc.PRIORITY_ORDER else None
        if takes("priority") and cell_band in dc.PRIORITY_ORDER:
            priority, psrc = cell_band, "band"
        else:
            not_applicable = cell_band == PRIORITY_NOT_APPLICABLE_LABEL.upper()
            if takes("priority") and cell_band and not not_applicable:
                issue(
                    "priority",
                    SEV_WARNING,
                    "PRIORITY_UNKNOWN",
                    f"Priority {_text(v.get('priority'), 40)!r} is not P1–P4 or Q; it is ignored.",
                )
            priority, psrc = (stored, "matched") if stored is not None else ("P3", "default")
        rank: int | None = None
        if takes("global-rank"):
            rank, ok = parse_rank(v.get("global-rank"))
            if not ok or (rank is not None and rank > 9999):
                issue(
                    "priority",
                    SEV_WARNING,
                    "RANK_INVALID",
                    "Rank is not a whole number from 1; it is ignored.",
                )
                rank = None
        elif m is not None and "priority" not in changed:
            rank = m.band_rank if m.band_rank is not None and m.band_rank <= 9999 else None

        # Leader (result).
        leader: Leader
        if leader_match is not None:
            leader = Leader("existing", leader_match.engineer_id, leader_match.name)
            matched_engineers.add(leader_match.engineer_id)
        elif leader_kind == "new" and eng_raw is not None:
            leader = Leader("new", None, eng_raw)
            issue(
                "engineer",
                SEV_WARNING,
                "ENGINEER_UNKNOWN",
                f"{eng_raw!r} is not on the roster; a new What-if designer of that name is "
                f"added to {dc.capacity_hub_name(hub)} (FTE 1.0).",
            )
        else:
            leader = Leader("auto")
            if status in _SCHEDULABLE:
                issue(
                    "engineer",
                    SEV_WARNING,
                    "ENGINEER_MISSING",
                    "No design engineer is named; one is auto-assigned (choose one to replace it).",
                )

        # Step weeks (and a changed or new Design / Lab time).
        cert = m.certification_testing_required if m is not None else True
        figures: dict[str, tuple[bool, float | None]] = {}
        plan_shape_kept = m is not None and m.workflow == wf and m.category == category
        for col, kind in _EFFORT_KEYS:
            plan_fig = None
            if m is not None:
                plan_fig = m.design_figure if kind == "design" else m.lab_figure
            if takes(col):
                fig, ok = parse_number(v.get(col))
                if not ok:
                    issue(
                        f"{kind}_time",
                        SEV_WARNING,
                        "EFFORT_INVALID",
                        f"{COLUMN_BY_KEY[col].header} {_text(v.get(col), 40)!r} is not a number "
                        "of weeks; it is ignored.",
                    )
                    figures[kind] = (not plan_shape_kept and plan_fig is not None, plan_fig)
                else:
                    figures[kind] = (fig is not None or m is not None, fig or None)
            else:
                figures[kind] = (not plan_shape_kept and plan_fig is not None, plan_fig)
        step_weeks, lead_label = _step_weeks(
            wf=wf,
            category=category,
            ctx=ctx,
            plan=m,
            figures=figures,
            cert=cert,
            issue=issue,
        )

        # B2 (d): a project that stays out of the run (status not schedulable
        # and not edited) simulates nothing; its priority is "Not applicable"
        # for Commercialized / Cancelled (ADR 0067), so an edit there is listed only.
        if m is not None and status not in _SCHEDULABLE and "status" not in changed:
            if "priority" in changed and not priority_applicable(status):
                issue(
                    "priority",
                    SEV_INFO,
                    PRIORITY_NOT_APPLICABLE_CODE,
                    f"Priority is Not applicable for a {status} project (ADR 0067); the edit "
                    "is not simulated.",
                )
            changes = [
                RowChange(c.field, c.label, c.before, c.after, False) if c.simulated else c
                for c in changes
            ]
        simulated_change = any(c.simulated for c in changes)
        if m is None:
            kind_of_row = "new"
        else:
            kind_of_row = "changed" if simulated_change else "unchanged"
        # B2 (b): a changed row whose current step is not edited updates its
        # plan project in place (progress, effort, exclusions, pins kept).
        in_place = (
            m is not None
            and m.in_plan
            and simulated_change
            and status in _SCHEDULABLE
            and "current-step" not in changed
            and m.workflow == wf
        )
        if m is not None and simulated_change:
            issue(
                "name",
                SEV_INFO,
                "CHANGED",
                (
                    f"Updates {m.name!r} in place (matched by {match_by}); its recorded progress "
                    "is kept; changed: "
                    if in_place
                    else f"Replaces {m.name!r} (matched by {match_by}); changed: "
                )
                + "; ".join(
                    f"{c.label} {c.before or '—'} → {c.after or '—'}"
                    for c in changes
                    if c.simulated
                )[:400]
                + ".",
            )
        quiet = [c.label for c in changes if not c.simulated]
        if quiet:
            issue(
                None,
                SEV_INFO,
                "NOT_SIMULATED",
                f"{', '.join(quiet)} changed; "
                + (
                    "not a scheduling input"
                    if status in _SCHEDULABLE or "status" in changed
                    else f"the project is not scheduled ({status})"
                )
                + ", so the simulation does not use it.",
            )

        rows.append(
            ParsedRow(
                key=key,
                file_row=file_row,
                sn=None,
                code=code_raw if takes("code") or m is None else m.code,
                plant=_text(v.get("charter-plant"), _RAW),
                name=name if (m is None or "project" in changed) else m.name,
                hub=hub,
                hub_raw=hub_raw,
                category=category,
                category_raw=cat_raw,
                lead_time_label=lead_label,
                status=status,
                status_raw=status_raw,
                stage_step_id=stage,
                stage_raw=stage_raw,
                rank=rank,
                priority=priority,
                priority_source=psrc,
                engineer_raw=eng_raw,
                leader=leader,
                matched_project_id=m.project_id if m is not None and m.in_plan else None,
                matched_project_name=m.name if m is not None and m.in_plan else None,
                match_by=match_by if m is not None and m.in_plan else None,
                num_projects=None,
                must_do=None,
                spillover_from_previous=None,
                complexity=None,
                est_duration_months=None,
                certification_testing_required=cert,
                step_weeks=step_weeks,
                include=status in _SCHEDULABLE,
                file_band=None,
                change_kind=kind_of_row,
                changes=tuple(changes),
            )
        )
        if in_place:
            in_place_keys.add(key)

    new_designers = {
        (_norm(r.leader.name), dc.capacity_hub_name(r.hub)) for r in rows if r.leader.kind == "new"
    }
    schedulable = sum(1 for r in rows if r.status in _SCHEDULABLE)
    matched_n = sum(1 for r in rows if r.change_kind != "new")
    counts = ParseCounts(
        rows=len(rows),
        schedulable=schedulable,
        not_scheduled=len(rows) - schedulable,
        matched=matched_n,
        new=len(rows) - matched_n,
        auto_assign=sum(1 for r in rows if r.leader.kind == "auto"),
        new_designers=len(new_designers),
        # Merge mode: an unchanged row keeps its plan project and a changed
        # row whose current step is kept edits it in place, so only the other
        # changed and the new schedulable rows become file projects.
        projects_after_expansion=sum(
            1
            for r in rows
            if r.include
            and r.status in _SCHEDULABLE
            and r.change_kind != "unchanged"
            and r.key not in in_place_keys
        ),
        changed=sum(1 for r in rows if r.change_kind == "changed"),
        unchanged=sum(1 for r in rows if r.change_kind == "unchanged"),
    )
    order = {r.key: i for i, r in enumerate(rows)}
    issues.sort(key=lambda i: -1 if i.row_key is None else order.get(i.row_key, 0))
    return ParseResult(
        projects_sheet=sheet.title,
        steps_sheet=None,
        lead_times=(),
        rows=tuple(rows),
        issues=tuple(issues),
        counts=counts,
        matched_engineer_ids=frozenset(matched_engineers),
        file_format=FILE_FORMAT,
    )


# --- simulate: a changed row edits its plan project in place (B2) ----------------------------

#: Fields a changed row may override on its plan project (the Projects table
#: column ids). Everything else of the plan project is kept: step progress,
#: Done / In Progress states and %, remaining effort, exclusions, own lead
#: times, pins, frozen, VIP.
_IN_PLACE_FIELDS: frozenset[str] = frozenset(
    {"hub", "category", "status", "priority", "global-rank", "leader", "design-time", "lab-time"}
)


def _wf_of_hub(hub: str) -> str:
    return dc.WORKFLOW_ID_FOR_OEM_HUB if hub in dc.OEM_HUBS else dc.WORKFLOW_ID_FOR_NON_OEM_HUB


def edits_in_place(r: ImportRow, mode: str, base: Mapping[str, ProjectInput]) -> bool:
    """2026-11-23 audit B2: a "changed" Projects list row in merge mode whose
    Current step was not edited (and whose workflow stays) is no file project.
    Its plan project stays in the run with only the edited fields overridden
    (`plan_overrides`), so its recorded progress is never rebuilt. Only an
    edited Current step (or a hub move to the other workflow) rebuilds the
    project from the list, as a file project."""

    if mode != "merge" or r.change_kind != "changed" or not r.include:
        return False
    if r.status not in dc.SCHEDULABLE_STATUS_ORDER or r.matched_project_id is None:
        return False
    p = base.get(r.matched_project_id)
    if p is None or p.category is None or p.workflow_id != _wf_of_hub(r.hub):
        return False
    return not any(c.field == "current-step" and c.simulated for c in r.changes)


def plan_overrides(
    ctx: WhatIfContext,
    body: ImportSimulateRequest,
    new_engineers: Sequence[ImportNewEngineer],
) -> tuple[dict[str, ProjectInput], tuple[ImportNewEngineer, ...]]:
    """The plan projects edited in place (project_id -> the edited input) and
    the request's new designers (extended by a new leader named on such a
    row). `ValueError` for an invalid row (the caller answers 422
    `INVALID_IMPORT`; an id outside the caller's scope reads as unknown)."""

    from scheduling import hubs as hub_names
    from scheduling.plan_import import ImportNewEngineer as _NewEng
    from scheduling.types import StepTimingInput
    from schemas.whatif_import import LeaderExisting, LeaderNew

    si = ctx.baseline.schedule
    base = {p.project_id: p for p in si.projects}
    category_workflow = {c.code: c.workflow_id for c in si.categories}
    roster_ids = {e.engineer_id for e in si.engineers if e.fte > 0}
    kinds = {(t.workflow_id, t.step_id): t.kind for t in si.workflow_steps}
    new_engs = list(new_engineers)
    new_key = {(" ".join(ne.name.split()).casefold(), ne.hub): ne.key for ne in new_engs}
    out: dict[str, ProjectInput] = {}
    for r in body.rows:
        if not edits_in_place(r, body.mode, base):
            continue
        where = f"row {r.key!r}"
        pid = str(r.matched_project_id)
        hub_of = ctx.project_hub.get(pid)
        if hub_of is None or not ctx.scope.hub_ok(hub_of) or pid in out:
            raise ValueError(f"{where}: unknown project id {pid!r}")
        p = base[pid]
        edited = {c.field for c in r.changes if c.simulated} & _IN_PLACE_FIELDS
        upd: dict[str, Any] = {}
        if "hub" in edited:
            upd["hub"] = r.hub
            upd["capacity_hub"] = dc.capacity_hub_name(hub_names.constants_hub_name(r.hub))
        if "category" in edited:
            if category_workflow.get(r.category) != p.workflow_id:
                raise ValueError(f"{where}: category {r.category} does not fit hub {r.hub}")
            upd["category"] = r.category
        if "status" in edited:
            upd["status"] = r.status
        if "priority" in edited:
            upd["priority"] = r.priority
        if edited & {"priority", "global-rank"}:
            # ADR 0050: a new band is unranked unless a rank is given.
            upd["band_rank"] = r.rank if r.rank is not None and r.rank >= 1 else None
        if "leader" in edited:
            if isinstance(r.leader, LeaderExisting):
                if r.leader.engineer_id not in roster_ids:
                    raise ValueError(f"{where}: unknown engineer id {r.leader.engineer_id!r}")
                upd["leader_engineer_id"] = r.leader.engineer_id
            elif isinstance(r.leader, LeaderNew):
                name = " ".join(r.leader.name.split())
                if not name:
                    raise ValueError(f"{where}: a new designer needs a name")
                cap = dc.capacity_hub_name(r.hub)
                dk = (name.casefold(), cap)
                if dk not in new_key:
                    ne = _NewEng(key=f"new:{len(new_engs) + 1}", name=name, hub=cap, fte=1.0)
                    new_engs.append(ne)
                    new_key[dk] = ne.key
                upd["leader_engineer_id"] = new_key[dk]
            else:
                upd["leader_engineer_id"] = None
        timed = {k for col, k in _EFFORT_KEYS if col in edited}
        if timed:
            timing = {t.step_id: t for t in p.step_timing}
            for sid, weeks in sorted(r.step_weeks.items()):
                if kinds.get((p.workflow_id, sid)) not in timed or weeks <= 0:
                    continue
                t = timing.get(sid)
                weeks = min(int(weeks), EFFORT_STEP_MAX_WEEKS)
                timing[sid] = (
                    StepTimingInput(sid, weeks, None)
                    if t is None
                    else dataclasses.replace(t, duration_override_weeks=weeks)
                )
            upd["step_timing"] = tuple(timing[k] for k in sorted(timing))
        out[pid] = dataclasses.replace(p, **upd) if upd else p
    return out, tuple(new_engs)


def with_plan_overrides(ctx: WhatIfContext, overrides: Mapping[str, ProjectInput]) -> WhatIfContext:
    """`ctx` whose baseline carries the in-place edits (the "after" plan). The
    original is untouched; the live plan stays the "before" run."""

    if not overrides:
        return ctx
    si = ctx.baseline.schedule
    schedule = dataclasses.replace(
        si, projects=tuple(overrides.get(p.project_id, p) for p in si.projects)
    )
    return dataclasses.replace(ctx, baseline=dataclasses.replace(ctx.baseline, schedule=schedule))


def run_plan_import_in_place(
    live: WhatIfBaseline,
    after: WhatIfBaseline,
    req: PlanImportRequest,
    *,
    deadline_s: float | None = None,
) -> PlanImportResult:
    """`scheduling.plan_import.run_plan_import` with the "before" run on the
    live plan and the simulated run on `after` (the plan with its in-place
    edits). The engine's own steps, called in the engine's order; nothing is
    scheduled here. With `after is live` it is `run_plan_import` (pinned by
    `test_p58_projects_list_round_trip`)."""

    from scheduling import plan_import as pi
    from scheduling.greedy import prepare_run, run_greedy_sgs
    from scheduling.whatif import _Budget

    if after is live:
        return pi.run_plan_import(live, req, deadline_s=deadline_s)
    budget = _Budget(deadline_s, None)
    built = pi._build(after, req, budget)
    run_si = built.run_si
    pyew = pi.resolve_plan_until_week(req)
    before: Mapping[str, Any] = {}
    if req.mode == "merge":
        budget.check()
        base_out = run_greedy_sgs(
            dataclasses.replace(
                live.schedule, horizon_weeks=run_si.horizon_weeks, within_year_week=pyew
            )
        )
        before = {o.project_id: o for o in base_out.project_outcomes}
    budget.check()
    out = run_greedy_sgs(run_si)
    budget.check()
    plans = prepare_run(run_si).plans
    budget.check()
    return pi._assemble(
        baseline=after,
        req=req,
        run_si=run_si,
        out=out,
        plans=plans,
        before=before,
        metas=built.metas,
        auto_assigned=set(built.auto_assigned),
        new_eng_ids=set(built.new_eng_ids),
        edited_plan_ids=built.edited_plan_ids,
    )


__all__ = [
    "FILE_FORMAT",
    "SIMULATED_KEYS",
    "RegisterContext",
    "RegisterProject",
    "build_register_context",
    "edits_in_place",
    "parse_register_workbook",
    "plan_overrides",
    "run_plan_import_in_place",
    "with_plan_overrides",
]
