import * as React from 'react';
import { QueryClient, QueryClientProvider, useMutation } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import {
  APP_BUILD_ID,
  CHUNK_RELOAD_GUARD_MS,
  CHUNK_RELOAD_KEY,
  VERSION_CHECK_INTERVAL_MS,
  VERSION_RELOAD_KEY,
  VERSION_URL,
  fetchServedBuildId,
  installChunkErrorReload,
  isSafeToReload,
  isChunkLoadError,
  reloadForChunkError,
} from '@/lib/app-version';
import { browserNavigation } from '@/lib/browser-navigation';
import { useScheduleRunFollow } from '@/lib/use-schedule-run-follow';
import { useEditSessionStore } from '@/stores/edit-session';

import { PENDING_RELOAD_CHECK_MS, VersionWatcher } from './version-watcher';

const NEW_ID = 'abc123def456-new';

function serve(body: unknown, ok = true): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) } as unknown as Response),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

let client: QueryClient;

function withClient(ui: React.ReactNode): React.JSX.Element {
  return <QueryClientProvider client={client}>{ui}</QueryClientProvider>;
}

/** A write that stays in flight until `settle()` is called. */
function PendingWrite({ onReady }: { onReady: (settle: () => void) => void }): null {
  const mutation = useMutation({ mutationFn: () => new Promise<void>((resolve) => onReady(resolve)) });
  const { mutate } = mutation;
  React.useEffect(() => mutate(), [mutate]);
  return null;
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let reload: ReturnType<typeof vi.spyOn>;
const originalFetch = globalThis.fetch;

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  vi.useFakeTimers();
  window.sessionStorage.clear();
  reload = vi.spyOn(browserNavigation, 'reload').mockImplementation(() => undefined);
  useEditSessionStore.setState({ editors: new Set() });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  reload.mockRestore();
  globalThis.fetch = originalFetch;
  window.sessionStorage.clear();
  useEditSessionStore.setState({ editors: new Set() });
});

