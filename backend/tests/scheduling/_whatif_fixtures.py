"""Deterministic synthetic baselines for the what-if engine tests (P18-T01).

Not a test module. No financial fields; engineer names are placeholders that
tests assert never leak into results.
"""

from __future__ import annotations

from scheduling import ChamberInput, EngineerInput, ProjectInput, ScheduleInput
from scheduling.whatif import ChamberSupplyInput, HubCalendarInput, WhatIfBaseline

CURRENT_WEEK = 31
ENGINEER_NAME_MARKER = "SECRETNAME"

PDD_STAGES = ("PDD-F", "PDD-H")
OEM_STAGES = ("OEM-E", "OEM-H")


def tiny_baseline(
    *, projects: tuple[ProjectInput, ...] = (), engineers: int = 1, platforms: int = 2
) -> WhatIfBaseline:
    """One hub (R&D-Greece, wwpe 50), `engineers` x 1.0 FTE, one Greece chamber.

    Hand figures: deduction = 10 / 5 = 2 wk, working weeks per engineer 50.
    Chamber: region holiday 2 wk, maintenance 2, breakdown 1, calibration 1 ->
    working 46, efficiency 0.8 -> 46 x 0.8 x platforms(2) = 73.6 lab weeks/year.
    """

    engs = tuple(
        EngineerInput(f"e{i}", f"{ENGINEER_NAME_MARKER}-{i}", "R&D-Greece", ("A+", "A", "B", "C"))
        for i in range(engineers)
    )
    ch = ChamberInput("c0", "GR-1", "Greece", platforms, PDD_STAGES + OEM_STAGES, efficiency=0.8)
    si = ScheduleInput(
        projects=projects,
        engineers=engs,
        chambers=(ch,),
        current_week=CURRENT_WEEK,
    )
    return WhatIfBaseline(
        schedule=si,
        calendars=(HubCalendarInput("R&D-Greece", 5, 10, 0, 0, 0),),
        chamber_supply=(ChamberSupplyInput("c0", "Greece", platforms, 0.8, 2, 1, 1),),
    )


_HUB_PLAN: tuple[tuple[str, int, tuple[str, ...]], ...] = (
    ("R&D-Greece", 3, ("A+", "A", "B", "C")),
    ("R&D-India", 2, ("A+", "A", "B", "C")),
    ("PD-India", 2, ("A+", "A", "B", "C")),
    ("PD-Romania", 2, ("A+", "A", "B", "C")),
    ("OEM-HCK", 1, ("OEM", "A-OEM", "B-OEM", "C-OEM")),
)
_CATS = ("A+", "A", "B", "C")
_OEM_CATS = ("A-OEM", "B-OEM", "C-OEM")
_PRIOS = ("P1", "P2", "P3", "P3", "P4", "P4", "Q")
_STATUSES = ("In Buyoff", "Under Industrialization", "In Development", "In Queue", "In Queue")


def portfolio_baseline(projects_per_engineer: int = 3) -> WhatIfBaseline:
    """A mid-size, fully deterministic portfolio across five hubs.

    Engineers: Greece 3, R&D-India 2, PD-India 2, Romania 2, OEM-HCK 1.
    Chambers: Greece 2 (2 platforms), India 2 (1 platform), Romania 1 (2 platforms).
    Projects are dealt round-robin over the hub's engineers with category,
    priority and status cycling, so some finish in-year and some spill.
    """

    engineers: list[EngineerInput] = []
    projects: list[ProjectInput] = []
    for hub, n, cats in _HUB_PLAN:
        for i in range(n):
            engineers.append(
                EngineerInput(
                    f"eng-{hub}-{i}", f"{ENGINEER_NAME_MARKER} {hub} {i}", hub, cats, fte=1.0
                )
            )
    k = 0
    for hub, n, _cats in _HUB_PLAN:
        oem = hub.startswith("OEM")
        for i in range(n * projects_per_engineer):
            k += 1
            cat = _OEM_CATS[k % 3] if oem else _CATS[k % 4]
            projects.append(
                ProjectInput(
                    project_id=f"p{k:03d}",
                    name=f"Project {k:03d}",
                    hub=hub,
                    status=_STATUSES[k % len(_STATUSES)],
                    category=cat,
                    priority=_PRIOS[k % len(_PRIOS)],
                    frozen=False,
                    leader_engineer_id=f"eng-{hub}-{i % n}",
                    workflow_id="OEM" if oem else "PDD",
                )
            )
    chambers = (
        ChamberInput("ch-gr-1", "GR-1", "Greece", 2, PDD_STAGES + OEM_STAGES, 0.8),
        ChamberInput("ch-gr-2", "GR-2", "Greece", 2, PDD_STAGES + OEM_STAGES, 0.9),
        ChamberInput("ch-in-1", "IN-1", "India", 1, PDD_STAGES, 0.85),
        ChamberInput("ch-in-2", "IN-2", "India", 1, PDD_STAGES, 0.85),
        ChamberInput("ch-ro-1", "RO-1", "Romania", 2, PDD_STAGES, 0.8),
    )
    si = ScheduleInput(
        projects=tuple(projects),
        engineers=tuple(engineers),
        chambers=chambers,
        current_week=CURRENT_WEEK,
    )
    calendars = tuple(HubCalendarInput(hub, 5, 12, 3, 4, 20) for hub, _, _ in _HUB_PLAN) + (
        HubCalendarInput("OEM-Seitek", 5, 12, 3, 4, 20),
    )
    supply = tuple(
        ChamberSupplyInput(c.chamber_id, c.lab_region, c.max_concurrent, c.efficiency, 2, 1, 1)
        for c in chambers
    )
    return WhatIfBaseline(schedule=si, calendars=calendars, chamber_supply=supply)
