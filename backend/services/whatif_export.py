"""P43 (ADR 0057 D3, docs/API_CONTRACT_P43.md §3): the What-if planner's
own export, `POST /whatif/export.xlsx` — Summary, Gantt and Gantt data.

**Server-computed only.** The request carries the scenario, never a result.
The summary is `services.whatif.do_simulate` (the same call as
`POST /whatif/simulate`, scope-narrowed by `scope_simulation`). The step
weeks come from the same pure engine calls the simulation makes
(`scheduling.whatif.apply_scenario` then `scheduling.greedy.run_greedy_sgs`
on the applied input), run in the What-if pool under the same time cap. The
greedy SGS is deterministic (I8), so the drawn weeks are the weeks the
simulation scheduled; `tests/test_p43_exports.py` checks every finish week
against the served `SimulateResponse`.

**Scope.** Only projects whose hub is in the caller's scope are drawn or
listed (the `scope_simulation` rule). Step rows name the assigned engineer
or chamber, as `GET /gantt` serves them to every reader (ADR 0028). The
project row's leader column is left blank: `GET /gantt` serves a leader
name only to that leader (OQ #8), and the planner does not know which
engineer the caller is.

**Nothing financial** is in a scenario or its result.
"""

from __future__ import annotations

from typing import Any

from scheduling import row_lab_load_weeks
from scheduling.greedy import run_greedy_sgs
from scheduling.types import ScheduleOutput
from scheduling.weeks import WEEK_BASE_YEAR
from scheduling.whatif import AppliedScenario, apply_scenario, classify_outcome
from schemas.whatif import SimulateExportIn, SimulateResponse
from services.export_builder import xlsx_bytes
from services.outcome_buckets import outcome_label
from services.priority_applicability import (
    effective_priority,
    effective_priority_display,
    served_priority_label,
)
from services.week_labels import week_label
from services.whatif import (
    WHATIF_TIME_CAP_SECONDS,
    do_simulate,
    run_capped,
    served_outcome,
    to_engine_scenario,
)
from services.whatif_baseline import WhatIfContext
from services.xlsx_writer import (
    OUTCOME_STYLES,
    SECTION,
    GanttChart,
    GanttProjectBar,
    GanttStepBar,
    SheetBook,
    label_for,
)

GANTT_SHEET = "Gantt"
GANTT_DATA_SHEET = "Gantt data"
SUMMARY_SHEET = "Summary"

GANTT_DATA_HEADERS: list[str] = [
    "project_id",
    "project_name",
    "hub",
    "category",
    "priority",
    "priority_label",
    "is_new",
    "frozen",
    "outcome",
    "outcome_label",
    "finish_week",
    "within_year",
    "counts_toward_year",
    "not_scheduled_priority",
    "step_id",
    "step_name",
    "kind",
    "sequence_order",
    "duration_weeks",
    # P62 (ADR 0071): the lab row's booked room weeks (blank otherwise).
    "lab_hold_weeks",
    "start_week",
    "end_week",
    "skipped",
    "pinned",
    "engineer_name",
    "chamber_code",
]


async def planned_steps(
    ctx: WhatIfContext, body: SimulateExportIn
) -> tuple[AppliedScenario, ScheduleOutput]:
    """The scenario's schedule, from the engine's own pure functions."""

    sc = to_engine_scenario(body.scenario)

    def run() -> tuple[AppliedScenario, ScheduleOutput]:
        applied = apply_scenario(ctx.baseline, sc)
        return applied, run_greedy_sgs(applied.schedule_input)

    return await run_capped(run, WHATIF_TIME_CAP_SECONDS, user_key=ctx.user_key)


def _outcome_text(o: Any, key: str) -> str:
    served = outcome_label(o, o.projected_end_week)
    if served:
        return served
    return OUTCOME_STYLES.get(key, (key, ""))[0]