describe('version.json check (ADR 0060 R1)', () => {
  it('fetches version.json with no-store every 5 minutes; the same id never reloads', async () => {
    const fetchMock = serve({ buildId: APP_BUILD_ID });
    render(withClient(<VersionWatcher />));
    expect(fetchMock).not.toHaveBeenCalled();

    await advance(VERSION_CHECK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(VERSION_URL, { cache: 'no-store', credentials: 'same-origin' });
    await advance(VERSION_CHECK_INTERVAL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.queryByTestId('new-version-bar')).toBeNull();
  });

  it('checks when the tab becomes visible', async () => {
    const fetchMock = serve({ buildId: APP_BUILD_ID });
    render(withClient(<VersionWatcher />));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.restoreAllMocks();
    reload = vi.spyOn(browserNavigation, 'reload').mockImplementation(() => undefined);
  });

  it('a new version reloads at once when nothing is being edited and no dialog is open', async () => {
    serve({ buildId: NEW_ID });
    render(withClient(<VersionWatcher />));
    await advance(VERSION_CHECK_INTERVAL_MS);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(VERSION_RELOAD_KEY)).toBe(NEW_ID);
  });

  it('while editing, shows the bar instead, and reloads by itself once the edits clear', async () => {
    serve({ buildId: NEW_ID });
    useEditSessionStore.getState().add('editor-1');
    render(withClient(<VersionWatcher />));
    await advance(VERSION_CHECK_INTERVAL_MS);

    expect(reload).not.toHaveBeenCalled();
    const bar = screen.getByTestId('new-version-bar');
    expect(bar).toHaveTextContent('A new version is available');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    // Non-blocking: a status bar, not a dialog.
    expect(screen.queryByRole('dialog')).toBeNull();

    act(() => useEditSessionStore.getState().remove('editor-1'));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('while a dialog is open, waits; reloads after it closes', async () => {
    serve({ buildId: NEW_ID });
    const { rerender } = render(
      withClient(
        <>
          <VersionWatcher />
          <Dialog open>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>Edit project</DialogTitle>
            </DialogContent>
          </Dialog>
        </>,
      ),
    );
    await advance(VERSION_CHECK_INTERVAL_MS);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-version-bar')).toBeInTheDocument();

    rerender(withClient(<VersionWatcher />));
    await advance(PENDING_RELOAD_CHECK_MS);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('P49-R01: a write in flight (any mutation) holds the reload; it reloads once the write settles', async () => {
    serve({ buildId: NEW_ID });
    let settle: () => void = () => undefined;
    render(
      withClient(
        <>
          <VersionWatcher />
          <PendingWrite onReady={(s) => (settle = s)} />
        </>,
      ),
    );
    await advance(0);
    expect(client.isMutating()).toBe(1);
    expect(isSafeToReload(client)).toBe(false);
    await advance(VERSION_CHECK_INTERVAL_MS + PENDING_RELOAD_CHECK_MS);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-version-bar')).toBeInTheDocument();

    await act(async () => {
      settle();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(client.isMutating()).toBe(0);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('P49-R01: a schedule run being followed holds the reload on any surface', () => {
    const { result } = renderHook(() => useScheduleRunFollow());
    expect(isSafeToReload(client)).toBe(true);
    act(() => {
      result.current.begin('Dispatching…');
    });
    expect(useEditSessionStore.getState().editors.size).toBe(1);
    expect(isSafeToReload(client)).toBe(false);
    act(() => result.current.reset());
    expect(isSafeToReload(client)).toBe(true);
  });

  it('the Reload button reloads even while editing', async () => {
    serve({ buildId: NEW_ID });
    useEditSessionStore.getState().add('editor-1');
    render(withClient(<VersionWatcher />));
    await advance(VERSION_CHECK_INTERVAL_MS);
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not loop: after one reload for an id, a second mismatch only shows the bar', async () => {
    window.sessionStorage.setItem(VERSION_RELOAD_KEY, NEW_ID);
    serve({ buildId: NEW_ID });
    render(withClient(<VersionWatcher />));
    await advance(VERSION_CHECK_INTERVAL_MS + PENDING_RELOAD_CHECK_MS * 3);
    expect(reload).not.toHaveBeenCalled();
    expect(screen.getByTestId('new-version-bar')).toBeInTheDocument();
  });

  it.each([
    ['a failed request', () => serve({}, false)],
    ['an HTML page (dev server fallback)', () => {
      globalThis.fetch = vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('Unexpected token <')) } as unknown as Response),
      ) as unknown as typeof fetch;
    }],
    ['a bad build id', () => serve({ buildId: '<script>' })],
    ['a network error', () => {
      globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch;
    }],
  ])('ignores %s', async (_label, setup) => {
    setup();
    expect(await fetchServedBuildId()).toBeNull();
  });
});

describe('chunk-load failure reload (ADR 0060 R1)', () => {
  it('recognises dynamic-import failures', () => {
    expect(isChunkLoadError(new TypeError('Failed to fetch dynamically imported module: https://x/assets/a.js'))).toBe(true);
    expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkLoadError(new Error('error loading dynamically imported module'))).toBe(true);
    expect(isChunkLoadError(new Error('Request failed with 500'))).toBe(false);
    expect(isChunkLoadError(undefined)).toBe(false);
  });

  it('reloads once, then not again within the guard window, then again after it', () => {
    vi.setSystemTime(1_000_000);
    expect(reloadForChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(window.sessionStorage.getItem(CHUNK_RELOAD_KEY)).toBe('1000000');

    vi.setSystemTime(1_000_000 + CHUNK_RELOAD_GUARD_MS - 1);
    expect(reloadForChunkError()).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + CHUNK_RELOAD_GUARD_MS);
    expect(reloadForChunkError()).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it('vite:preloadError reloads once and is prevented; a repeat is not', () => {
    const uninstall = installChunkErrorReload();
    try {
      const first = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(first);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(first.defaultPrevented).toBe(true);

      const second = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(second);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(second.defaultPrevented).toBe(false);
    } finally {
      uninstall();
    }
  });

  it('an unhandled dynamic-import rejection reloads; other rejections do not', () => {
    const uninstall = installChunkErrorReload();
    try {
      const other = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(other, 'reason', { value: new Error('boom') });
      window.dispatchEvent(other);
      expect(reload).not.toHaveBeenCalled();

      const chunk = new Event('unhandledrejection') as PromiseRejectionEvent;
      Object.defineProperty(chunk, 'reason', { value: new TypeError('Failed to fetch dynamically imported module: /assets/x.js') });
      window.dispatchEvent(chunk);
      expect(reload).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it('does not reload when sessionStorage is unavailable (no guard, no loop)', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    try {
      expect(reloadForChunkError()).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      setItem.mockRestore();
    }
  });
});
