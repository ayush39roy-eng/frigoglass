import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import type { EngineerUtilizationResponse } from '../api/types';

const hook = vi.fn();
vi.mock('../hooks/use-capacity', () => ({ useEngineerUtilization: () => hook() }));

import { EngineerUtilizationHeatmap, utilBand } from './engineer-utilization-heatmap';
import { EngineerUtilizationPanel } from './engineer-utilization-panel';

function eng(id: string, name: string, hub: 'R&D-Greece' | 'PD-India', pcts: number[]) {
  return {
    id, name, hub, role: 'Designer', total_booked: 2, total_capacity: 3, utilization_pct: 66.7,
    weeks: pcts.map((p, i) => ({ week: i + 1, booked: p / 100, capacity: 1, utilization_pct: p })),
  };
}
const data: EngineerUtilizationResponse = {
  week_range: [1, 3],
  current_week: 2,
  engineers: [eng('e1', 'Priya N', 'PD-India', [40, 85, 120]), eng('e2', 'Nikos K', 'R&D-Greece', [0, 0, 0])],
};

beforeEach(() => vi.clearAllMocks());

describe('utilBand', () => {
  it('bands a served pct; zero capacity is none', () => {
    expect(utilBand(1, 50)).toBe('under');
    expect(utilBand(1, 85)).toBe('well');
    expect(utilBand(1, 120)).toBe('over');
    expect(utilBand(0, 0)).toBe('none');
  });
});

describe('EngineerUtilizationHeatmap', () => {
  it('groups by hub, shows % text + band in aria-label, marks the current week, has a totals column and legend', () => {
    renderWithProviders(<EngineerUtilizationHeatmap data={data} />);
    expect(screen.getByRole('region', { name: /Engineer utilization by week/ })).toHaveAttribute('tabindex', '0');
    const rows = screen.getAllByRole('row');
    const text = rows.map((r) => r.textContent ?? '');
    expect(text.findIndex((t) => t.startsWith('PD-India'))).toBeLessThan(text.findIndex((t) => t.startsWith('R&D-Greece')));
    const row = screen.getAllByTestId('engineer-row').find((r) => r.textContent?.includes('Priya N'))!;
    expect(within(row).getByLabelText(/W3: .*over-utilized/)).toHaveTextContent('120');
    expect(within(row).getByLabelText(/W1: .*under-utilized/)).toBeInTheDocument();
    expect(within(row).getByTestId('engineer-total')).toHaveTextContent('2/3');
    expect(screen.getByRole('columnheader', { name: '2' })).toHaveAttribute('aria-current', 'date');
    expect(screen.getByTestId('engineer-util-legend')).toHaveTextContent(/Under-utilized.*Well-utilized.*Over-utilized/);
  });

  it('windows the body above 100 rows (not all rendered)', () => {
    const many: EngineerUtilizationResponse = {
      ...data,
      engineers: Array.from({ length: 150 }, (_, i) => eng(`x${String(i)}`, `Eng ${String(i)}`, 'PD-India', [50, 50, 50])),
    };
    renderWithProviders(<EngineerUtilizationHeatmap data={many} />);
    expect(screen.queryAllByTestId('engineer-row').length).toBeLessThan(150);
  });
});

describe('EngineerUtilizationPanel states', () => {
  it('loading', () => {
    hook.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });
    renderWithProviders(<EngineerUtilizationPanel />);
    expect(screen.getByText('Engineers × weeks')).toBeInTheDocument();
  });
  it('empty', () => {
    hook.mockReturnValue({ data: { ...data, engineers: [] }, isPending: false, isError: false, error: null, refetch: vi.fn() });
    renderWithProviders(<EngineerUtilizationPanel />);
    expect(screen.getByText('No engineers in scope')).toBeInTheDocument();
  });
  it('403 shows an in-card access notice', () => {
    hook.mockReturnValue({ data: undefined, isPending: false, isError: true, error: new ApiError(403, 'no'), refetch: vi.fn() });
    renderWithProviders(<EngineerUtilizationPanel />);
    expect(screen.getByText('No access to engineer utilization')).toBeInTheDocument();
  });
  it('other error shows retry state', () => {
    hook.mockReturnValue({ data: undefined, isPending: false, isError: true, error: new Error('x'), refetch: vi.fn() });
    renderWithProviders(<EngineerUtilizationPanel />);
    expect(screen.getByText(/could not be loaded/i)).toBeInTheDocument();
  });
});
