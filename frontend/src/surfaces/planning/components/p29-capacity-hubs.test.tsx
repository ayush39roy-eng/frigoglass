import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { Hub } from '@/lib/api/reference';

import type { DesignHubSummary, EngineerRead } from '../api/types';
import { EngineerFormDialog } from './engineer-form';
import { EngineerTable } from './engineer-table';
import { HubEngineerCard } from './overview/hub-engineer-card';

/**
 * P29-T03 (ADR 0042, API_CONTRACT_P29 §3, §5): Capacity Planning on the four
 * capacity hubs — the "Not in capacity roster" marker, the served members /
 * not-counted notes on the hub card, and engineer hub pickers limited to
 * capacity hubs.
 */
const HUBS: Hub[] = [
  { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-pdin', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
  { id: 'h-sel', name: 'OEM-Seitek', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
];

const pair = (year: number, remaining: number) => ({ year, remaining });

function engineer(overrides: Partial<EngineerRead> = {}): EngineerRead {
  return {
    id: 'e-dim',
    name: 'Dimopoulou',
    hub_id: 'h-gr',
    fte: 1,
    allowed_categories: ['B', 'B-OEM'],
    user_id: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    weekdays_per_week: 5,
    capacity_weeks: pair(44.6, 9.4),
    capacity_days: pair(223, 47),
    counts_in_capacity: true,
    ...overrides,
  };
}

const theoni = engineer({ id: 'e-theoni', name: 'Theoni', counts_in_capacity: false, capacity_weeks: pair(44.6, 9.4) });

const greeceSummary: DesignHubSummary = {
  hub: 'R&D-Greece',
  engineer_count: 3,
  not_counted_engineer_count: 1,
  fte_total: 2.8,
  weekdays_per_week: 5,
  capacity_weeks: pair(124.88, 23.61),
  capacity_days: pair(624.4, 118.05),
  share_pct: pair(17.5, 17.1),
  members: ['OEM-HCK', 'OEM-Seitek'],
  selected_member: null,
};

function card(summary: DesignHubSummary | undefined, canEdit = false) {
  return (
    <HubEngineerCard
      hubName="R&D-Greece"
      hubId="h-gr"
      region="Greece"
      summary={summary}
      engineers={[engineer(), theoni]}
      basis="year"
      unit="weeks"
      canEdit={canEdit}
      onUpdate={vi.fn()}
      onEdit={vi.fn()}
      onDelete={vi.fn()}
      onAdd={vi.fn()}
    />
  );
}

describe('HubEngineerCard — P29 Greece card', () => {
  it('names the served member hubs and the served not-counted figure', () => {
    renderWithProviders(card(greeceSummary));
    expect(screen.getByTestId('hub-notes-members')).toHaveTextContent('Capacity also serves OEM-HCK and OEM-Seitek');
    expect(screen.getByTestId('hub-notes-not-counted')).toHaveTextContent('1 not in capacity roster');
  });

  it('marks only the not-counted engineer and mutes their own (served) capacity', () => {
    renderWithProviders(card(greeceSummary));
    const theoniRow = screen.getByTestId('engineer-row-e-theoni');
    expect(within(theoniRow).getByTestId('not-in-capacity-roster')).toHaveTextContent('Not in capacity roster');
    const capCell = theoniRow.querySelector('td[data-numeric].font-mono');
    expect(capCell).toHaveClass('text-text-muted');
    expect(capCell?.textContent).toMatch(/44\.6/);
    expect(screen.getByTestId('engineer-row-e-dim').querySelector('td[data-numeric].font-mono')).toHaveClass('text-primary-subtle-fg');
    expect(within(screen.getByTestId('engineer-row-e-dim')).queryByTestId('not-in-capacity-roster')).toBeNull();
  });

  it('highlights the filter-selected member', () => {
    renderWithProviders(card({ ...greeceSummary, selected_member: 'OEM-HCK' }));
    const members = screen.getByTestId('hub-notes-members');
    expect(within(members).getByText('OEM-HCK')).toHaveAttribute('data-selected', 'true');
    expect(within(members).getByText('OEM-Seitek')).not.toHaveAttribute('data-selected');
    expect(members).toHaveTextContent('OEM-HCK selected in the hub filter');
  });

  it('shows no notes on a hub without members or non-counted engineers', () => {
    renderWithProviders(card({ ...greeceSummary, hub: 'PD-India', members: [], not_counted_engineer_count: 0 }));
    expect(screen.queryByTestId('hub-notes')).toBeNull();
  });

  it('is axe-clean (editable)', async () => {
    const { container } = renderWithProviders(card(greeceSummary, true));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('EngineerTable — roster marker', () => {
  it('marks a not-counted engineer in the Engineers tab', () => {
    renderWithProviders(
      <EngineerTable
        rows={[
          { ...engineer(), hubName: 'R&D-Greece' },
          { ...theoni, hubName: 'R&D-Greece' },
        ]}
        canEdit={false}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('not-in-capacity-roster')).toHaveLength(1);
    expect(screen.getByTestId('not-in-capacity-roster').closest('tr')).toHaveTextContent('Theoni');
  });
});

describe('EngineerFormDialog — capacity hubs only (contract §5.2)', () => {
  it('offers the capacity hubs only and says the OEM hubs use R&D-Greece engineers', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <EngineerFormDialog mode="create" engineer={null} open onOpenChange={() => {}} hubs={HUBS} onSubmit={vi.fn()} />,
    );
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['R&D-Greece', 'PD-India']);
    expect(screen.getByTestId('engineer-hub-members-note')).toHaveTextContent("OEM-HCK and OEM-Seitek use R&D-Greece’s engineers.");
  });

  it('never sends counts_in_capacity (Admin-only field, 403 otherwise)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <EngineerFormDialog mode="edit" engineer={theoni} open onOpenChange={() => {}} hubs={HUBS} onSubmit={onSubmit} />,
    );
    await user.click(screen.getByRole('button', { name: /Save/ }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('counts_in_capacity');
  });
});
