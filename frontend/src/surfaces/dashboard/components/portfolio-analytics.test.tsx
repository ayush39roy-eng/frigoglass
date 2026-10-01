import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYearRow } from '../api/types';
import { PortfolioAnalytics } from './portfolio-analytics';

function row(
  id: string,
  overrides: Partial<CompletingWithinYearRow> = {},
): CompletingWithinYearRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A+',
    priority: 'P1',
    within_year: true,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: 40,
    ...overrides,
  };
}

describe('PortfolioAnalytics', () => {
  it('renders all three views of the same completing-within-year rows', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} />);
    expect(screen.getByRole('heading', { name: 'Portfolio analytics' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Finish-week distribution' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delivery by priority' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Outcomes by hub' })).toBeInTheDocument();
  });

  it('counts the within-year share per priority band from the rows own flags', () => {
    renderWithProviders(
      <PortfolioAnalytics
        rows={[
          row('a', { priority: 'P1', within_year: true }),
          row('b', { priority: 'P1', within_year: true }),
          row('c', { priority: 'P1', within_year: false, spillover: true }),
          row('d', { priority: 'Q', within_year: false, left_out: true }),
        ]}
      />,
    );
    // P1: 2 of 3 within year = 67%. Q: 0 of 1 = 0%.
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByText('67%')).toBeInTheDocument();
    expect(screen.getByText('0 of 1')).toBeInTheDocument();
  });

  it('omits priority bands with no projects rather than printing an empty ring', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a', { priority: 'P1' })]} />);
    expect(screen.getByText('P1')).toBeInTheDocument();
    expect(screen.queryByText('P4')).not.toBeInTheDocument();
  });

  it('stacks each hub by the shared outcome precedence — blocked wins over within_year', () => {
    renderWithProviders(
      <PortfolioAnalytics
        rows={[
          // Both flags set: `outcomeOf` must file this under blocked, exactly as
          // the backend's `blocked_count` does (P9-F02), so the chart cannot
          // disagree with the KPI tiles above it.
          row('a', { hub: 'PD-India', within_year: true, blocked: true }),
          row('b', { hub: 'PD-India', within_year: true }),
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'Outcome counts per hub' });
    expect(within(list).getByText('PD-India')).toBeInTheDocument();
    expect(within(list).getByTitle('PD-India: 1 blocked')).toBeInTheDocument();
    expect(within(list).getByTitle('PD-India: 1 within year')).toBeInTheDocument();
  });

  it('orders hubs by how many projects each has in the run', () => {
    renderWithProviders(
      <PortfolioAnalytics
        rows={[
          row('a', { hub: 'R&D-Greece' }),
          row('b', { hub: 'PD-India' }),
          row('c', { hub: 'PD-India' }),
          row('d', { hub: 'PD-India' }),
        ]}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Outcome counts per hub' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('PD-India');
    expect(items[0]).toHaveTextContent('3');
    expect(items[1]).toHaveTextContent('R&D-Greece');
  });

  it('says so plainly when the run has no scheduled finish weeks, instead of drawing an empty chart', () => {
    renderWithProviders(
      <PortfolioAnalytics rows={[row('a', { last_step_end_week: null, within_year: false, left_out: true })]} />,
    );
    expect(screen.getByText('No scheduled finish weeks in this run.')).toBeInTheDocument();
  });

  it('exposes each chart definition behind a named affordance rather than as body copy', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} />);
    expect(screen.getByRole('button', { name: 'About Finish-week distribution' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Delivery by priority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Outcomes by hub' })).toBeInTheDocument();
  });

  it('shows no engineer, owner or avatar anywhere (OPEN_QUESTIONS #8)', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a'), row('b', { hub: 'PD-India' })]} />);
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
