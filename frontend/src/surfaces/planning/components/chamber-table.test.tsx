import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

import { ChamberTable } from './chamber-table';

const ROWS = [
  {
    id: 'c1',
    code: 'GR-CH1',
    lab_region: 'Greece' as const,
    max_concurrent: 2,
    platforms: 1,
    efficiency: 1,
    maintenance_weeks: 2,
    breakdown_weeks: 3,
    calibration_weeks: 1,
    working_weeks_per_chamber: 43.4,
    efficient_lab_weeks: 26.04,
    allowed_stages: ['PDD-F'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    weekdays_per_week: 5, working_weeks: 43.4, capacity_weeks: { year: 26.04, remaining: 5.01 }, capacity_days: { year: 130.2, remaining: 25.05 },
  },
];

describe('ChamberTable', () => {
  it('renders every field verbatim from the API row', () => {
    renderWithProviders(<ChamberTable rows={ROWS} canEdit onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('GR-CH1')).toBeInTheDocument();
    // P13-T17: the lab region is the group header, not a column.
    expect(screen.getByText('Greece labs')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
    expect(screen.getByText('PDD-F')).toBeInTheDocument();
  });

  it('hides the actions column entirely for a read-only role', () => {
    renderWithProviders(<ChamberTable rows={ROWS} canEdit={false} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('calls onEdit / onDelete with the row', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    renderWithProviders(<ChamberTable rows={ROWS} canEdit onEdit={onEdit} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Edit GR-CH1' }));
    expect(onEdit).toHaveBeenCalledWith(ROWS[0]);
    await user.click(screen.getByRole('button', { name: 'Delete GR-CH1' }));
    expect(onDelete).toHaveBeenCalledWith(ROWS[0]);
  });

  it('P13-T17: groups chambers by lab region in Greece / India / Romania order', () => {
    const rows = [
      { ...ROWS[0]!, id: 'c2', code: 'RO-CH1', lab_region: 'Romania' as const },
      { ...ROWS[0]!, id: 'c3', code: 'IN-CH1', lab_region: 'India' as const },
      ROWS[0]!,
    ];
    renderWithProviders(<ChamberTable rows={rows} canEdit={false} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      'Greece labs1 chamber',
      'India labs1 chamber',
      'Romania labs1 chamber',
    ]);
    expect(within(screen.getByTestId('chamber-group-India')).getByText('IN-CH1')).toBeInTheDocument();
    expect(within(screen.getByTestId('chamber-group-India')).getByTestId('flag-India')).toBeInTheDocument();
  });
});
