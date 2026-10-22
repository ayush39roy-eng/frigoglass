import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { CompletingWithinYearRow } from '../../api/types';

// jsdom: the shared VirtualDataTable's viewport measures 0 high, so the
// virtualizer is mocked to list every row (virtual-data-table.test.tsx pattern).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

import { KpiProjectsDialog } from './kpi-projects-dialog';

function row(overrides: Partial<CompletingWithinYearRow>): CompletingWithinYearRow {
  return {
    project_id: 'p-x',
    project_name: 'Project X',
    hub: 'PD-India',
    category: null,
    priority: 'P2',
    within_year: false,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: null,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

describe('KpiProjectsDialog (P28 addendum)', () => {
  it('lists the bucket rows — name link, hub, priority, end week (— on null), outcome chip — and is axe-clean open', async () => {
    const rows = [
      row({ project_id: 's1', project_name: 'Spill One', spillover: true, last_step_end_week: 61 }),
      row({ project_id: 's2', project_name: 'Spill Two', spillover: true, priority: null }),
      // Not in this bucket:
      row({ project_id: 'w1', project_name: 'Within One', within_year: true }),
    ];
    const { baseElement } = renderWithProviders(
      <KpiProjectsDialog bucket="spillover" rows={rows} onClose={() => undefined} />,
    );
    const dialog = screen.getByTestId('exec-kpi-dialog');
    expect(within(dialog).getByTestId('exec-kpi-dialog-title')).toHaveTextContent('Spillover (past W52) — 2 projects');
    expect(within(dialog).getByRole('link', { name: 'Spill One' })).toHaveAttribute('href', '/projects/s1');
    expect(within(dialog).getByText('Spill Two')).toBeInTheDocument();
    expect(within(dialog).queryByText('Within One')).not.toBeInTheDocument();
    // Served end week past W52 prints the plan-year framing; null priority → "—".
    expect(within(dialog).getByText('After W52')).toBeInTheDocument();
    expect(within(dialog).getAllByText('—').length).toBeGreaterThan(0);
    // Outcome chip text (display framing of the served flag).
    expect(within(dialog).getAllByText('Spillover (past W52)').length).toBeGreaterThan(0);
    // axe on the OPEN dialog (portal renders into baseElement).
    expect(await seriousAxeViolations(baseElement)).toEqual([]);
  });

  it('renders nothing when closed', () => {
    renderWithProviders(<KpiProjectsDialog bucket={null} rows={[]} onClose={() => undefined} />);
    expect(screen.queryByTestId('exec-kpi-dialog')).not.toBeInTheDocument();
  });
});
