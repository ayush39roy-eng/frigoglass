import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  APP_BUILD_ID,
  VERSION_CHECK_INTERVAL_MS,
  fetchServedBuildId,
  isSafeToReload,
  mayAutoReloadFor,
  reloadForNewVersion,
} from '@/lib/app-version';
import { useEditSessionStore } from '@/stores/edit-session';

/** While a new version waits for edits or a dialog to clear, re-check this often. */
export const PENDING_RELOAD_CHECK_MS = 2_000;

/**
 * ADR 0060 R1 (P49): checks `version.json` every 5 minutes and when the tab
 * becomes visible. On a new version it reloads at once if nothing is being
 * edited, pending or running (`isSafeToReload`) and no dialog is open; otherwise it shows a non-blocking bar
 * ("A new version is available — Reload") and reloads by itself as soon as
 * the edits are saved or discarded. Mounted once, at the app root.
 */
export function VersionWatcher(): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [servedId, setServedId] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const id = await fetchServedBuildId();
      if (!cancelled && id !== null && id !== APP_BUILD_ID) setServedId(id);
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') void check();
    };
    const interval = window.setInterval(() => void check(), VERSION_CHECK_INTERVAL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const autoReload = servedId !== null && mayAutoReloadFor(servedId);

  React.useEffect(() => {
    if (servedId === null || !autoReload) return undefined;
    let reloading = false;
    const attempt = (): void => {
      if (reloading || !isSafeToReload(queryClient)) return;
      reloading = true;
      reloadForNewVersion(servedId);
    };
    attempt();
    const unsubscribe = useEditSessionStore.subscribe(attempt);
    // A write finishing may be the last thing holding the reload.
    const unsubscribeMutations = queryClient.getMutationCache().subscribe(attempt);
    const interval = window.setInterval(attempt, PENDING_RELOAD_CHECK_MS);
    return () => {
      unsubscribe();
      unsubscribeMutations();
      window.clearInterval(interval);
    };
  }, [servedId, autoReload, queryClient]);

  if (servedId === null) return null;

  return (
    <div
      role="status"
      data-testid="new-version-bar"
      className="fixed inset-x-0 bottom-s4 z-[60] mx-auto flex w-fit max-w-[calc(100vw-2rem)] items-center gap-s3 rounded-pill border border-border bg-surface px-s4 py-s2 text-sm font-medium text-text shadow-feature"
    >
      <RefreshCw className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <span>A new version is available</span>
      <Button type="button" size="sm" onClick={() => reloadForNewVersion(servedId)}>
        Reload
      </Button>
    </div>
  );
}
