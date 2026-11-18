import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { makeMe } from '@/test/session';
import { useSessionStore } from '@/stores/session';

const api = { fetchMe: vi.fn(), fetchDevUsers: vi.fn(), devLogin: vi.fn() };
vi.mock('@/lib/api/session', () => ({
  fetchMe: () => api.fetchMe(),
  fetchDevUsers: () => api.fetchDevUsers(),
  devLogin: (body: unknown) => api.devLogin(body),
}));

// P46 (ADR 0058 L1): the two served test accounts.
const SUPER = { email: 'superadmin@example.com', full_name: 'Super Admin', roles: ['Super Admin'] };
const ADMIN = { email: 'admin@example.com', full_name: 'Admin', roles: ['Admin'] };

import LoginPage from './login';

beforeEach(() => {
  vi.clearAllMocks();
  useSessionStore.getState().reset();
  setDevUserEmail(null);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('LoginPage (ADR 0013, P46 / ADR 0058)', () => {
  it('P46: dev mode shows only the username/email + password form; no account, email or password hint is rendered', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([ADMIN, SUPER]);
    api.devLogin.mockResolvedValue(SUPER);
    api.fetchMe.mockResolvedValue(makeMe({ email: SUPER.email, full_name: SUPER.full_name, dev_mode: true }));

    const { container } = renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-dev-picker')).toBeInTheDocument();
    expect(screen.getByLabelText('Username or email')).toHaveValue('');
    expect(screen.getByLabelText('Password')).toHaveValue('');
    // Owner 2026-11-18: the served dev users decide dev mode only; none is shown.
    const text = container.textContent ?? '';
    for (const needle of ['superadmin', 'admin@example.com', 'Super Admin', '@example.com', 'password = username', 'Test logins', 'rpd-test-2026']) {
      expect(text).not.toContain(needle);
    }
    expect(container.innerHTML).not.toMatch(/superadmin|@example\.com/);
    expect(screen.queryByTestId('test-logins')).toBeNull();
    expect(screen.queryAllByRole('button', { name: /^Use / })).toHaveLength(0);

    await user.type(screen.getByLabelText('Username or email'), 'superadmin');
    await user.type(screen.getByLabelText('Password'), 'superadmin');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(api.devLogin).toHaveBeenCalledWith({ username: 'superadmin', password: 'superadmin' });
    await waitFor(() => expect(getDevUserEmail()).toBe('superadmin@example.com'));
    await waitFor(() => expect(useSessionStore.getState().status).toBe('ready'));
  });

  it('P46: the email works as the username, and the server-returned user is signed in', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
    api.devLogin.mockResolvedValue(ADMIN);
    api.fetchMe.mockResolvedValue(makeMe({ email: ADMIN.email, roles: ['Admin'], dev_mode: true }));
    renderWithProviders(<LoginPage />, { session: null });

    await user.type(await screen.findByLabelText('Username or email'), ' admin@example.com ');
    await user.type(screen.getByLabelText('Password'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(api.devLogin).toHaveBeenCalledWith({ username: 'admin@example.com', password: 'admin' });
    await waitFor(() => expect(getDevUserEmail()).toBe('admin@example.com'));
  });

  it('P31-R01: "Remember me" is on by default, so the test user lands in localStorage (survives reload / new tab)', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
    api.devLogin.mockResolvedValue(SUPER);
    api.fetchMe.mockResolvedValue(makeMe({ email: SUPER.email, dev_mode: true }));
    renderWithProviders(<LoginPage />, { session: null });

    const remember = await screen.findByRole('checkbox', { name: 'Remember me' });
    expect(remember).toBeChecked();
    await user.type(screen.getByLabelText('Username or email'), 'superadmin');
    await user.type(screen.getByLabelText('Password'), 'superadmin');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(window.localStorage.getItem('rpd-dev-user-email')).toBe('superadmin@example.com'));
    expect(window.sessionStorage.getItem('rpd-dev-user-email')).toBeNull();
  });

  it('P31-R01: unticking "Remember me" keeps the test user in this tab only', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
    api.devLogin.mockResolvedValue(SUPER);
    api.fetchMe.mockResolvedValue(makeMe({ email: SUPER.email, dev_mode: true }));
    renderWithProviders(<LoginPage />, { session: null });

    await user.click(await screen.findByRole('checkbox', { name: 'Remember me' }));
    await user.type(screen.getByLabelText('Username or email'), 'superadmin');
    await user.type(screen.getByLabelText('Password'), 'superadmin');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(window.sessionStorage.getItem('rpd-dev-user-email')).toBe('superadmin@example.com'));
    expect(window.localStorage.getItem('rpd-dev-user-email')).toBeNull();
  });

  it('P46: a wrong password (401) is refused with one plain message, without signing in', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
    api.devLogin.mockRejectedValue(new ApiError(401, 'Unauthorized'));
    renderWithProviders(<LoginPage />, { session: null });

    await user.type(await screen.findByLabelText('Username or email'), 'superadmin');
    await user.type(screen.getByLabelText('Password'), 'not-the-password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('That username and password combination is not recognised.');
    expect(api.devLogin).toHaveBeenCalledWith({ username: 'superadmin', password: 'not-the-password' });
    expect(getDevUserEmail()).toBeNull();
    expect(api.fetchMe).not.toHaveBeenCalled();
  });

  it('P46: a 429 says to wait, without signing in', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
    api.devLogin.mockRejectedValue(new ApiError(429, 'Too Many Requests', undefined, 'RATE_LIMITED', 20));
    renderWithProviders(<LoginPage />, { session: null });

    await user.type(await screen.findByLabelText('Username or email'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Too many sign-in attempts. Wait 20 s and try again.');
    expect(getDevUserEmail()).toBeNull();
  });

  it('P46: empty fields are caught before any request', async () => {
    const user = userEvent.setup();
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
    renderWithProviders(<LoginPage />, { session: null });

    await user.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter your username or email.');
    expect(api.devLogin).not.toHaveBeenCalled();
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

  it('P31-R01: a 503 from a sleeping API is retried, so a dev-mode deploy still shows the test login form', async () => {
    api.fetchDevUsers
      .mockRejectedValueOnce(new ApiError(503, 'Service Unavailable'))
      .mockResolvedValueOnce([SUPER, ADMIN]);
    renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-dev-picker', {}, { timeout: 3_000 })).toBeInTheDocument();
    expect(api.fetchDevUsers).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('login-sso-card')).not.toBeInTheDocument();
  });

  it('a network failure probing dev mode still falls back to the SSO path, with a note', async () => {
    api.fetchDevUsers.mockRejectedValue(new ApiError(0, 'network'));
    renderWithProviders(<LoginPage />, { session: null });

    expect(await screen.findByTestId('login-sso-card')).toBeInTheDocument();
    expect(screen.getByText(/Could not reach the server/)).toBeInTheDocument();
  });

  it('has no serious/critical axe violations on the dev picker', async () => {
    api.fetchDevUsers.mockResolvedValue([SUPER, ADMIN]);
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