def planner_book(
    ctx: WhatIfContext,
    body: SimulateExportIn,
    sim: SimulateResponse,
    applied: AppliedScenario,
    out: ScheduleOutput,
) -> SheetBook:
    si = applied.schedule_input
    scope = ctx.scope
    projects = {p.project_id: p for p in si.projects}
    step_meta = {s.step_id: s for s in si.workflow_steps}
    engineers = {e.engineer_id: e.name for e in si.engineers}
    chambers = {c.chamber_id: c.code for c in si.chambers}
    new_ids = set(applied.new_project_ids)
    name = body.name or "What-if scenario"

    bars: list[GanttProjectBar] = []
    data: list[dict[str, Any]] = []
    kept = [o for o in out.project_outcomes if scope.hub_ok(projects[o.project_id].hub)]
    for o in kept:
        p = projects[o.project_id]
        # BUG-4 (2026-11-23): the screen's / Dashboard's bucket, so a
        # Commercialized project delivered this year is "within year" here too.
        key = served_outcome(classify_outcome(o), blocked=o.blocked, within_year=o.within_year)
        text = _outcome_text(o, key)
        project_fields: dict[str, Any] = {
            "project_id": p.project_id if p.project_id not in new_ids else "",
            "project_name": p.name,
            "hub": p.hub,
            "category": p.category,
            # ADR 0067: "Not applicable" for a Commercialized / Cancelled project.
            "priority": effective_priority_display(p.status, p.priority) or None,
            "priority_label": served_priority_label(p.status, p.priority),
            "is_new": p.project_id in new_ids,
            "frozen": p.frozen,
            "outcome": key,
            "outcome_label": text,
            "finish_week": o.projected_end_week,
            "within_year": o.within_year,
            "counts_toward_year": o.counts_toward_year,
            "not_scheduled_priority": o.not_scheduled_priority,
        }
        steps: list[GanttStepBar] = []
        for st in o.steps:
            meta = step_meta.get(st.step_id)
            step_name = meta.name if meta is not None else st.step_id
            engineer = engineers.get(st.assigned_engineer_id) if st.assigned_engineer_id else None
            chamber = chambers.get(st.assigned_chamber_id) if st.assigned_chamber_id else None
            steps.append(
                GanttStepBar(
                    step_id=st.step_id,
                    name=step_name,
                    kind=st.kind,
                    sequence_order=st.sequence_order,
                    start=st.start_week,
                    end=st.end_week,
                    resource=engineer or chamber,
                    skipped=st.skipped,
                    pinned=st.pinned,
                )
            )
            data.append(
                {
                    **project_fields,
                    "step_id": st.step_id,
                    "step_name": step_name,
                    "kind": st.kind,
                    "sequence_order": st.sequence_order,
                    "duration_weeks": st.duration_weeks,
                    "lab_hold_weeks": (
                        row_lab_load_weeks(st) if st.kind == "lab" and not st.skipped else None
                    ),
                    "start_week": st.start_week,
                    "end_week": st.end_week,
                    "skipped": st.skipped,
                    "pinned": st.pinned,
                    "engineer_name": engineer,
                    "chamber_code": chamber,
                }
            )
        if not o.steps:
            data.append({**project_fields, **{h: None for h in GANTT_DATA_HEADERS[14:]}})
        bars.append(
            GanttProjectBar(
                name=p.name + (" (new)" if p.project_id in new_ids else ""),
                hub=p.hub,
                priority=effective_priority(p.status, p.priority),
                priority_label=served_priority_label(p.status, p.priority),
                leader=None,
                outcome=key,
                outcome_text=text,
                frozen=p.frozen,
                steps=steps,
                rank=p.band_rank,
                is_vip=p.is_vip,
                status=p.status,
                start=o.start_week,
                end=o.end_week,
            )
        )

    scope_text = "all hubs" if scope.all_hubs else ", ".join(sorted(scope.hubs)) or "no hubs"
    context = [
        f"Scenario: {name}",
        f"Simulated at {week_label(si.current_week)}",
        f"Scope: {scope_text}",
        f"{len(kept)} project(s)",
    ]
    chart = GanttChart(
        title=f"What-if — {name} — Gantt",
        projects=bars,
        current_week=si.current_week,
        base_year=WEEK_BASE_YEAR,
        horizon_weeks=si.horizon_weeks,
        within_year_week=si.within_year_week,
        context=context,
    )
    return SheetBook(
        {
            SUMMARY_SHEET: (["Item", "Value"], _summary_rows(body, sim, name)),
            GANTT_DATA_SHEET: (GANTT_DATA_HEADERS, data),
        },
        title=f"What-if — {name}",
        context=context,
        charts={GANTT_SHEET: chart},
        reports={SUMMARY_SHEET},
        order=[SUMMARY_SHEET, GANTT_SHEET, GANTT_DATA_SHEET],
    )


