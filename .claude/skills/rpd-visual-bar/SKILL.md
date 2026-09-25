---
name: rpd-visual-bar
description: The visual bar for the RPD Web Application — an industrial B2B dashboard that executives present to a board. Load before styling any of the six surfaces.
---

# UI/UX bar for the RPD Web Application

This is a data tool, not a marketing page. Every screen will be presented to a board. The bar is
information density done right — not sparse, not decorative, dense and legible.

## Information density

- Default to compact table rows and tight vertical rhythm. White space is a tool for grouping, not
  a default aesthetic.
- Every number that matters gets **tabular numerals** (`font-variant-numeric: tabular-nums`) so
  columns of figures align visually without manual padding.
- Prefer inline sparklines and small multiples over a single giant chart when the underlying data
  is per-hub or per-category — six small trends beat one busy trend.

## Type scale

A restrained scale, tied to Tailwind's default steps: `text-xs` (12px) for table cells and badges,
`text-sm` (14px) for body/labels, `text-base` (16px) for section headers, `text-lg`/`text-xl` for
page titles only. Do not introduce a custom scale — this stays legible and consistent across all
six surfaces without designer-per-page drift.

## Palette

A restrained palette anchored on Frigoglass blue as the primary brand color. Semantic color is
**reserved for status only**:

- Neutral grays for structure (backgrounds, borders, body text).
- Frigoglass blue for primary actions and active/selected state.
- Red only for `ENG_CONFLICT`, `OVERLAP`, blocking errors.
- Amber only for `SPILLOVER`, `LEFT_OUT`, warnings.
- Green only for on-track / completed / PASS.

Never use color as the *sole* carrier of meaning — pair every status color with a label, icon, or
pattern (see "conflict/warning states" below) so the app remains usable for colorblind users and
readable in a black-and-white printout of an export.

## Card and panel patterns

- Cards: a single 1px border (not a shadow-only card — shadows don't reproduce well when exported/
  printed), consistent corner radius, consistent internal padding on an 8px grid.
- Panel headers are a fixed-height row with title left, actions/filters right. Never let panel
  headers reflow independently across the six surfaces — the eye should find the same landmark in
  the same place on every screen.

## Table design

- **Sticky headers** on every table over one viewport height (the Matrix, the Gantt's fixed left
  column, Capacity Planning's engineer/chamber lists).
- **Zebra-free.** Use borders and whitespace for row separation, not alternating background —
  zebra striping reads as noisy at this data density and fights with status-color backgrounds.
- **Right-align numerics**, left-align text, center-align short categorical badges (P1/P2/P3/P4,
  A+/A/B/C).
- Inline sparklines belong in a dedicated narrow column, never overlapping the numeric value they
  summarize.

## Empty, loading, and error states — required on every surface

- **Empty:** never a blank panel. State what's missing and, where actionable, the action to fix it
  ("No projects registered for this hub yet — Register a project").
- **Loading: skeleton loaders, not spinners.** A spinner tells the user nothing about shape; a
  skeleton (matching the real layout's card/table/chart shape) sets correct expectations and feels
  faster. Reserve spinners for sub-second inline actions (button pending state) only.
- **Error:** state what failed and whether it's retryable. Never a bare "Something went wrong."

## Conflict/warning states without a wall of red

`ENG_CONFLICT`, `OVERLAP`, `LEFT_OUT`, `SPILLOVER`, `CAT_NOT_ALLOWED` are frequent, expected outputs
of a resource-constrained scheduler on a real portfolio — not rare catastrophic failures. Do not
render every one of 236 projects' worth of conflicts as a full red row; use a small badge (icon +
label + status color) inline, reserve full-row red backgrounds for the single project currently
selected/expanded in the Gantt.

## Explicit anti-patterns — do not do these

- Gradient hero backgrounds. This is a dashboard, not a landing page.
- Decorative accent stripes with no semantic meaning.
- Glassmorphism (blur/translucency effects) — hurts legibility of dense tabular data.
- Unlabelled icons. Every icon-only control needs a tooltip or `aria-label`; icon meaning is not
  self-evident at this domain's specificity (what does a chamber icon mean vs. an engineer icon).
- Color as the sole carrier of meaning (restated from Palette above — this is worth repeating as an
  anti-pattern because it's the easiest one to slip into under deadline pressure).
- Animation on data updates that fires more than once per interaction. A number changing on
  poll/refresh should not re-trigger its entrance animation every time; animate on genuine user
  action (Apply, filter change), not on background revalidation.
