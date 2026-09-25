---
name: dataviz-gantt
description: How to build the custom Project Execution Timeline (Gantt) — week-bucket coordinates, virtualization, hatched delay bars, badges, the activity-load bottleneck strip, zoom, and scroll sync. Load before touching frontend/surfaces/gantt/.
---

# Building the custom Gantt

No commercial Gantt library (DHTMLX, Bryntum, Syncfusion) — hand-built virtualized SVG, with a
Canvas fallback at extreme node counts. This is a Standing Decision (`docs/MEMORY.md`).

## Week-bucket coordinate system

The x-axis is week-indexed, not date-indexed, matching the domain model directly:
`x = weekIndex * weekWidthPx`. `weekIndex` runs `0..HORIZON_WEEKS` (78, per
`docs/DOMAIN_RULES.md`). Do not compute x-position from calendar dates at render time — the backend
already returns `start_week`/`end_week` integers per step; converting through `Date` objects only
introduces timezone bugs for no benefit, since the domain model is week-granular everywhere (booking
rules, invariants, horizon).

The y-axis is row-indexed: one row per project when collapsed, one row per project + 14 rows when a
project is expanded (the 14 PDD steps). Row height is fixed and known ahead of layout — this is what
makes virtualization tractable.

## Virtualization

236 projects × 14 steps = up to ~3,300 potential rows if every project were expanded simultaneously,
plus the bottleneck strip. Virtualize with TanStack Virtual on the **row** axis (project rows;
expanded step rows count as additional virtual rows inserted at the expansion point) — do not
attempt to virtualize the x-axis, week counts are small enough (≤78) that rendering all week columns
is cheap; only row count is the scaling risk.

## SVG vs. Canvas fallback

Default to SVG — it gives free hit-testing, accessible tooltips via `<title>`, and CSS-based hover
states. Switch to a Canvas renderer only if the SVG node count exceeds ~10k in a single viewport
render (this can happen if a user expands most of the 236 projects at once at a wide zoom level).
Canvas fallback trigger: count `visibleRows * (weeksInViewport + badgeCount)` and switch renderers
above the threshold; keep the two renderers behind the same component interface so surfaces above
don't know which is active.

## Bar rendering

- **Solid bar** = planned (the schedule as computed by the solver, no delay).
- **Hatched bar** (diagonal SVG `<pattern>`, 45°, subtle) = actual + delay. The hatch pattern must
  read clearly at the smallest zoom level (weeks view) — test at 4px bar height, not just the
  comfortable default.
- **Red connector line** = delay, drawn from the planned bar's end to the actual bar's end,
  horizontal, with a small arrowhead. This is the one place red is used outside a status badge —
  because it's showing a magnitude (how much delay), not a status.

## Badge placement without overlap at narrow zoom

Badges (`ENG_CONFLICT` / `OVERLAP` / `LEFT_OUT`) are small icon+color chips anchored to the
step or project row where the condition occurs. At narrow zoom (weeks view, many projects visible),
multiple badges on adjacent rows can visually collide — stack badges vertically within a fixed
badge-column to the right of the bar area rather than overlaying them on the bar itself, so they
never obscure the bar's own hatch/solid state and never overlap each other.

## Activity-load bottleneck strip

A single horizontal strip beneath the main timeline, same x-axis (week-indexed), showing aggregate
resource load per week across the currently visible/filtered project set — a compact bar or heat
strip, not a full chart, since its only job is to let the eye spot a bottleneck week at a glance
before scrolling through individual rows. Uses the same week-bucket coordinates as the main Gantt so
they stay pixel-aligned during horizontal scroll.

## Zoom levels

Two zoom levels: **weeks** (default, ~1 column per week, full 78-week horizon roughly fits) and
**days** (expanded, for inspecting a specific project's step boundaries precisely). Zoom changes
`weekWidthPx` (or subdivides it for days view) — it does not change the underlying data query;
zoom is a pure rendering-layer concern.

## Scroll sync

Horizontal scroll (the timeline body) and vertical scroll (the row list) are independent, but the
**fixed left column** (project name / step name, non-scrolling horizontally) must stay vertically
in sync with the timeline body — implement as two elements sharing one vertical scroll position
(synced `scrollTop`, not two independent scroll containers that drift), with the left column's own
horizontal scroll disabled entirely.

## Chart library handoff

The Gantt itself (bars, badges, connectors, bottleneck strip) is hand-built SVG/Canvas as above.
Where the Gantt surface also needs a utilization heatmap (engineers/chambers × weeks) or a simple
donut/bar summary panel alongside it, those are **not** part of the custom Gantt component — use
ECharts for the heatmap (dense categorical/continuous grid, handles this well out of the box) and
Recharts for simple summary panels (lighter weight, simpler API for basic bar/donut). Don't
reimplement either in the custom SVG renderer.
