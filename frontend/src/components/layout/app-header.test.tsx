import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@/components/ui/tooltip';
import { CURRENT_WEEK, DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';

import { WeekPill } from './app-header';

// Client ask 2026-10-13 (ADR 0024): the header frames a 52-week year only — the
// server's internal 78-week search horizon is never presented.
describe('WeekPill (header planning week)', () => {
  it('reads "W42 of 52" and never mentions a 78-week horizon', async () => {
    expect(CURRENT_WEEK).toBe(42);
    expect(DISPLAY_HORIZON_WEEKS).toBe(52);
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <WeekPill />
      </TooltipProvider>,
    );
    const pill = screen.getByTestId('week-indicator');
    expect(pill).toHaveTextContent('W42 of 52');
    await user.hover(pill);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Planning week 42 of 52.');
    expect(tip).toHaveTextContent('spillover into 2027');
    expect(tip.textContent).not.toMatch(/78/);
  });
});
