import * as React from 'react';
import {
  Building2,
  Camera,
  Eye,
  LogOut,
  Monitor,
  Moon,
  Palette,
  Pencil,
  ShieldCheck,
  SlidersHorizontal,
  Sun,
  Trash2,
  UserRound,
} from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { UserAvatar } from '@/components/session/user-avatar';
import { useTheme, type ThemePreference } from '@/components/theme/theme-context';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useHubs } from '@/lib/api/reference';
import { getDevUserEmail } from '@/lib/api/dev-user';
import { useSignOut } from '@/lib/auth/use-sign-out';
import { cn } from '@/lib/utils';
import { usePreferencesStore, type StartPage } from '@/stores/preferences';
import { useSessionStore } from '@/stores/session';
import { SURFACE_KEYS, type SurfaceKey } from '@/types/enums';

/**
 * Profile & settings (2026-10-01). Everything editable here is a per-browser
 * preference (`stores/preferences.ts`, theme via `ThemeProvider`); identity,
 * roles and permissions are read-only and come from `GET /me`. The profile
 * photo is downscaled in the browser and never uploaded to the server.
 */

const MAX_PHOTO_BYTES = 5 * 1024 * 1024;
const PHOTO_SIZE = 256;

const START_PAGES: { value: StartPage; label: string }[] = [
  { value: '/', label: 'Dashboard' },
  { value: '/capacity', label: 'RPD Capacity' },
  { value: '/matrix', label: 'Prioritization Matrix' },
  { value: '/timeline', label: 'Execution Timeline' },
  { value: '/register', label: 'Project Registration' },
  { value: '/planning', label: 'Capacity Planning' },
];

const SURFACE_LABEL: Record<SurfaceKey, string> = {
  dashboard: 'Dashboard',
  capacity: 'Capacity',
  matrix: 'Prioritization Matrix',
  gantt: 'Execution Timeline',
  project_workspace: 'Project Workspace',
  project_registration: 'Project Registration',
  capacity_planning: 'Capacity Planning',
  workflow_settings: 'Workflow Settings',
  audit_log: 'Audit Log',
  user_role_admin: 'User / Role Admin',
};

/** Read an image file, centre-crop it square and downscale to 256px JPEG. */
function toAvatarDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const side = Math.min(img.naturalWidth, img.naturalHeight);
      const canvas = document.createElement('canvas');
      canvas.width = PHOTO_SIZE;
      canvas.height = PHOTO_SIZE;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        URL.revokeObjectURL(url);
        reject(new Error('Canvas unavailable'));
        return;
      }
      ctx.drawImage(
        img,
        (img.naturalWidth - side) / 2,
        (img.naturalHeight - side) / 2,
        side,
        side,
        0,
        0,
        PHOTO_SIZE,
        PHOTO_SIZE,
      );
      URL.revokeObjectURL(url);
      resolve(canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Not a readable image'));
    };
    img.src = url;
  });
}

export default function ProfilePage(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const signOut = useSignOut();

  React.useEffect(() => {
    document.title = 'Profile & settings — RPD';
  }, []);

  if (!me) return <></>;

  return (
    <>
      <PageHeader
        eyebrow="Account"
        title="Profile & settings"
        description="Your identity, access and the preferences this browser remembers for you."
      />
      <div className="grid gap-gutter xl:grid-cols-[22rem_1fr]">
        <div className="space-y-gutter">
          <IdentityCard />
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-4 text-text-muted" aria-hidden="true" />
                Session
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-s3 text-sm">
              <Row label="Signed in with" value={me.dev_mode ? 'Test login (dev mode)' : 'Single sign-on'} />
              {me.dev_mode ? (
                <Row
                  label="Remembered"
                  value={safeLocalHas() ? 'Yes — on this browser' : 'This tab only'}
                />
              ) : null}
              <Button variant="danger" className="w-full rounded-xl font-bold" onClick={signOut}>
                <LogOut />
                Sign out
              </Button>
            </CardContent>
          </Card>
        </div>

        <div className="space-y-gutter">
          <AppearanceCard />
          <PreferencesCard />
          <AccessCard />
        </div>
      </div>
    </>
  );
}

