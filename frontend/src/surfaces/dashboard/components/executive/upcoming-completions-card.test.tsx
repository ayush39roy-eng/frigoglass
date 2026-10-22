import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { CompletingWithinYearRow } from '../../api/types';
import { UpcomingCompletionsCard } from './upcoming-completions-card';

function row(id: string, week: number | null, overrides: Partial<CompletingWithinYearRow> = {}): CompletingWithinYearRow {
  return {
    project_id: id,
    project_name: `Cooler ${id}`,
    hub: 'R&D-Greece',
    category: null,
    priority: 'P2',
    within_year: true,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: week,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

describe('UpcomingCompletionsCard', () => {
  it('lists served within-year finishes in the next 8 weeks from the served current week, soonest first', () => {
    // Session fixture: current_week 31 → window W31–W38.
    renderWithProviders(
      <UpcomingCompletionsCard
        rows={[
          row('c', 38),
          row('a', 32),
          row('x', 39),
          row('h', 33, { blocked: true }),
          row('q', 10),
          row('d', null, { status: 'Commercialized' }),
        ]}
      />,
    );
    const items = screen.getAllByTestId('exec-upcoming-row');
    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByRole('link', { name: 'Cooler a' })).toHaveAttribute('href', '/projects/a');
    expect(within(items[0]!).getByText('W32')).toBeInTheDocument();
    expect(within(items[1]!).getByText('W38')).toBeInTheDocument();
    expect(screen.getByText(/W31–W38/)).toBeInTheDocument();
    // Quarter strip: W10 → Q1, W32/W38/W39 → Q3; the blocked row is excluded.
    const quarters = screen.getAllByTestId('exec-upcoming-quarter');
    expect(quarters.map((q) => q.getAttribute('aria-label'))).toEqual([
      'Q1 (Jan–Mar): 1 completing, past',
      'Q2 (Apr–Jun): 0 completing, past',
      'Q3 (Jul–Sep): 3 completing, current quarter',
      'Q4 (Oct–Dec): 0 completing',
    ]);
    // The no-finish-week within-year row is "Delivered": 1 + 1 + 0 + 3 + 0 = 5 within-year rows.
    expect(screen.getByTestId('exec-upcoming-delivered')).toHaveAttribute('aria-label', 'Delivered (no stage left): 1');
  });

  it('caps the list and links the rest to the register', () => {
    renderWithProviders(<UpcomingCompletionsCard rows={Array.from({ length: 9 }, (_, i) => row(`p${String(i)}`, 32))} />);
    expect(screen.getAllByTestId('exec-upcoming-row')).toHaveLength(6);
    expect(screen.getByTestId('exec-upcoming-more')).toHaveTextContent('+3 more');
  });

  it('shows an empty state when nothing lands in the window', () => {
    renderWithProviders(<UpcomingCompletionsCard rows={[]} />);
    expect(screen.getByTestId('exec-upcoming-empty')).toBeInTheDocument();
  });
});
