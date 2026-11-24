import * as React from 'react';

import { useRecalcModeStore } from '@/stores/recalc-mode';
import { useSessionStore } from '@/stores/session';

/**
 * P61 (ADR 0069): points the recalc-mode store at the signed-in user. Rendered
 * once in the app shell. Since 2026-11-24 recalculation is manual for everyone
 * (the header "Auto-recalculate" switch was removed), so the store's per-user
 * value is no longer read; this only keeps `activeEmail` current.
 */
export function RecalcModeSync(): null {
  const email = useSessionStore((s) => s.me?.email ?? null);
  const setActiveEmail = useRecalcModeStore((s) => s.setActiveEmail);
  React.useEffect(() => {
    setActiveEmail(email);
  }, [email, setActiveEmail]);
  return null;
}
