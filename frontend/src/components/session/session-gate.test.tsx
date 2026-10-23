import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { DevRoleSwitcher } from '@/components/session/dev-role-switcher';
import { renderApp, renderWithProviders } from '@/test/render';
import { makeMe } from '@/test/session';
import { useSessionStore } from '@/stores/session';

const api = { fetchMe: vi.fn(), fetchDevUsers: vi.fn() };
vi.mock('@/lib/api/session', () => ({
  fetchMe: () => api.fetchMe(),
  fetchDevUsers: () => api.fetchDevUsers(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().reset();
  setDevUserEmail(null);
  api.fetchDevUsers.mockResolvedValue([
    { email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin'] },
    { email: 'alex.admin@example.com', full_name: 'Alex Admin', roles: ['Admin'] },
    { email: 'ellie.exec@example.com', full_name: 'Ellie Exec', roles: ['Executive Viewer'] },
  ]);
});

describe('SessionGate (boot on GET /me)', () => {
  it('shows a loading state until /me resolves, then the shell with the signed-in identity', async () => {
    let resolve: (me: unknown) => void = () => undefined;
    api.fetchMe.mockReturnValue(new Promise((r) => (resolve = r)));
    renderApp('/', { session: null });
    expect(screen.getByTestId('session-gate-loading')).toBeInTheDocument();
    resolve(makeMe({ full_name: 'Sam Super', roles: ['Super Admin'] }));
    expect(await screen.findByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
    expect(screen.getByTestId('session-identity')).toHaveTextContent('Sam Super');
    expect(screen.queryByTestId('session-gate-loading')).not.toBeInTheDocument();
  });

  it('a 401 redirects to /login instead of showing a dead-end card', async () => {
    api.fetchMe.mockRejectedValue(new ApiError(401, 'unauthorized'));
    renderApp('/', { session: null });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Surfaces' })).not.toBeInTheDocument();
  });

  it('a 401 goes to /login without any retry', async () => {
    api.fetchMe.mockRejectedValue(new ApiError(401, 'unauthorized'));
    renderApp('/', { session: null });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('session-gate-waking')).not.toBeInTheDocument();
  });
});

describe('SessionGate during an API cold start (P31-R01)', () => {
  afterEach(() => {
    useSessionStore.getState().reset();
    vi.useRealTimers();
  });

  it('network errors show "Waking up the server…" with elapsed time, then the app once /me answers', async () => {
    vi.useFakeTimers();
    setDevUserEmail('sam.super@example.com');
    api.fetchMe
      .mockRejectedValueOnce(new ApiError(0, 'Network request failed'))
      .mockRejectedValueOnce(new ApiError(504, 'Gateway Timeout'))
      .mockResolvedValueOnce(makeMe());
    renderApp('/', { session: null });
    await act(() => vi.advanceTimersByTimeAsync(0));

    expect(screen.getByText('Waking up the server…')).toBeInTheDocument();
    expect(screen.getByTestId('session-gate-elapsed')).toHaveTextContent('Waiting 0 s');
    expect(screen.queryByText('Could not load your session')).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(screen.getByTestId('session-gate-elapsed')).toHaveTextContent('Waiting 2 s');
    expect(api.fetchMe).toHaveBeenCalledTimes(2);

    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(api.fetchMe).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
    expect(await screen.findByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
    expect(getDevUserEmail()).toBe('sam.super@example.com');
  });

  it('"Retry now" tries again without waiting for the backoff', async () => {
    vi.useFakeTimers();
    api.fetchMe.mockRejectedValueOnce(new ApiError(503, 'Service Unavailable')).mockResolvedValueOnce(makeMe());
    renderApp('/', { session: null });
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.fetchMe).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(api.fetchMe).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
    expect(await screen.findByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
  });

  it('shows the error card only after the ~90 s budget is spent, and Retry starts over', async () => {
    vi.useFakeTimers();
    setDevUserEmail('sam.super@example.com');
    api.fetchMe.mockRejectedValue(new ApiError(502, 'Bad Gateway'));
    renderApp('/', { session: null });
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(screen.getByText('Waking up the server…')).toBeInTheDocument();
    expect(screen.queryByText('Could not load your session')).not.toBeInTheDocument();

    await act(() => vi.advanceTimersByTimeAsync(40_000));
    expect(screen.getByText('Could not load your session')).toBeInTheDocument();
    expect(screen.getByText(/did not respond after about 90 seconds/)).toBeInTheDocument();
    expect(getDevUserEmail()).toBe('sam.super@example.com');

    api.fetchMe.mockReset();
    api.fetchMe.mockResolvedValue(makeMe());
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    vi.useRealTimers();
    expect(await screen.findByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
  });
});

describe('DevRoleSwitcher (ADR 0010 §4)', () => {
  it('never renders when the server says dev_mode is false', async () => {
    renderApp('/', { session: { dev_mode: false } });
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    expect(screen.queryByTestId('dev-role-switcher')).not.toBeInTheDocument();
    expect(api.fetchDevUsers).not.toHaveBeenCalled();
  });

  it('renders only in dev mode, and switching sets the X-Dev-User-Email header source and reloads /me', async () => {
    const user = userEvent.setup();
    api.fetchMe.mockResolvedValue(
      makeMe({ email: 'ellie.exec@example.com', full_name: 'Ellie Exec', roles: ['Executive Viewer'], dev_mode: true }),
    );
    setDevUserEmail('sam.super@example.com');
    // c074e62 (2026-10-01) unmounted the switcher from the app header; the
    // component and its server-dev_mode-only guard remain, so test it directly.
    const { rerender } = renderWithProviders(<DevRoleSwitcher />, { session: { dev_mode: false } });
    expect(screen.queryByTestId('dev-role-switcher')).not.toBeInTheDocument();
    useSessionStore.setState({ me: makeMe({ dev_mode: true }) });
    rerender(<DevRoleSwitcher />);
    expect(await screen.findByTestId('dev-role-switcher')).toBeInTheDocument();

    await user.click(await screen.findByRole('combobox', { name: 'Dev mode: act as user' }));
    await user.click(await screen.findByRole('option', { name: /Ellie Exec/ }));

    await waitFor(() => expect(getDevUserEmail()).toBe('ellie.exec@example.com'));
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    await waitFor(() => expect(useSessionStore.getState().me?.full_name).toBe('Ellie Exec'));
  });

  it('dev mode with no signed-in test user sends you to the login page first', async () => {
    renderApp('/', { session: { dev_mode: true } });
    expect(await screen.findByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Surfaces' })).not.toBeInTheDocument();
  });
});
