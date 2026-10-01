import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { CURRENT_WEEK, HORIZON_WEEKS, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { PlanningClockCard } from './planning-clock-card';

describe('PlanningClockCard', () => {
  it('renders the planning week and the within-year cut-off from the DOMAIN_RULES constants', () => {
    renderWithProviders(<PlanningClockCard />);
    const card = screen.getByRole('group', { name: 'Planning clock' });

    expect(within(card).getByText(`W${String(CURRENT_WEEK)}`)).toBeInTheDocument();
    expect(within(card).getByText(`/ W${String(WITHIN_YEAR_WEEK)}`)).toBeInTheDocument();
    expect(within(card).getByText(`Cut-off W${String(WITHIN_YEAR_WEEK)}`)).toBeInTheDocument();
    expect(within(card).getByText(`W${String(HORIZON_WEEKS)}`)).toBeInTheDocument();
    expect(within(card).getByText('W1')).toBeInTheDocument();
  });

  it('never reads the wall clock — the week is the mirrored backend constant', () => {
    // `lib/domain-constants.ts` mirrors `backend/scheduling/domain_constants.py`
    // verbatim. If this card ever derived "now" from `new Date()` it would drift
    // away from the week every scheduled figure on the surface is expressed in.
    renderWithProviders(<PlanningClockCard />);
    expect(screen.getByText('W31')).toBeInTheDocument();
    expect(CURRENT_WEEK).toBe(31);
  });

  it('shows the weeks remaining to the cut-off, consistent with those same constants', () => {
    renderWithProviders(<PlanningClockCard />);
    expect(
      screen.getByText(`${String(WITHIN_YEAR_WEEK - CURRENT_WEEK)} wks left`),
    ).toBeInTheDocument();
  });

  it('states the elapsed share of the planning year in text, not colour alone', () => {
    renderWithProviders(<PlanningClockCard />);
    const pct = Math.round((CURRENT_WEEK / WITHIN_YEAR_WEEK) * 100);
    expect(
      screen.getByText(`${String(pct)}% of the planning year elapsed`),
    ).toBeInTheDocument();
  });

  it('takes no props and shows no project or person data', () => {
    // Deliberately data-free: it is the surface's fixed frame of reference, which
    // is why it is also the fallback card when there is no active schedule run.
    renderWithProviders(<PlanningClockCard />);
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});
