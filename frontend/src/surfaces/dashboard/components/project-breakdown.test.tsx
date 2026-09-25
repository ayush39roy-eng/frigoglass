import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import type { ProjectFilterParams, ProjectFilterResult } from '../api/types';

const useDashboardProjects = vi.fn();
const useHubs = vi.fn();

vi.mock('../hooks/use-dashboard', () => ({
  useDashboardProjects: (params: ProjectFilterParams) => useDashboardProjects(params),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => useHubs(),
}));

import { ProjectBreakdown } from './project-breakdown';

function ok(rows: ProjectFilterResult['rows']): UseQueryResult<ProjectFilterResult> {
  return {
    data: { total_count: rows.length, rows },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as UseQueryResult<ProjectFilterResult>;
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubs.mockReturnValue({ data: [{ id: 'hub-greece', name: 'R&D-Greece' }] });
});

describe('ProjectBreakdown', () => {
  it('requests the unfiltered list on first render and shows its total count', () => {
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectBreakdown />);
    expect(useDashboardProjects).toHaveBeenCalledWith({
      hub_id: undefined,
      category: undefined,
      status_: undefined,
      priority: undefined,
    });
  });

  it('passes a chosen category filter through to the data hook (server-side filtering)', async () => {
    useDashboardProjects.mockReturnValue(ok([]));
    const user = userEvent.setup();
    renderWithProviders(<ProjectBreakdown />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'A+' }));

    expect(useDashboardProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: 'A+' }),
    );
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

    await user.click(screen.getByRole('combobox', { name: 'Priority' }));
    await user.click(await screen.findByRole('option', { name: 'P1' }));

    expect(screen.getByText(/No projects match these filters/i)).toBeInTheDocument();
  });
});
