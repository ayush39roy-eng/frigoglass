import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';

const client = { apiGet: vi.fn(), apiSend: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (...a: unknown[]) => client.apiGet(...a),
    apiSend: (...a: unknown[]) => client.apiSend(...a),
  };
});

import type { VipProject, VipProjectsResponse } from './api';
import VipProjectsPage from './VipProjectsPage';

function vip(rank: number, overrides: Partial<VipProject> = {}): VipProject {
  return {
    rank,
    selection: 'auto',
    project_id: `p${String(rank)}`,
    name: `Project ${String(rank)}`,
    category: 'A',
    priority: 'P1',
    score: 80 - rank,
    expected_end_week: 44,
    projected_end_week: 47,
    within_year: true,
    health: 'at_risk',
    progress_pct: 35,
    current_stage: { step_id: 'PDD-E', step_name: 'Design Detailing', status: 'In Progress' },
    tracking_status: 'due',
    ...overrides,
  };
}

const PLAN: VipProjectsResponse = {
  run_id: 'run-42',
  year: 'plan',
  week_range: [1, 52],
  limit: 15,
  hubs: [
    {
      hub_id: 'hub-gr',
      hub: 'R&D-Greece',
      pinned_count: 1,
      over_limit: false,
      projects: [
        vip(1, { name: 'Pinned Cooler', selection: 'pinned', project_id: 'pin-1' }),
        vip(2, { name: 'Auto Freezer', current_stage: { step_id: 'LAB', step_name: 'Lab Test', status: 'Blocked' } }),
        vip(3, { name: 'Late Chiller', within_year: false, projected_end_week: 60, health: 'off_track', progress_pct: null, current_stage: null }),
      ],
    },
    {
      hub_id: 'hub-in',
      hub: 'R&D-India',
      pinned_count: 16,
      over_limit: true,
      projects: [vip(1, { name: 'India One', selection: 'pinned', project_id: 'in-1' })],
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null });
  client.apiGet.mockImplementation((path: string, opts: { query: { year: string } }) => {
    if (path === '/vip-projects') {
      return Promise.resolve(opts.query.year === 'next' ? { ...PLAN, year: 'next', week_range: [53, 78], hubs: [] } : PLAN);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  client.apiSend.mockResolvedValue({ project_id: 'p2', is_vip: true });
});

function cardOf(name: string): HTMLElement {
  const el = screen.getByRole('link', { name }).closest<HTMLElement>('[data-testid="vip-card"]');
  if (!el) throw new Error(`no card ${name}`);
  return el;
}

describe('VipProjectsPage — served ranking display', () => {
  it('requests the plan year with the default limit and shows per-hub sections in served order', async () => {
    renderWithProviders(<VipProjectsPage />);
    await screen.findByRole('link', { name: 'Pinned Cooler' });
    expect(client.apiGet).toHaveBeenCalledWith('/vip-projects', expect.objectContaining({ query: { year: 'plan', hub_id: undefined, limit: 15 } }));
    const hubs = screen.getAllByTestId('vip-hub');
    expect(hubs.map((h) => within(h).getByRole('heading', { level: 2 }).textContent)).toEqual(['R&D-Greece', 'R&D-India']);
    const greece = hubs[0];
    if (!greece) throw new Error('no hub');
    expect(within(greece).getAllByTestId('vip-rank').map((r) => r.textContent)).toEqual(['1', '2', '3']);
    expect(within(greece).getAllByRole('link').map((l) => l.textContent)).toEqual(['Pinned Cooler', 'Auto Freezer', 'Late Chiller']);
    expect(screen.getByTestId('vip-week-range')).toHaveTextContent('Weeks 1–52');
  });

  it('shows the pinned/auto marker, expected vs projected, within-year, health, progress, stage and tracking as served', async () => {
    renderWithProviders(<VipProjectsPage />);
    await screen.findByRole('link', { name: 'Pinned Cooler' });
    const pinned = cardOf('Pinned Cooler');
    expect(within(pinned).getByTestId('vip-selection')).toHaveTextContent('Pinned');
    expect(within(pinned).getByTestId('vip-expected-projected')).toHaveTextContent('Expected W44 · Projected W47');
    expect(within(pinned).getByTestId('finish-chip')).toHaveTextContent('Within year');
    expect(within(pinned).getByTestId('health-chip')).toHaveTextContent('At risk');
    expect(within(pinned).getByTestId('vip-progress')).toHaveTextContent('35 %');
    expect(within(pinned).getByRole('progressbar')).toHaveAttribute('aria-valuenow', '35');
    expect(within(pinned).getByTestId('tracking-status-chip')).toHaveTextContent('Due this week');
    expect(within(cardOf('Auto Freezer')).getByTestId('vip-selection')).toHaveTextContent('Auto');
    // ADR 0017: a stage on hold reads "On Hold", never "Blocked".
    expect(within(cardOf('Auto Freezer')).getByTestId('vip-current-stage')).toHaveTextContent('Lab Test · On Hold');
    const late = cardOf('Late Chiller');
    expect(within(late).getByTestId('finish-chip')).toHaveTextContent('Past W52');
    expect(within(late).getByTestId('vip-progress')).toHaveTextContent('—');
    expect(within(late).getByTestId('vip-current-stage')).toHaveTextContent('No open stage');
  });

  it('flags a hub whose pins exceed the limit (over_limit), and only that hub', async () => {
    renderWithProviders(<VipProjectsPage />);
    await screen.findByRole('link', { name: 'India One' });
    const notices = screen.getAllByTestId('vip-over-limit');
    expect(notices).toHaveLength(1);
    expect(notices[0]).toHaveTextContent('More projects are pinned (16) than the list limit of 15');
    expect(notices[0]?.closest('[data-testid="vip-hub"]')).toHaveAttribute('data-hub-id', 'hub-in');
  });

  it('the year toggle and the hub filter go into the request', async () => {
    useHubFilterStore.setState({ hubId: 'hub-gr' });
    const user = userEvent.setup();
    renderWithProviders(<VipProjectsPage />);
    await screen.findByRole('link', { name: 'Pinned Cooler' });
    await user.click(screen.getByRole('radio', { name: 'Next year, weeks 53 to 78' }));
    await waitFor(() =>
      expect(client.apiGet).toHaveBeenCalledWith('/vip-projects', expect.objectContaining({ query: { year: 'next', hub_id: 'hub-gr', limit: 15 } })),
    );
    expect(await screen.findByText('No VIP projects')).toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<VipProjectsPage />);
    await screen.findByRole('link', { name: 'Pinned Cooler' });
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('VipProjectsPage — pin control gating (ADR 0022 §4)', () => {
  it('without Registration write (Executive Viewer) there is no pin control', async () => {
    renderWithProviders(<VipProjectsPage />, { session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    await screen.findByRole('link', { name: 'Pinned Cooler' });
    expect(screen.queryAllByTestId('vip-pin-toggle')).toHaveLength(0);
  });

  it('with Registration write (Hub Planner) pins an auto project and unpins a pinned one via PUT /projects/{id}/vip', async () => {
    const user = userEvent.setup();
    renderWithProviders(<VipProjectsPage />, { session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    await screen.findByRole('link', { name: 'Pinned Cooler' });
    await user.click(screen.getByRole('button', { name: 'Pin Auto Freezer as VIP' }));
    await waitFor(() => expect(client.apiSend).toHaveBeenCalledWith('PUT', '/projects/p2/vip', { is_vip: true }));
    await user.click(screen.getByRole('button', { name: 'Unpin Pinned Cooler' }));
    await waitFor(() => expect(client.apiSend).toHaveBeenCalledWith('PUT', '/projects/pin-1/vip', { is_vip: false }));
  });

  it('a failed pin shows the error on that card', async () => {
    client.apiSend.mockRejectedValue(new ApiError(403, 'Forbidden', 'nope'));
    const user = userEvent.setup();
    renderWithProviders(<VipProjectsPage />, { session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    await screen.findByRole('link', { name: 'Auto Freezer' });
    await user.click(screen.getByRole('button', { name: 'Pin Auto Freezer as VIP' }));
    expect(await within(cardOf('Auto Freezer')).findByRole('alert')).toBeInTheDocument();
  });
});
