import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Hub } from '@/lib/api/reference';
import { renderWithProviders } from '@/test/render';
import { makeMe } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';
import { useHubFilterStore } from '@/stores/hub-filter';

const HUBS: Hub[] = [
  { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
  { id: 'h-in', name: 'R&D-India', lab_region: 'India', is_oem: false },
  { id: 'h-pdin', name: 'PD-India', lab_region: 'India', is_oem: false },
  { id: 'h-ro', name: 'PD-Romania', lab_region: 'Greece', is_oem: false },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true },
  { id: 'h-sel', name: 'OEM-Seltek', lab_region: 'Greece', is_oem: true },
] as Hub[];

const hubs = { data: HUBS as Hub[] | undefined };
vi.mock('@/lib/api/reference', () => ({ useHubs: () => hubs }));

import { HubFilterChip } from './hub-filter-chip';
import { HubFilterSelect } from './hub-filter-select';
import { hubsInScope, shouldResetHub } from './hub-scope';

beforeEach(() => {
  hubs.data = HUBS;
  useHubFilterStore.setState({ hubId: null });
});
afterEach(() => {
  useHubFilterStore.setState({ hubId: null });
});

describe('hubsInScope (ADR 0020 §1)', () => {
  it('hub_scope_all → all six', () => {
    expect(hubsInScope(makeMe({ hub_scope_all: true }), HUBS)?.map((h) => h.id)).toHaveLength(6);
  });
  it('scoped → only /me.hub_ids, in GET /hubs order', () => {
    const me = makeMe({ hub_scope_all: false, hub_ids: ['h-ro', 'h-gr'], roles: ['Hub Planner'] });
    expect(hubsInScope(me, HUBS)?.map((h) => h.name)).toEqual(['R&D-Greece', 'PD-Romania']);
  });
  it('an Engineer with no hub ids → all six as narrowing choices', () => {
    const me = makeMe({ hub_scope_all: false, hub_ids: [], roles: ['Engineer'] });
    expect(hubsInScope(me, HUBS)).toHaveLength(6);
  });
  it('unknown while /me or /hubs is loading (never resets against a half list)', () => {
    expect(hubsInScope(null, HUBS)).toBeNull();
    expect(hubsInScope(makeMe(), undefined)).toBeNull();
    expect(shouldResetHub('h-gr', null)).toBe(false);
    expect(shouldResetHub(null, [])).toBe(false);
    expect(shouldResetHub('h-gr', [HUBS[1]!])).toBe(true);
  });
});

describe('<HubFilterSelect> (header)', () => {
  it('has an accessible label and offers "All hubs" + the in-scope hubs only', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubFilterSelect />, {
      session: { hub_scope_all: false, hub_ids: ['h-in', 'h-pdin'], roles: ['Hub Planner'] },
    });
    const trigger = screen.getByRole('combobox', { name: 'Hub filter' });
    expect(trigger).toHaveTextContent('All hubs');
    await user.click(trigger);
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All hubs', 'R&D-India', 'PD-India']);
  });

  it('choosing a hub sets the global store; "All hubs" clears it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubFilterSelect />);
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    await user.click(await screen.findByRole('option', { name: 'OEM-HCK' }));
    expect(useHubFilterStore.getState().hubId).toBe('h-hck');
    expect(screen.getByRole('combobox', { name: 'Hub filter' })).toHaveTextContent('OEM-HCK');
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    await user.click(await screen.findByRole('option', { name: 'All hubs' }));
    expect(useHubFilterStore.getState().hubId).toBeNull();
  });

  it('resets a persisted hub that is no longer in scope to "All hubs"', async () => {
    useHubFilterStore.setState({ hubId: 'h-gr' });
    renderWithProviders(<HubFilterSelect />, {
      session: { hub_scope_all: false, hub_ids: ['h-in'], roles: ['Hub Planner'] },
    });
    await waitFor(() => expect(useHubFilterStore.getState().hubId).toBeNull());
  });

  it('keeps a persisted in-scope hub, and does not reset while /hubs is still loading', () => {
    hubs.data = undefined;
    useHubFilterStore.setState({ hubId: 'h-gr' });
    const { unmount } = renderWithProviders(<HubFilterSelect />);
    expect(useHubFilterStore.getState().hubId).toBe('h-gr');
    unmount();
    hubs.data = HUBS;
    renderWithProviders(<HubFilterSelect />);
    expect(useHubFilterStore.getState().hubId).toBe('h-gr');
    expect(screen.getByRole('combobox', { name: 'Hub filter' })).toHaveTextContent('R&D-Greece');
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<HubFilterSelect />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('<HubFilterChip> (page header)', () => {
  it('renders nothing under "All hubs"', () => {
    renderWithProviders(<HubFilterChip />);
    expect(screen.queryByTestId('hub-filter-chip')).not.toBeInTheDocument();
  });

  it('names the hub and clears it', async () => {
    const user = userEvent.setup();
    useHubFilterStore.setState({ hubId: 'h-ro' });
    const { container } = renderWithProviders(<HubFilterChip />);
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hub: PD-Romania');
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Clear hub filter (PD-Romania)' }));
    expect(useHubFilterStore.getState().hubId).toBeNull();
    expect(screen.queryByTestId('hub-filter-chip')).not.toBeInTheDocument();
  });
});
