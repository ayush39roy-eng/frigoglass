import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
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
    weeks_per_chamber: 0,
    allowed_stages: ['PDD-F'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

describe('ChamberTable', () => {
  it('renders every field verbatim from the API row', () => {
    renderWithProviders(<ChamberTable rows={ROWS} canEdit onEdit={vi.fn()} onDelete={vi.fn()} />);
    expect(screen.getByText('GR-CH1')).toBeInTheDocument();
    expect(screen.getByText('Greece')).toBeInTheDocument();
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
});
