import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { permissionsFrom } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';
import { ApiError } from '@/lib/api/client';
import type { CapacitySummary, ChamberRead, EngineerRead } from './api/types';

const hooks = {
  useEngineerList: vi.fn(),
  useChamberList: vi.fn(),
  useCreateEngineer: vi.fn(),
  useUpdateEngineer: vi.fn(),
  useDeleteEngineer: vi.fn(),
  useCreateChamber: vi.fn(),
  useUpdateChamber: vi.fn(),
  useDeleteChamber: vi.fn(),
  useApplyLogic: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useCapacitySummary: vi.fn(),
  useResourceLoad: vi.fn(),
  useResourceLoadOptions: vi.fn(),
};
vi.mock('./hooks/use-planning', () => ({
  useEngineerList: (hubId: unknown) => hooks.useEngineerList(hubId),
  useChamberList: () => hooks.useChamberList(),
  useCreateEngineer: () => hooks.useCreateEngineer(),
  useUpdateEngineer: () => hooks.useUpdateEngineer(),
  useDeleteEngineer: () => hooks.useDeleteEngineer(),
  useCreateChamber: () => hooks.useCreateChamber(),
  useUpdateChamber: () => hooks.useUpdateChamber(),
  useDeleteChamber: () => hooks.useDeleteChamber(),
  useApplyLogic: () => hooks.useApplyLogic(),
  useActiveScheduleRun: (enabled: unknown) => hooks.useActiveScheduleRun(enabled),
  useCapacitySummary: () => hooks.useCapacitySummary(),
  useResourceLoad: (...args: unknown[]) => hooks.useResourceLoad(...args),
  useResourceLoadOptions: (enabled: unknown) => hooks.useResourceLoadOptions(enabled),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
      { id: 'hub-2', name: 'PD-India', lab_region: 'India', is_oem: false },
    ],
  }),
  useWorkflowStepTemplates: () => ({
    data: [
      { id: 'OEM-E', name: 'Proof of Concept', kind: 'lab', base_weeks: 3, code: 'POC' },
      { id: 'PDD-E', name: 'Design', kind: 'design', base_weeks: 3, code: 'DES' },
      { id: 'PDD-F', name: 'Proof of Concept', kind: 'lab', base_weeks: 3, code: 'POC' },
      { id: 'PDD-H', name: 'Certification Testing & Compliance', kind: 'lab', base_weeks: 3, code: 'CERT' },
    ],
    isPending: false,
  }),
}));

import PlanningPage from './PlanningPage';

