import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { ResourceLoadOptionsResponse, ResourceLoadResponse } from '../../api/types';

const hooks = { useResourceLoad: vi.fn(), useResourceLoadOptions: vi.fn() };
vi.mock('../../hooks/use-planning', () => ({
  useResourceLoad: (...args: unknown[]) => hooks.useResourceLoad(...args),
  useResourceLoadOptions: (enabled: unknown) => hooks.useResourceLoadOptions(enabled),
}));

import { ResourceLoadSection } from './resource-load-section';

const HUBS = [
  { id: 'hub-1', name: 'R&D-Greece' as const, lab_region: 'Greece' as const, is_oem: false },
  { id: 'hub-2', name: 'PD-India' as const, lab_region: 'India' as const, is_oem: false },
];

const options: ResourceLoadOptionsResponse = {
  hubs: ['R&D-Greece', 'PD-India'],
  lab_regions: ['Greece', 'India'],
  project_types: ['NM', 'CO'],
  project_statuses: ['In Development', 'In Queue'],
  categories: ['A', 'B'],
  requesting_departments: [],
  requesting_department_available: false,
  engineers: [
    { engineer_id: 'e1', name: 'Ada', hub: 'R&D-Greece' },
    { engineer_id: 'e2', name: 'Lokesh', hub: 'PD-India' },
  ],
};

const load: ResourceLoadResponse = {
  has_active_schedule_run: true,
  schedule_run_version: 7,
  current_week: 42,
  basis: 'remaining',
  engineers: [
    { engineer_id: 'e1', name: 'Ada', hub: 'R&D-Greece', weekdays_per_week: 5, capacity_weeks: 9.25, load_weeks: 12.5, utilization_pct: 135.14, capacity_days: 46.25, load_days: 62.5 },
    { engineer_id: 'e2', name: 'Lokesh', hub: 'PD-India', weekdays_per_week: 6, capacity_weeks: 4.5, load_weeks: 2, utilization_pct: 44.44, capacity_days: 27, load_days: 12 },
  ],
  chambers: [
    { chamber_id: 'c1', code: 'GR-CH1', lab_region: 'Greece', weekdays_per_week: 5, capacity_weeks: 1.71, load_weeks: 1, utilization_pct: 58.48, capacity_days: 8.55, load_days: 5 },
  ],
  totals: {
    engineers: { capacity_weeks: 13.75, load_weeks: 14.5, utilization_pct: 105.45, capacity_days: 73.25, load_days: 74.5 },
    chambers: { capacity_weeks: 1.71, load_weeks: 1, utilization_pct: 58.48, capacity_days: 8.55, load_days: 5 },
  },
  filters_applied: {
    hub_id: null, region: null, project_type: [], project_status: [], requesting_department: [], category: [], engineer_id: [], basis: 'remaining',
  },
};

let ioCallback: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
const OriginalIO = window.IntersectionObserver;

beforeEach(() => {
  vi.clearAllMocks();
  ioCallback = null;
  window.IntersectionObserver = class {
    constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
      ioCallback = cb;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
    root = null;
    rootMargin = '';
    thresholds = [];
  } as unknown as typeof IntersectionObserver;
  hooks.useResourceLoadOptions.mockReturnValue({ data: options, isPending: false });
  hooks.useResourceLoad.mockReturnValue({ data: load, isPending: false, isError: false, isFetching: false, refetch: vi.fn() });
});
afterEach(() => {
  window.IntersectionObserver = OriginalIO;
});

function reveal() {
  act(() => ioCallback?.([{ isIntersecting: true }]));
}

const EMPTY = { hubId: null, types: [], statuses: [], departments: [], categories: [], engineerIds: [] };

