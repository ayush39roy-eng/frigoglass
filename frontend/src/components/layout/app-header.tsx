import * as React from 'react';
import { CalendarClock, ChevronDown, LogOut, UserCog } from 'lucide-react';
import { Link } from 'react-router-dom';

import { NotificationBell } from '@/components/notifications/notification-bell';
import { HubFilterSelect } from '@/components/shared/hub-filter/hub-filter-select';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UserAvatar } from '@/components/session/user-avatar';
import { useSignOut } from '@/lib/auth/use-sign-out';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  CURRENT_WEEK,
  DISPLAY_HORIZON_WEEKS,
  SPILLOVER_YEAR,
  WITHIN_YEAR_WEEK,
} from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { useSessionStore } from '@/stores/session';

/**
 * TopNav — Boltshift spec §4: "minimal. Left: blue circular logo chip (gradient) +
 * wordmark. Right: grouped pill holding icon buttons + avatar/name stack. No
 * breadcrumbs, no search bar here."
 */
export function AppHeader(): React.JSX.Element {
  return (
    <header className="mx-s4 mt-s4 flex h-header shrink-0 items-center gap-s4 rounded-dash border-[1.5px] border-border bg-surface px-s5 shadow-card">
      <LogoChip />

      <div className="ml-auto flex min-w-0 items-center gap-s3">
        {/* The global hub filter (ADR 0020) stays visible at every width; the
            week, notifications and theme join it from `lg` up. */}
        <div className="flex min-w-0 items-center gap-1 rounded-pill border-[1.5px] border-border bg-shell p-1">
          <HubFilterSelect />
          <span className="hidden items-center gap-1 lg:flex">
            <Divider />
            <WeekPill />
            <Divider />
            <NotificationBell />
            <ThemeToggle />
          </span>
        </div>

        <IdentityStack />
      </div>
    </header>
  );
}

function Divider(): React.JSX.Element {
  return <span aria-hidden="true" className="h-5 w-px bg-border" />;
}

/** Boltshift spec §4: "blue circular logo chip (gradient) + wordmark 18px/700." */
function LogoChip(): React.JSX.Element {
  return (
    <div className="flex items-center gap-s3">
      <span
        className="grid size-10 shrink-0 place-items-center rounded-xl text-base font-extrabold text-on-feature shadow-feature"
        // The theme's feature gradient: Frigoglass blue in light mode, lime in graphite dark.
        style={{ backgroundImage: 'var(--gradient-dash-primary)' }}
        aria-hidden="true"
      >
        R
      </span>
      <span className="hidden leading-tight sm:block">
        <span className="block font-display text-lg font-extrabold tracking-tight text-text">
          RPD Portfolio
        </span>
        <span className="block text-2xs font-semibold uppercase tracking-wider text-text-subtle">
          Frigoglass · R&amp;D Planning
        </span>
      </span>
    </div>
  );
}

/** Today's date for the header ("18 Oct 2026"), from the browser clock. */
function formatToday(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
}

/**
 * The planning week indicator, P13-T15 (API_CONTRACT_P13 §7; mock-up "Week 31 |
 * 21 Wks Left" + date): "Week 42 · 10 wks left" from the SERVED
 * `GET /me` `current_week` / `weeks_left_in_year` (52-week year, ADR 0024) —
 * the header never subtracts. Before `/me` resolves it falls back to the
 * build-time `CURRENT_WEEK` and the old "of 52" framing.
 */
export function WeekPill(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const week = me?.current_week ?? CURRENT_WEEK;
  const weeksLeft = me?.weeks_left_in_year;
  const today = React.useMemo(() => new Date(), []);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-s3 py-1.5 text-2xs font-semibold text-text"
          data-testid="week-indicator"
        >
          <CalendarClock className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
          {weeksLeft === undefined ? (
            <span>
              {formatWeek(week)}
              <span className="font-medium text-text-muted"> of {DISPLAY_HORIZON_WEEKS}</span>
            </span>
          ) : (
            <span>
              Week {week}
              <span className="font-medium text-text-muted">
                {' · '}
                {weeksLeft} {weeksLeft === 1 ? 'wk' : 'wks'} left
              </span>
            </span>
          )}
          <span aria-hidden="true" className="h-3.5 w-px bg-border" />
          <time
            dateTime={today.toISOString().slice(0, 10)}
            className="tnum font-medium text-text-muted"
            data-testid="header-today"
          >
            {formatToday(today)}
          </time>
        </span>
      </TooltipTrigger>
      {/* Client ask 2026-10-13: a 52-week year only — the server's internal
          78-week search horizon is never presented. */}
      <TooltipContent side="bottom" data-testid="week-indicator-tooltip">
        Planning week {week} of {DISPLAY_HORIZON_WEEKS}
        {weeksLeft === undefined ? '' : `, ${String(weeksLeft)} left in the year`}. Projects completing by
        week {WITHIN_YEAR_WEEK} count as within-year; anything not done by then is spillover into{' '}
        {SPILLOVER_YEAR}.
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Identity: avatar + name opens the account menu (Profile & settings, Sign
 * out). The standalone sign-out icon stays beside it. Both now actually sign
 * out (`lib/auth/use-sign-out.ts`); before 2026-10-01 the button had no handler.
 */
function IdentityStack(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const signOut = useSignOut();

  return (
    <div className="flex items-center gap-s2 border-l border-border pl-s3">
      <DropdownMenu>
        <DropdownMenuTrigger
          className="flex items-center gap-s2 rounded-pill py-1 pl-1 pr-s2 text-left transition-colors hover:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-label="Account menu"
        >
          <UserAvatar email={me?.email} name={me?.full_name} />
          <span className="hidden min-w-0 lg:block">
            <span
              className="block max-w-32 truncate text-body font-semibold text-text"
              title={me?.email}
              data-testid="session-identity"
            >
              {me?.full_name ?? 'Frigoglass'}
            </span>
            <span className="block max-w-32 truncate text-2xs text-text-subtle">
              {me && me.roles.length > 0 ? me.roles.join(' · ') : 'R&D Portfolio'}
            </span>
          </span>
          <ChevronDown className="hidden size-4 text-text-subtle lg:block" aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64">
          <div className="flex items-center gap-s3 px-2 py-2">
            <UserAvatar email={me?.email} name={me?.full_name} className="size-10" />
            <span className="min-w-0">
              <span className="block truncate text-sm font-bold text-text">{me?.full_name}</span>
              <span className="block truncate text-xs text-text-subtle">{me?.email}</span>
            </span>
          </div>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild className="gap-s3">
            <Link to="/profile">
              <UserCog className="size-4" aria-hidden="true" />
              Profile &amp; settings
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="gap-s3 text-danger focus:text-danger" onSelect={signOut}>
            <LogOut className="size-4" aria-hidden="true" />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="ghost" size="icon" aria-label="Sign out" className="rounded-full" onClick={signOut}>
        <LogOut />
      </Button>
    </div>
  );
}

