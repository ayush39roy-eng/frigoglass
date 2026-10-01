import * as React from 'react';
import { Navigate } from 'react-router-dom';

import { ErrorState } from '@/components/shared/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { getDevUserEmail } from '@/lib/api/dev-user';
import { useSessionStore } from '@/stores/session';

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
 */
export function SessionGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const status = useSessionStore((s) => s.status);
  const errorKind = useSessionStore((s) => s.errorKind);
  const load = useSessionStore((s) => s.load);
  const me = useSessionStore((s) => s.me);

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
              ? 'The API is unreachable. Check your connection and try again.'
              : 'The server did not return a valid session. Try again, or contact your RPD administrator.'
          }
          onRetry={() => void load()}
        />
      </div>
    );
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
