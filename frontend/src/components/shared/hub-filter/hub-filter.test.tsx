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
  { id: 'h-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true },
  { id: 'h-sel', name: 'OEM-Seltek', lab_region: 'Greece', is_oem: true },
] as Hub[];

const hubs = { data: HUBS as Hub[] | undefined };
vi.mock('@/lib/api/reference', () => ({ useHubs: () => hubs }));

import { HubFilterChip } from './hub-filter-chip';
import { HubFilterSelect } from './hub-filter-select';
import { CountrySegmented } from './country-segmented';
import { hubsInScope, regionsInScope, shouldResetHub, shouldResetRegion } from './hub-scope';

beforeEach(() => {
  hubs.data = HUBS;
  useHubFilterStore.setState({ hubId: null, region: null });
});
afterEach(() => {
  useHubFilterStore.setState({ hubId: null, region: null });
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
    // P13 (ADR 0025): "All hubs", then the in-scope countries, then the in-scope hubs.
    expect(options).toEqual(['All hubs', 'India', 'R&D-India', 'PD-India']);
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

describe('<HubFilterSelect> countries group (P13, ADR 0025)', () => {
  it('offers "All hubs", a Countries group and a Hubs group', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubFilterSelect />);
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual([
      'All hubs',
      'Greece',
      'India',
      'Romania',
      'R&D-Greece',
      'R&D-India',
      'PD-India',
      'PD-Romania',
      'OEM-HCK',
      'OEM-Seltek',
    ]);
    expect(screen.getByText('Countries')).toBeInTheDocument();
    expect(screen.getByText('Hubs')).toBeInTheDocument();
  });

  it('choosing a country clears the hub; choosing a hub clears the country', async () => {
    const user = userEvent.setup();
    useHubFilterStore.setState({ hubId: 'h-gr', region: null });
    renderWithProviders(<HubFilterSelect />);
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    await user.click(await screen.findByRole('option', { name: 'India' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: 'India' });
    expect(screen.getByRole('combobox', { name: 'Hub filter' })).toHaveTextContent('India');
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    await user.click(await screen.findByRole('option', { name: 'PD-Romania' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: 'h-ro', region: null });
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    await user.click(await screen.findByRole('option', { name: 'All hubs' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: null });
  });

  it('hides a country with no in-scope hub and resets a persisted one', async () => {
    const user = userEvent.setup();
    useHubFilterStore.setState({ hubId: null, region: 'Romania' });
    renderWithProviders(<HubFilterSelect />, {
      session: { hub_scope_all: false, hub_ids: ['h-in', 'h-pdin'], roles: ['Hub Planner'] },
    });
    await waitFor(() => expect(useHubFilterStore.getState().region).toBeNull());
    await user.click(screen.getByRole('combobox', { name: 'Hub filter' }));
    expect(screen.queryByRole('option', { name: 'Romania' })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Greece' })).not.toBeInTheDocument();
  });
});

describe('<HubFilterChip> country (P13)', () => {
  it('reads "Country: India" and clears it', async () => {
    const user = userEvent.setup();
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    const { container } = renderWithProviders(<HubFilterChip />);
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Country: India');
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Clear country filter (India)' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: null });
  });
});

describe('<CountrySegmented> (Dashboard header, P13)', () => {
  it('shows All Hubs + the in-scope countries with CSS flags and binds to the store', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<CountrySegmented />);
    const group = screen.getByRole('radiogroup', { name: 'Country filter' });
    expect(group).toBeInTheDocument();
    const radios = screen.getAllByRole('radio').map((r) => r.textContent);
    expect(radios).toEqual(['All Hubs', 'Greece', 'India', 'Romania']);
    expect(screen.getByRole('radio', { name: 'All Hubs' })).toHaveAttribute('aria-checked', 'true');
    // Inline CSS flags, decorative (no emoji, no injected markup).
    expect(screen.getByTestId('flag-Greece')).toHaveAttribute('aria-hidden', 'true');
    expect(container.textContent).not.toMatch(/\p{Extended_Pictographic}/u);

    await user.click(screen.getByRole('radio', { name: 'Greece' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: 'Greece' });
    expect(screen.getByRole('radio', { name: 'Greece' })).toHaveAttribute('aria-checked', 'true');
    // Re-clicking the active country keeps it (no accidental empty state).
    await user.click(screen.getByRole('radio', { name: 'Greece' }));
    expect(useHubFilterStore.getState().region).toBe('Greece');
    await user.click(screen.getByRole('radio', { name: 'All Hubs' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: null });
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('a selected hub leaves no button on; picking a country clears the hub', async () => {
    const user = userEvent.setup();
    useHubFilterStore.setState({ hubId: 'h-gr', region: null });
    renderWithProviders(<CountrySegmented />);
    for (const radio of screen.getAllByRole('radio')) expect(radio).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('radio', { name: 'India' }));
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: 'India' });
  });

  it('hides countries outside the caller\'s scope', () => {
    renderWithProviders(<CountrySegmented />, {
      session: { hub_scope_all: false, hub_ids: ['h-ro'], roles: ['Hub Planner'] },
    });
    expect(screen.getAllByRole('radio').map((r) => r.textContent)).toEqual(['All Hubs', 'Romania']);
  });
});
