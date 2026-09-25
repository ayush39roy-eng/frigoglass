import * as React from 'react';
import { NavLink } from 'react-router-dom';
import { Building2, LogOut } from 'lucide-react';

import { NAV_GROUP_ORDER, SURFACES, type NavGroup, type SurfaceNavItem } from '@/app/nav';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useUiStore } from '@/stores/ui';

/**
 * The rail. A dark petrol island inside a light app, per the reference.
 *
 * WHY IT HAS ITS OWN COLOUR TOKENS
 * The rail is the one place in the product where the light-theme semantic tokens are
 * wrong: `text-text` on `bg-surface` is correct on every other surface and unreadable
 * here. So it reads from a dedicated `--color-sidebar-*` block instead of borrowing
 * the semantic layer. That also means dark mode re-points the rail independently — it
 * goes darker still rather than inverting, because a rail that became LIGHTER in dark
 * mode would be the brightest object on a dark screen.
 *
 * THE TWO-COLOUR CONTRACT
 * Petrol is structure and is never clickable. Blue is action. The active nav item is
 * therefore blue — the one blue object on a petrol field, which is why it reads
 * instantly without needing a bar, an arrow or a weight change to help it.
 *
 * Section labels remain structure, not navigation: no path, no hover state, no tab
 * stop. A heading that looks clickable and isn't is worse than no heading.
 */

const GROUPED: ReadonlyArray<readonly [NavGroup, readonly SurfaceNavItem[]]> = NAV_GROUP_ORDER.map(
  (group) => [group, SURFACES.filter((s) => s.group === group)] as const,
).filter(([, items]) => items.length > 0);

function NavItem({ item, collapsed }: { item: SurfaceNavItem; collapsed: boolean }) {
  const link = (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      className={({ isActive }) =>
        cn(
          'group relative flex h-11 items-center gap-s3 rounded-control px-s3 text-body font-medium',
          'transition-[background-color,color] duration-fast ease-ease-out-expo',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar',
          collapsed && 'justify-center px-0',
          isActive
            ? 'bg-sidebar-active text-sidebar-active-fg shadow-card'
            : 'text-sidebar-text-muted hover:bg-sidebar-raised hover:text-sidebar-text',
        )
      }
    >
      <item.icon className="size-[18px] shrink-0 text-current" aria-hidden="true" />
      <span className={cn('truncate', collapsed && 'sr-only')}>{item.label}</span>
    </NavLink>
  );

  // Tooltips only in collapsed mode — an expanded item already shows its label, and a
  // tooltip repeating visible text is noise for everyone and a double-announcement
  // for a screen reader.
  return collapsed ? (
    <Tooltip delayDuration={400}>
      <TooltipTrigger asChild>{link}</TooltipTrigger>
      <TooltipContent side="right">{item.title}</TooltipContent>
    </Tooltip>
  ) : (
    link
  );
}