function pending() {
  return { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
}
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

const pair = (year: number, remaining: number) => ({ year, remaining });

const engineer: EngineerRead = {
  id: 'e1',
  name: 'Ada Lovelace',
  hub_id: 'hub-1',
  fte: 1,
  allowed_categories: ['A+', 'B'],
  user_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  weekdays_per_week: 5,
  capacity_weeks: pair(44.5, 9.25),
  capacity_days: pair(222.5, 46.25),
};
const lokesh: EngineerRead = {
  ...engineer,
  id: 'e2',
  name: 'Lokesh',
  hub_id: 'hub-2',
  fte: 0.5,
  allowed_categories: ['C'],
  capacity_weeks: pair(21.75, 4.5),
  capacity_days: pair(130.5, 27),
};

const chamber: ChamberRead = {
  id: 'c1',
  code: 'GR-CH1',
  lab_region: 'Greece',
  max_concurrent: 2,
  platforms: 1,
  efficiency: 0.21,
  maintenance_weeks: 2,
  breakdown_weeks: 3,
  calibration_weeks: 1,
  working_weeks_per_chamber: 43.4,
  efficient_lab_weeks: 26.04,
  allowed_stages: ['PDD-F'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  weekdays_per_week: 5,
  working_weeks: 38.6,
  capacity_weeks: pair(8.11, 1.71),
  capacity_days: pair(40.55, 8.55),
};

const summary: CapacitySummary = {
  current_week: 42,
  design: {
    hubs: [
      { hub: 'R&D-Greece', engineer_count: 1, fte_total: 1, weekdays_per_week: 5, capacity_weeks: pair(44.5, 9.25), capacity_days: pair(222.5, 46.25), share_pct: pair(67.17, 67.27) },
      { hub: 'PD-India', engineer_count: 1, fte_total: 0.5, weekdays_per_week: 6, capacity_weeks: pair(21.75, 4.5), capacity_days: pair(130.5, 27), share_pct: pair(32.83, 32.73) },
    ],
    total: { engineer_count: 2, fte_total: 1.5, capacity_weeks: pair(66.25, 13.75), capacity_days: pair(353, 73.25) },
  },
  lab: {
    regions: [
      { lab_region: 'Greece', chamber_count: 1, weekdays_per_week: 5, capacity_weeks: pair(8.11, 1.71), capacity_days: pair(40.55, 8.55), share_pct: pair(100, 100) },
    ],
    total: { chamber_count: 1, capacity_weeks: pair(8.11, 1.71), capacity_days: pair(40.55, 8.55) },
  },
};

let updateEngineer: ReturnType<typeof vi.fn>;
let updateChamber: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  updateEngineer = vi.fn().mockResolvedValue({});
  updateChamber = vi.fn().mockResolvedValue({});
  hooks.useEngineerList.mockReturnValue(ready([engineer, lokesh]));
  hooks.useChamberList.mockReturnValue(ready([chamber]));
  hooks.useCreateEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useUpdateEngineer.mockReturnValue({ mutateAsync: updateEngineer });
  hooks.useDeleteEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useCreateChamber.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useUpdateChamber.mockReturnValue({ mutateAsync: updateChamber });
  hooks.useDeleteChamber.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useApplyLogic.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false, data: undefined });
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
  hooks.useCapacitySummary.mockReturnValue(ready(summary));
  hooks.useResourceLoad.mockReturnValue(pending());
  hooks.useResourceLoadOptions.mockReturnValue(pending());
});

function toolbar() {
  return within(screen.getByTestId('planning-toolbar'));
}

function totals() {
  return screen.getAllByTestId('total-headline').map((n) => n.textContent);
}

