import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { renderApp } from '@/test/render';
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
    expect(await screen.findByRole('heading', { name: 'Sign in to RPD' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Surfaces' })).not.toBeInTheDocument();
  });

  it('a network failure is retryable', async () => {
    const user = userEvent.setup();
    api.fetchMe
      .mockRejectedValueOnce(new ApiError(0, 'Network request failed'))
      .mockResolvedValueOnce(makeMe());
    renderApp('/', { session: null });
    expect(await screen.findByText('Could not load your session')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
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
    renderApp('/', { session: { dev_mode: true } });
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    expect(screen.getByTestId('dev-role-switcher')).toBeInTheDocument();

    await user.click(await screen.findByRole('combobox', { name: 'Dev mode: act as user' }));
    await user.click(await screen.findByRole('option', { name: /Ellie Exec/ }));

    await waitFor(() => expect(getDevUserEmail()).toBe('ellie.exec@example.com'));
    await waitFor(() => expect(api.fetchMe).toHaveBeenCalled());
    expect(await screen.findByText('Ellie Exec')).toBeInTheDocument();
  });
});
