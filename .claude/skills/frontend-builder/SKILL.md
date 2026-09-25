---
name: frontend-builder
description: React 19 + TypeScript + Vite conventions for the RPD Web Application frontend — folder structure, state management, forms, Framer Motion patterns, Lottie boundaries, code splitting, bundle budget.
---

# Frontend build conventions

## Folder structure

```
frontend/src/
  surfaces/           one folder per surface: dashboard/, capacity/, matrix/, gantt/,
                       project-registration/, capacity-planning/
    <surface>/
      components/      surface-local components
      hooks/           surface-local TanStack Query hooks
      <Surface>Page.tsx
  components/ui/       shadcn/ui primitives (generated, don't hand-edit — regenerate instead)
  components/shared/   cross-surface components (StatusBadge, CurrencyToggle, HubFilter, etc.)
  lib/
    api/               generated API client + TanStack Query key factory
    query-keys.ts       single source of truth for query keys (see below)
  stores/              Zustand stores, one file per concern (scenario.ts, ui.ts)
  types/               types generated from the backend OpenAPI schema — never hand-authored
```

Route-split at the surface boundary: each of the six surfaces is its own lazy-loaded route chunk.
This is what makes the 400 KB initial-bundle budget achievable — the initial load is shell + auth +
Dashboard only.

## TanStack Query key factory and cache invalidation

Define query keys in one place (`lib/query-keys.ts`) as a typed factory, not ad-hoc arrays scattered
across hooks:

```ts
export const queryKeys = {
  projects: (hubId?: string) => ['projects', hubId] as const,
  project: (id: string) => ['projects', 'detail', id] as const,
  scheduleRun: (versionId: string) => ['schedule-runs', versionId] as const,
  capacity: (hubId: string) => ['capacity', hubId] as const,
};
```

Every mutation that changes a project, priority, or capacity input invalidates the relevant
`scheduleRun` and `capacity` keys — a stale Gantt after "Apply Priorities" is a correctness bug, not
a cosmetic one, because Invariant I9 requires the Dashboard's within-year count to match the current
schedule run.

## Zustand store slicing for scenario edits with undo/redo

One store per concern, not one giant store. The scenario-editing store (`stores/scenario.ts`) holds
the in-progress diff against the last committed version (priorities, capacity inputs) plus an
undo/redo stack. On "Apply", the diff is POSTed; on success, the store resets to empty (the new
committed state now lives in TanStack Query's cache, not in Zustand — Zustand never duplicates
server state, it only holds the uncommitted delta).

## Form handling: react-hook-form + zod

Every form (Project Registration's create/edit, Capacity Planning's engineer/chamber config) uses
`react-hook-form` with a `zod` schema mirrored from the backend Pydantic model's shape. Validate
client-side for responsiveness; the backend is still the authority — never trust client validation
alone for hard gates (required financial fields, category constraints).

## shadcn/ui: when to pull from 21st.dev vs. write new

Pull a shadcn/ui component (optionally sourced from 21st.dev's variants) when the pattern is
generic UI chrome: dialogs, dropdowns, tooltips, form inputs, tabs, popovers. Write new,
domain-specific components when the pattern encodes RPD business meaning: the Gantt bar, the
prioritization score cell, the capacity utilization heatmap cell, the status badge set
(`ENG_CONFLICT`/`OVERLAP`/`LEFT_OUT`/`SPILLOVER`/`CAT_NOT_ALLOWED`). Domain components are never
generic enough to be worth sourcing externally — build them once in `components/shared/` and reuse.

## Framer Motion patterns

- **`layoutId`** for the Gantt row expansion (project row → per-step rows) — this is the one place
  a shared-element transition earns its cost, since it visually confirms which project's steps
  you're now looking at.
- **`AnimatePresence`** for panel mount/unmount (scenario edit panel, filter drawers).
- **Spring configs, never linear easing, on any layout animation.** Linear easing on a layout change
  reads as robotic on a data-dense screen; a spring (`type: "spring", stiffness: 300, damping: 30`
  as a starting point, tune per component) reads as responsive.
- Respect `prefers-reduced-motion`: gate all non-essential motion behind
  `useReducedMotion()` from Framer Motion; state changes must still be visible without animation
  when the user has this preference set.

## Lottie usage boundaries — do not exceed these

Exactly three uses, per Standing Decisions in `docs/MEMORY.md`:

1. Empty states (e.g., "No projects in this hub yet").
2. Solver progress (the SSE-driven queued → running → done indicator).
3. Success confirmations (e.g., "Priorities applied").

Nothing else. Do not reach for Lottie for hover effects, page transitions, or general decoration —
that's Framer Motion's job, and it's cheaper.

## Code splitting per route

Each surface is a separate Vite route chunk (dynamic `import()` at the router level). Shared
components, the API client, and the design system primitives are in the main chunk since every
surface needs them; surface-specific chart configs and heavy libraries (ECharts on Capacity, the
custom Gantt's SVG/Canvas renderer) load only when that surface's route is visited.

## Bundle budget enforcement

400 KB gzipped for the initial chunk (shell + auth + Dashboard). Enforce with a Vite build-size
check in CI (`vite-bundle-visualizer` or `rollup-plugin-visualizer` output checked against budget,
not just eyeballed). If a dependency addition would blow the budget, route-split it further or
reconsider the dependency — don't raise the budget without an ADR.
