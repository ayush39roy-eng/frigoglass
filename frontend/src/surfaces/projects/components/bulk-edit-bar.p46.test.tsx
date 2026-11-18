import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import { BulkEditBar } from './bulk-edit-bar';
import { StatusSelect } from './register-edit-cells';

function renderBar(session?: { roles: ['Admin'] }) {
  return renderWithProviders(
    <BulkEditBar selectedCount={2} draftCount={0} leaderOptions={[]} leaderNote={null} onApply={vi.fn()} onClearSelection={vi.fn()} />,
    session ? { session } : undefined,
  );
}

describe('P46 (ADR 0058 D1.1): Cancelled is Super Admin only in bulk edit and the row status', () => {
  it('bulk edit: an Admin sees Cancelled disabled with "Super Admin only"', () => {
    renderBar({ roles: ['Admin'] });
    const option = within(screen.getByTestId('bulk-status')).getByRole('option', { name: /^Cancelled/ });
    expect(option).toBeDisabled();
    expect(option).toHaveTextContent('Cancelled (Super Admin only)');
  });

  it('bulk edit: a Super Admin may pick Cancelled', () => {
    renderBar();
    expect(within(screen.getByTestId('bulk-status')).getByRole('option', { name: 'Cancelled' })).toBeEnabled();
  });

  it('row status: a project already Cancelled keeps it selectable as itself (leaving Cancelled is an edit)', () => {
    renderWithProviders(
      <StatusSelect value="Cancelled" served="Cancelled" changed={false} label="Cooler A" onChange={vi.fn()} />,
      { session: { roles: ['Admin'] } },
    );
    const select = screen.getByRole('combobox', { name: 'Status of Cooler A' });
    expect(select).toHaveValue('Cancelled');
    expect(within(select).getByRole('option', { name: 'Cancelled' })).toBeEnabled();
    expect(within(select).getByRole('option', { name: 'In Queue' })).toBeEnabled();
  });
});
