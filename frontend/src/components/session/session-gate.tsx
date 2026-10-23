import * as React from 'react';
import { Navigate } from 'react-router-dom';
import { RefreshCw, Server } from 'lucide-react';

import { ErrorState } from '@/components/shared/error-state';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { getDevUserEmail } from '@/lib/api/dev-user';
import { useSessionStore, type SessionWaking } from '@/stores/session';

/**
 * Boot gate (ADR 0010 §2): nothing under the app shell renders until `GET /me`
 * has resolved, because the sidebar, every route guard and every write
 * control read the permission table synchronously. Rendering the shell first
 * and hiding nav items a moment later would flash surfaces the user cannot
 * open.
 *
 * Skeleton, not a spinner (rpd-visual-bar SKILL): the placeholder is shaped
 * like the shell it precedes.
 *
 * ADR 0013 §1/§5: an `unauthorized` `/me` redirects to `/login` instead of
 * the old "Sign in to continue" / "Try again" dead end — retrying a request
 * with no auth was never going to succeed without an actual sign-in action.
 *
 * P31-R01: while the store retries a transient `/me` failure (the API waking
 * from an idle nap), show a calm "Waking up the server…" panel with the time
 * waited and a "Retry now" button. The error card appears only once the
 * store's retry budget is spent.
 */
export function SessionGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const status = useSessionStore((s) => s.status);
  const errorKind = useSessionStore((s) => s.errorKind);
  const load = useSessionStore((s) => s.load);
  const me = useSessionStore((s) => s.me);
  const waking = useSessionStore((s) => s.waking);
  const retryNow = useSessionStore((s) => s.retryNow);

  React.useEffect(() => {
    if (status === 'idle') void load();
  }, [status, load]);

  if (status === 'ready') {
    // Test-login sign-in (2026-10-01): a dev-mode backend would otherwise run
    // every request as the default seeded Admin, so the app never asked anyone
    // to sign in. In dev mode, require an explicit sign-in first.
    if (me?.dev_mode && getDevUserEmail() === null) return <Navigate to="/login" replace />;
    return <>{children}</>;
  }

  if (status === 'error') {
    if (errorKind === 'unauthorized') {
      return <Navigate to="/login" replace />;
    }
    return (
      <div className="grid h-full place-items-center p-s6">
        <ErrorState
          title="Could not load your session"
          description={
            errorKind === 'network'
              ? 'The server did not respond after about 90 seconds. It may still be starting up, or your connection may be down. Try again in a moment.'
              : 'The server did not return a valid session. Try again, or contact your RPD administrator.'
          }
          onRetry={() => void load()}
        />
      </div>
    );
  }

  if (status === 'loading' && waking) {
    return <WakingUp waking={waking} onRetryNow={retryNow} />;
  }

  return (
    <div
      className="flex h-full"
      role="status"
      aria-live="polite"
      aria-label="Signing you in"
      data-testid="session-gate-loading"
    >
      {/* Matches the Boltshift rail's one, permanent width (app-sidebar.tsx) —
          2026-10-01: the rail is no longer petrol, so this placeholder now
          reuses `bg-surface`, the same token the real rail renders on. */}
      <div
        className="hidden w-sidebar-collapsed shrink-0 rounded-rail border border-border bg-surface sm:block"
        aria-hidden="true"
      />
      <div className="flex-1 space-y-s4 p-gutter" aria-hidden="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-96" />
        <div className="grid gap-s4 sm:grid-cols-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
          <Skeleton className="h-24" />
        </div>
        <Skeleton className="h-64" />
      </div>
      <span className="sr-only">Signing you in…</span>
    </div>
  );
}

/** Seconds since `since`, re-rendered once a second. */
function useElapsedSeconds(since: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(id);
  }, []);
  return Math.max(0, Math.floor((now - since) / 1_000));
}

function WakingUp({ waking, onRetryNow }: { waking: SessionWaking; onRetryNow: () => void }): React.JSX.Element {
  const elapsed = useElapsedSeconds(waking.since);
  return (
    <div className="grid h-full place-items-center p-s6" data-testid="session-gate-waking">
      <div
        role="status"
        aria-live="polite"
        className="flex max-w-sm flex-col items-center gap-3 rounded-card border border-border bg-surface px-6 py-10 text-center shadow-card"
      >
        <Server className="size-8 text-primary motion-safe:animate-pulse" aria-hidden="true" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-text">Waking up the server…</p>
          <p className="text-xs text-text-muted">
            The RPD server was idle and is starting up. This usually takes under a minute; you will
            not need to sign in again.
          </p>
        </div>
        <p className="font-mono text-xs tabular-nums text-text-subtle" data-testid="session-gate-elapsed">
          Waiting {elapsed} s
        </p>
        <Button variant="secondary" size="sm" onClick={onRetryNow}>
          <RefreshCw />
          Retry now
        </Button>
      </div>
    </div>
  );
}