function safeLocalHas(): boolean {
  try {
    return window.localStorage.getItem('rpd-dev-user-email') !== null && getDevUserEmail() !== null;
  } catch {
    return false;
  }
}

function Row({ label, value }: { label: string; value: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-s3 border-b border-border/70 pb-s2 last:border-0">
      <span className="font-medium text-text-muted">{label}</span>
      <span className="text-right font-semibold text-text">{value}</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function IdentityCard(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  const hubs = useHubs();
  const setAvatar = usePreferencesStore((s) => s.setAvatar);
  const hasPhoto = usePreferencesStore((s) => (me ? Boolean(s.avatars[me.email]) : false));
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [photoError, setPhotoError] = React.useState<string | null>(null);

  if (!me) return <></>;

  const hubLabel = me.hub_scope_all
    ? 'All hubs'
    : me.hub_ids.map((id) => hubs.data?.find((h) => h.id === id)?.name ?? '…').join(', ') || 'No hubs';

  const onFile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      setPhotoError('Choose an image file (JPG, PNG, WebP).');
      return;
    }
    if (file.size > MAX_PHOTO_BYTES) {
      setPhotoError('That image is over 5 MB — choose a smaller one.');
      return;
    }
    try {
      setAvatar(me.email, await toAvatarDataUrl(file));
      setPhotoError(null);
    } catch {
      setPhotoError('That file could not be read as an image.');
    }
  };

  return (
    <Card className="overflow-hidden">
      <div className="relative h-24" style={{ backgroundImage: 'var(--gradient-dash-primary)' }}>
        <span aria-hidden="true" className="bg-dots absolute inset-0 text-on-feature/[0.14]" />
      </div>
      <CardContent className="-mt-12 space-y-s4">
        <div className="relative w-fit">
          <UserAvatar email={me.email} name={me.full_name} className="size-24 text-2xl ring-4" />
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="absolute bottom-0 right-0 grid size-9 place-items-center rounded-full border-2 border-surface bg-primary text-primary-fg shadow-feature hover:bg-primary-hover"
            aria-label={hasPhoto ? 'Change profile photo' : 'Upload profile photo'}
          >
            {hasPhoto ? <Pencil className="size-4" /> : <Camera className="size-4" />}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onFile(e)}
          />
        </div>

        <div>
          <h2 className="font-display text-2xl font-extrabold tracking-tight text-text">{me.full_name}</h2>
          <p className="text-sm font-medium text-text-muted">{me.email}</p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {me.roles.map((r) => (
            <Badge key={r} tone={r === 'Super Admin' ? 'primary' : 'neutral'}>
              {r}
            </Badge>
          ))}
        </div>

        <div className="space-y-s2 text-sm">
          <Row
            label="Hub scope"
            value={
              <span className="inline-flex items-center gap-1.5">
                <Building2 className="size-3.5 text-text-subtle" aria-hidden="true" />
                {hubLabel}
              </span>
            }
          />
          <Row
            label="Engineer profile"
            value={
              <span className="inline-flex items-center gap-1.5">
                <UserRound className="size-3.5 text-text-subtle" aria-hidden="true" />
                {me.engineer_id ? 'Linked' : 'Not linked'}
              </span>
            }
          />
        </div>

        <div className="flex flex-wrap gap-s2">
          <Button variant="secondary" className="rounded-xl font-semibold" onClick={() => inputRef.current?.click()}>
            <Camera />
            {hasPhoto ? 'Change photo' : 'Upload photo'}
          </Button>
          {hasPhoto ? (
            <Button variant="ghost" className="rounded-xl font-semibold text-danger" onClick={() => setAvatar(me.email, null)}>
              <Trash2 />
              Remove
            </Button>
          ) : null}
        </div>
        {photoError ? (
          <p role="alert" className="text-xs font-medium text-danger">
            {photoError}
          </p>
        ) : (
          <p className="text-xs text-text-subtle">Stored on this browser only — never uploaded.</p>
        )}
      </CardContent>
    </Card>
  );
}

