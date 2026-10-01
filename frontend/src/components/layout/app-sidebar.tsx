import * as React from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { type NavGroup, type SurfaceNavItem } from '@/app/nav';
import { visibleNavGroups } from '@/app/nav-visibility';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSessionStore } from '@/stores/session';

/**
 * The rail — Boltshift spec §4 ("Sidebar rail — ICON ONLY, no permanent text").
 *
 * 2026-10-01: REPLACES the petrol "dark island" rail (2026-09-08 client direction,
 * see docs/MEMORY.md) with the floating white rail every other piece of shell chrome
 * now matches. It is PERMANENTLY icon-only — there is no expanded state any more, so
 * this file drops the old `collapsed` branching entirely. `--color-sidebar-*` and the
 * `petrol` ramp (tokens.css / tailwind.config.ts) are consequently unused by this
 * component now; they are left defined rather than deleted (same "inert, documented,
 * not churned" treatment already given to the unused `--app-sidebar-w`, 256px —
 * tokens.css's own "Bigger chrome" comment) because `styles/sidebar-contrast.test.ts`
 * still exercises them in isolation (pure token-math, independent of what actually
 * renders) and a wholesale token deletion is out of this task's own stated scope
 * boundary. See docs/MEMORY.md "[2026-10-01] Boltshift shell + Dashboard rebuild".
 *
 * THE RAIL IS NOW WHITE, LIKE EVERYTHING ELSE
 * Boltshift's chrome is "restrained blue-and-white" with colour reserved for charts —
 * there is no second structural hue any more. The rail reuses the EXISTING
 * `--color-surface`/`--color-border` tokens (same family as every Card and the Shell
 * itself), not a new colour: active = `bg-primary` (the one blue the whole app already
 * uses for action), hover = `bg-primary-subtle` (the existing blue-50-equivalent tint).
 *
 * IA DECISION — 4 real nav groups → 3 visual clusters
 * `nav.ts`'s `SURFACES` still define 4 groups (Plan / Execute / Configure / Data) and
 * `visibleNavGroups()` still does 100% of the RBAC filtering — THAT logic is untouched.
 * Only the PRESENTATION groups them differently: Configure (Workflow Settings, Users
 * & roles) and Data (Audit Log) merge into one visual cluster, since both are
 * "configure the system / inspect its record" actions a planner reaches for far less
 * often than Plan or Execute, and 4 clusters at 72px width (with hairlines eating
 * vertical space) read as cramped once a role can see all 9 surfaces. Plan and Execute
 * — the two groups almost every role actually uses day to day — each keep their own
 * cluster.
 *
 * WHY NO FRAMER-MOTION HERE (the brief's own §4 asks for a `layoutId`-shared spring)
 * `lib/motion.ts`'s own standing rule is "Framer stays a per-surface LAZY dependency"
 * precisely so the always-loaded app shell never pulls its ~30KB gzip into the
 * critical bundle (CLAUDE.md: "Bundle budget: 400 KB gzipped initial load... non-
 * negotiable"). An earlier draft of this file imported `framer-motion` for the active-
 * indicator bar and measurably regressed the initial bundle (204.9 → ~240 KB gzip in
 * local verification) for a rail that is NOT lazy — it is part of `AppShell`, loaded on
 * every route. The indicator below gets the same "springs between items" read with a
 * measured `top` offset + a plain CSS `transition-[top]` (the sitewide `--dur-base`/
 * `ease-out-expo` tokens, which `prefers-reduced-motion` already zeroes globally,
 * `index.css`) instead of a literal physics spring — visually close, zero extra bytes.
 */

const CLUSTER_OF: Record<NavGroup, 0 | 1 | 2> = {
  Plan: 0,
  Execute: 1,
  Configure: 2,
  Data: 2,
};

/** Merge the 4 RBAC-filtered nav groups down to 3 visual clusters, dropping empties. */
function buildClusters(
  grouped: ReadonlyArray<readonly [NavGroup, readonly SurfaceNavItem[]]>,
): SurfaceNavItem[][] {
  const clusters: SurfaceNavItem[][] = [[], [], []];
  for (const [group, items] of grouped) {
    clusters[CLUSTER_OF[group]]?.push(...items);
  }
  return clusters.filter((c) => c.length > 0);
}

/** Same match rule `<NavLink>` uses internally, lifted out so the parent can measure
 *  the active item's position without re-deriving it from each child. */
function isItemActive(item: SurfaceNavItem, pathname: string): boolean {
  if (item.path === '/') return pathname === '/';
  return pathname === item.path || pathname.startsWith(`${item.path}/`);
}

