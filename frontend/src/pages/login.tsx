import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useLocation, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  CalendarRange,
  Clock,
  Eye,
  EyeOff,
  KeyRound,
  Layers,
  LogIn,
  ShieldCheck,
  Sparkles,
  UserRound,
} from 'lucide-react';

import { CoolerIllustration } from '@/components/brand/cooler-illustration';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { devLogin, fetchDevUsers } from '@/lib/api/session';
import { IDLE_SIGNED_OUT_NOTICE, writeSharedLastActivity } from '@/lib/auth/idle';
import { devLoginErrorMessage, loginFormError } from '@/lib/auth/test-logins';
import type { LoginLocationState } from '@/lib/auth/use-sign-out';
import { browserNavigation } from '@/lib/browser-navigation';
import { useMotionTokens } from '@/lib/motion';
import { queryKeys } from '@/lib/query-keys';
import { resolveStartPage, usePreferencesStore } from '@/stores/preferences';
import { useSessionStore } from '@/stores/session';

import { buildAuthorizeUrl, getOidcConfig } from './login-sso';

/**
 * Sign-in (2026-10-01 redesign). Two paths, decided by the server:
 *
 *  - DEV MODE (`GET /me/dev-users` answers): a username-or-email + password
 *    form checked by the server (`POST /me/dev-login`, P46 / ADR 0058). The
 *    probe only decides that dev mode is on; its users are never rendered here
 *    (owner, 2026-11-18: no accounts shown on the login page). See
 *    `lib/auth/test-logins.ts` for why this is a demo convention, not security.
 *  - PRODUCTION (the probe 404s or fails): the OIDC "Sign in with SSO" card.
 *
 * Left half: brand panel with the bundled cooler illustration (no external image).
 *
 * ADR 0060 (P49): no "Remember me" — the session lives in this browser
 * session only. Sign-in ends with a full page load, so whoever signs in runs
 * the newest deployed bundle. After an idle sign-out the page shows the
 * inactivity notice. There is no idle timer on this page.
 */

