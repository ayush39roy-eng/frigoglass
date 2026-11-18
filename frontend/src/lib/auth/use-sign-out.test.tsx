import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createQueryClient } from '@/lib/query-client';

import { FakeBroadcastChannel } from '@/test/fake-broadcast-channel';

import { SESSION_CHANNEL_NAME } from './session-channel';
import { SIGNED_OUT_EVENT, clearAppSessionStorage, useSignOut } from './use-sign-out';

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/matrix']}>
        <Routes>
          <Route path="*" element={children} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useSignOut (P21-R01, security S21-L2)', () => {
  it('removes the Matrix compare selection and every other rpd- sessionStorage key', () => {
    window.sessionStorage.setItem(
      'rpd-matrix-compare',
      JSON.stringify({ state: { items: [{ id: 'p1', name: 'Cooler Heineken', hub: 'PD-India' }] }, version: 0 }),
    );
    window.sessionStorage.setItem('rpd-dev-user-email', 'planner@example.test');
    window.sessionStorage.setItem('rpd-future-store', '{}');
    window.sessionStorage.setItem('unrelated-key', 'kept');

    const { result } = renderHook(() => useSignOut(), { wrapper });
    act(() => result.current());

    expect(window.sessionStorage.getItem('rpd-matrix-compare')).toBeNull();
    expect(window.sessionStorage.getItem('rpd-dev-user-email')).toBeNull();
    expect(window.sessionStorage.getItem('rpd-future-store')).toBeNull();
    expect(window.sessionStorage.getItem('unrelated-key')).toBe('kept');
  });

  it('ADR 0060 L1: clears the per-tab test user and tells the other tabs', () => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const otherTab = new FakeBroadcastChannel(SESSION_CHANNEL_NAME);
    const received: unknown[] = [];
    otherTab.onmessage = (event) => received.push(event.data);
    window.sessionStorage.setItem('rpd-dev-user-email', 'planner@example.test');

    const { result } = renderHook(() => useSignOut(), { wrapper });
    act(() => result.current());

    expect(window.sessionStorage.getItem('rpd-dev-user-email')).toBeNull();
    expect(window.localStorage.getItem('rpd-dev-user-email')).toBeNull();
    const posted = FakeBroadcastChannel.instances.flatMap((c) => c.sent);
    expect(posted).toEqual([{ type: 'signed-out' }]);
  });

  it('ADR 0060 L1: a sign-out that came from another tab is not broadcast again', () => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
    const { result } = renderHook(() => useSignOut(), { wrapper });
    act(() => result.current({ broadcast: false }));
    expect(FakeBroadcastChannel.instances.flatMap((c) => c.sent)).toEqual([]);
  });

  it('dispatches the signed-out event after sessionStorage is cleared', () => {
    window.sessionStorage.setItem('rpd-matrix-compare', '{}');
    let keyAtEvent: string | null = 'unset';
    const listener = (): void => {
      keyAtEvent = window.sessionStorage.getItem('rpd-matrix-compare');
    };
    window.addEventListener(SIGNED_OUT_EVENT, listener);
    try {
      const { result } = renderHook(() => useSignOut(), { wrapper });
      act(() => result.current());
    } finally {
      window.removeEventListener(SIGNED_OUT_EVENT, listener);
    }
    expect(keyAtEvent).toBeNull();
  });

  it('still signs out when sessionStorage throws', () => {
    vi.spyOn(Storage.prototype, 'key').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    expect(() => clearAppSessionStorage()).not.toThrow();
    const { result } = renderHook(() => useSignOut(), { wrapper });
    expect(() => act(() => result.current())).not.toThrow();
  });
});
