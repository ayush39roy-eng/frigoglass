import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { getDevUserEmail } from '@/lib/api/dev-user';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { makeMe } from '@/test/session';
import { useSessionStore } from '@/stores/session';

const api = { fetchMe: vi.fn(), fetchDevUsers: vi.fn() };
vi.mock('@/lib/api/session', () => ({
  fetchMe: () => api.fetchMe(),
  fetchDevUsers: () => api.fetchDevUsers(),
}));

import LoginPage from './login';

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().reset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LoginPage (ADR 0013)', () => {
  it('dev mode: lists seeded users grouped by role, Super Admin first, and picking one signs in', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([
      { email: 'alex.admin@example.com', full_name: 'Alex Admin', roles: ['Admin'] },
      { email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin'] },
      { email: 'ellie.exec@example.com', full_name: 'Ellie Exec', roles: ['Executive Viewer'] },
    ]);
    api.fetchMe.mockResolvedValue(makeMe({ email: 'sam.super@example.com', full_name: 'Sam Super', dev_mode: true }));

    renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-dev-picker')).toBeInTheDocument();
    const legends = screen.getAllByRole('group');
    expect(legends[0]).toHaveTextContent('Super Admin');
    expect(legends[0]).toHaveTextContent('Start here');

    await user.click(screen.getByRole('button', { name: /Sam Super — sam.super@example.com/ }));

    await waitFor(() => expect(getDevUserEmail()).toBe('sam.super@example.com'));
    await waitFor(() => expect(useSessionStore.getState().status).toBe('ready'));
  });

  it('production path: a 404 probe (no dev mode) shows the SSO button, disabled when unconfigured', async () => {
    api.fetchDevUsers.mockRejectedValue(new ApiError(404, 'not found'));
    renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-sso-card')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Sign in with SSO/ })).toBeDisabled();
    expect(screen.getByText(/not configured for this environment/)).toBeInTheDocument();
    expect(screen.queryByTestId('login-dev-picker')).not.toBeInTheDocument();
  });

  it('production path: redirects to the issuer when VITE_OIDC_* is configured', async () => {
    vi.stubEnv('VITE_OIDC_ISSUER', 'https://idp.example.com/realms/rpd');
    vi.stubEnv('VITE_OIDC_CLIENT_ID', 'rpd-frontend');
    api.fetchDevUsers.mockRejectedValue(new ApiError(404, 'not found'));
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, assign, origin: 'https://rpd.frigoglass.example' });

    const user = userEvent.setup();
    renderWithProviders(<LoginPage />, { session: null });

    const button = await screen.findByRole('button', { name: /Sign in with SSO/ });
    expect(button).toBeEnabled();
    await user.click(button);

    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(assign.mock.calls[0]![0] as string);
    expect(url.origin + url.pathname).toBe('https://idp.example.com/realms/rpd/protocol/openid-connect/auth');
    expect(url.searchParams.get('client_id')).toBe('rpd-frontend');
    expect(url.searchParams.get('redirect_uri')).toBe('https://rpd.frigoglass.example/login');
  });

  it('a network failure probing dev mode still falls back to the SSO path, with a note', async () => {
    api.fetchDevUsers.mockRejectedValue(new ApiError(0, 'network'));
    renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-sso-card')).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument();
  });

  it('has no serious/critical axe violations on the dev picker', async () => {
    api.fetchDevUsers.mockResolvedValue([
      { email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin'] },
    ]);
    const { container } = renderWithProviders(<LoginPage />, { session: null });
    await screen.findByTestId('login-dev-picker');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('has no serious/critical axe violations on the SSO card', async () => {
    api.fetchDevUsers.mockRejectedValue(new ApiError(404, 'not found'));
    const { container } = renderWithProviders(<LoginPage />, { session: null });
    await screen.findByTestId('login-sso-card');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
