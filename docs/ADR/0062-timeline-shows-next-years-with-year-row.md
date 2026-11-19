# ADR 0062 — The Timeline shows the weeks past W52 (2027, 2028) under a year header row

**Date:** 2026-11-19 · **Status:** Accepted (owner) · **Amends:** ADR 0024 §4 (52-week display) for the Gantt surfaces only

## Context

ADR 0024 cut every surface at W52 and showed later work as a "Spillover → 2027" marker. The owner
(2026-11-19): "2027 and 2028 are not visible on the timeline … there should be a row above weeks
which shows 2026, 2027 or 2028 respectively." Planning the client's 2027 list (ADR 0061) makes
next-year weeks the main content of a What-if import.

## Decision

1. **Live Timeline** axis runs W1 .. the run's horizon (`HORIZON_WEEKS` = 78 → W26 2027); bars are
   no longer clipped at W52. **What-if import Gantt** runs to its horizon (`plan_until + 26`, up to
   W130 → W26 2028).
2. A **year header row** above the week ruler spans each calendar year ("2026", "2027", "2028");
   week ticks restart at W1 each year (absolute week 53 is labelled 1 under "2027"; owner rule
   2026-11-18: no label ≥ 53).
3. The year-end (W52) marker line stays; weeks past the plan year are shaded. Spillover badges,
   KPIs and the server's within-year verdicts (I9) are unchanged — display only.
4. Every other surface keeps ADR 0024's W52 window.