describe('PlanningPage (P19-T04 Overview)', () => {
  it('renders the client header: title, description, basis and unit toggles, Apply logic and Auto-assign', () => {
    renderWithProviders(<PlanningPage />);
    expect(screen.getByRole('heading', { name: 'Capacity Planning' })).toBeInTheDocument();
    expect(screen.getByText('Configure resource mapping, availability, and capacity logic for the year.')).toBeInTheDocument();
    expect(toolbar().getByRole('radio', { name: 'YTD 2026' })).toHaveAttribute('aria-checked', 'true');
    expect(toolbar().getByRole('radio', { name: 'Weeks' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Apply logic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Auto-assign projects' })).toBeInTheDocument();
    expect(within(screen.getAllByRole('tablist')[0]!).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Overview', 'Engineers', 'Chambers', 'What-if planner']);
  });

  it('orders totals, then design resources, then lab capacities, then resource load analytics', () => {
    renderWithProviders(<PlanningPage />);
    const order = [
      screen.getByTestId('capacity-totals'),
      screen.getByRole('heading', { name: 'Design resources (engineers)' }),
      screen.getByRole('heading', { name: 'Lab & chamber capacities' }),
      screen.getByRole('heading', { name: 'Resource load analytics' }),
    ];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const hubCards = screen.getAllByTestId(/^hub-card-/).map((n) => n.getAttribute('data-testid'));
    expect(hubCards).toEqual(['hub-card-R&D-Greece', 'hub-card-PD-India']);
  });

  it('totals are the served fields of the selected basis and unit; the toggles switch them', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    // YTD (remaining), weeks
    expect(totals()).toEqual(['13.8 wks', '1.7 wks']);
    expect(screen.getByText(/≈ 73 man-days/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 9 lab-days/)).toBeInTheDocument();
    expect(screen.getByText(/Total design capacity — YTD 2026/)).toBeInTheDocument();

    await user.click(toolbar().getByRole('radio', { name: 'Full year' }));
    expect(totals()).toEqual(['66.3 wks', '8.1 wks']);
    expect(screen.getByText(/Total design capacity — 2026 full year/)).toBeInTheDocument();

    await user.click(toolbar().getByRole('radio', { name: 'Days' }));
    expect(totals()).toEqual(['353 man-days', '41 lab-days']);
    expect(screen.getByText(/≈ 66.3 weeks/)).toBeInTheDocument();
  });

  it('hub and lab cards show the served share % and the weeks / days pills', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    const greece = screen.getByTestId('hub-card-R&D-Greece');
    expect(within(greece).getByRole('heading', { name: /R&D-Greece Hub \(67.27%\)/ })).toBeInTheDocument();
    expect(within(greece).getByRole('list', { name: 'R&D-Greece design capacity' })).toHaveTextContent('9.3 wks46 days');
    const lab = screen.getByTestId('lab-card-Greece');
    expect(within(lab).getByRole('heading', { name: /Greece labs \(100%\)/ })).toBeInTheDocument();

    await user.click(toolbar().getByRole('radio', { name: 'Full year' }));
    expect(within(greece).getByRole('heading', { name: /R&D-Greece Hub \(67.17%\)/ })).toBeInTheDocument();
    expect(within(greece).getByRole('list', { name: 'R&D-Greece design capacity' })).toHaveTextContent('44.5 wks223 days');
  });

  it('per-engineer and per-chamber capacity come from their own served fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('9.3')).toBeInTheDocument();
    const ch = screen.getByTestId('chamber-row-c1');
    expect(within(ch).getByText('1.7')).toBeInTheDocument();
    expect(within(ch).getByText('38.6')).toBeInTheDocument(); // working_weeks, not working_weeks_per_chamber
    await user.click(toolbar().getByRole('radio', { name: 'Days' }));
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('46')).toBeInTheDocument();
  });

  it('category chips reflect allowed_categories (all eight values) and stage chips the lab steps, PDD first', () => {
    renderWithProviders(<PlanningPage />);
    const row = screen.getByTestId('engineer-row-e1');
    const chips = within(row).getAllByRole('button', { name: /^Allow category / });
    expect(chips.map((c) => c.textContent)).toEqual(['A+', 'A', 'B', 'C', 'OEM', 'A-OEM', 'B-OEM', 'C-OEM']);
    expect(within(row).getByRole('button', { name: 'Allow category B for Ada Lovelace' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(row).getByRole('button', { name: 'Allow category C for Ada Lovelace' })).toHaveAttribute('aria-pressed', 'false');

    const ch = screen.getByTestId('chamber-row-c1');
    const stages = within(ch).getAllByRole('button', { name: /^Allow stage / }).map((b) => b.getAttribute('aria-label'));
    expect(stages).toEqual([
      'Allow stage PDD-F Proof of concept for GR-CH1',
      'Allow stage PDD-H Certification for GR-CH1',
      'Allow stage OEM-E Proof of concept for GR-CH1',
    ]);
    expect(within(ch).getByRole('button', { name: 'Allow stage PDD-F Proof of concept for GR-CH1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('chip toggles and inline FTE / platforms / efficiency save through the existing PATCH mutations', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' }));
    expect(updateEngineer).toHaveBeenLastCalledWith({ engineerId: 'e1', body: { allowed_categories: ['A+', 'B', 'C'] } });
    await user.click(screen.getByRole('button', { name: 'Allow category B for Ada Lovelace' }));
    expect(updateEngineer).toHaveBeenLastCalledWith({ engineerId: 'e1', body: { allowed_categories: ['A+'] } });

    const fte = screen.getByRole('spinbutton', { name: 'FTE for Ada Lovelace' });
    await user.clear(fte);
    await user.type(fte, '0.8{Enter}');
    expect(updateEngineer).toHaveBeenLastCalledWith({ engineerId: 'e1', body: { fte: 0.8 } });

    const plat = screen.getByRole('spinbutton', { name: 'Platforms for GR-CH1' });
    await user.clear(plat);
    await user.type(plat, '3');
    await user.tab();
    expect(updateChamber).toHaveBeenLastCalledWith({ chamberId: 'c1', body: { platforms: 3 } });

    await user.click(screen.getByRole('button', { name: 'Allow stage PDD-H Certification for GR-CH1' }));
    expect(updateChamber).toHaveBeenLastCalledWith({ chamberId: 'c1', body: { allowed_stages: ['PDD-F', 'PDD-H'] } });
  });

  it('an invalid inline value is rejected with the form schema message and not sent', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    const fte = screen.getByRole('spinbutton', { name: 'FTE for Ada Lovelace' });
    await user.clear(fte);
    await user.type(fte, '0{Enter}');
    expect(screen.getByRole('alert')).toHaveTextContent('FTE must be greater than 0');
    expect(updateEngineer).not.toHaveBeenCalled();
  });

  it('a rejected chip save shows the server message', async () => {
    const user = userEvent.setup();
    updateChamber.mockRejectedValueOnce(new ApiError(422, 'bad', 'allowed_stages must be lab-kind steps only'));
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Allow stage PDD-H Certification for GR-CH1' }));
    expect(await screen.findByText(/Not saved: allowed_stages must be lab-kind/)).toBeInTheDocument();
  });

  it('a read-only role sees static values and no editable controls', () => {
    renderWithProviders(<PlanningPage />, { session: { roles: ['Portfolio Manager'], permissions: permissionsFrom({ capacity_planning: 'r' }) } });
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Allow / })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Add engineer to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Delete / })).not.toBeInTheDocument();
    const row = screen.getByTestId('engineer-row-e1');
    expect(within(row).getByText('A+')).toBeInTheDocument();
    expect(within(row).queryByText('C')).not.toBeInTheDocument();
    expect(within(row).getByText('1')).toBeInTheDocument();
  });

  it('a Hub Planner edits only the cards of their own hub (and its lab region)', () => {
    renderWithProviders(<PlanningPage />, {
      session: { roles: ['Hub Planner'], hub_scope_all: false, hub_ids: ['hub-2'], permissions: permissionsFrom({ capacity_planning: 'rw' }) },
    });
    expect(within(screen.getByTestId('hub-card-PD-India')).getAllByRole('spinbutton')).toHaveLength(1);
    expect(within(screen.getByTestId('hub-card-R&D-Greece')).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(screen.getByTestId('lab-card-Greece')).queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('"Add" on a hub card opens the existing engineer form with that hub selected, and creates through the existing mutation', async () => {
    const user = userEvent.setup();
    const create = vi.fn().mockResolvedValue({});
    hooks.useCreateEngineer.mockReturnValue({ mutateAsync: create });
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Add engineer to PD-India' }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Name/), 'Rishi');
    await user.click(within(dialog).getByRole('button', { name: 'Add engineer' }));
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Rishi', hub_id: 'hub-2' }));
  });

  it('a failed capacity summary prints "—" for totals, shares and pills, never a browser figure', () => {
    hooks.useCapacitySummary.mockReturnValue(failed(new ApiError(500, 'boom')));
    renderWithProviders(<PlanningPage />);
    expect(totals()).toEqual(['— wks', '— wks']);
    const greece = screen.getByTestId('hub-card-R&D-Greece');
    expect(within(greece).getByTestId('share')).toHaveTextContent('(—)');
    expect(within(greece).getByRole('list', { name: 'R&D-Greece design capacity' })).toHaveTextContent('— wks— days');
    // Per-row figures are the rows' own served fields and still show.
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('9.3')).toBeInTheDocument();
    expect(screen.getByText(/capacity summary could not be loaded/)).toBeInTheDocument();
  });

  it('does not fetch resource load until the section is on screen (lazy, personal data)', () => {
    renderWithProviders(<PlanningPage />);
    expect(hooks.useResourceLoad).toHaveBeenCalled();
    for (const call of hooks.useResourceLoad.mock.calls) expect(call[2]).toBe(false);
    for (const call of hooks.useResourceLoadOptions.mock.calls) expect(call[0]).toBe(false);
  });

  it('has no serious axe violations (editable view)', async () => {
    const { container } = renderWithProviders(<PlanningPage />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('PlanningPage (kept capability)', () => {
  it('degrades to an access notice on a 403', () => {
    hooks.useEngineerList.mockReturnValue(failed(new ApiError(403, 'forbidden')));
    renderWithProviders(<PlanningPage />);
    expect(screen.getByText(/does not have access to Capacity Planning/i)).toBeInTheDocument();
  });

  it('shows the empty state when no engineers are registered', () => {
    hooks.useEngineerList.mockReturnValue(ready([]));
    hooks.useCapacitySummary.mockReturnValue(pending());
    renderWithProviders(<PlanningPage />);
    expect(screen.getByText('No engineers registered yet')).toBeInTheDocument();
  });

  it('Engineers tab lists engineers and re-fetches with the hub filter', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'Engineers' }));
    expect(hooks.useEngineerList).toHaveBeenLastCalledWith(undefined);
    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    expect(hooks.useEngineerList).toHaveBeenCalledWith('hub-1');
  });

  it('deleting an engineer requires confirmation', async () => {
    const user = userEvent.setup();
    const del = vi.fn().mockResolvedValue(undefined);
    hooks.useDeleteEngineer.mockReturnValue({ mutateAsync: del, isPending: false });
    renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-row-e1')).getByRole('button', { name: 'Delete Ada Lovelace' }));
    const dialog = await screen.findByRole('dialog');
    expect(del).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(del).toHaveBeenCalledWith('e1');
  });

  it('Chambers tab lists chambers with the full detail table', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'Chambers' }));
    expect(screen.getByRole('columnheader', { name: /Downtime/ })).toBeInTheDocument();
  });

  it('"Apply logic" opens the Apply Logic panel in a dialog; confirming calls the mutation', async () => {
    const user = userEvent.setup();
    const apply = vi.fn().mockResolvedValue({});
    hooks.useApplyLogic.mockReturnValue({ mutateAsync: apply, isPending: false, data: undefined });
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Apply logic' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply logic' });
    await user.click(within(dialog).getByRole('button', { name: 'Apply Logic' }));
    const confirm = await screen.findByRole('dialog', { name: /whole portfolio/ });
    expect(apply).not.toHaveBeenCalled();
    await user.click(within(confirm).getByRole('button', { name: 'Apply Logic' }));
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a 403 on Apply logic shows the Admin-only message and the read-only notice', async () => {
    const user = userEvent.setup();
    hooks.useApplyLogic.mockReturnValue({ mutateAsync: vi.fn().mockRejectedValue(new ApiError(403, 'forbidden')), isPending: false, data: undefined });
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Apply logic' }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply logic' });
    await user.click(within(dialog).getByRole('button', { name: 'Apply Logic' }));
    const confirm = await screen.findByRole('dialog', { name: /whole portfolio/ });
    await user.click(within(confirm).getByRole('button', { name: 'Apply Logic' }));
    expect(await screen.findByText(/limited to Admins/)).toBeInTheDocument();
  });

  it('"Auto-assign projects" keeps its OQ #10 pending state', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Auto-assign projects' }));
    expect(await screen.findByText('Auto-assign is pending a client decision')).toBeInTheDocument();
  });

  it('keeps the What-if planner tab and its half-built scenario across tab switches', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'What-if planner' }));
    expect(screen.getByRole('heading', { name: 'Scenario builder' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Add project line' }));
    await user.click(screen.getByRole('tab', { name: 'Chambers' }));
    await user.click(screen.getByRole('tab', { name: 'What-if planner' }));
    expect(screen.getByRole('group', { name: /Added projects, line 1/ })).toBeInTheDocument();
  });
});