def _summary_rows(body: SimulateExportIn, sim: SimulateResponse, name: str) -> list[dict[str, Any]]:
    sc = body.scenario
    d = sim.diff
    items: list[tuple[str, Any]] = [
        ("Scenario", SECTION),
        ("Name", name),
        ("Projects added", sum(p.count for p in sc.add_projects)),
        ("Designers added", sum(e.count for e in sc.add_engineers)),
        (
            "Designers removed",
            sum(r.count for r in sc.remove_engineer_counts) + len(sc.remove_engineers),
        ),
        ("Chambers added", sum(c.count for c in sc.add_chambers)),
        ("Chamber downtime changes", len(sc.chamber_downtime)),
        ("Priority overrides", len(sc.priority_overrides)),
        ("Within the year", SECTION),
        ("Projects within the year before", d.within_year_before),
        ("Projects within the year after", d.within_year_after),
        ("Change", d.within_year_delta),
        ("Existing projects within the year before", d.existing_within_year_before),
        ("Existing projects within the year after", d.existing_within_year_after),
        ("New projects", d.new_projects_total),
        ("New projects within the year", d.new_projects_within_year),
        ("Changes", SECTION),
        ("Existing projects newly slipping", len(d.newly_slipping)),
        ("Existing projects recovered", len(d.recovered)),
        ("Existing projects otherwise moved", len(d.moved)),
        ("Outcomes after the scenario", SECTION),
    ]
    # P43-R02 (G5): a Commercialized project counts as within year
    # (`within_year_bucket`, OQ #109). P58: the served class is already
    # `within_year` (the Dashboard bucket), so the delivered ones are shown as
    # an "of which" line under it and each table reconciles to the headline.
    delivered_after = sum(1 for p in sim.projects if _delivered(p))
    delivered_before = sum(1 for p in sim.projects if _delivered(p) and not p.is_new)
    items.extend(_outcome_rows(sim.outcome_counts_after, delivered_after))
    items.append(("Outcomes before the scenario", SECTION))
    items.extend(_outcome_rows(sim.outcome_counts_before, delivered_before))
    items.append(("How it was computed", SECTION))
    items.extend((f"Note {i}", line) for i, line in enumerate(sim.workings, start=1))
    return [{"Item": k, "Value": v} for k, v in items]


_OUTCOME_NAMES: dict[str, str] = {k: v[0] for k, v in OUTCOME_STYLES.items()}

DELIVERED_LABEL = "of which Delivered (Commercialized) — counts as within year"
WITHIN_YEAR_TOTAL_LABEL = "Within year, in total (the headline above)"


def _delivered(p: Any) -> bool:
    """Served fields only: a project served `within_year` with no finish week
    and no band (`priority_applicable` false, ADR 0067) is a Commercialized
    one delivered in the plan year (P58 `services.whatif.served_outcome`)."""

    return bool(
        p.outcome == "within_year"
        and p.within_year
        and not p.priority_applicable
        and p.finish_week is None
    )


def _outcome_rows(counts: Any, delivered: int) -> list[tuple[str, Any]]:
    rows: list[tuple[str, Any]] = []
    for k, v in counts.items():
        rows.append((label_for(k, _OUTCOME_NAMES), v))
        if k == "within_year":
            rows.append((DELIVERED_LABEL, delivered))
    rows.append((WITHIN_YEAR_TOTAL_LABEL, counts.get("within_year", 0)))
    return rows


async def planner_export(
    ctx: WhatIfContext, body: SimulateExportIn
) -> tuple[SimulateResponse, SheetBook]:
    """Validate and simulate (as `/whatif/simulate`), then draw. The
    simulate call runs `check_scope` first, so an out-of-scope scenario is
    the same 403 `SCENARIO_OUT_OF_SCOPE`."""

    sim = await do_simulate(ctx, body.scenario)
    applied, out = await planned_steps(ctx, body)
    return sim, planner_book(ctx, body, sim, applied, out)


def planner_xlsx(book: SheetBook) -> bytes:
    return xlsx_bytes(book)
