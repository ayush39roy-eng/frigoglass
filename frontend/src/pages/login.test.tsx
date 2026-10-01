import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { TEST_LOGIN_PASSWORD } from '@/lib/auth/test-logins';
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
  setDevUserEmail(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LoginPage (ADR 0013)', () => {
  it('dev mode: test logins fill the form, and the right password signs in', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([
      { email: 'alex.admin@example.com', full_name: 'Alex Admin', roles: ['Admin'] },
      { email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin'] },
      { email: 'ellie.exec@example.com', full_name: 'Ellie Exec', roles: ['Executive Viewer'] },
    ]);
    api.fetchMe.mockResolvedValue(makeMe({ email: 'sam.super@example.com', full_name: 'Sam Super', dev_mode: true }));

    renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-dev-picker')).toBeInTheDocument();
    const accounts = screen.getAllByRole('button', { name: /^Use / });
    // One account per role, Super Admin first.
    expect(accounts[0]).toHaveAccessibleName(/Sam Super/);

    await user.click(accounts[0] as HTMLElement);
    expect(screen.getByLabelText('Email')).toHaveValue('sam.super@example.com');
    expect(screen.getByLabelText('Password')).toHaveValue(TEST_LOGIN_PASSWORD);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(getDevUserEmail()).toBe('sam.super@example.com'));
    await waitFor(() => expect(useSessionStore.getState().status).toBe('ready'));
  });

  it('dev mode: a wrong password is refused without signing in', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([
      { email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin'] },
    ]);
    renderWithProviders(<LoginPage />, { session: null });

    await user.type(await screen.findByLabelText('Email'), 'sam.super@example.com');
    await user.type(screen.getByLabelText('Password'), 'not-the-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/not recognised/);
    expect(getDevUserEmail()).toBeNull();
    expect(api.fetchMe).not.toHaveBeenCalled();
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
