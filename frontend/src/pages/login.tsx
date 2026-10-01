import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { FlaskConical, LogIn, ShieldCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Component as GlowPage } from '@/components/ui/background-components';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { setDevUserEmail } from '@/lib/api/dev-user';
import { fetchDevUsers, type DevUser } from '@/lib/api/session';
import { queryKeys } from '@/lib/query-keys';
import { useSessionStore } from '@/stores/session';
import { ROLE_NAMES, type RoleName } from '@/types/enums';

import { buildAuthorizeUrl, getOidcConfig } from './login-sso';

/**
 * `/login` (ADR 0013) — the front door. Rendered by the router BEFORE the app
 * shell's `<SessionGate>` ever attempts `GET /me` for the shell itself: there
 * is no silent fallback identity, in dev mode or otherwise.
 *
 * Detecting dev mode WITHOUT ever "signing in" as a silent default identity:
 * this page calls `GET /me/dev-users` directly (not `/me`). That endpoint is
 * 404 outside dev mode and the seeded list otherwise (`session-gate.tsx`'s
 * sibling mechanism, `dev-role-switcher.tsx` — reused verbatim here via the
 * same `fetchDevUsers`/`setDevUserEmail`). Landing here never establishes a
 * session by itself; only picking a user (dev path) or completing SSO (prod
 * path) does.
 */
const SUPER_ADMIN: RoleName = 'Super Admin';
/** Super Admin's group renders first (ADR 0013 §3: "the obvious first
 *  action for anyone starting fresh"); the rest keep `ROLE_NAMES` order. */
const GROUP_ORDER: RoleName[] = [SUPER_ADMIN, ...ROLE_NAMES.filter((r) => r !== SUPER_ADMIN)];

function groupByRole(users: DevUser[]): { role: RoleName; users: DevUser[] }[] {
  return GROUP_ORDER.map((role) => ({
    role,
    users: users.filter((u) => u.roles.includes(role)),
  })).filter((g) => g.users.length > 0);
}

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const status = useSessionStore((s) => s.status);
  const load = useSessionStore((s) => s.load);
  const [switching, setSwitching] = React.useState<string | null>(null);

  // Already signed in (e.g. a bookmark to /login, or back-navigation after a
  // dev pick) — go straight to the app rather than showing the picker again.
  React.useEffect(() => {
    if (status === 'ready') navigate('/', { replace: true });
  }, [status, navigate]);

  const devUsers = useQuery({
    queryKey: queryKeys.devUsers(),
    queryFn: ({ signal }) => fetchDevUsers({ signal }),
    retry: false,
  });

  React.useEffect(() => {
    document.title = 'Sign in — RPD';
  }, []);

  if (status === 'ready') return <></>;

  const handlePick = async (email: string) => {
    setSwitching(email);
    try {
      setDevUserEmail(email);
      await load();
      navigate('/', { replace: true });
    } finally {
      setSwitching(null);
    }
  };

  // `/me/dev-users` 404s outside dev mode (`api/routers/me.py`); any other
  // failure (network, 5xx) also falls back to the production path — a
  // seeded-user picker must never appear because a request merely failed.
  const isDevMode = devUsers.isSuccess;
  const devUsersFailed = devUsers.isError && !(devUsers.error instanceof ApiError && devUsers.error.status === 404);

  return (
    <GlowPage className="grid place-items-center p-s6">
      <div className="w-full max-w-md space-y-s4">
        <div className="space-y-1 text-center">
          <h1 className="text-lg font-semibold text-text">Sign in to RPD</h1>
          <p className="text-xs text-text-muted">
            Frigoglass R&amp;D and Product Development portfolio planning.
          </p>
        </div>

        {devUsers.isPending ? (
          <Card>
            <CardContent className="space-y-2 pt-s4">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </CardContent>
          </Card>
        ) : isDevMode ? (
          <DevPicker
            groups={groupByRole(devUsers.data ?? [])}
            switching={switching}
            onPick={(email) => void handlePick(email)}
          />
        ) : (
          <SsoCard failedProbe={devUsersFailed} />
        )}
      </div>
    </GlowPage>
  );
}

function DevPicker({
  groups,
  switching,
  onPick,
}: {
  groups: { role: RoleName; users: DevUser[] }[];
  switching: string | null;
  onPick: (email: string) => void;
}): React.JSX.Element {
  return (
    <Card data-testid="login-dev-picker">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm">
          <FlaskConical className="size-4 text-warning-subtle-fg" aria-hidden="true" />
          Development sign-in
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-s4">
        <p className="text-2xs text-text-muted">
          This environment runs with <code>RPD_DEV_MODE</code> on. Pick a seeded user to act as —
          there is no password.
        </p>
        {groups.map((group) => (
          <fieldset key={group.role} className="space-y-1.5">
            <legend className="flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wide text-text-muted">
              {group.role}
              {group.role === 'Super Admin' ? <Badge tone="primary">Start here</Badge> : null}
            </legend>
            <div className="space-y-1">
              {group.users.map((u) => (
                <Button
                  key={u.email}
                  type="button"
                  variant={group.role === 'Super Admin' ? 'primary' : 'secondary'}
                  className="w-full justify-start"
                  disabled={switching !== null}
                  onClick={() => onPick(u.email)}
                >
                  {switching === u.email ? 'Signing in…' : `${u.full_name} — ${u.email}`}
                </Button>
              ))}
            </div>
          </fieldset>
        ))}
      </CardContent>
    </Card>
  );
}

function SsoCard({ failedProbe }: { failedProbe: boolean }): React.JSX.Element {
  const config = getOidcConfig();

  const handleSignIn = () => {
    if (!config) return;
    const state = crypto.randomUUID();
    const redirectUri = `${window.location.origin}/login`;
    window.location.assign(buildAuthorizeUrl(config, redirectUri, state));
  };

  return (
    <Card data-testid="login-sso-card">
      <CardContent className="space-y-s3 pt-s4">
        <Button type="button" className="w-full" disabled={!config} onClick={handleSignIn}>
          <LogIn />
          Sign in with SSO
        </Button>
        {!config ? (
          <p className="flex items-start gap-1.5 text-2xs text-text-muted">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
            Single sign-on is not configured for this environment yet. Contact your RPD
            administrator.
          </p>
        ) : null}
        {failedProbe ? (
          <p role="status" className="text-2xs text-text-subtle">
            Could not reach the server to check for a development sign-in option — showing the
            standard sign-in.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
