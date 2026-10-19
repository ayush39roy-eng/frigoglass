import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { CategoryTimeline } from '../api/types';
import { CategoryTimelineList } from './category-timeline';

const A_PLUS: CategoryTimeline = {
  category: 'A+',
  total_weeks: 10,
  design_weeks: 7,
  lab_weeks: 2,
  steps: [
    { code: 'PDD-A', name: 'Marketing Brief', resource_kind: 'design', start_week: 0, duration_weeks: 1 },
    { code: 'PDD-B', name: 'Feasibility Study', resource_kind: 'design', start_week: 1, duration_weeks: 6 },
    { code: 'PDD-C', name: 'Business Case Approval', resource_kind: 'elapsed', start_week: 7, duration_weeks: 0 },
    { code: 'PDD-F', name: 'Proof of Concept', resource_kind: 'lab', start_week: 7, duration_weeks: 2 },
  ],
};
const B: CategoryTimeline = { ...A_PLUS, category: 'B', total_weeks: 5, design_weeks: 3, lab_weeks: 0 };

describe('CategoryTimelineList (P13-T16)', () => {
  it('shows served totals in each header; first category open, others collapsed', () => {
    renderWithProviders(<CategoryTimelineList timelines={[A_PLUS, B]} />);
    const first = screen.getByRole('button', { name: /A\+\s*Timeline preview/ });
    expect(first).toHaveAttribute('aria-expanded', 'true');
    expect(first).toHaveTextContent('(10w total)');
    expect(first).toHaveTextContent('Design 7w');
    expect(first).toHaveTextContent('Lab 2w');
    expect(screen.getByRole('button', { name: /^B\s*Timeline preview/ })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'B steps' })).not.toBeInTheDocument();
  });

  it('describes each served step and marks 0-week steps as skipped; positions bars from served weeks', () => {
    renderWithProviders(<CategoryTimelineList timelines={[A_PLUS]} />);
    const steps = screen.getByRole('list', { name: 'A+ steps' });
    expect(within(steps).getByTestId('step-PDD-B')).toHaveTextContent('design, starts W1, 6 weeks');
    expect(within(steps).getByTestId('step-PDD-C')).toHaveTextContent('skipped (0 weeks)');
    // left = (1 − 0) / 10, width = 6 / 10 of the served total.
    const bar = within(steps).getByTestId('step-PDD-B').querySelector('[style*="width"]') as HTMLElement;
    expect(bar.style.left).toBe('10%');
    expect(bar.style.width).toBe('60%');
  });

  it('expands a collapsed category on click', async () => {
    const user = userEvent.setup();
    renderWithProviders(<CategoryTimelineList timelines={[A_PLUS, B]} />);
    await user.click(screen.getByRole('button', { name: /^B\s*Timeline preview/ }));
    expect(screen.getByRole('list', { name: 'B steps' })).toBeInTheDocument();
  });

  it('has an empty state and no serious axe violations', async () => {
    const { container, unmount } = renderWithProviders(<CategoryTimelineList timelines={[A_PLUS, B]} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
    unmount();
    renderWithProviders(<CategoryTimelineList timelines={[]} />);
    expect(screen.getByText('No categories configured for this workflow.')).toBeInTheDocument();
  });

  it('the open mini-Gantt scroller is a keyboard-focusable named region (P13-R01)', () => {
    renderWithProviders(<CategoryTimelineList timelines={[A_PLUS, B]} />);
    const region = screen.getByRole('region', { name: 'A+ timeline chart' });
    expect(region).toHaveAttribute('tabindex', '0');
  });
});
