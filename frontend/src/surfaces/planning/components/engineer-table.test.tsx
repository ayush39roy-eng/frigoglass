import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

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
  },
];

describe('EngineerTable', () => {
  it('renders name, hub, FTE and allowed categories verbatim from the API row', () => {
    renderWithProviders(<EngineerTable rows={ROWS} canEdit onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(screen.getByText('R&D-Greece')).toBeInTheDocument();
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
});