/**
 * One 44×44 icon button. The tooltip IS the only place the label text exists — this is
 * the same Radix `<Tooltip>` every other icon-only control in the app already uses
 * (keyboard-focusable, Escape-dismissible, `role="tooltip"`), just restyled as a flying
 * pill (`data-[state=delayed-open]:slide-in-from-left-1`, 140ms — tailwindcss-animate's
 * data-state transitions, honouring `prefers-reduced-motion` via the sitewide
 * `transition-duration: 0.01ms` override in index.css) rather than a bespoke
 * AnimatePresence tooltip, so the existing accessible interaction model is unchanged.
 *
 * `className` is a plain string here, computed from `isActive` (passed down from
 * `isItemActive()`, the same match rule `<NavLink>` itself uses), NOT `<NavLink>`'s
 * own function-`className` render prop (`className={({isActive}) => ...}`) — that
 * form was observed, in this exact real production build, to leave the raw
 * function uninvoked and stringified straight into the DOM `class` attribute
 * (visible as literal `"(isActive) => ..."` text, and every icon consequently
 * invisible). `<NavLink>` still computes its OWN `aria-current="page"` correctly
 * regardless (confirmed in that same broken build — only its function-className
 * special-case misbehaved), which is what this file's active-indicator
 * measurement below relies on. */
function NavItem({ item, isActive }: { item: SurfaceNavItem; isActive: boolean }): React.JSX.Element {
  return (
    <Tooltip delayDuration={200}>
      <TooltipTrigger asChild>
        <NavLink
          to={item.path}
          end={item.path === '/'}
          className={cn(
            'group relative grid size-11 shrink-0 place-items-center rounded-control',
            'transition-colors duration-fast ease-ease-out-expo',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface',
            isActive
              ? 'bg-primary text-primary-fg shadow-feature'
              : 'text-text-muted hover:bg-primary-subtle hover:text-primary',
          )}
        >
          <item.icon className="size-[18px] shrink-0" aria-hidden="true" />
          {/* The ONLY place this label exists outside the tooltip — an sr-only
              accessible name, so `getByRole('link', { name: item.label })`
              (app.test.tsx, e2e/p9-rbac.spec.ts) keeps resolving every item
              exactly as it did in the old "collapsed" rail mode. */}
          <span className="sr-only">{item.label}</span>
        </NavLink>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={10}
        className="rounded-pill border-transparent bg-text px-s3 py-1.5 text-2xs font-semibold text-text-inverse shadow-pop data-[state=delayed-open]:slide-in-from-left-1"
      >
        {item.title}
      </TooltipContent>
    </Tooltip>
  );
}

export function AppSidebar(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const { pathname } = useLocation();
  const clusters = React.useMemo(() => buildClusters(visibleNavGroups(me)), [me]);
  const activeItem = React.useMemo(
    () => clusters.flat().find((item) => isItemActive(item, pathname)),
    [clusters, pathname],
  );

  const navRef = React.useRef<HTMLElement>(null);
  const [barTop, setBarTop] = React.useState<number | null>(null);

  // Measure the active item's position so the indicator bar can slide to it with a
  // plain CSS transition — see this file's header comment for why that is a
  // deliberate substitute for a framer-motion `layoutId` spring here. Found via
  // `aria-current="page"` (which `<NavLink>` already sets on the active link)
  // rather than a per-item ref callback — passing a `ref` straight through
  // `<NavLink>`'s function `className` prop was observed, in a real production
  // build, to corrupt that className into a literal stringified function (a
  // React 19 + this exact react-router-dom version interaction); querying the
  // DOM for the one link the library itself already marks active sidesteps it.
  React.useLayoutEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLAnchorElement>('a[aria-current="page"]');
    if (!el) {
      setBarTop(null);
      return;
    }
    setBarTop(el.offsetTop + el.offsetHeight / 2 - 10);
  }, [activeItem, clusters]);

  return (
    <nav
      ref={navRef}
      aria-label="Surfaces"
      className="sticky top-5 relative flex h-[calc(100vh-2.5rem)] w-sidebar-collapsed shrink-0 flex-col items-center overflow-y-auto rounded-rail border-[1.5px] border-border bg-surface py-s4 shadow-card scrollbar-thin"
    >
      {/* The active indicator — a 3×20px blue bar on the rail's inner edge
          (Boltshift spec §4). */}
      {barTop !== null ? (
        <span
          aria-hidden="true"
          className="absolute left-1.5 h-5 w-[3px] rounded-full bg-primary transition-[top] duration-base ease-ease-out-expo"
          style={{ top: barTop }}
        />
      ) : null}

      {clusters.map((items, clusterIndex) => (
        <div
          key={clusterIndex}
          className={cn(
            'flex w-full flex-col items-center gap-s2',
            // Hairline between clusters, not above the first one.
            clusterIndex > 0 && 'mt-s4 border-t border-border pt-s4',
          )}
        >
          {items.map((item) => (
            <NavItem key={item.path} item={item} isActive={isItemActive(item, pathname)} />
          ))}
        </div>
      ))}
    </nav>
  );
}
