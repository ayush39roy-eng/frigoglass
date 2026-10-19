import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { permissionsFrom } from '@/test/session';
import { useHubFilterStore } from '@/stores/hub-filter';
import type { ProjectFilterParams, ProjectFilterResult, ProjectFilterRow, RegionSummary } from '../api/types';

const useDashboardProjects = vi.fn();
const useProjectFacets = vi.fn();
const useRegionSummary = vi.fn();
const useHubs = vi.fn();

vi.mock('../hooks/use-dashboard', () => ({
  useDashboardProjects: (params: ProjectFilterParams) => useDashboardProjects(params),
  useProjectFacets: (...a: unknown[]) => useProjectFacets(...a),
  useRegionSummary: (...a: unknown[]) => useRegionSummary(...a),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => useHubs(),
}));
// The register is virtualised; jsdom has no layout, so render every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () => Array.from({ length: count }, (_, index) => ({ index, start: index * 60, key: index })),
    getTotalSize: () => count * 60,
    measureElement: () => undefined,
  }),
}));

import { ProjectBreakdown } from './project-breakdown';

const HUBS = [
  { id: 'hub-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
  { id: 'hub-pdin', name: 'PD-India', lab_region: 'India', is_oem: false },
  { id: 'hub-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false },
];

function row(over: Partial<ProjectFilterRow> = {}): ProjectFilterRow {
  return {
    project_id: 'p-1',
    project_name: 'Ice cooler ICOOL-7',
    hub: 'PD-India',
    category: 'A',
    status: 'In Development',
    priority: 'P1',
    is_vip: false,
    tracking_status: 'idle',
    external_code: '24-00221_1',
    type: 'CO',
    region: 'India',
    leader_name: 'Rishi',
    leader_engineer_id: 'eng-1',
    current_step_code: 'PDD-E',
    current_step_name: 'Design Detailing',
    end_week: 43,
    outcome: 'WITHIN_YEAR',
    reg_year: 2026,
    carry_over: false,
    priority_rank: 1,
    ...over,
  };
}

function ok(rows: ProjectFilterRow[], total = rows.length): UseQueryResult<ProjectFilterResult> {
  return {
    data: { total_count: total, rows },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as UseQueryResult<ProjectFilterResult>;
}

const SUMMARY: RegionSummary = {
  total_count: 236,
  regions: [
    {
      region: 'Greece',
      total_count: 30,
      share_pct: 12.71,
      spillover_count: 9,
      newly_registered_count: 21,
      status_counts: { Commercialized: 4, 'Under Industrialization': 6, 'In Development': 8, 'In Queue': 12 },
      status_share_pct: {},
    },
    {
      region: 'India',
      total_count: 182,
      share_pct: 77.12,
      spillover_count: 59,
      newly_registered_count: 123,
      status_counts: { Commercialized: 11, 'Under Industrialization': 50, 'In Development': 33, 'In Queue': 97 },
      status_share_pct: {},
    },
    {
      region: 'Romania',
      total_count: 24,
      share_pct: 10.17,
      spillover_count: 4,
      newly_registered_count: 20,
      status_counts: { Commercialized: 2, 'Under Industrialization': 3, 'In Development': 9, 'In Queue': 10 },
      status_share_pct: {},
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null, region: null });
  useHubs.mockReturnValue({ data: HUBS });
  useProjectFacets.mockReturnValue({
    data: {
      leaders: [{ id: 'eng-1', name: 'Rishi' }],
      steps: [{ code: 'PDD-E', name: 'Design Detailing' }],
    },
  });
  useRegionSummary.mockReturnValue({ data: SUMMARY });
});
afterEach(() => {
  vi.useRealTimers();
  useHubFilterStore.setState({ hubId: null, region: null });
});

describe('All registered projects register (P13, ADR 0025 §5)', () => {
  it('requests the unfiltered list on first render (same params as before P13)', () => {
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectBreakdown />);
    expect(useDashboardProjects).toHaveBeenCalledWith({
      hub_id: undefined,
      category: undefined,
      status_: undefined,
      priority: undefined,
    });
    expect(useProjectFacets).toHaveBeenLastCalledWith(null, null);
    expect(useRegionSummary).toHaveBeenLastCalledWith(null, null);
  });

  it('shows the served total_count and every contract column, with no Plant / Req. dept / Delete', () => {
    useDashboardProjects.mockReturnValue(ok([row()], 236));
    renderWithProviders(<ProjectBreakdown />);
    expect(screen.getByTestId('register-total')).toHaveTextContent('236 projects');
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual([
      '#',
      'Hub',
      'Cat',
      'Type',
      'Status',
      'Project',
      'Leader',
      'End wk',
      'Current step',
      'Priority',
      'Actions',
    ]);
    const table = screen.getByRole('table', { name: 'All registered projects' });
    const cells = within(table).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(
      expect.arrayContaining(['1', 'PD-India', 'CO', 'Rishi', 'W43', 'PDD-EDesign Detailing']),
    );
    expect(screen.queryByText(/Plant/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Req\. dept/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/i })).not.toBeInTheDocument();
  });

  it('prints a finish past W52 as "After W52" (ADR 0024) and a missing week as a dash', () => {
    useDashboardProjects.mockReturnValue(
      ok([row({ project_id: 'a', end_week: 60 }), row({ project_id: 'b', project_name: 'B', end_week: null })]),
    );
    renderWithProviders(<ProjectBreakdown />);
    expect(screen.getByText('After W52')).toBeInTheDocument();
  });

  it('Open always links to the workspace; Edit only with Registration write', () => {
    useDashboardProjects.mockReturnValue(ok([row()]));
    const { unmount } = renderWithProviders(<ProjectBreakdown />, {
      session: { permissions: permissionsFrom({ dashboard: 'r', project_registration: 'r' }) },
    });
    expect(screen.getByRole('link', { name: 'Open Ice cooler ICOOL-7' })).toHaveAttribute('href', '/projects/p-1');
    expect(screen.queryByRole('link', { name: 'Edit Ice cooler ICOOL-7' })).not.toBeInTheDocument();
    unmount();

    renderWithProviders(<ProjectBreakdown />, {
      session: { permissions: permissionsFrom({ dashboard: 'r', project_registration: 'rw' }) },
    });
    expect(screen.getByRole('link', { name: 'Edit Ice cooler ICOOL-7' })).toHaveAttribute(
      'href',
      '/register?edit=p-1',
    );
  });

  it('renders the per-country summary row from region-summary (Comm. / Ind. / Dev. / Que)', () => {
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectBreakdown />);
    const summary = screen.getByTestId('register-region-summary');
    const items = within(summary).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[1]).toHaveTextContent('India');
    expect(items[1]).toHaveTextContent('Comm. 11');
    expect(items[1]).toHaveTextContent('Ind. 50');
    expect(items[1]).toHaveTextContent('Dev. 33');
    expect(items[1]).toHaveTextContent('Que 97');
  });

  it('sends type, status, leader and current step to the server', async () => {
    useDashboardProjects.mockReturnValue(ok([]));
    const user = userEvent.setup();
    renderWithProviders(<ProjectBreakdown />);

    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: /^CO ·/ }));
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'In Queue' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader' }));
    await user.click(await screen.findByRole('option', { name: 'Rishi' }));
    await user.click(screen.getByRole('combobox', { name: 'Current step' }));
    await user.click(await screen.findByRole('option', { name: 'PDD-E · Design Detailing' }));

    expect(useDashboardProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: 'CO',
        status_: 'In Queue',
        leader_engineer_id: 'eng-1',
        current_step: 'PDD-E',
      }),
    );
  });

  it('debounces the search and sends it as q', async () => {
    useDashboardProjects.mockReturnValue(ok([]));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderWithProviders(<ProjectBreakdown />);
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'icool');
    expect(useDashboardProjects).not.toHaveBeenCalledWith(expect.objectContaining({ q: 'icoo' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'icool' }));
  });

  it('follows the global country filter and its Hub select narrows to that country, setting the global hub', async () => {
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    useDashboardProjects.mockReturnValue(ok([]));
    const user = userEvent.setup();
    renderWithProviders(<ProjectBreakdown />);
    expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'India' }));
    expect(useProjectFacets).toHaveBeenLastCalledWith(null, 'India');

    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All', 'PD-India']);
    await user.click(screen.getByRole('option', { name: 'PD-India' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: 'hub-pdin', region: null });
    expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ hub_id: 'hub-pdin' }));
  });

  it('renders an error state with retry when the list fails to load', () => {
    useDashboardProjects.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    } as unknown as UseQueryResult<ProjectFilterResult>);
    renderWithProviders(<ProjectBreakdown />);
    expect(screen.getByRole('alert')).toHaveTextContent(/could not be loaded/i);
  });

  it('shows a filtered-empty message once a filter is applied and nothing matches', async () => {
    useDashboardProjects.mockReturnValue(ok([]));
    const user = userEvent.setup();
    renderWithProviders(<ProjectBreakdown />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'A+' }));

    expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ category: 'A+' }));
    expect(screen.getByText(/No projects match these filters/i)).toBeInTheDocument();
  });

  it('ADR 0028: a leader id with no name renders as "Name unavailable" and stays a distinct filter option', async () => {
    useDashboardProjects.mockReturnValue(ok([row({ leader_name: null, leader_engineer_id: 'eng-abcd1234' })]));
    useProjectFacets.mockReturnValue({
      data: {
        leaders: [
          { id: 'eng-abcd1234', name: null },
          { id: 'eng-ffff9999', name: null },
        ],
        steps: [],
      },
    });
    const user = userEvent.setup();
    renderWithProviders(<ProjectBreakdown />);
    expect(screen.getByText('Name unavailable')).toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Leader' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All', 'Leader (name unavailable) · 1234', 'Leader (name unavailable) · 9999']);
    await user.click(screen.getByRole('option', { name: 'Leader (name unavailable) · 9999' }));
    expect(useDashboardProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ leader_engineer_id: 'eng-ffff9999' }),
    );
  });

  it('Table/Cards tabs: aria-controls only on the active tab, and it resolves to the mounted panel (P13-R01)', async () => {
    useDashboardProjects.mockReturnValue(ok([row()]));
    const user = userEvent.setup();
    renderWithProviders(<ProjectBreakdown />);
    const tableTab = screen.getByRole('tab', { name: 'Table' });
    const cardsTab = screen.getByRole('tab', { name: 'Cards' });
    const check = (active: HTMLElement, inactive: HTMLElement) => {
      const id = active.getAttribute('aria-controls');
      expect(id).toBeTruthy();
      const panel = document.getElementById(id ?? '');
      expect(panel).toHaveAttribute('role', 'tabpanel');
      expect(panel).toHaveAttribute('aria-labelledby', active.id);
      expect(inactive).not.toHaveAttribute('aria-controls');
    };
    check(tableTab, cardsTab);
    await user.click(cardsTab);
    check(cardsTab, tableTab);
  });
});
