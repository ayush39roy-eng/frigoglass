import * as React from 'react';
import { Building2, CalendarClock, ChevronDown, LogOut, UserCog } from 'lucide-react';
import { Link } from 'react-router-dom';

import { NotificationBell } from '@/components/notifications/notification-bell';
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
import { useHubs } from '@/lib/api/reference';
import { CURRENT_WEEK, HORIZON_WEEKS, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
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

      <div className="ml-auto flex items-center gap-s3">
        <div className="hidden items-center gap-1 rounded-pill border-[1.5px] border-border bg-shell p-1 lg:flex">
          <HubScopePill />
          <Divider />
          <WeekPill />
          <Divider />
          <NotificationBell />
          <ThemeToggle />
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
        className="grid size-10 shrink-0 place-items-center rounded-xl text-base font-extrabold text-primary-fg shadow-feature"
        style={{ backgroundImage: 'linear-gradient(135deg, hsl(var(--blue-700)), hsl(var(--blue-400)))' }}
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

function HubScopePill(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubsQuery = useHubs();

  const scopeLabel = React.useMemo(() => {
    if (!me) return 'All hubs';
    if (me.hub_scope_all) return 'All hubs';
    if (me.hub_ids.length === 0) return 'No hubs';
    const names: string[] = [];
    for (const id of me.hub_ids) {
      const name = hubsQuery.data?.find((h) => h.id === id)?.name;
      if (name) names.push(name);
    }
    if (names.length === me.hub_ids.length) return names.join(', ');
    return `${String(me.hub_ids.length)} ${me.hub_ids.length === 1 ? 'hub' : 'hubs'}`;
  }, [me, hubsQuery.data]);

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex max-w-40 items-center gap-1.5 rounded-pill px-s3 py-1.5 text-2xs font-medium text-text-muted"
          data-testid="hub-scope"
        >
          <Building2 className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="truncate">{scopeLabel}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">Your hub scope: {scopeLabel}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The planning week indicator (W31).
 */
function WeekPill(): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex items-center gap-1.5 whitespace-nowrap rounded-pill px-s3 py-1.5 text-2xs font-semibold text-text"
          data-testid="week-indicator"
        >
          <CalendarClock className="size-3.5 shrink-0 text-text-subtle" aria-hidden="true" />
          <span>{formatWeek(CURRENT_WEEK)}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        Planning week {CURRENT_WEEK} of a {HORIZON_WEEKS}-week horizon. Projects completing by week{' '}
        {WITHIN_YEAR_WEEK} count as within-year.
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

