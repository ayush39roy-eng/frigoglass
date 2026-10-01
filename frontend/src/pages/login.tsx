import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  CalendarRange,
  Check,
  Copy,
  Eye,
  EyeOff,
  FlaskConical,
  KeyRound,
  Layers,
  LogIn,
  Mail,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';

import { CoolerIllustration } from '@/components/brand/cooler-illustration';
import { initialsOf } from '@/lib/initials';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { fetchDevUsers, type DevUser } from '@/lib/api/session';
import { pickTestAccounts, TEST_LOGIN_PASSWORD, verifyTestLogin } from '@/lib/auth/test-logins';
import { useMotionTokens } from '@/lib/motion';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import { resolveStartPage, usePreferencesStore } from '@/stores/preferences';
import { useSessionStore } from '@/stores/session';
import { ROLE_NAMES, type RoleName } from '@/types/enums';

import { buildAuthorizeUrl, getOidcConfig } from './login-sso';

/**
 * Sign-in (2026-10-01 redesign). Two paths, decided by the server:
 *
 *  - DEV MODE (`GET /me/dev-users` answers): an email + password form checked
 *    against the seeded users and the shared test password
 *    (`lib/auth/test-logins.ts`), plus a "Test logins" panel listing one account
 *    per role. See that module for why this is a demo convention, not security.
 *  - PRODUCTION (the probe 404s or fails): the OIDC "Sign in with SSO" card.
 *
 * Left half: brand panel with the bundled cooler illustration (no external image).
 */

const SUPER_ADMIN: RoleName = 'Super Admin';
const ROLE_ORDER: RoleName[] = [SUPER_ADMIN, ...ROLE_NAMES.filter((r) => r !== SUPER_ADMIN)];

