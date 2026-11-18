/**
 * ADR 0060 R1 (P49): auto reload onto a new deployed version.
 *
 * The build writes `version.json` ({"buildId": "..."}) next to `index.html`,
 * and the bundle knows its own id (`__APP_BUILD_ID__`, a Vite define). The
 * watcher (`components/app/version-watcher.tsx`) fetches the file with
 * `cache: 'no-store'` and reloads when the ids differ and nothing is being
 * edited. A reload never saves anything or starts a run.
 *
 * A lazy chunk that no longer exists after a deploy also triggers one reload,
 * guarded by a `sessionStorage` timestamp so it cannot loop.
 */

import type { QueryClient } from '@tanstack/react-query';

import { browserNavigation } from '@/lib/browser-navigation';
import { useEditSessionStore } from '@/stores/edit-session';

export const APP_BUILD_ID: string = __APP_BUILD_ID__;

export const VERSION_CHECK_INTERVAL_MS = 5 * 60_000;

export const VERSION_URL = `${import.meta.env.BASE_URL}version.json`;

/** The served id this tab already reloaded for; a second mismatch for it shows the bar instead (no loop). */
export const VERSION_RELOAD_KEY = 'rpd-version-reloaded-for';

/** When this tab last reloaded for a failed chunk load. */
export const CHUNK_RELOAD_KEY = 'rpd-chunk-reload-at';

/** No second chunk-error reload within this window. */
export const CHUNK_RELOAD_GUARD_MS = 60_000;

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/;

/** The deployed build id, or `null` when it cannot be read (dev server, offline, bad file). */
export async function fetchServedBuildId(): Promise<string | null> {
  try {
    const response = await fetch(VERSION_URL, { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const buildId = (body as Record<string, unknown>).buildId;
    return typeof buildId === 'string' && BUILD_ID_PATTERN.test(buildId) ? buildId : null;
  } catch {
    return null;
  }
}

/** A modal, sheet or popover is open (Radix renders open ones only). */
export function isAnyDialogOpen(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}

/**
 * A reload loses nothing: no editor, pending result or followed run is
 * registered in the edit-session store (P49-R01: register drafts, Save-then-
 * recalc, priority-move panel, What-if planner, Matrix scenario, every
 * `useScheduleRunFollow` while busy), no request is writing
 * (`queryClient.isMutating() === 0`, which also covers What-if
 * estimate / simulate / solve), and no dialog is open.
 */
export function isSafeToReload(queryClient: QueryClient): boolean {
  return (
    useEditSessionStore.getState().editors.size === 0 && queryClient.isMutating() === 0 && !isAnyDialogOpen()
  );
}

function readSession(key: string): string | null {
  try {
    return window.sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSession(key: string, value: string): void {
  try {
    window.sessionStorage.setItem(key, value);
  } catch {
    // storage unavailable — the guard falls back to "do not reload again"
  }
}

/** Whether this tab may still reload on its own for `servedId` (it has not already done so). */
export function mayAutoReloadFor(servedId: string): boolean {
  return readSession(VERSION_RELOAD_KEY) !== servedId;
}

/** Reload onto `servedId`, remembering it so a stale cache cannot loop. */
export function reloadForNewVersion(servedId: string): void {
  writeSession(VERSION_RELOAD_KEY, servedId);
  browserNavigation.reload();
}

const CHUNK_ERROR_PATTERN =
  /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|Loading (CSS )?chunk .* failed/i;

export function isChunkLoadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return CHUNK_ERROR_PATTERN.test(message);
}

/**
 * Reload once for a failed chunk load. Returns `false` (and does nothing) when
 * this tab already reloaded for one within `CHUNK_RELOAD_GUARD_MS`.
 */
export function reloadForChunkError(now: number = Date.now()): boolean {
  const raw = readSession(CHUNK_RELOAD_KEY);
  const last = raw !== null && /^\d{1,16}$/.test(raw) ? Number(raw) : null;
  if (last !== null && now - last >= 0 && now - last < CHUNK_RELOAD_GUARD_MS) return false;
  writeSession(CHUNK_RELOAD_KEY, String(now));
  if (readSession(CHUNK_RELOAD_KEY) !== String(now)) return false;
  browserNavigation.reload();
  return true;
}

/** Listen for Vite's preload error and unhandled dynamic-import failures. Returns an uninstall function. */
export function installChunkErrorReload(): () => void {
  const onPreloadError = (event: Event): void => {
    if (reloadForChunkError()) event.preventDefault();
  };
  const onRejection = (event: PromiseRejectionEvent): void => {
    if (isChunkLoadError(event.reason)) reloadForChunkError();
  };
  window.addEventListener('vite:preloadError', onPreloadError);
  window.addEventListener('unhandledrejection', onRejection);
  return () => {
    window.removeEventListener('vite:preloadError', onPreloadError);
    window.removeEventListener('unhandledrejection', onRejection);
  };
}
