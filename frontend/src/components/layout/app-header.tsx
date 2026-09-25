import * as React from 'react';
import { CalendarClock, PanelLeft, Search } from 'lucide-react';

import { NotificationBell } from '@/components/notifications/notification-bell';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CURRENT_WEEK, HORIZON_WEEKS, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { useUiStore } from '@/stores/ui';

/**
 * The top bar, restyled to the reference look (2026-09-08): a pill search field as
 * the centre of gravity, circular icon buttons, and no bottom border.
 *
 * The bar is 64px and sits on a white surface with a hairline border under it. It no
 * longer needs to recede into the canvas: the petrol rail beside it now carries the
 * "this is chrome" signal on its own, and a light bar against a dark rail gives the
 * top-left corner the contrast the reference has. Its controls are therefore sunken
 * canvas-coloured wells rather than raised white pills.
 *
 * The separators that used to divide the right-hand controls are gone. Circular
 * buttons on a plain ground already read as discrete objects, and vertical rules
 * between them added a second, competing grouping signal.
 */
export function AppHeader(): React.JSX.Element {
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const collapsed = useUiStore((s) => s.sidebarCollapsed);

  return (
    <header className="flex h-header shrink-0 items-center gap-s3 border-b border-border bg-surface px-s4">
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleSidebar}
        aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        aria-pressed={collapsed}
        className="rounded-pill"
      >
        <PanelLeft />
      </Button>

      {/* The wordmark moved into the rail's identity block — showing it twice made
          the top-left corner read as two competing headers. */}
      <span className="hidden text-h2 tracking-tight text-text sm:inline">
        RPD Web Application
      </span>

      <GlobalSearch />

      <div className="ml-auto flex items-center gap-s2">
        <WeekIndicator />
        <NotificationBell />
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * Global search.
 *
 * Presentational for now — it is wired to nothing, and deliberately so: a search box
 * that accepts a query and silently returns nothing is worse than no search box,
 * because the user concludes the data is missing rather than that the feature is.
 * It is `disabled` with an honest placeholder until the search endpoint lands, which
 * also keeps it out of the tab order rather than offering a dead stop.
 */
function GlobalSearch(): React.JSX.Element {
  return (
    <div className="relative ml-s4 hidden max-w-md flex-1 md:block">
      <Search
        className="pointer-events-none absolute left-s3 top-1/2 size-4 -translate-y-1/2 text-text-subtle"
        aria-hidden="true"
      />
      <input
        type="search"
        disabled
        aria-label="Search projects (not yet available)"
        placeholder="Search projects…"
        className="h-10 w-full rounded-pill border border-border bg-canvas pl-9 pr-s3 text-body text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed"
      />
    </div>
  );
}

/**
 * The planning week, always visible.
 *
 * Every date in this application is a week index, not a calendar date — the
 * scheduler assigns steps to weeks, the Gantt axis is weeks, "within year" means
 * "completes by W52". A user reading "W31" in a table has to hold the current week
 * in their head to know whether that is past or future, and they will get it wrong.
 * Pinning it to the header makes every relative week judgement on every surface a
 * glance instead of a calculation.
 *
 * Values come from src/lib/domain-constants.ts (DOMAIN_RULES.md horizon constants),
 * not from the wall clock — the planning week is a property of the active schedule
 * run, and must never silently disagree with the data on screen.
 */
function WeekIndicator(): React.JSX.Element {
  const remaining = WITHIN_YEAR_WEEK - CURRENT_WEEK;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <div className="hidden items-center gap-s2 rounded-pill border border-border bg-canvas px-s3 py-1.5 lg:flex">
          <CalendarClock className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
          <span className="font-mono text-2xs font-semibold tabular-nums text-text">
            {formatWeek(CURRENT_WEEK)}
          </span>
          <span className="text-2xs text-text-subtle">
            {remaining > 0 ? `${remaining} to W${WITHIN_YEAR_WEEK}` : 'past W52'}
          </span>
        </div>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Planning week {CURRENT_WEEK} of a {HORIZON_WEEKS}-week horizon. Projects completing by week{' '}
        {WITHIN_YEAR_WEEK} count as within-year.
      </TooltipContent>
    </Tooltip>
  );
}
