import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TooltipProvider } from '@/components/ui/tooltip';
import { CURRENT_WEEK, DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';
import { seedSession } from '@/test/session';

import { WeekPill } from './app-header';

function renderPill() {
  return render(
    <TooltipProvider delayDuration={0}>
      <WeekPill />
    </TooltipProvider>,
  );
}

afterEach(() => {
  seedSession(null);
  vi.useRealTimers();
});

// Client ask 2026-10-13 (ADR 0024): the header frames a 52-week year only — the
// server's internal 78-week search horizon is never presented.
describe('WeekPill (header planning week)', () => {
  it('P13-T15: reads the served "Week N · M wks left" and today\'s date', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-18T09:00:00Z') });
    seedSession({ current_week: 42, weeks_left_in_year: 10 });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPill();
    const pill = screen.getByTestId('week-indicator');
    expect(pill).toHaveTextContent('Week 42 · 10 wks left');
    expect(screen.getByTestId('header-today')).toHaveTextContent('18 Oct 2026');
    expect(screen.getByTestId('header-today')).toHaveAttribute('dateTime', '2026-10-18');
    await user.hover(pill);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Planning week 42 of 52, 10 left in the year.');
    expect(tip).toHaveTextContent('spillover into 2027');
    expect(tip.textContent).not.toMatch(/78/);
  });

  it('uses the served values verbatim (never recomputed from the constant)', () => {
    seedSession({ current_week: 31, weeks_left_in_year: 21 });
    renderPill();
    expect(screen.getByTestId('week-indicator')).toHaveTextContent('Week 31 · 21 wks left');
  });

  it('falls back to "W42 of 52" before /me has loaded', () => {
    expect(CURRENT_WEEK).toBe(42);
    expect(DISPLAY_HORIZON_WEEKS).toBe(52);
    seedSession(null);
    renderPill();
    expect(screen.getByTestId('week-indicator')).toHaveTextContent('W42 of 52');
  });
});
