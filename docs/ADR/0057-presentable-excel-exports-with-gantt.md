# ADR 0057 — Presentable Excel exports, with a drawn Gantt chart

- **Status:** Accepted (2026-11-17, orchestrator, owner request). Presentation only: no scheduler,
  KPI or data-scope change.
- **Phase:** P43.

## Context

Owner, 2026-11-17: "when I export the Gantt chart, numbers come in Excel. I want Gantt charts
exported in Excel everywhere, also in the scenarios we build in the What-if planner, and all
exports good-looking and presentable."

Every `.xlsx` is built server-side by `services/export_builder.xlsx_bytes`. That covers:
- the surface exports `/exports/{surface}`;
- What-if import result, saved scenario and comparison exports (`services/whatif_import_scenarios`).

Today each sheet is raw `snake_case` headers with plain rows. The Gantt export is one row per
project × step with the week numbers as numbers.

## Decision

**D1 — One styled workbook writer**, used by every `.xlsx` export:
- title block: export name, scope or filter, generated-at, run version / week where relevant;
- a styled header row with human column names;
- frozen header and first columns, auto-filter, and column widths sized to the content;
- booleans shown as Yes / No, and number formats;
- banded rows;
- print setup: landscape, fit to width, repeat the header rows.

Every existing guard stays:
- formula neutralisation (P13-F10);
- text-typed strings;
- financial fields only where they are already exported, and only to roles already allowed;
- bounded memory.

CSV is unchanged apart from the human headers.

**D2 — A drawn "Gantt" sheet** wherever a schedule is exported:
- the surface Gantt export;
- the What-if import result;
- each saved scenario;
- the scenario comparison: one Gantt sheet per scenario, up to 4.

Layout:
- **Rows:** one row per project, carrying the overall bar, then its steps indented beneath.
  Fixed columns are project / step, hub, priority (with label), leader / engineer, start, end
  and outcome.
- **Week columns:** W1..horizon, narrow. Filled cells are coloured by step kind (design / lab /
  elapsed), matching the app's step colours. Frozen and pinned steps get a hatched or bordered
  marker.
- **Markers:** the current-week column is highlighted, and so is the W52 year boundary.
- **Legend:** a legend block.
- **Outcome chips** as coloured text: within year / spillover / left out / Queued / Not scheduled
  (P4).

The numeric project × step table stays as a second sheet, "Gantt data", so nothing is lost.

**D3 — The What-if planner.** If the plain What-if planner (not the import) has a scenario result
with no export, it gains one: `.xlsx` with Summary, Gantt and Gantt data. Its RBAC and hub scope
are those of the What-if read.

## Consequences

- Workbooks are larger. With ~236 projects × 14 steps × 78 weeks the drawn sheet is about 3,500 ×
  85 cells, well within limits.
- Column names change from `snake_case` to words, so any downstream script that parses the old
  headers breaks. OQ #112.
