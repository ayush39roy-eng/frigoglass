"""Category template timeline (P33-T04; ADR 0046 §5 as ruled, R33-4/R33-6;
DOMAIN_RULES "Category templates" §D "Template preview"; contract P33 F3).

One pure function, `template_timeline`, walks one workflow's precedence DAG
for one category's template — the step lengths and signed gaps — from week 0,
with no capacity, FTE 1.0 and the one-leader rule. It is what the Workflow
templates editor draws (`GET /workflow-settings/category-timelines`, `POST
/workflow-templates/timeline-preview`) and what the apply preview shows. Real
projects also wait for engineers and chambers; `TEMPLATE_VIEW_NOTE` says so.

Weeks are 0-based and end-exclusive (as P13-T16): a step occupies
`[start_week, end_week)`. In those terms, with `g` the step's signed gap,
`o = max(0, -g)`, `w = max(0, g)` and `release(s)` the end-exclusive week by
which everything `s` waits for is done:

    G(q)       = release(q)                if q is skipped (length 0)
               = end(q)                    if o(q) = 0
               = max(end(q), release(q))   if o(q) > 0
    release(s) = max(G(q) for q in P(s))   (0 for the first step)
    gate(s)    = release(s) + w(s)                                  if o(s) = 0
               = max(release(s) - o(s), max start of SG(s), 0)      if o(s) > 0

which is DOMAIN_RULES §D's inclusive `gate` with `frontier = 0` shifted by
one. Then:

- a **skipped** step (length 0) is emitted at `release(s)` with
  `start == end`; its gap is ignored (flag `gap_ignored_zero_length` when it
  asked for one);
- a **design** step obeys the one-leader rule (R33-6): it starts at the first
  week `>= gate(s)` whose window does not intersect a design step placed
  earlier in walk order (flag `same_leader_serialised`, "Overlap — same
  leader, runs back-to-back", when that moved it);
- an **overlap** larger than the start anchor allows (`release - o` below
  the start of the nearest non-skipped predecessors) is clamped there (flag
  `anchor_clamped`);
- every other step starts at its gate.

`effective_gap_weeks = start_week - release(s)` (signed; 0 on a skipped
step). With every gap 0 and design steps totally ordered (the seeded strict
chain) every start and duration equals the pre-P33 category timeline
(`services.workflow_previews.category_preview`): `start = max(end of
predecessors)`, `end = start + length`.

It agrees with `workflow.unconstrained_end_week` for a fresh, Not Started,
non-frozen project at FTE 1.0 carrying the same lengths (`lead_weeks`) and
gaps (`overlap_weeks` / `wait_weeks`): that walk's finish is `frontier +
total_weeks - 1`.

Pure, deterministic, no I/O. Iteration is over the workflow's deterministic
walk order and sorted sequences only (I8).
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass

from scheduling.workflow import (
    LEAD_MAX_WEEKS,
    LEAD_MIN_WEEKS,
    OVERLAP_MAX_WEEKS,
    WAIT_MAX_WEEKS,
    Workflow,
    first_free_week,
)

#: Flag: a design step was moved past another design step of the template (one
#: leader does one step at a time). UI note: "Overlap — same leader, runs
#: back-to-back".
FLAG_SAME_LEADER_SERIALISED = "same_leader_serialised"
#: Flag: the overlap asked for is larger than the start anchor allows (a step
#: never starts before the step it runs in parallel with has started).
FLAG_ANCHOR_CLAMPED = "anchor_clamped"
#: Flag: the step has length 0 (skipped), so its gap has no effect.
FLAG_GAP_IGNORED_ZERO_LENGTH = "gap_ignored_zero_length"

TEMPLATE_FLAGS: tuple[str, ...] = (
    FLAG_SAME_LEADER_SERIALISED,
    FLAG_ANCHOR_CLAMPED,
    FLAG_GAP_IGNORED_ZERO_LENGTH,
)

#: Always shown with a template timeline (ADR 0045 §1, DOMAIN_RULES §D).
TEMPLATE_VIEW_NOTE = (
    "This is the category template with no capacity limits. Real projects also wait for "
    "engineers and chambers."
)

#: Signed-gap domain (template `gap_weeks`): -104..104.
GAP_MIN_WEEKS = -OVERLAP_MAX_WEEKS
GAP_MAX_WEEKS = WAIT_MAX_WEEKS


@dataclass(frozen=True)
class TemplateStep:
    """One step of a template timeline (0-based, end-exclusive weeks)."""

    step_id: str
    start_week: int
    end_week: int  # exclusive; == start_week for a skipped (0-length) step
    duration_weeks: int
    requested_gap_weeks: int
    effective_gap_weeks: int  # start_week - release(s); 0 on a skipped step
    flags: frozenset[str]


@dataclass(frozen=True)
class TemplateTimeline:
    """`steps` are in the workflow's display (`sequence_order`) order.
    `total_weeks` is the latest end; `design_weeks` / `lab_weeks` are the sums
    of the design / lab step lengths (the B-equivalent figures)."""

    workflow_id: str
    steps: tuple[TemplateStep, ...]
    total_weeks: int
    design_weeks: int
    lab_weeks: int
    note: str = TEMPLATE_VIEW_NOTE


def _validate(workflow: Workflow, lengths: Mapping[str, int], gaps: Mapping[str, int]) -> None:
    for sid in sorted(lengths):
        if sid not in workflow.steps_by_id:
            raise ValueError(f"length for unknown step {sid!r} (workflow {workflow.workflow_id!r})")
        weeks = lengths[sid]
        if (
            isinstance(weeks, bool)
            or not isinstance(weeks, int)
            or not LEAD_MIN_WEEKS <= weeks <= LEAD_MAX_WEEKS
        ):
            raise ValueError(
                f"step {sid!r}: length {weeks!r} is outside {LEAD_MIN_WEEKS}..{LEAD_MAX_WEEKS}"
            )
    for sid in sorted(gaps):
        if sid not in workflow.steps_by_id:
            raise ValueError(f"gap for unknown step {sid!r} (workflow {workflow.workflow_id!r})")
        gap = gaps[sid]
        if (
            isinstance(gap, bool)
            or not isinstance(gap, int)
            or not GAP_MIN_WEEKS <= gap <= GAP_MAX_WEEKS
        ):
            raise ValueError(
                f"step {sid!r}: gap {gap!r} is outside {GAP_MIN_WEEKS}..{GAP_MAX_WEEKS}"
            )
        if gap != 0 and not workflow.steps_by_id[sid].predecessor_ids:
            raise ValueError(f"step {sid!r}: gap {gap} on the workflow's first step (it must be 0)")


def template_timeline(
    *, workflow: Workflow, lengths: Mapping[str, int], gaps: Mapping[str, int]
) -> TemplateTimeline:
    """The category template timeline (module docstring). `lengths` maps step
    id → template weeks (a missing step counts as 0, i.e. skipped, as the
    pre-P33 preview did); `gaps` maps step id → signed gap (missing = 0).
    `ValueError` for an unknown step id, a length outside 0..104, a gap
    outside -104..104 or a non-zero gap on the workflow's first step."""

    _validate(workflow, lengths, gaps)

    starts: dict[str, int] = {}
    ends: dict[str, int] = {}  # exclusive
    g: dict[str, int] = {}  # G(q), exclusive
    releases: dict[str, int] = {}
    flags: dict[str, set[str]] = {}
    design_windows: list[tuple[int, int]] = []  # inclusive, for `first_free_week`

    def anchor_start(sid: str) -> int:
        """Max start of `SG(s)`, the nearest non-skipped predecessors (walking
        through skipped ones); 0 (the frontier) when there are none."""

        found: set[str] = set()
        seen: set[str] = set()
        stack = list(workflow.steps_by_id[sid].predecessor_ids)
        while stack:
            q = stack.pop()
            if q in seen:
                continue
            seen.add(q)
            if lengths.get(q, 0) == 0:
                stack.extend(workflow.steps_by_id[q].predecessor_ids)
            else:
                found.add(q)
        return max((starts[q] for q in sorted(found)), default=0)

    for sid in workflow.walk_order:
        step = workflow.steps_by_id[sid]
        length = lengths.get(sid, 0)
        gap = gaps.get(sid, 0)
        flags[sid] = set()
        release = max((g[p] for p in step.predecessor_ids), default=0)
        releases[sid] = release

        if length == 0:
            if gap != 0:
                flags[sid].add(FLAG_GAP_IGNORED_ZERO_LENGTH)
            starts[sid] = ends[sid] = g[sid] = release
            continue

        overlap = max(0, -gap)
        wait = max(0, gap)
        if overlap == 0:
            start = release + wait
        else:
            anchored = max(anchor_start(sid), 0)
            start = max(release - overlap, anchored)
            if anchored > release - overlap:
                flags[sid].add(FLAG_ANCHOR_CLAMPED)
        if step.kind == "design":
            # R33-6: one leader, one design step at a time (FTE 1.0: span = length).
            placed = first_free_week(start, length, design_windows)
            if placed != start:
                flags[sid].add(FLAG_SAME_LEADER_SERIALISED)
            start = placed
            design_windows.append((start, start + length - 1))
        starts[sid] = start
        ends[sid] = start + length
        g[sid] = ends[sid] if overlap == 0 else max(ends[sid], release)

    design = sum(lengths.get(s.step_id, 0) for s in workflow.steps if s.kind == "design")
    lab = sum(lengths.get(s.step_id, 0) for s in workflow.steps if s.kind == "lab")
    steps = tuple(
        TemplateStep(
            step_id=s.step_id,
            start_week=starts[s.step_id],
            end_week=ends[s.step_id],
            duration_weeks=lengths.get(s.step_id, 0),
            requested_gap_weeks=gaps.get(s.step_id, 0),
            effective_gap_weeks=(
                0 if lengths.get(s.step_id, 0) == 0 else starts[s.step_id] - releases[s.step_id]
            ),
            flags=frozenset(flags[s.step_id]),
        )
        for s in workflow.steps
    )
    return TemplateTimeline(
        workflow_id=workflow.workflow_id,
        steps=steps,
        total_weeks=max(ends.values(), default=0),
        design_weeks=design,
        lab_weeks=lab,
    )
