import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { EngineerTable } from './engineer-table';

const ROWS = [
  {
    id: 'e1',
    name: 'Ada Lovelace',
    hub_id: 'hub-1',
    hubName: 'R&D-Greece',
    fte: 1,
    allowed_categories: ['A+' as const],
    user_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    weekdays_per_week: 5, capacity_weeks: { year: 44, remaining: 9 }, capacity_days: { year: 220, remaining: 45 }, counts_in_capacity: true,
  },
];

describe('EngineerTable', () => {
  it('renders name, hub, FTE and allowed categories verbatim from the API row', () => {
    renderWithProviders(<EngineerTable rows={ROWS} canEdit onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    // P13-T17: the hub is the group header, not a column.
    expect(screen.getByText('R&D-Greece Hub')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('A+')).toBeInTheDocument();
  });

  it('hides the actions column entirely for a read-only role', () => {
    renderWithProviders(<EngineerTable rows={ROWS} canEdit={false} onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete/ })).not.toBeInTheDocument();
  });

  it('calls onEdit / onDelete with the row', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    renderWithProviders(<EngineerTable rows={ROWS} canEdit onEdit={onEdit} onDelete={onDelete} />);
    await user.click(screen.getByRole('button', { name: 'Edit Ada Lovelace' }));
    expect(onEdit).toHaveBeenCalledWith(ROWS[0]);
    await user.click(screen.getByRole('button', { name: 'Delete Ada Lovelace' }));
    expect(onDelete).toHaveBeenCalledWith(ROWS[0]);
  });

  it('P13-T17: groups engineers under a header per hub, in canonical hub order, with the country flag', async () => {
    const rows = [
      { ...ROWS[0]!, id: 'e2', name: 'Rishi', hub_id: 'hub-2', hubName: 'PD-India', hubRegion: 'India' as const },
      { ...ROWS[0]!, hubRegion: 'Greece' as const },
      { ...ROWS[0]!, id: 'e3', name: 'Pawan', hub_id: 'hub-2', hubName: 'PD-India', hubRegion: 'India' as const },
    ];
    const { container } = renderWithProviders(<EngineerTable rows={rows} canEdit onEdit={vi.fn()} onDelete={vi.fn()} />);
    const headers = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(headers).toEqual(['R&D-Greece Hub1 engineer', 'PD-India Hub2 engineers']);
    const india = screen.getByTestId('engineer-group-PD-India');
    expect(within(india).getByText('Rishi')).toBeInTheDocument();
    expect(within(india).getByText('Pawan')).toBeInTheDocument();
    expect(within(india).getByTestId('flag-India')).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
