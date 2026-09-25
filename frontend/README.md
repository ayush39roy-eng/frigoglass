# RPD Web Application — Frontend

React 19 + TypeScript + Vite frontend for Frigoglass's RPD (R&D and Product Development portfolio
planning) application. See the repo root `CLAUDE.md` and `docs/PROJECT_AND_STACK.md` for the full
product/architecture context.

**Status:** P4-T01 (design tokens, base components, app shell) is complete. The six surfaces
(Dashboard, Capacity, Prioritization Matrix, Gantt, Project Registration, Capacity Planning) are
**not built yet** — every route currently renders a placeholder naming the P4 task that builds it.
They are blocked on the P3 API layer (`docs/IMPLEMENTATION_PLAN.md`).

## Running it

```bash
pnpm install
pnpm dev          # http://localhost:5173 (or the next free port)
```

Other scripts:

| Script | What it does |
|---|---|
| `pnpm build` | `tsc -b` + `vite build` + the 400 KB gzip initial-bundle budget check |
| `pnpm build:no-budget` | Same build, skips the budget check (debugging only) |
| `pnpm check:bundle` | Re-runs just the budget check against an existing `dist/` |
| `pnpm lint` | ESLint (flat config) |
| `pnpm typecheck` | `tsc -b --noEmit` |
| `pnpm test` | Vitest (jsdom + Testing Library) |
| `pnpm vitest run --coverage` | Vitest with a v8 coverage report |

Copy `.env.example` to `.env.local` for local overrides. Nothing in it is a secret — anything
prefixed `VITE_` ships to the browser bundle.

## Design system

Three-layer token system in `src/styles/tokens.css`:

1. **Primitives** — raw HSL palette + dimension ramps. Never referenced from a component.
2. **Semantic** — role-based aliases (`--color-surface`, `--color-danger`, `--color-band-p1`, …).
   Re-pointed inside `.dark`; this is the only layer `tailwind.config.ts` consumes
   (`hsl(var(--color-x) / <alpha-value>)`), so **dark mode is a pure token re-point** — no
   component-level dark-mode classes exist anywhere.
3. **Component** — a handful of shared chrome dimensions (`--radius-*`, `--app-header-h`,
   `--app-sidebar-w*`).

Rule: **components consume semantic/component tokens only, via Tailwind utility classes.** Raw hex
must never appear in a `.tsx` file. If a screen needs a new colour, add a primitive + a semantic
alias in `tokens.css` first.

Visual bar: `.claude/skills/rpd-visual-bar/SKILL.md` (information density, restrained type scale,
zebra-free tables, colour reserved for status, required empty/loading/error states on every
surface). Build conventions: `.claude/skills/frontend-builder/SKILL.md` (folder structure, TanStack
Query key factory, Zustand slicing, Lottie boundaries, bundle budget). Read both before adding a
surface.

### Base components — `src/components/ui/`

Generated-style shadcn/ui primitives (new-york style, Radix underneath): `button`, `badge`, `card`,
`input`, `label`, `select`, `dialog`, `dropdown-menu`, `popover`, `tabs`, `tooltip`, `separator`,
`checkbox`, `toggle-group`, `skeleton`, `spinner`, `table`. Per the frontend-builder skill these are
meant to be regenerated, not hand-edited — `eslint.config.js` turns off
`react-refresh/only-export-components` for this directory for exactly that reason (they're
multi-export barrels by convention, not something Fast Refresh needs to optimise).

### RPD-specific / shared components — `src/components/shared/`

Domain components that carry business meaning, per the frontend-builder skill's "when to write new
vs. pull from shadcn" rule:

- `PriorityBandPill` — P1–P4 / Q band. Colour is **never** the sole signal: always paired with a
  dot + text label (or an `sr-only` label in `iconOnly` mode).
- `ScheduleOutcomeBadge` / `schedule-outcome-meta.ts` — the five named scheduler outcomes
  (`ENG_CONFLICT`, `OVERLAP`, `LEFT_OUT`, `SPILLOVER`, `CAT_NOT_ALLOWED`), each an icon + label +
  status colour, meant to sit inline in a dense row rather than as a full-row highlight.