const GATEWAY_STATUSES = new Set([502, 503, 504]);

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const location = useLocation();
  const idleNotice = (location.state as LoginLocationState | null)?.signedOut === 'idle';
  // Set while the sign-in's full page load is under way, so the SPA redirect below stays out of its way.
  const leavingRef = React.useRef(false);
  const status = useSessionStore((s) => s.status);
  const me = useSessionStore((s) => s.me);
  const load = useSessionStore((s) => s.load);
  const startPage = usePreferencesStore((s) => s.startPage);

  // Already signed in (and, in dev mode, explicitly so) → straight into the app.
  const signedIn = status === 'ready' && (!me?.dev_mode || getDevUserEmail() !== null);
  React.useEffect(() => {
    if (signedIn && !leavingRef.current) navigate(resolveStartPage(me, startPage), { replace: true });
  }, [signedIn, navigate, startPage, me]);

  const devUsers = useQuery({
    queryKey: queryKeys.devUsers(),
    queryFn: ({ signal }) => fetchDevUsers({ signal }),
    // A 404 means production (SSO) and is final. P31-R01: a 502/503/504 is the
    // API waking from an idle nap, so wait it out instead of falling back to
    // the SSO card in a dev-mode deployment.
    retry: (failureCount, error) =>
      error instanceof ApiError && GATEWAY_STATUSES.has(error.status) && failureCount < 6,
    retryDelay: (attempt) => Math.min(1_000 * 2 ** attempt, 15_000),
  });

  React.useEffect(() => {
    document.title = 'Sign in — RPD';
  }, []);

  if (signedIn) return <></>;

  const handleSignIn = async (email: string): Promise<void> => {
    leavingRef.current = true;
    setDevUserEmail(email);
    // ADR 0060 L2: signing in is activity, so a stale shared time cannot sign the new session out.
    writeSharedLastActivity(Date.now());
    await load();
    // ADR 0060: a full page load, so the newest deployed version runs.
    browserNavigation.assign(resolveStartPage(useSessionStore.getState().me, startPage));
  };

  const isDevMode = devUsers.isSuccess;
  const devUsersFailed = devUsers.isError && !(devUsers.error instanceof ApiError && devUsers.error.status === 404);

  return (
    <div className="h-full overflow-y-auto overscroll-contain bg-canvas p-s4 lg:p-s6">
      <div className="mx-auto grid min-h-[calc(100vh-3rem)] max-w-7xl items-start gap-s6 lg:grid-cols-[1.05fr_1fr]">
        <BrandPanel />
        <main className="flex items-center justify-center py-s6">
          <div className="w-full max-w-md space-y-s6">
            <div className="space-y-2">
              <span className="grid size-12 place-items-center rounded-2xl bg-primary text-lg font-extrabold text-primary-fg shadow-feature">
                R
              </span>
              <h1 className="font-display text-page text-text">Welcome back</h1>
              <p className="text-sm font-medium text-text-muted">
                Sign in to the Frigoglass R&amp;D and Product Development portfolio planner.
              </p>
            </div>

            {idleNotice ? (
              <p
                role="status"
                data-testid="login-idle-notice"
                className="flex items-start gap-2 rounded-xl bg-warning-subtle px-s3 py-s2 text-sm font-medium text-warning-subtle-fg"
              >
                <Clock className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                {IDLE_SIGNED_OUT_NOTICE}
              </p>
            ) : null}

            {devUsers.isPending ? (
              <div className="space-y-3 rounded-card border-2 border-border-strong/60 bg-surface p-card">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : isDevMode ? (
              <TestLoginForm onSignIn={handleSignIn} />
            ) : (
              <SsoCard failedProbe={devUsersFailed} />
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const HIGHLIGHTS = [
  { icon: CalendarRange, label: '52-week resource-constrained plan year' },
  { icon: Layers, label: '14 workflow steps across 6 hubs' },
  { icon: Sparkles, label: 'Within-year delivery at a glance' },
];

function BrandPanel(): React.JSX.Element {
  const { reduced } = useMotionTokens();
  return (
    <aside
      className="relative hidden overflow-hidden rounded-[2rem] p-s8 text-on-feature shadow-feature lg:sticky lg:top-6 lg:flex lg:h-[calc(100vh-3rem)] lg:flex-col"
      style={{ backgroundImage: 'var(--gradient-dash-primary)' }}
    >
      <span aria-hidden="true" className="bg-dots pointer-events-none absolute inset-0 text-on-feature/[0.12]" />
      <span aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />

      <div className="relative space-y-s3">
        <p className="label-caps text-on-feature/75">Frigoglass · RPD Portfolio</p>
        <h2 className="max-w-md font-display text-4xl font-extrabold leading-tight tracking-tight">
          Plan the R&amp;D portfolio with confidence.
        </h2>
      </div>

      <div className="relative mt-s6 flex min-h-0 flex-1 items-center justify-center gap-s8">
        <motion.div
          className="w-52 shrink-0 xl:w-60 [&_svg]:max-h-[60vh]"
          {...(reduced
            ? {}
            : {
                initial: { opacity: 0, y: 24 },
                animate: { opacity: 1, y: 0 },
                transition: { type: 'spring', stiffness: 120, damping: 18 },
              })}
        >
          <CoolerIllustration />
        </motion.div>
        <ul className="space-y-s3">
          {HIGHLIGHTS.map((h, i) => (
            <motion.li
              key={h.label}
              className="flex items-center gap-s3 rounded-2xl border border-on-feature/20 bg-on-feature/10 px-s4 py-s3 text-sm font-semibold backdrop-blur"
              {...(reduced
                ? {}
                : {
                    initial: { opacity: 0, x: 16 },
                    animate: { opacity: 1, x: 0 },
                    transition: { delay: 0.25 + i * 0.12, type: 'spring', stiffness: 200, damping: 22 },
                  })}
            >
              <span className="grid size-8 place-items-center rounded-xl bg-surface text-text">
                <h.icon className="size-4" aria-hidden="true" />
              </span>
              {h.label}
            </motion.li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

function TestLoginForm({
  onSignIn,
}: {
  onSignIn: (email: string) => Promise<void>;
}): React.JSX.Element {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    const missing = loginFormError(username, password);
    if (missing) {
      setError(missing);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // P46 (ADR 0058 L1): the server checks the password; the browser never does.
      const user = await devLogin({ username: username.trim(), password });
      await onSignIn(user.email);
    } catch (err) {
      setError(devLoginErrorMessage(err));
    } finally {
      setSubmitting(false);
    }
  };


  return (
    <div className="space-y-s6" data-testid="login-dev-picker">
      <form
        onSubmit={(e) => void submit(e)}
        noValidate
        className="space-y-s4 rounded-card border-2 border-border-strong/60 bg-surface p-card shadow-card"
        aria-label="Sign in"
      >
        <div className="space-y-1.5">
          <Label htmlFor="login-username" className="text-sm font-bold">
            Username or email
          </Label>
          <div className="relative">
            <UserRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" aria-hidden="true" />
            <Input
              id="login-username"
              type="text"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              placeholder="Username or email"
              className="h-11 pl-9"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              aria-invalid={error !== null}
            />
          </div>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="login-password" className="text-sm font-bold">
            Password
          </Label>
          <div className="relative">
            <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" aria-hidden="true" />
            <Input
              id="login-password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              placeholder="••••••••"
              className="h-11 px-9"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={error !== null}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-text-muted hover:bg-surface-sunken hover:text-text"
              aria-label={showPassword ? 'Hide password' : 'Show password'}
            >
              {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="flex items-start gap-2 rounded-xl bg-danger-subtle px-s3 py-s2 text-sm font-medium text-danger-subtle-fg">
            <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            {error}
          </p>
        ) : null}

        <Button type="submit" className="h-11 w-full rounded-xl text-base font-bold shadow-feature" disabled={submitting}>
          <LogIn />
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function SsoCard({ failedProbe }: { failedProbe: boolean }): React.JSX.Element {
  const config = getOidcConfig();

  const handleSignIn = () => {
    if (!config) return;
    const state = crypto.randomUUID();
    const redirectUri = `${window.location.origin}/login`;
    window.location.assign(buildAuthorizeUrl(config, redirectUri, state));
  };

  return (
    <div
      className="space-y-s3 rounded-card border-2 border-border-strong/60 bg-surface p-card shadow-card"
      data-testid="login-sso-card"
    >
      <Button type="button" className="h-11 w-full rounded-xl text-base font-bold" disabled={!config} onClick={handleSignIn}>
        <LogIn />
        Sign in with SSO
      </Button>
      {!config ? (
        <p className="flex items-start gap-1.5 text-xs text-text-muted">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          Single sign-on is not configured for this environment yet. Contact your RPD administrator.
        </p>
      ) : null}
      {failedProbe ? (
        <p role="status" className="text-xs text-text-subtle">
          Could not reach the server to check for a development sign-in option — showing the
          standard sign-in.
        </p>
      ) : null}
    </div>
  );
}
