import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { Hub } from '@/lib/api/reference';
import { renderWithProviders } from '@/test/render';
import { makeMe } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';
import { useHubFilterStore } from '@/stores/hub-filter';

const HUBS: Hub[] = [
  { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-in', name: 'R&D-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-pdin', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
  { id: 'h-sel', name: 'OEM-Seitek', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
] as Hub[];

const hubs = { data: HUBS as Hub[] | undefined };
vi.mock('@/lib/api/reference', () => ({ useHubs: () => hubs }));

import { HubFilterChip } from './hub-filter-chip';
import { HubFilterSelect } from './hub-filter-select';
import { CountrySegmented } from './country-segmented';
import {
  hubsInScope,
  pruneHubSelection,
  regionsInScope,
  shouldResetHub,
  shouldResetRegion,
  summarizeHubSelection,
} from './hub-scope';

beforeEach(() => {
  hubs.data = HUBS;
  useHubFilterStore.getState().setSelection([], []);
});
afterEach(() => {
  useHubFilterStore.getState().setSelection([], []);
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

const state = () => {
  const { hubIds, regions } = useHubFilterStore.getState();
  return { hubIds, regions };
};
const trigger = () => screen.getByRole('button', { name: 'Hub filter' });

describe('<HubFilterSelect> (header, multi-select)', () => {
  it('has an accessible name and offers "All hubs" + the in-scope countries and hubs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubFilterSelect />, {
      session: { hub_scope_all: false, hub_ids: ['h-in', 'h-pdin'], roles: ['Hub Planner'] },
    });
    expect(trigger()).toHaveAccessibleDescription('All hubs');
    await user.click(trigger());
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All hubs', 'India', 'R&D-India', 'PD-India']);
  });

  it('ticks a country AND hubs together (the country is kept as a country), then "All hubs" clears', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubFilterSelect />);
    await user.click(trigger());
    await user.click(await screen.findByRole('option', { name: 'India' }));
    await user.click(screen.getByRole('option', { name: 'R&D-Greece' }));
    // Selecting a country selects the COUNTRY, not each of its hubs.
    expect(state()).toEqual({ hubIds: ['h-gr'], regions: ['India'] });
    expect(screen.getByRole('option', { name: 'India' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'PD-India' })).toHaveAttribute('aria-selected', 'false');
    expect(trigger()).toHaveTextContent('India + R&D-Greece');
    // P29: a member hub's option reads "OEM-HCK (Greece)".
    await user.click(screen.getByRole('option', { name: 'OEM-HCK (Greece)' }));
    expect(state()).toEqual({ hubIds: ['h-gr', 'h-hck'], regions: ['India'] });
    expect(trigger()).toHaveTextContent('1 country + 2 hubs');
    await user.click(screen.getByRole('option', { name: 'All hubs' }));
    expect(state()).toEqual({ hubIds: [], regions: [] });
    expect(trigger()).toHaveTextContent('All hubs');
  });

  it('drops a persisted hub / country that is no longer in scope, keeping the rest', async () => {
    useHubFilterStore.getState().setSelection(['h-gr', 'h-in'], ['Romania', 'India']);
    renderWithProviders(<HubFilterSelect />, {
      session: { hub_scope_all: false, hub_ids: ['h-in'], roles: ['Hub Planner'] },
    });
    await waitFor(() => expect(state()).toEqual({ hubIds: ['h-in'], regions: ['India'] }));
  });

  it('keeps a persisted in-scope selection, and does not prune while /hubs is still loading', () => {
    hubs.data = undefined;
    useHubFilterStore.getState().setSelection(['h-gr'], []);
    const { unmount } = renderWithProviders(<HubFilterSelect />);
    expect(state().hubIds).toEqual(['h-gr']);
    unmount();
    hubs.data = HUBS;
    renderWithProviders(<HubFilterSelect />);
    expect(state().hubIds).toEqual(['h-gr']);
    expect(trigger()).toHaveTextContent('R&D-Greece');
  });

  it('shows Countries and Hubs as labelled groups, and hides a country with no in-scope hub', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<HubFilterSelect />);
    await user.click(trigger());
    expect(await screen.findByRole('group', { name: 'Countries' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Hubs' })).toBeInTheDocument();
    unmount();
    renderWithProviders(<HubFilterSelect />, {
      session: { hub_scope_all: false, hub_ids: ['h-in', 'h-pdin'], roles: ['Hub Planner'] },
    });
    await user.click(trigger());
    expect(screen.queryByRole('option', { name: 'Romania' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Greece' })).not.toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<HubFilterSelect />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('summarizeHubSelection / pruneHubSelection', () => {
  const name = (id: string) => HUBS.find((h) => h.id === id)?.name ?? '?';
  it('names up to two picks, otherwise counts them', () => {
    expect(summarizeHubSelection([], [], name)).toBe('All hubs');
    expect(summarizeHubSelection(['h-gr'], ['India'], name)).toBe('India + R&D-Greece');
    expect(summarizeHubSelection(['h-gr', 'h-ro', 'h-in'], [], name)).toBe('3 hubs');
    expect(summarizeHubSelection([], ['Greece', 'India', 'Romania'], name)).toBe('3 countries');
    expect(summarizeHubSelection(['h-gr', 'h-ro'], ['India'], name)).toBe('1 country + 2 hubs');
  });
  it('returns null when nothing changes or the scope is loading', () => {
    expect(pruneHubSelection(['h-gr'], [], null, null)).toBeNull();
    expect(pruneHubSelection(['h-gr'], ['Greece'], HUBS, ['Greece'])).toBeNull();
    expect(pruneHubSelection(['h-gr', 'x'], ['India'], HUBS, ['Greece'])).toEqual({ hubIds: ['h-gr'], regions: [] });
  });
});

describe('<HubFilterChip> (page header)', () => {
  it('renders nothing under "All hubs"', () => {
    renderWithProviders(<HubFilterChip />);
    expect(screen.queryByTestId('hub-filter-chip')).not.toBeInTheDocument();
  });

  it('names one hub and clears it', async () => {
    const user = userEvent.setup();
    useHubFilterStore.getState().setSelection(['h-ro'], []);
    const { container } = renderWithProviders(<HubFilterChip />);
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hub: PD-Romania');
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Clear hub filter (PD-Romania)' }));
    expect(state()).toEqual({ hubIds: [], regions: [] });
    expect(screen.queryByTestId('hub-filter-chip')).not.toBeInTheDocument();
  });

  it('reads "Country: India" for one country', async () => {
    const user = userEvent.setup();
    useHubFilterStore.getState().setSelection([], ['India']);
    renderWithProviders(<HubFilterChip />);
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Country: India');
    await user.click(screen.getByRole('button', { name: 'Clear country filter (India)' }));
    expect(state()).toEqual({ hubIds: [], regions: [] });
  });

  it('summarises a mixed selection ("India + R&D-Greece", "3 hubs")', () => {
    useHubFilterStore.getState().setSelection(['h-gr'], ['India']);
    const { unmount } = renderWithProviders(<HubFilterChip />);
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hubs: India + R&D-Greece');
    unmount();
    useHubFilterStore.getState().setSelection(['h-gr', 'h-ro', 'h-in'], []);
    renderWithProviders(<HubFilterChip />);
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hubs: 3 hubs');
    expect(screen.getByRole('button', { name: 'Clear hubs filter (3 hubs)' })).toBeInTheDocument();
  });
});

describe('regionsInScope (P13, ADR 0025)', () => {
  it('lists each lab_region holding an in-scope hub, in Greece / India / Romania order', () => {
    expect(regionsInScope(HUBS)).toEqual(['Greece', 'India', 'Romania']);
    expect(regionsInScope([HUBS[2]!, HUBS[3]!])).toEqual(['India', 'Romania']);
    expect(regionsInScope([])).toEqual([]);
  });
  it('is unknown while loading, and only resets a country with no in-scope hub', () => {
    expect(regionsInScope(null)).toBeNull();
    expect(shouldResetRegion('India', null)).toBe(false);
    expect(shouldResetRegion(null, ['Greece'])).toBe(false);
    expect(shouldResetRegion('India', ['Greece'])).toBe(true);
    expect(shouldResetRegion('Greece', ['Greece'])).toBe(false);
  });
});

describe('<CountrySegmented> (Dashboard header, multi-select toggles)', () => {
  it('shows All Hubs + the in-scope countries with CSS flags; several countries can be on', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<CountrySegmented />);
    expect(screen.getByRole('group', { name: 'Country filter' })).toBeInTheDocument();
    const buttons = screen.getAllByRole('button').map((r) => r.textContent);
    expect(buttons).toEqual(['All Hubs', 'Greece', 'India', 'Romania']);
    expect(screen.getByRole('button', { name: 'All Hubs' })).toHaveAttribute('aria-pressed', 'true');
    // Inline CSS flags, decorative (no emoji, no injected markup).
    expect(screen.getByTestId('flag-Greece')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);

    await user.click(screen.getByRole('button', { name: 'Greece' }));
    await user.click(screen.getByRole('button', { name: 'Romania' }));
    expect(state()).toEqual({ hubIds: [], regions: ['Greece', 'Romania'] });
    expect(screen.getByRole('button', { name: 'Greece' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'All Hubs' })).toHaveAttribute('aria-pressed', 'false');
    // Un-pressing one keeps the other.
    await user.click(screen.getByRole('button', { name: 'Greece' }));
    expect(state().regions).toEqual(['Romania']);
    // Un-pressing the last one is "All hubs".
    await user.click(screen.getByRole('button', { name: 'Romania' }));
    expect(state()).toEqual({ hubIds: [], regions: [] });
    expect(screen.getByRole('button', { name: 'All Hubs' })).toHaveAttribute('aria-pressed', 'true');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('keeps header-picked hubs beside a country; "All Hubs" clears both', async () => {
    const user = userEvent.setup();
    useHubFilterStore.getState().setSelection(['h-gr'], []);
    renderWithProviders(<CountrySegmented />);
    for (const b of screen.getAllByRole('button')) expect(b).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'India' }));
    expect(state()).toEqual({ hubIds: ['h-gr'], regions: ['India'] });
    await user.click(screen.getByRole('button', { name: 'All Hubs' }));
    expect(state()).toEqual({ hubIds: [], regions: [] });
  });

  it("hides countries outside the caller's scope", () => {
    renderWithProviders(<CountrySegmented />, {
      session: { hub_scope_all: false, hub_ids: ['h-ro'], roles: ['Hub Planner'] },
    });
    expect(screen.getAllByRole('button').map((r) => r.textContent)).toEqual(['All Hubs', 'Romania']);
  });
});