- `ProjectStatusBadge` — lifecycle status, deliberately quiet (mostly neutral) so it doesn't compete
  with the scheduler-outcome colour on the same row.
- `EmptyState` / `ErrorState` — the required empty/error affordances for every surface (never a
  blank panel, never a bare "Something went wrong").
- `ErrorBoundary` — class-based render-error boundary; backs `LottieBoundary` and is available for
  wrapping future lazy route chunks.
- `LottieBoundary` — the **only** sanctioned entry point for Lottie (`lottie-react` is
  `React.lazy`-loaded so it never lands in the initial bundle). Scoped to exactly three uses per
  CLAUDE.md / Standing Decisions: empty states, solver progress, success confirmations. Falls back
  to a static `poster` under `prefers-reduced-motion`, on load failure, or before the chunk resolves.

### Theming — `src/components/theme/`

`ThemeProvider` + `useTheme()` support `light` / `dark` / `system`, persisted to
`localStorage['rpd-theme']` and mirrored by the pre-paint inline script in `index.html` (avoids a
flash of the wrong theme before React hydrates). `ThemeToggle` is a three-way radio group in the
app header.

### App shell — `src/components/layout/`, `src/app/`

`AppShell` = fixed header (`AppHeader`) + collapsible sidebar (`AppSidebar`, state in
`stores/ui.ts`, a Zustand store scoped to UI chrome only — no server state, no scenario-edit state)
+ a scrolling `<Outlet>`. `src/app/nav.ts` is the single source of truth for the six surfaces (path,
label, icon, owning P4 task); `src/app/routes.tsx` builds the route table from it. Until a surface
is built, its route renders `PlaceholderPage`, which names the task and shows the design-system
scaffolding (`PageHeader` + `Card` + `Skeleton`) that surface will be built on.

## What's intentionally not here yet

- **No real API client.** `src/lib/api/` is empty on purpose; `src/types/*.ts` are hand-authored
  placeholders (see `src/types/README.md`) standing in for OpenAPI-generated types until P3 ships
  its schema. Every placeholder type file carries a `// PLACEHOLDER` header.
- **No surfaces.** All six routes render `PlaceholderPage`. Building them is P4-T02 through P4-T07.
- **No Framer Motion usage in the shell**, by choice — it would land in the always-loaded initial
  chunk for no benefit at this stage (the sidebar collapse is a CSS width transition, respecting
  `prefers-reduced-motion` via the global rule in `index.css`). It's reserved for the surfaces that
  actually need shared-element transitions (the Gantt row expansion) or panel mount/unmount
  (`AnimatePresence`), per the frontend-builder skill, and will load as part of their lazy chunk.
- **No route-splitting yet.** With only placeholder pages there's nothing worth splitting; real
  surfaces must be added as `React.lazy` route chunks (frontend-builder skill) to keep holding the
  400 KB budget as they grow.

## Testing

Vitest + `jsdom` + Testing Library. `src/test/setup.ts` wires up
`@testing-library/jest-dom/vitest` (not the plain `/matchers` import — the `/vitest` entry point
also augments Vitest's `Assertion` types, which `/matchers` alone does not) plus jsdom polyfills
Radix/Framer-adjacent code needs (`matchMedia`, `scrollIntoView`, pointer capture, `ResizeObserver`).
`src/test/render.tsx` provides `renderWithProviders` (theme + query client + tooltip provider) and
`renderApp` (the real router, for shell/nav/routing tests) so surface and shell tests don't each
re-wire boilerplate.

**Node version note:** `jsdom` is pinned to `29.1.1`, not the latest `30.x`, because `jsdom@30`
requires Node `^22.22.2 || ^24.15.0 || >=26.0.0` and this environment runs Node `20.20.2`; `30.x`'s
bundled `undici@8` also hard-requires Node `>=22.19.0` and fails at import time (`webidl.util.
markAsUncloneable is not a function`) on 20.x. `29.1.1`'s `undici@^7.25.0` only requires Node
`>=20.18.1`, which this environment satisfies. Vitest declares `jsdom` as an open (`"*"`, optional)
peer dependency, so this pin is safe. Revisit once the target Node runtime moves to 22+.
