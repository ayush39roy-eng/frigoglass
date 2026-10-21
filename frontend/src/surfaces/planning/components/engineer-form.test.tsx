import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';

import { EngineerFormDialog } from './engineer-form';

const HUBS: Hub[] = [
  { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
  { id: 'hub-2', name: 'PD-India', lab_region: 'India', is_oem: false },
];

describe('EngineerFormDialog', () => {
  it('explains FTE as the engineer’s speed (ADR 0032), not as a reporting-only figure', () => {
    renderWithProviders(
      <EngineerFormDialog mode="create" engineer={null} open onOpenChange={() => {}} hubs={HUBS} onSubmit={vi.fn()} />,
    );
    const help = screen.getByTestId('engineer-fte-help');
    expect(help).toHaveTextContent("FTE sets the engineer's speed");
    expect(help).toHaveTextContent('at 0.5 FTE they work at half speed, so 4 weeks of work take 8 calendar weeks');
    expect(help).not.toHaveTextContent(/reporting figure only|does not gate|0002/);
  });

  it('requires a hub before submitting in create mode', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <EngineerFormDialog
        mode="create"
        engineer={null}
        open
        onOpenChange={() => {}}
        hubs={HUBS}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace');
    await user.click(screen.getByRole('button', { name: 'Add engineer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Hub is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits name, hub, fte and the selected allowed categories', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <EngineerFormDialog
        mode="create"
        engineer={null}
        open
        onOpenChange={() => {}}
        hubs={HUBS}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText('Name *'), 'Ada Lovelace');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('checkbox', { name: 'A+' }));
    await user.click(screen.getByRole('button', { name: 'Add engineer' }));

    expect(onSubmit).toHaveBeenCalledWith({
      name: 'Ada Lovelace',
      hub_id: 'hub-1',
      fte: 1,
      allowed_categories: ['A+'],
    });
  });

  it('pre-fills the form from the existing engineer in edit mode', () => {
    renderWithProviders(
      <EngineerFormDialog
        mode="edit"
        engineer={{
          id: 'e1',
          name: 'Grace Hopper',
          hub_id: 'hub-2',
          fte: 0.5,
          allowed_categories: ['B', 'OEM'],
          user_id: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          weekdays_per_week: 5, capacity_weeks: { year: 44, remaining: 9 }, capacity_days: { year: 220, remaining: 45 },
        }}
        open
        onOpenChange={() => {}}
        hubs={HUBS}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('Grace Hopper')).toBeInTheDocument();
    expect(screen.getByDisplayValue('0.5')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'B' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'OEM' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'A' })).not.toBeChecked();
  });
});