/* -------------------------------------------------------------------------- */

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun; hint: string }[] = [
  { value: 'light', label: 'Light', icon: Sun, hint: 'Bright, high-contrast boxes' },
  { value: 'dark', label: 'Dark', icon: Moon, hint: 'Easier on the eyes at night' },
  { value: 'system', label: 'System', icon: Monitor, hint: 'Follow your OS setting' },
];

function AppearanceCard(): React.JSX.Element {
  const { preference, setPreference } = useTheme();
  const reduceMotion = usePreferencesStore((s) => s.reduceMotion);
  const setReduceMotion = usePreferencesStore((s) => s.setReduceMotion);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Palette className="size-4 text-text-muted" aria-hidden="true" />
          Appearance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-s5">
        <fieldset className="space-y-s2">
          <legend className="text-sm font-bold text-text">Theme</legend>
          <div className="grid gap-s3 sm:grid-cols-3">
            {THEME_OPTIONS.map((opt) => {
              const active = preference === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setPreference(opt.value)}
                  className={cn(
                    'flex items-start gap-s3 rounded-xl border-2 p-s3 text-left transition-colors',
                    active
                      ? 'border-primary bg-primary-subtle/50'
                      : 'border-border hover:border-border-strong hover:bg-surface-sunken',
                  )}
                >
                  <span
                    className={cn(
                      'grid size-9 shrink-0 place-items-center rounded-lg',
                      active ? 'bg-primary text-primary-fg' : 'bg-surface-sunken text-text-muted',
                    )}
                  >
                    <opt.icon className="size-4" aria-hidden="true" />
                  </span>
                  <span>
                    <span className="block text-sm font-bold text-text">{opt.label}</span>
                    <span className="block text-xs text-text-subtle">{opt.hint}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>

        <label className="flex cursor-pointer items-start gap-s3 rounded-xl border-2 border-border p-s3 hover:border-border-strong">
          <Checkbox
            checked={reduceMotion}
            onCheckedChange={(v) => setReduceMotion(v === true)}
            className="mt-0.5"
            aria-label="Reduce motion"
          />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-bold text-text">
              <Eye className="size-4 text-text-muted" aria-hidden="true" />
              Reduce motion
            </span>
            <span className="block text-xs text-text-subtle">
              Turns off chart, card and timeline animations, even if your system allows them.
            </span>
          </span>
        </label>
      </CardContent>
    </Card>
  );
}

function PreferencesCard(): React.JSX.Element {
  const startPage = usePreferencesStore((s) => s.startPage);
  const setStartPage = usePreferencesStore((s) => s.setStartPage);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-text-muted" aria-hidden="true" />
          Preferences
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-s2">
        <Label htmlFor="start-page" className="text-sm font-bold">
          Start page after sign-in
        </Label>
        <Select value={startPage} onValueChange={(v) => setStartPage(v as StartPage)}>
          <SelectTrigger id="start-page" className="h-10 max-w-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {START_PAGES.map((p) => (
              <SelectItem key={p.value} value={p.value}>
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-text-subtle">
          If your role cannot open the page you pick, you land on the Dashboard instead.
        </p>
      </CardContent>
    </Card>
  );
}

function AccessCard(): React.JSX.Element {
  const me = useSessionStore((s) => s.me);
  if (!me) return <></>;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-4 text-text-muted" aria-hidden="true" />
          Your access
        </CardTitle>
        <span className="text-xs font-medium text-text-subtle">Set by your roles — read-only</span>
      </CardHeader>
      <CardContent>
        <ul className="grid gap-s2 sm:grid-cols-2">
          {SURFACE_KEYS.map((key) => {
            const cell = me.permissions[key] ?? { read: false, write: false };
            const level = cell.write ? 'Edit' : cell.read ? 'View' : 'No access';
            return (
              <li
                key={key}
                className="flex items-center justify-between gap-s3 rounded-xl border-2 border-border px-s3 py-s2"
              >
                <span className="text-sm font-semibold text-text">{SURFACE_LABEL[key]}</span>
                <Badge tone={cell.write ? 'success' : cell.read ? 'primary' : 'neutral'}>{level}</Badge>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}