export default function LoginPage(): React.JSX.Element {
  const navigate = useNavigate();
  const status = useSessionStore((s) => s.status);
  const me = useSessionStore((s) => s.me);
  const load = useSessionStore((s) => s.load);
  const startPage = usePreferencesStore((s) => s.startPage);

  // Already signed in (and, in dev mode, explicitly so) → straight into the app.
  const signedIn = status === 'ready' && (!me?.dev_mode || getDevUserEmail() !== null);
  React.useEffect(() => {
    if (signedIn) navigate(resolveStartPage(me, startPage), { replace: true });
  }, [signedIn, navigate, startPage, me]);

  const devUsers = useQuery({
    queryKey: queryKeys.devUsers(),
    queryFn: ({ signal }) => fetchDevUsers({ signal }),
    retry: false,
  });

  React.useEffect(() => {
    document.title = 'Sign in — RPD';
  }, []);

  if (signedIn) return <></>;

  const handleSignIn = async (email: string, remember: boolean): Promise<void> => {
    setDevUserEmail(email, { remember });
    await load();
    navigate(resolveStartPage(useSessionStore.getState().me, startPage), { replace: true });
  };

  const isDevMode = devUsers.isSuccess;
  const devUsersFailed = devUsers.isError && !(devUsers.error instanceof ApiError && devUsers.error.status === 404);

  return (
    <div className="min-h-screen bg-canvas p-s4 lg:p-s6">
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

            {devUsers.isPending ? (
              <div className="space-y-3 rounded-card border-2 border-border-strong/60 bg-surface p-card">
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            ) : isDevMode ? (
              <TestLoginForm users={devUsers.data ?? []} onSignIn={handleSignIn} />
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
  { icon: CalendarRange, label: '78-week resource-constrained schedule' },
  { icon: Layers, label: '14 workflow steps across 6 hubs' },
  { icon: Sparkles, label: 'Within-year delivery at a glance' },
];

function BrandPanel(): React.JSX.Element {
  const { reduced } = useMotionTokens();
  return (
    <aside
      className="relative hidden overflow-hidden rounded-[2rem] p-s8 text-white shadow-feature lg:sticky lg:top-6 lg:flex lg:h-[calc(100vh-3rem)] lg:flex-col"
      style={{ backgroundImage: 'var(--gradient-dash-primary)' }}
    >
      <span aria-hidden="true" className="bg-dots pointer-events-none absolute inset-0 text-white/[0.12]" />
      <span aria-hidden="true" className="pointer-events-none absolute -right-24 -top-24 size-96 rounded-full bg-white/10 blur-3xl" />

      <div className="relative space-y-s3">
        <p className="label-caps text-white/75">Frigoglass · RPD Portfolio</p>
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
              className="flex items-center gap-s3 rounded-2xl border border-white/25 bg-white/15 px-s4 py-s3 text-sm font-semibold backdrop-blur"
              {...(reduced
                ? {}
                : {
                    initial: { opacity: 0, x: 16 },
                    animate: { opacity: 1, x: 0 },
                    transition: { delay: 0.25 + i * 0.12, type: 'spring', stiffness: 200, damping: 22 },
                  })}
            >
              <span className="grid size-8 place-items-center rounded-xl bg-white text-primary">
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
  users,
  onSignIn,
}: {
  users: DevUser[];
  onSignIn: (email: string, remember: boolean) => Promise<void>;
}): React.JSX.Element {
  const [email, setEmail] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [showPassword, setShowPassword] = React.useState(false);
  const [remember, setRemember] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const accounts = React.useMemo(() => pickTestAccounts(users, ROLE_ORDER), [users]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const result = verifyTestLogin(email, password, users);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSignIn(result.user.email, remember);
    } finally {
      setSubmitting(false);
    }
  };

  const fill = (account: DevUser) => {
    setEmail(account.email);
    setPassword(TEST_LOGIN_PASSWORD);
    setError(null);
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
          <Label htmlFor="login-email" className="text-sm font-bold">
            Email
          </Label>
          <div className="relative">
            <Mail className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-text-subtle" aria-hidden="true" />
            <Input
              id="login-email"
              type="email"
              autoComplete="username"
              placeholder="name@example.com"
              className="h-11 pl-9"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
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

        <label className="flex cursor-pointer items-center gap-2 text-sm font-medium text-text-muted">
          <Checkbox checked={remember} onCheckedChange={(v) => setRemember(v === true)} aria-label="Remember me" />
          Remember me on this browser
        </label>

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

      <TestLoginsPanel accounts={accounts} onPick={fill} />
    </div>
  );
}

function TestLoginsPanel({
  accounts,
  onPick,
}: {
  accounts: DevUser[];
  onPick: (account: DevUser) => void;
}): React.JSX.Element {
  const [copied, setCopied] = React.useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(TEST_LOGIN_PASSWORD).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <section
      aria-labelledby="test-logins-heading"
      className="space-y-s3 rounded-card border-2 border-dashed border-warning/60 bg-warning-subtle/40 p-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-s2">
        <h2 id="test-logins-heading" className="flex items-center gap-2 text-sm font-extrabold text-text">
          <FlaskConical className="size-4 text-warning-subtle-fg" aria-hidden="true" />
          Test logins
        </h2>
        <button
          type="button"
          onClick={copy}
          className="inline-flex items-center gap-1.5 rounded-pill border-2 border-border bg-surface px-2.5 py-1 font-mono text-xs font-bold text-text hover:border-border-strong"
          aria-label={`Copy test password ${TEST_LOGIN_PASSWORD}`}
        >
          {copied ? <Check className="size-3.5 text-success" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          {TEST_LOGIN_PASSWORD}
        </button>
      </div>
      <p className="text-xs font-medium text-text-muted">
        This environment runs with <code>RPD_DEV_MODE</code> on. Every seeded user signs in with the
        password above. Pick an account to fill the form.
      </p>
      <ul className="space-y-1.5">
        {accounts.map((account) => {
          const role = account.roles[0] ?? 'User';
          return (
            <li key={account.email}>
              <button
                type="button"
                onClick={() => onPick(account)}
                className="flex w-full items-center gap-s3 rounded-xl border-2 border-transparent bg-surface px-s3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-primary-subtle/40"
                aria-label={`Use ${account.full_name} — ${account.email}`}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'grid size-9 shrink-0 place-items-center rounded-full text-2xs font-bold',
                    role === SUPER_ADMIN || role === 'Admin' ? 'bg-ink text-ink-fg' : 'bg-primary-subtle text-primary-subtle-fg',
                  )}
                >
                  {initialsOf(account.full_name)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-bold text-text">{account.full_name}</span>
                  <span className="block truncate text-xs text-text-subtle">{account.email}</span>
                </span>
                <Badge tone={role === SUPER_ADMIN ? 'primary' : 'neutral'}>{role}</Badge>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
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
