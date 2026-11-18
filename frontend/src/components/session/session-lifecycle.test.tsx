import * as React from 'react';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, RouterProvider, Routes, createMemoryRouter, useBlocker, useLocation, useNavigate } from 'react-router-dom';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import {
  ACTIVITY_WRITE_THROTTLE_MS,
  IDLE_SIGNED_OUT_NOTICE,
  IDLE_TIMEOUT_MS,
  IDLE_WARNING_BEFORE_MS,
  LAST_ACTIVITY_KEY,
} from '@/lib/auth/idle';
import { shouldBlockLeave } from '@/lib/auth/leave-guard';
import { REMOTE_SIGNED_OUT_EVENT, SESSION_CHANNEL_NAME, startSessionChannel } from '@/lib/auth/session-channel';
import type { LoginLocationState } from '@/lib/auth/use-sign-out';
import { createQueryClient } from '@/lib/query-client';
import { FakeBroadcastChannel } from '@/test/fake-broadcast-channel';

import { IdleLogout, SessionLifecycle } from './session-lifecycle';

const MIN = 60_000;
const START = Date.UTC(2026, 10, 18, 9, 0, 0);

function shared(): number | null {
  const raw = window.localStorage.getItem(LAST_ACTIVITY_KEY);
  return raw === null ? null : Number(raw);
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('IdleLogout (ADR 0060 L2)', () => {
  it('the timeout is 30 minutes and the warning opens 2 minutes before it', () => {
    expect(IDLE_TIMEOUT_MS).toBe(30 * MIN);
    expect(IDLE_WARNING_BEFORE_MS).toBe(2 * MIN);
    expect(IDLE_SIGNED_OUT_NOTICE).toBe('You were signed out after 30 minutes of inactivity.');
  });

  it('warns at 28 minutes with a countdown, then signs out once at 30 minutes', async () => {
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);
    expect(shared()).toBe(START);

    await advance(28 * MIN - 1_000);
    expect(screen.queryByTestId('idle-warning')).toBeNull();

    await advance(1_000);
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();
    expect(screen.getByTestId('idle-countdown')).toHaveTextContent('2:00');
    expect(screen.getByRole('dialog')).toHaveTextContent('You will be signed out in 2:00 for inactivity');

    await advance(61_000);
    expect(screen.getByTestId('idle-countdown')).toHaveTextContent('0:59');
    expect(onIdle).not.toHaveBeenCalled();

    await advance(59_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    await advance(10 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('activity resets the clock (pointer, key, wheel, touch, scroll)', async () => {
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);

    for (const fire of [
      () => fireEvent.pointerDown(document.body),
      () => fireEvent.keyDown(document.body, { key: 'a' }),
      () => fireEvent.wheel(document.body),
      () => fireEvent.touchStart(document.body),
      () => fireEvent.scroll(window),
    ]) {
      await advance(20 * MIN);
      fire();
      expect(shared()).toBe(Date.now());
    }
    // 100 minutes in, never more than 20 minutes idle.
    await advance(27 * MIN);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    expect(onIdle).not.toHaveBeenCalled();
    await advance(1 * MIN);
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();
  });

  it('throttles the shared timestamp writes but always writes the last activity', async () => {
    render(<IdleLogout onIdle={vi.fn()} />);
    await advance(ACTIVITY_WRITE_THROTTLE_MS);
    fireEvent.pointerMove(document.body);
    const firstWrite = Date.now();
    expect(shared()).toBe(firstWrite);

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    await advance(1_000);
    fireEvent.pointerMove(document.body);
    await advance(1_000);
    fireEvent.pointerMove(document.body);
    const lastActivity = Date.now();
    expect(setItem).not.toHaveBeenCalled();
    expect(shared()).toBe(firstWrite);

    await advance(ACTIVITY_WRITE_THROTTLE_MS);
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(shared()).toBe(lastActivity);
    setItem.mockRestore();
  });

  it('"Stay signed in" closes the warning and restarts the 30 minutes in every tab', async () => {
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);
    await advance(29 * MIN);
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stay signed in' }));
    await advance(0);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    expect(shared()).toBe(Date.now());

    await advance(5 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
    await advance(23 * MIN);
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();
  });

  it('activity inside this tab does not dismiss an open warning; only the button does', async () => {
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);
    await advance(28 * MIN);
    fireEvent.pointerMove(document.body);
    fireEvent.keyDown(document.body, { key: 'Shift' });
    await advance(2 * MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('activity in another tab (shared timestamp) closes the warning here', async () => {
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);
    await advance(28 * MIN + 30_000);
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();

    act(() => {
      window.localStorage.setItem(LAST_ACTIVITY_KEY, String(Date.now()));
      window.dispatchEvent(new StorageEvent('storage', { key: LAST_ACTIVITY_KEY }));
    });
    await advance(0);
    expect(screen.queryByTestId('idle-warning')).toBeNull();
    await advance(5 * MIN);
    expect(onIdle).not.toHaveBeenCalled();
  });

  it('a stale shared timestamp (idle while the tab was away) signs out at once', async () => {
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(START - IDLE_TIMEOUT_MS - 1));
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);
    await advance(0);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('mounting (e.g. an auto reload) is not activity: an existing shared time is kept', async () => {
    window.localStorage.setItem(LAST_ACTIVITY_KEY, String(START - 10 * MIN));
    const onIdle = vi.fn();
    render(<IdleLogout onIdle={onIdle} />);
    expect(shared()).toBe(START - 10 * MIN);
    await advance(18 * MIN);
    expect(screen.getByTestId('idle-warning')).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------------- */

function LoginProbe(): React.JSX.Element {
  const state = useLocation().state as LoginLocationState | null;
  return <p data-testid="login">{state?.signedOut === 'idle' ? IDLE_SIGNED_OUT_NOTICE : 'login'}</p>;
}

function renderShell(): void {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={['/matrix']}>
        <Routes>
          <Route path="/login" element={<LoginProbe />} />
          <Route path="*" element={<SessionLifecycle />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('SessionLifecycle (ADR 0060 L1 + L2)', () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  });

  it('at 30 minutes signs out through the sign-out path, tells the other tabs, and shows the notice', async () => {
    setDevUserEmail('admin@example.com');
    const otherTab = vi.fn();
    const stop = startSessionChannel({ onRemoteSignOut: vi.fn() });
    const listener = new FakeBroadcastChannel(SESSION_CHANNEL_NAME);
    listener.onmessage = (event) => otherTab(event.data);
    try {
      renderShell();
      await advance(IDLE_TIMEOUT_MS);
      expect(getDevUserEmail()).toBeNull();
      expect(screen.getByTestId('login')).toHaveTextContent(IDLE_SIGNED_OUT_NOTICE);
      expect(otherTab).toHaveBeenCalledWith({ type: 'signed-out' });
    } finally {
      stop();
    }
  });

  it('a sign-out from another tab signs this tab out without re-broadcasting', async () => {
    setDevUserEmail('admin@example.com');
    const stop = startSessionChannel({ onRemoteSignOut: vi.fn() });
    try {
      renderShell();
      await advance(5 * MIN);
      act(() => {
        window.dispatchEvent(new Event(REMOTE_SIGNED_OUT_EVENT));
      });
      expect(getDevUserEmail()).toBeNull();
      expect(screen.getByTestId('login')).toHaveTextContent('login');
      expect(FakeBroadcastChannel.instances[0]!.sent).toEqual([]);
    } finally {
      stop();
    }
  });

  it('a remote sign-out at the idle deadline shows the inactivity notice', async () => {
    setDevUserEmail('admin@example.com');
    renderShell();
    await advance(IDLE_TIMEOUT_MS - 2_000);
    act(() => {
      window.dispatchEvent(new Event(REMOTE_SIGNED_OUT_EVENT));
    });
    expect(screen.getByTestId('login')).toHaveTextContent(IDLE_SIGNED_OUT_NOTICE);
  });
});

/* -------------------------------------------------------------------------- */

/** A surface with unsaved edits and a `useBlocker` leave guard, like the register or the Matrix grid. */
function GuardedSurface(): React.JSX.Element {
  const blocker = useBlocker((args) => shouldBlockLeave(true, args));
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="blocker-state">{blocker.state}</p>
      <button type="button" onClick={() => navigate('/other')}>
        Go elsewhere
      </button>
      <SessionLifecycle />
    </>
  );
}

function renderGuarded(): void {
  const router = createMemoryRouter(
    [
      { path: '/login', element: <LoginProbe /> },
      { path: '/other', element: <p data-testid="other">other</p> },
      { path: '/matrix', element: <GuardedSurface /> },
    ],
    { initialEntries: ['/matrix'] },
  );
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe('P49-R01 A2: a forced sign-out passes the leave guards', () => {
  beforeEach(() => {
    FakeBroadcastChannel.reset();
    vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  });

  it('the guard still blocks an ordinary route change', async () => {
    setDevUserEmail('admin@example.com');
    renderGuarded();
    fireEvent.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    await advance(0);
    expect(screen.getByTestId('blocker-state')).toHaveTextContent('blocked');
    expect(screen.queryByTestId('other')).toBeNull();
  });

  it('an idle sign-out on a guarded page reaches the login page with the inactivity notice', async () => {
    setDevUserEmail('admin@example.com');
    renderGuarded();
    await advance(IDLE_TIMEOUT_MS);
    expect(getDevUserEmail()).toBeNull();
    expect(screen.getByTestId('login')).toHaveTextContent(IDLE_SIGNED_OUT_NOTICE);
  });

  it('a sign-out from another tab also passes the guard', async () => {
    setDevUserEmail('admin@example.com');
    renderGuarded();
    await advance(5 * MIN);
    act(() => {
      window.dispatchEvent(new Event(REMOTE_SIGNED_OUT_EVENT));
    });
    await advance(0);
    expect(screen.getByTestId('login')).toHaveTextContent('login');
  });
});