export function AppSidebar(): React.JSX.Element {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <nav
      aria-label="Surfaces"
      data-collapsed={collapsed ? '' : undefined}
      className={cn(
        'flex shrink-0 flex-col bg-sidebar transition-[width] duration-base ease-ease-out-expo',
        collapsed ? 'w-sidebar-collapsed' : 'w-sidebar',
      )}
    >
      <SidebarIdentity collapsed={collapsed} />

      <div className="flex-1 overflow-y-auto overflow-x-hidden px-s3 py-s3 scrollbar-thin">
        {GROUPED.map(([group, items], groupIndex) => (
          <div key={group} className={cn(groupIndex > 0 && 'mt-s5')}>
            {/* In collapsed mode the label would truncate to nonsense, so it becomes a
                hairline rule instead — the grouping survives, the text does not. */}
            {collapsed ? (
              groupIndex > 0 ? (
                <div aria-hidden="true" className="mx-auto mb-s3 h-px w-7 bg-sidebar-border" />
              ) : null
            ) : (
              <div className="label-caps px-s3 pb-s2 pt-s1 text-sidebar-text-muted/70">{group}</div>
            )}
            <div className="flex flex-col gap-s1">
              {items.map((item) => (
                <NavItem key={item.path} item={item} collapsed={collapsed} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <SidebarFooter collapsed={collapsed} />
    </nav>
  );
}

/**
 * The identity block at the top of the rail, as in the reference.
 *
 * Deliberately NOT a photo avatar. The reference uses one because it is a consumer
 * product; this is an internal planning tool reached through corporate SSO, where a
 * photo is both unavailable until Entra ID is wired (P6) and, once it is, personal
 * data rendered on every single screen for no functional gain. A monogram tile
 * carries the same "you are signed in, here" signal at a fraction of the cost.
 */
function SidebarIdentity({ collapsed }: { collapsed: boolean }) {
  return (
    <div
      className={cn(
        // h-header matches --app-header-h exactly, so the rail's divider lines up
        // with the bottom of the top bar. A one-pixel disagreement here is the kind
        // of thing nobody can name but everybody notices.
        'flex h-header items-center gap-s3 border-b border-sidebar-border px-s4',
        collapsed && 'justify-center px-0',
      )}
    >
      <span
        className="grid size-9 shrink-0 place-items-center rounded-control bg-sidebar-active text-2xs font-bold text-sidebar-active-fg"
        aria-hidden="true"
      >
        RPD
      </span>
      {!collapsed && (
        <span className="min-w-0">
          <span className="block truncate text-body font-semibold text-sidebar-text">
            Frigoglass
          </span>
          {/* TODO(P6-SSO): replace with the authenticated user's display name. */}
          <span className="block truncate text-2xs text-sidebar-text-muted">R&amp;D Portfolio</span>
        </span>
      )}
    </div>
  );
}

/**
 * Pinned footer: WHAT YOU CAN SEE, and the way out.
 *
 * The hub scope indicator is the load-bearing element here. A Hub Planner is
 * row-scoped to their own hub in the data access layer, so their Dashboard total
 * legitimately differs from a Portfolio Manager's. Without a persistent, glanceable
 * statement of scope, that reads as missing data, and the first thing a user does
 * with a tool they believe is losing records is stop trusting it.
 */
function SidebarFooter({ collapsed }: { collapsed: boolean }) {
  return (
    <div className="border-t border-sidebar-border p-s3">
      {!collapsed && (
        <div className="mb-s2 flex items-center gap-s3 rounded-control bg-sidebar-raised px-s3 py-s3">
          <Building2 className="size-4 shrink-0 text-sidebar-text-muted" aria-hidden="true" />
          <span className="min-w-0">
            <span className="label-caps block text-sidebar-text-muted/70">Hub scope</span>
            {/* TODO(P6-SSO): bind to the authenticated session's hub scope. Rendering a
                placeholder rather than a fabricated hub name — a wrong scope indicator
                is strictly worse than an obviously-unbound one. */}
            <span className="mt-0.5 block truncate text-body font-medium text-sidebar-text">
              All hubs
            </span>
          </span>
        </div>
      )}

      {/* No collapse toggle here — <AppHeader> already owns that control. Two buttons
          driving one piece of state is a bug even when both work: the user cannot tell
          whether they do the same thing, and a screen reader announces the state twice. */}
      <button
        type="button"
        aria-label="Sign out"
        className={cn(
          'flex h-10 items-center gap-s2 rounded-control px-s3 text-body text-sidebar-text-muted transition-colors duration-fast hover:bg-sidebar-raised hover:text-sidebar-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50',
          collapsed ? 'mx-auto w-10 justify-center px-0' : 'w-full',
        )}
      >
        <LogOut className="size-4 shrink-0" aria-hidden="true" />
        <span className={cn(collapsed && 'sr-only')}>Sign out</span>
      </button>
    </div>
  );
}
