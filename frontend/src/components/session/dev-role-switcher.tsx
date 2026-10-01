import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { setDevUserEmail } from '@/lib/api/dev-user';
import { fetchDevUsers } from '@/lib/api/session';
import { queryKeys } from '@/lib/query-keys';
import { useSessionStore } from '@/stores/session';

/**
 * Dev-only acting-user switcher (ADR 0010 §4).
 *
 * IMPOSSIBLE TO RENDER OUTSIDE DEV MODE, by construction: the only thing that
 * can make this component return markup is `dev_mode: true` on the `/me`
 * payload the SERVER returned. There is no build flag, env var or local
 * setting that enables it, so a production backend (which never sets
 * `dev_mode`) never sees it — and the `X-Dev-User-Email` header it sets is
 * ignored there anyway. `security-auditor` verifies both halves on the P9 gate.
 *
 * Switching: write the header value, reload `/me`, then reset every query so
 * nothing cached under the previous identity survives (`resetQueries`, not
 * `invalidateQueries` — the latter would keep serving the old user's rows as
 * placeholder data while the refetch is in flight).
 */
export function DevRoleSwitcher(): React.JSX.Element | null {
  const me = useSessionStore((s) => s.me);
  const load = useSessionStore((s) => s.load);
  const queryClient = useQueryClient();
  const [switching, setSwitching] = React.useState(false);
  const devMode = me?.dev_mode === true;

  const devUsers = useQuery({
    queryKey: queryKeys.devUsers(),
    queryFn: ({ signal }) => fetchDevUsers({ signal }),
    enabled: devMode,
    staleTime: 60 * 60_000,
  });

  if (!devMode || !me) return null;

  const options = devUsers.data ?? [];
  const current = options.some((u) => u.email === me.email) ? me.email : '';

  const handleSwitch = async (email: string) => {
    if (!email || email === me.email) return;
    setSwitching(true);
    try {
      setDevUserEmail(email);
      await load();
      await queryClient.resetQueries();
    } finally {
      setSwitching(false);
    }
  };

  return (
    <div
      className="hidden items-center gap-1.5 whitespace-nowrap rounded-pill border border-warning/40 bg-warning-subtle/60 px-2.5 py-1 text-2xs font-medium text-warning-subtle-fg md:flex"
      data-testid="dev-role-switcher"
    >
      <FlaskConical className="size-3.5 shrink-0 text-warning-subtle-fg" aria-hidden="true" />
      <span className="font-semibold">Dev:</span>
      <Select value={current} onValueChange={(v) => void handleSwitch(v)} disabled={switching}>
        <SelectTrigger
          id="dev-role-switcher"
          className="h-6 max-w-44 border-transparent bg-transparent p-0 text-2xs font-medium focus:ring-0"
          aria-label="Dev mode: act as user"
        >
          <SelectValue placeholder={devUsers.isPending ? 'Loading…' : me.full_name || me.email} />
        </SelectTrigger>
        <SelectContent>
          {options.map((u) => (
            <SelectItem key={u.email} value={u.email}>
              {u.full_name} ({u.roles.join(', ')})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
