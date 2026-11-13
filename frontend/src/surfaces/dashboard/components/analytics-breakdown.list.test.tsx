import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { DashboardAnalytics, ProjectFilterRow } from '../api/types';
import { AnalyticsBreakdown } from './analytics-breakdown';
import { ProjectListProvider } from './project-list-dialog';

/** Owner ask 2026-11-13: a chart bucket lists its projects. Recharts draws no
 *  bars in jsdom, so the hub legend rows (same open path) are exercised. */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

const drill = vi.hoisted(() => ({ useDrilldownProjects: vi.fn() }));
vi.mock('../hooks/use-dashboard', () => ({
  useDrilldownProjects: (...a: unknown[]) => drill.useDrilldownProjects(...a) as unknown,
}));

const DATA: DashboardAnalytics = {
  by_type: [{ key: 'CO', count: 1, share_pct: 50 }],
  by_category: [{ key: 'B', count: 2, share_pct: 100 }],
  by_hub: [
    { key: 'PD-India', count: 1, share_pct: 50 },
    { key: 'R&D-Greece', count: 1, share_pct: 50 },
  ],
  by_reg_year: [{ key: '2026', count: 2, share_pct: 100 }],
  completing_hub_type: [],
  completing_by_type: [],
  completing_by_hub: [],
  has_active_schedule_run: true,
};

const row = (name: string, hub: string): ProjectFilterRow =>
  ({
    project_id: name,
    project_name: name,
    hub,
    region: hub === 'PD-India' ? 'India' : 'Greece',
    status: 'In Development',
    category: 'B',
    type: 'CO',
    priority: 'P2',
    reg_year: 2026,
    carry_over: false,
    end_week: null,
    external_code: null,
  }) as unknown as ProjectFilterRow;

describe('AnalyticsBreakdown click-to-list', () => {
  it('a hub legend row lists that hub (By hub has no filter, so rows open lists)', async () => {
    drill.useDrilldownProjects.mockReturnValue({
      data: { total_count: 2, rows: [row('India one', 'PD-India'), row('Greece one', 'R&D-Greece')] },
      isPending: false,
      isError: false,
    });
    renderWithProviders(
      <ProjectListProvider scope={{ hubId: null, region: null, selection: { categories: [], types: [] } }}>
        <AnalyticsBreakdown data={DATA} pipelineTotal={2} />
      </ProjectListProvider>,
    );
    const legend = screen.getByRole('list', { name: 'Pipeline projects by hub' });
    await userEvent.click(within(legend).getByRole('button', { name: /^PD-India: 1 projects/ }));
    expect(screen.getByTestId('project-list-dialog-title')).toHaveTextContent('Hub · PD-India — 1 project');
    const dialog = screen.getByTestId('project-list-dialog');
    expect(within(dialog).getAllByRole('link').map((a) => a.textContent)).toEqual(['India one']);
  });

  it('without a project list the hub legend stays a plain list', () => {
    renderWithProviders(<AnalyticsBreakdown data={DATA} pipelineTotal={2} />);
    expect(screen.queryByTestId('analytics-open-legend')).not.toBeInTheDocument();
  });
});
