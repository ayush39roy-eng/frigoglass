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
    renderWithProviders(<EngineerTable rows={ROWS} canEdit onEdit={vi.fn()} canChangeStatus onDeactivate={vi.fn()} onReactivate={vi.fn()} />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    // P13-T17: the hub is the group header, not a column.
    expect(screen.getByText('R&D-Greece Hub')).toBeInTheDocument();
    expect(screen.getByText('1')).toBeInTheDocument();
    expect(screen.getByText('A+')).toBeInTheDocument();
  });

  it('hides the actions column entirely for a read-only role', () => {
    renderWithProviders(<EngineerTable rows={ROWS} canEdit={false} onEdit={vi.fn()} canChangeStatus onDeactivate={vi.fn()} onReactivate={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /Edit/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete|Deactivate/ })).not.toBeInTheDocument();
  });

  it('calls onEdit / onDeactivate with the row; there is no Delete (P38)', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDeactivate = vi.fn();
    renderWithProviders(<EngineerTable rows={ROWS} canEdit canChangeStatus onEdit={onEdit} onDeactivate={onDeactivate} onReactivate={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Edit Ada Lovelace' }));
    expect(onEdit).toHaveBeenCalledWith(ROWS[0]);
    await user.click(screen.getByRole('button', { name: 'Deactivate Ada Lovelace' }));
    expect(onDeactivate).toHaveBeenCalledWith(ROWS[0]);
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
  });

  it('P38: without the Admin role a writer sees Edit but no Deactivate', () => {
    renderWithProviders(<EngineerTable rows={ROWS} canEdit canChangeStatus={false} onEdit={vi.fn()} onDeactivate={vi.fn()} onReactivate={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Edit Ada Lovelace' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Deactivate|Reactivate/ })).not.toBeInTheDocument();
  });

  it('P38: an inactive row has the Inactive tag, the served week and reason, Reactivate, and a name-only Edit', async () => {
    const user = userEvent.setup();
    const onReactivate = vi.fn();
    const inactive = { ...ROWS[0]!, active: false, deactivated_week: 47, deactivation_reason: 'left_company' as const };
    const { container } = renderWithProviders(
      <EngineerTable rows={[inactive]} canEdit canChangeStatus onEdit={vi.fn()} onDeactivate={vi.fn()} onReactivate={onReactivate} />,
    );
    expect(screen.getByTestId('inactive-tag')).toHaveTextContent('Inactive');
    expect(screen.getByTestId('inactive-since')).toHaveTextContent('Since W47 \'26 · Left the company');
    expect(screen.queryByRole('button', { name: /^Deactivate/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit name of Ada Lovelace' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reactivate Ada Lovelace' }));
    expect(onReactivate).toHaveBeenCalledWith(inactive);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('P13-T17: groups engineers under a header per hub, in canonical hub order, with the country flag', async () => {
    const rows = [
      { ...ROWS[0]!, id: 'e2', name: 'Rishi', hub_id: 'hub-2', hubName: 'PD-India', hubRegion: 'India' as const },
      { ...ROWS[0]!, hubRegion: 'Greece' as const },
      { ...ROWS[0]!, id: 'e3', name: 'Pawan', hub_id: 'hub-2', hubName: 'PD-India', hubRegion: 'India' as const },
    ];
    const { container } = renderWithProviders(<EngineerTable rows={rows} canEdit onEdit={vi.fn()} canChangeStatus onDeactivate={vi.fn()} onReactivate={vi.fn()} />);
    const headers = screen.getAllByRole('rowheader').map((h) => h.textContent);
    expect(headers).toEqual(['R&D-Greece Hub1 engineer', 'PD-India Hub2 engineers']);
    const india = screen.getByTestId('engineer-group-PD-India');
    expect(within(india).getByText('Rishi')).toBeInTheDocument();
    expect(within(india).getByText('Pawan')).toBeInTheDocument();
    expect(within(india).getByTestId('flag-India')).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  describe('P46 (ADR 0058 D1.3): deactivate is Super Admin only, reactivate stays Admin', () => {
    it('an Admin sees Deactivate disabled with "Super Admin only"', async () => {
      const user = userEvent.setup();
      const onDeactivate = vi.fn();
      renderWithProviders(
        <EngineerTable rows={ROWS} canEdit canChangeStatus onEdit={vi.fn()} onDeactivate={onDeactivate} onReactivate={vi.fn()} />,
        { session: { roles: ['Admin'] } },
      );
      const button = screen.getByRole('button', { name: 'Deactivate Ada Lovelace' });
      expect(button).toBeDisabled();
      expect(button.closest('[data-super-admin-only]')).toHaveAttribute('title', 'Super Admin only');
      await user.click(button);
      expect(onDeactivate).not.toHaveBeenCalled();
    });

    it('an Admin may still reactivate', () => {
      const inactive = { ...ROWS[0]!, active: false, deactivated_week: 47, deactivation_reason: 'left_company' as const };
      renderWithProviders(
        <EngineerTable rows={[inactive]} canEdit canChangeStatus onEdit={vi.fn()} onDeactivate={vi.fn()} onReactivate={vi.fn()} />,
        { session: { roles: ['Admin'] } },
      );
      expect(screen.getByRole('button', { name: 'Reactivate Ada Lovelace' })).toBeEnabled();
    });

    it('a Super Admin may deactivate', () => {
      renderWithProviders(<EngineerTable rows={ROWS} canEdit canChangeStatus onEdit={vi.fn()} onDeactivate={vi.fn()} onReactivate={vi.fn()} />);
      expect(screen.getByRole('button', { name: 'Deactivate Ada Lovelace' })).toBeEnabled();
    });
  });
});