describe('ResourceLoadSection', () => {
  it('fetches nothing until the section scrolls into view, then enables both queries', () => {
    renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('remaining', EMPTY, false);
    expect(hooks.useResourceLoadOptions).toHaveBeenLastCalledWith(false);
    expect(screen.queryByTestId('load-bars')).not.toBeInTheDocument();
    reveal();
    expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('remaining', EMPTY, true);
    expect(hooks.useResourceLoadOptions).toHaveBeenLastCalledWith(true);
  });

  it('maps the filters to the query (debounced), and Clear resets them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResourceLoadSection basis="year" unit="weeks" hubs={HUBS} />);
    reveal();

    await user.click(screen.getByRole('button', { name: 'Type filter: All' }));
    await user.click(await screen.findByRole('checkbox', { name: /CO · Cost Optimization/ }));
    await user.keyboard('{Escape}');
    // Not yet: the change is debounced.
    expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('year', EMPTY, true);
    await waitFor(() => expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('year', { ...EMPTY, types: ['CO'] }, true), { timeout: 2000 });

    await user.click(screen.getByRole('button', { name: 'Engineer filter: All' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Lokesh (PD-India)' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('year', { ...EMPTY, types: ['CO'], engineerIds: ['e2'] }, true), { timeout: 2000 });

    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    await user.click(await screen.findByRole('option', { name: 'PD-India' }));
    await waitFor(() => expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('year', { ...EMPTY, hubId: 'hub-2', types: ['CO'], engineerIds: ['e2'] }, true), { timeout: 2000 });

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('year', EMPTY, true), { timeout: 2000 });
  });

  it('disables Dept with a tooltip when the server says departments are not recorded', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    const dept = screen.getByRole('button', { name: 'Dept filter: All, unavailable' });
    expect(dept).toHaveAttribute('aria-disabled', 'true');
    await user.hover(dept);
    expect((await screen.findAllByText('No department data yet')).length).toBeGreaterThan(0);
    await user.click(dept);
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  it('enables Dept over the served departments when the server says they are available (P24-T02)', async () => {
    const user = userEvent.setup();
    hooks.useResourceLoadOptions.mockReturnValue({
      data: { ...options, requesting_departments: ['Marketing', 'Sales'], requesting_department_available: true },
      isPending: false,
    });
    renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    expect(screen.queryByRole('button', { name: /Dept filter: All, unavailable/ })).not.toBeInTheDocument();
    const dept = screen.getByRole('button', { name: 'Dept filter: All' });
    expect(dept).not.toHaveAttribute('aria-disabled');
    await user.hover(dept);
    expect(screen.queryByText('No department data yet')).not.toBeInTheDocument();
    await user.click(dept);
    expect(await screen.findByRole('checkbox', { name: 'Marketing' })).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: 'Sales' }));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(hooks.useResourceLoad).toHaveBeenLastCalledWith('remaining', { ...EMPTY, departments: ['Sales'] }, true), { timeout: 2000 });
  });

  it('charts and tables show the served fields in the page unit, labelled "<name> (<hub>)"', () => {
    const { rerender } = renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    const eng = screen.getByRole('region', { name: /^Engineer load vs capacity \(/ });
    expect(within(eng).getByText('Ada (R&D-Greece)')).toBeInTheDocument();
    const ada = within(eng).getByTestId('load-row-e1');
    expect(ada).toHaveTextContent('Ada');
    expect(ada).toHaveTextContent('9.3');
    expect(ada).toHaveTextContent('12.5');
    expect(ada).toHaveTextContent('135.14%');
    expect(within(eng).getByText('105.45%')).toBeInTheDocument(); // served total
    const ch = screen.getByRole('region', { name: /^Chamber load vs capacity \(/ });
    expect(within(ch).getByText('GR-CH1 (Greece)')).toBeInTheDocument();
    expect(within(ch).getByRole('columnheader', { name: /Region/ })).toBeInTheDocument();

    rerender(<ResourceLoadSection basis="remaining" unit="days" hubs={HUBS} />);
    expect(within(screen.getByRole('region', { name: /^Engineer load vs capacity \(/ })).getByTestId('load-row-e1')).toHaveTextContent('46');
    expect(within(screen.getByRole('region', { name: /^Engineer load vs capacity \(/ })).getByTestId('load-row-e1')).toHaveTextContent('63');
  });

  it('highlights utilization over 100% in red with a non-colour cue', () => {
    renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    const ada = screen.getByTestId('load-row-e1');
    const util = within(ada).getByText(/135.14%/).closest('td')!;
    expect(util).toHaveAttribute('data-over');
    expect(util.className).toContain('text-danger');
    expect(util).toHaveTextContent('(over capacity)');
    const lokesh = screen.getByTestId('load-row-e2').querySelectorAll('td')[4]!;
    expect(lokesh).not.toHaveAttribute('data-over');
  });

  it('table rows sort by a column header (aria-sort)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    const eng = screen.getByRole('region', { name: /^Engineer load vs capacity \(/ });
    const rows = () => within(eng).getAllByTestId(/^load-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rows()).toEqual(['load-row-e1', 'load-row-e2']);
    await user.click(within(eng).getByRole('button', { name: /Util %/ }));
    expect(within(eng).getByRole('columnheader', { name: /Util %/ })).toHaveAttribute('aria-sort', 'descending');
    expect(rows()).toEqual(['load-row-e1', 'load-row-e2']);
    await user.click(within(eng).getByRole('button', { name: /Util %/ }));
    expect(rows()).toEqual(['load-row-e2', 'load-row-e1']);
    await user.click(within(eng).getByRole('button', { name: /^Engineer/ }));
    expect(within(eng).getByRole('columnheader', { name: /^Engineer/ })).toHaveAttribute('aria-sort', 'ascending');
  });

  it.each([
    ['Type', 'Type filter options'],
    ['Status', 'Status filter options'],
    ['Dept', 'Department filter options'],
    ['Cat', 'Category filter options'],
    ['Engineer', 'Engineer filter options'],
  ])('QA-F24-1: the %s filter popover is a dialog with an accessible name (axe clean while open)', async (label, name) => {
    const user = userEvent.setup();
    hooks.useResourceLoadOptions.mockReturnValue({
      data: { ...options, requesting_departments: ['Marketing', 'Sales'], requesting_department_available: true },
      isPending: false,
    });
    renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    await user.click(screen.getByRole('button', { name: `${label} filter: All` }));
    const dialog = await screen.findByRole('dialog', { name });
    expect(within(dialog).getAllByRole('checkbox').length).toBeGreaterThan(0);
    expect(await seriousAxeViolations(document.body)).toEqual([]);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('has no serious axe violations', async () => {
    const { container } = renderWithProviders(<ResourceLoadSection basis="remaining" unit="weeks" hubs={HUBS} />);
    reveal();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
