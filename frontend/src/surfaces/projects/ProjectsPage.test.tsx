import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import type { ProjectFilterParams, ProjectFilterResult } from '@/surfaces/dashboard/api/types';

const useDashboardProjects = vi.fn();
const useHubs = vi.fn();

vi.mock('@/surfaces/dashboard/hooks/use-dashboard', () => ({
  useDashboardProjects: (params: ProjectFilterParams) => useDashboardProjects(params),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => useHubs(),
}));
vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({
  askAgent: vi.fn(),
}));

import ProjectsPage from './ProjectsPage';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';

function ok(rows: ProjectFilterResult['rows']): UseQueryResult<ProjectFilterResult> {
  return {
    data: { total_count: rows.length, rows },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as UseQueryResult<ProjectFilterResult>;
}

function row(id: string, overrides: Partial<ProjectFilterResult['rows'][number]> = {}) {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece' as const,
    category: 'A+' as const,
    status: 'In Development' as const,
    priority: 'P1' as const,
    is_vip: false,
    tracking_status: 'idle' as const,
    ...P13_ROW_DEFAULTS,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubs.mockReturnValue({ data: [{ id: 'hub-greece', name: 'R&D-Greece' }] });
});

describe('ProjectsPage', () => {
  it('P12 (ADR 0020): the hub comes from the global header filter, not a local select', () => {
    useHubFilterStore.setState({ hubId: 'hub-greece' });
    try {
      useDashboardProjects.mockReturnValue(ok([]));
      renderWithProviders(<ProjectsPage />);
      expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ hub_id: 'hub-greece' }));
      expect(screen.queryByRole('combobox', { name: 'Hub' })).not.toBeInTheDocument();
      expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hub: R&D-Greece');
      expect(screen.getByText('No projects match these filters')).toBeInTheDocument();
    } finally {
      useHubFilterStore.setState({ hubId: null, region: null });
    }
  });

  it('requests the unfiltered list and renders one feature card per row, with Ask the agent on each', () => {
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha cooler refresh' }), row('b', { project_name: 'Beta chest freezer' })]),
    );
    renderWithProviders(<ProjectsPage />);

    expect(useDashboardProjects).toHaveBeenCalledWith({
      hub_id: undefined,
      category: undefined,
      status_: undefined,
      priority: undefined,
    });
    expect(screen.getByRole('link', { name: /Alpha cooler refresh/ })).toHaveAttribute(
      'href',
      '/projects/a',
    );
    expect(screen.getAllByRole('button', { name: 'Ask the agent' })).toHaveLength(2);
  });

  it('passes a chosen filter through to the data hook (server-side filtering)', async () => {
    useDashboardProjects.mockReturnValue(ok([]));
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'A+' }));

    expect(useDashboardProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'A+' }),
    );
  });

  it('renders an error state with retry when the list fails to load', () => {
    const refetch = vi.fn();
    useDashboardProjects.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch,
    } as unknown as UseQueryResult<ProjectFilterResult>);
    renderWithProviders(<ProjectsPage />);

    expect(screen.getByText('The project list could not be loaded.')).toBeInTheDocument();
  });

  it('renders an empty state when nothing matches', () => {
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);

    expect(screen.getByText('No projects')).toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    useDashboardProjects.mockReturnValue(ok([row('a'), row('b', { priority: null, category: null })]));
    const { container } = renderWithProviders(<ProjectsPage />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
