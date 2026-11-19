import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';
import { ApiError } from '@/lib/api/client';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectFormDialog, UNSET_NOT_SCHEDULED } from './project-form';
import {
  CLIENT_REQUIRED_FIELD_KEYS,
  missingRequiredFields,
  requiredFieldErrorsFromApi,
} from './required-fields-hint';

vi.setConfig({ testTimeout: 30_000 });

const hubs: Hub[] = [
  { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
];

const DROPPED = ['reg-leader', 'reg-category', 'reg-type', 'reg-priority', 'reg-tcogs', 'reg-selling-price', 'reg-gross-margin'];

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({ data: [{ id: 'eng-1', name: 'Nikos Papas' }] });
});

function labelText(id: string): string {
  return document.querySelector(`label[for="${id}"]`)?.textContent ?? '';
}

function renderCreate(onSubmit = vi.fn().mockResolvedValue(undefined)) {
  renderWithProviders(
    <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={hubs} onSubmit={onSubmit} />,
  );
  return onSubmit;
}

describe('P56: only Name and Hub are required at registration', () => {
  it('the client mirror checks nothing (HARD_GATE_FIELDS is empty)', () => {
    expect(CLIENT_REQUIRED_FIELD_KEYS).toEqual([]);
    expect(
      missingRequiredFields({
        leader_engineer_id: null,
        category: null,
        type: null,
        tcogs_eur: null,
        selling_price_eur: null,
        gross_margin_pct: null,
        priority: null,
      }),
    ).toEqual({});
  });

  it('a server 422 HARD_GATE_FIELDS_MISSING still maps onto its fields', () => {
    const detail = JSON.stringify({ missing_fields: ['priority', 'TCOGS'] });
    expect(requiredFieldErrorsFromApi(new ApiError(422, 'invalid', detail, 'HARD_GATE_FIELDS_MISSING'))).toEqual({
      priority: 'Priority is required.',
      tcogs_eur: 'TCOGS is required.',
    });
  });

  it('Name and Hub keep their * mark; the dropped fields have none; the help text says so', () => {
    renderCreate();
    expect(labelText('reg-name')).toContain('*');
    expect(labelText('reg-hub')).toContain('*');
    for (const id of DROPPED) expect(labelText(id)).not.toContain('*');
    expect(screen.getByText(/\(Name and Hub\) are/)).toBeInTheDocument();
  });

  it('Priority and Category show "Unset — not scheduled until set" when empty', () => {
    renderCreate();
    expect(screen.getByRole('combobox', { name: /^Priority/ })).toHaveTextContent(UNSET_NOT_SCHEDULED);
    expect(screen.getByRole('combobox', { name: /^Category/ })).toHaveTextContent(UNSET_NOT_SCHEDULED);
  });

  it('create with only Name and Hub submits, the other fields sent as null', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await user.type(screen.getByLabelText(/^Name/), 'Cooler A');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Register project' }));

    await vi.waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({
      name: 'Cooler A',
      hub_id: 'hub-1',
      leader_engineer_id: null,
      category: null,
      type: null,
      priority: null,
      tcogs_eur: null,
      selling_price_eur: null,
      gross_margin_pct: null,
      actual_start_week: null,
    });
    expect(screen.queryByText(/is required\./)).not.toBeInTheDocument();
    for (const id of DROPPED) expect(document.getElementById(id)).not.toHaveAttribute('aria-invalid');
  });

  it('Name is still required', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Hub is still required', async () => {
    const user = userEvent.setup();
    const onSubmit = renderCreate();
    await user.type(screen.getByLabelText(/^Name/), 'Cooler A');
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByText('Hub is required.')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
