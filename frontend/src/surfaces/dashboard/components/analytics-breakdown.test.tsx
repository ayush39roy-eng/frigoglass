import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { DashboardAnalytics } from '../api/types';
import { AnalyticsBreakdown } from './analytics-breakdown';

const DATA: DashboardAnalytics = {
  by_type: [
    { key: 'CO', count: 89, share_pct: 37.71 },
    { key: 'Unmapped', count: 3, share_pct: 1.27 },
  ],
  by_category: [
    { key: 'B', count: 162, share_pct: 68.64 },
    { key: 'A+', count: 7, share_pct: 2.97 },
  ],
  by_hub: [{ key: 'PD-India', count: 180, share_pct: 76.27 }],
  by_reg_year: [
    { key: '2026', count: 160, share_pct: 67.8 },
    { key: 'Unknown', count: 2, share_pct: 0.85 },
  ],
  completing_hub_type: [
    { hub: 'PD-India', type: 'CO', pipeline_count: 82, completing_count: 7, completing_pct: 8.54 },
  ],
  completing_by_type: [{ key: 'CO', pipeline_count: 89, completing_count: 10, completing_pct: 11.24 }],
  completing_by_hub: [{ key: 'PD-India', pipeline_count: 180, completing_count: 14, completing_pct: 7.78 }],
  has_active_schedule_run: true,
};

describe('AnalyticsBreakdown (P13-T10)', () => {
  it('states every served bucket verbatim (count + served share)', () => {
    renderWithProviders(<AnalyticsBreakdown data={DATA} pipelineTotal={236} />);
    const byType = screen.getByRole('list', { name: 'Pipeline projects by project type' });
    expect(byType).toHaveTextContent('Cost Optimization: 89 (37.71%)');
    expect(byType).toHaveTextContent('Unmapped: 3 (1.27%)');
    const byYear = screen.getByRole('list', { name: 'Pipeline projects by registration year' });
    expect(byYear).toHaveTextContent('2026: 160 (67.8%)');
    expect(byYear).toHaveTextContent('Unknown: 2 (0.85%)');
    const byHub = screen.getByLabelText('Pipeline projects by hub');
    expect(byHub).toHaveTextContent('PD-India');
    expect(byHub).toHaveTextContent('76.27%');
    const byCategory = screen.getByLabelText('Pipeline projects by category');
    expect(byCategory).toHaveTextContent('68.64%');
    expect(screen.getByRole('list', { name: 'Pipeline vs completing by project type' })).toHaveTextContent(
      'Cost Optimization: pipeline 89, completing 10 (11.24%)',
    );
  });

  it('puts the served pipeline total in each donut centre, and omits it when not given', () => {
    const { unmount } = renderWithProviders(<AnalyticsBreakdown data={DATA} pipelineTotal={236} />);
    expect(screen.getAllByText('236')).toHaveLength(2);
    unmount();
    renderWithProviders(<AnalyticsBreakdown data={DATA} />);
    expect(screen.queryByText('236')).not.toBeInTheDocument();
  });

  it('without an active run, explains the missing completion breakdown and still shows the pipeline charts', () => {
    renderWithProviders(
      <AnalyticsBreakdown
        data={{ ...DATA, has_active_schedule_run: false, completing_hub_type: [], completing_by_type: [], completing_by_hub: [] }}
      />,
    );
    expect(screen.getByText(/No active schedule run yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Pipeline projects by project type' })).toBeInTheDocument();
  });

  it('shows empty states for empty buckets', () => {
    renderWithProviders(
      <AnalyticsBreakdown data={{ ...DATA, by_type: [], by_category: [], by_hub: [], by_reg_year: [] }} />,
    );
    expect(screen.getAllByText('No pipeline projects in view.').length).toBe(4);
  });

  it('has no serious axe violations', async () => {
    const { container } = renderWithProviders(<AnalyticsBreakdown data={DATA} pipelineTotal={236} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
