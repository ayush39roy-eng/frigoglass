import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { TooltipProvider } from '@/components/ui/tooltip';
import { PlanWeekChip, PlanWeekNotice, SimulatedWeekNotice } from '@/components/shared/plan-week-notice';
import { seriousAxeViolations } from '@/test/axe';
import { seedSession } from '@/test/session';

import { WeekPill } from './app-header';

function renderPill() {
  return render(
    <TooltipProvider delayDuration={0}>
      <WeekPill />
    </TooltipProvider>,
  );
}

function renderWithQuery(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  seedSession(null);
  vi.useRealTimers();
});

const W47 = {
  current_week: 47,
  weeks_left_in_year: 5,
  as_of_date: '2026-11-16',
  week_source: 'calendar' as const,
  week_ends_at: '2026-11-23T00:00:00+02:00',
};

// P53 (R53-6): "Week 5 · 2027 · 47 wks left" from the served /me; the search
// limit is never presented in the header.
describe('WeekPill (header planning week)', () => {
  it('P37: reads "Week 47 · 5 wks left · 16 Nov 2026" from the served /me, not the browser clock', async () => {
    // The browser clock says October; the served Athens date says 16 Nov.
    vi.useFakeTimers({ shouldAdvanceTime: true, now: new Date('2026-10-18T09:00:00Z') });
    seedSession(W47);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
    renderPill();
    const pill = screen.getByTestId('week-indicator');
    expect(pill).toHaveTextContent('Week 47 · 2026 · 5 wks left');
    expect(screen.getByTestId('header-today')).toHaveTextContent('16 Nov 2026');
    expect(screen.getByTestId('header-today')).toHaveAttribute('dateTime', '2026-11-16');
    await user.hover(pill);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('Planning week 47 of 2026, 5 left in the year.');
    expect(tip.textContent).not.toMatch(/78/);
  });

  it('derives every year label from the served plan_year', async () => {
    seedSession({ ...W47, plan_year: 2031 });
    const user = userEvent.setup();
    renderPill();
    await user.hover(screen.getByTestId('week-indicator'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('by the end of 2031');
  });

  it('uses the served values verbatim (never recomputed)', () => {
    seedSession({ current_week: 31, weeks_left_in_year: 21 });
    renderPill();
    expect(screen.getByTestId('week-indicator')).toHaveTextContent('Week 31 · 2026 · 21 wks left');
  });

  it('renders nothing before /me has loaded (no constant fallback)', () => {
    seedSession(null);
    renderPill();
    expect(screen.queryByTestId('week-indicator')).not.toBeInTheDocument();
  });

  it('P53 (R53-1): 4 Jan 2027 is absolute week 53, shown as "Week 1 · 2027"; no closed state', () => {
    seedSession({
      current_week: 53,
      weeks_left_in_year: 51,
      as_of_date: '2027-01-04',
      plan_year: 2027,
      plan_year_start_week: 53,
      plan_year_end_week: 104,
    });
    renderPill();
    const pill = screen.getByTestId('week-indicator');
    expect(pill).toHaveTextContent('Week 1 · 2027 · 51 wks left');
    expect(pill.textContent).not.toMatch(/closed/);
  });

});

describe('PlanWeekChip / PlanWeekNotice (ADR 0052 §6)', () => {
  it('shows nothing while the plan is current or there is no active run', () => {
    seedSession({ ...W47, plan_week: { run_week: 47, run_version: 9, status: 'current' } });
    const { unmount } = renderWithQuery(
      <>
        <PlanWeekChip />
        <PlanWeekNotice />
      </>,
    );
    expect(screen.queryByTestId('plan-week-chip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('plan-week-notice')).not.toBeInTheDocument();
    unmount();
    seedSession({ ...W47, plan_week: null });
    renderWithQuery(<PlanWeekChip />);
    expect(screen.queryByTestId('plan-week-chip')).not.toBeInTheDocument();
  });

  it('"Plan from W42 · recalculating…" while the rollover run is in flight, no Recalculate', async () => {
    seedSession({ ...W47, plan_week: { run_week: 42, run_version: 8, status: 'recalculating' } });
    const { container } = renderWithQuery(
      <>
        <PlanWeekChip />
        <PlanWeekNotice />
      </>,
    );
    expect(screen.getByTestId('plan-week-chip')).toHaveTextContent('Plan from W42 \'26 · recalculating…');
    expect(screen.getByTestId('plan-week-notice')).toHaveTextContent('This plan is from W42 \'26; the current week is W47 \'26.');
    expect(screen.queryByTestId('plan-week-recalculate')).not.toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('"recalculation failed" with Recalculate for an Admin', async () => {
    seedSession({ ...W47, roles: ['Admin'], plan_week: { run_week: 42, run_version: 8, status: 'failed' } });
    const { container } = renderWithQuery(<PlanWeekChip />);
    expect(screen.getByTestId('plan-week-chip')).toHaveTextContent('Plan from W42 \'26 · recalculation failed');
    expect(screen.getByTestId('plan-week-recalculate')).toBeEnabled();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('no Recalculate for a role the server would refuse', () => {
    seedSession({ ...W47, roles: ['Hub Planner'], plan_week: { run_week: 42, run_version: 8, status: 'failed' } });
    renderWithQuery(<PlanWeekNotice />);
    expect(screen.getByTestId('plan-week-notice')).toHaveTextContent('The automatic recalculation failed.');
    expect(screen.queryByTestId('plan-week-recalculate')).not.toBeInTheDocument();
  });

  it('R37-3: "Simulated from W47; the active plan is from W42" only when the weeks differ', () => {
    seedSession({ ...W47, plan_week: { run_week: 42, run_version: 8, status: 'pending' } });
    const { rerender } = renderWithQuery(<SimulatedWeekNotice simulatedWeek={47} />);
    expect(screen.getByTestId('simulated-week-notice')).toHaveTextContent(
      'Simulated from W47 \'26; the active plan is from W42 \'26.',
    );
    rerender(<SimulatedWeekNotice simulatedWeek={42} />);
    expect(screen.queryByTestId('simulated-week-notice')).not.toBeInTheDocument();
  });
});
