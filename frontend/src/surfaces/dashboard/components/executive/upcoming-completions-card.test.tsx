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

  it('QA-F28-1: below sm each row stacks (chip + name, then hub · priority); from sm the 4-column grid is unchanged', () => {
    renderWithProviders(
      <UpcomingCompletionsCard rows={[row('a', 32, { project_name: 'Assembled double-door cooler for Coca-Cola HBC' })]} />,
    );
    const item = screen.getByTestId('exec-upcoming-row');
    const cls = item.className.split(/\s+/);
    expect(cls).toEqual(expect.arrayContaining(['grid-cols-[auto_minmax(0,1fr)]', 'sm:grid-cols-[auto_minmax(0,1fr)_auto_auto]']));
    const [chip, link, meta] = [...item.children] as HTMLElement[];
    expect(chip).toHaveTextContent('W32');
    expect(link).toHaveRole('link');
    // The name wraps between words only: no letter-level breaking, no truncation.
    expect(link!.className).not.toMatch(/break-words|break-all|anywhere|truncate|line-clamp|whitespace-nowrap/);
    // Line 2: the meta wrapper starts under the name and dissolves into columns 3–4 from sm.
    expect(meta).toBe(within(item).getByTestId('exec-upcoming-row-meta'));
    expect(meta!.className.split(/\s+/)).toEqual(expect.arrayContaining(['col-start-2', 'sm:contents']));
    expect(meta).toHaveTextContent('R&D-Greece');
    expect(within(meta!).getByText('·')).toHaveClass('sm:hidden');
    expect(within(meta!).getByText('P2')).toBeInTheDocument();
  });

  it('QA-F28-1: the quarter strip wraps below sm (Delivered full width, quarters 2 x 2) with whole labels', () => {
    renderWithProviders(<UpcomingCompletionsCard rows={[row('a', 32)]} />);
    const strip = screen.getByTestId('exec-upcoming-strip');
    expect(strip.className.split(/\s+/)).toEqual(expect.arrayContaining(['grid-cols-2', 'sm:grid-cols-5']));
    expect(screen.getByTestId('exec-upcoming-delivered').className.split(/\s+/)).toEqual(
      expect.arrayContaining(['col-span-2', 'sm:col-span-1']),
    );
    for (const el of strip.querySelectorAll('.label-caps')) {
      expect(el.className).not.toMatch(/truncate|ellipsis|break-all|anywhere/);
    }
    // The month range never splits at its dash.
    expect(screen.getByText('Jul–Sep')).toHaveClass('whitespace-nowrap');
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
