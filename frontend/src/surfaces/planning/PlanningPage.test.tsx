import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
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
  useReactivateEngineer: vi.fn(),
  useDeactivationPreview: vi.fn(),
  useDeactivateEngineer: vi.fn(),
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
  useEngineerList: (hubId: unknown, status: unknown) => hooks.useEngineerList(hubId, status),
  useChamberList: () => hooks.useChamberList(),
  useCreateEngineer: () => hooks.useCreateEngineer(),
  useUpdateEngineer: () => hooks.useUpdateEngineer(),
  useReactivateEngineer: () => hooks.useReactivateEngineer(),
  useDeactivationPreview: (id: unknown) => hooks.useDeactivationPreview(id),
  useDeactivateEngineer: () => hooks.useDeactivateEngineer(),
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
      { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-2', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
    ],
  }),
  useWorkflowStepTemplates: () => ({
    data: [
      { id: 'OEM-E', workflow_id: 'OEM', code: 'POC', name: 'Proof of Concept', kind: 'lab', sequence_order: 5, predecessor_ids: [] },
      { id: 'PDD-E', workflow_id: 'PDD', code: 'DES', name: 'Design', kind: 'design', sequence_order: 5, predecessor_ids: [] },
      { id: 'PDD-F', workflow_id: 'PDD', code: 'POC', name: 'Proof of Concept', kind: 'lab', sequence_order: 6, predecessor_ids: [] },
      { id: 'PDD-H', workflow_id: 'PDD', code: 'CERT', name: 'Certification Testing & Compliance', kind: 'lab', sequence_order: 8, predecessor_ids: [] },
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
  counts_in_capacity: true,
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
      { hub: 'R&D-Greece', engineer_count: 1, not_counted_engineer_count: 0, members: ['OEM-HCK', 'OEM-Seitek'], selected_member: null, fte_total: 1, weekdays_per_week: 5, capacity_weeks: pair(44.5, 9.25), capacity_days: pair(222.5, 46.25), share_pct: pair(67.17, 67.27) },
      { hub: 'PD-India', engineer_count: 1, not_counted_engineer_count: 0, members: [], selected_member: null, fte_total: 0.5, weekdays_per_week: 6, capacity_weeks: pair(21.75, 4.5), capacity_days: pair(130.5, 27), share_pct: pair(32.83, 32.73) },
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
  hooks.useReactivateEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useDeactivationPreview.mockReturnValue(pending());
  hooks.useDeactivateEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
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
    expect(totals()).toEqual(['14 wks', '2 wks']);
    expect(screen.getByText(/≈ 73 man-days/)).toBeInTheDocument();
    expect(screen.getByText(/≈ 9 lab-days/)).toBeInTheDocument();
    expect(screen.getByText(/Total design capacity — YTD 2026/)).toBeInTheDocument();

    await user.click(toolbar().getByRole('radio', { name: 'Full year' }));
    expect(totals()).toEqual(['66 wks', '8 wks']);
    expect(screen.getByText(/Total design capacity — 2026 full year/)).toBeInTheDocument();

    await user.click(toolbar().getByRole('radio', { name: 'Days' }));
    expect(totals()).toEqual(['353 man-days', '41 lab-days']);
    expect(screen.getByText(/≈ 66 weeks/)).toBeInTheDocument();
  });

  it('hub and lab cards show the served share % and the weeks / days pills', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    const greece = screen.getByTestId('hub-card-R&D-Greece');
    expect(within(greece).getByRole('heading', { name: /R&D-Greece Hub \(67%\)/ })).toBeInTheDocument();
    expect(within(greece).getByRole('list', { name: 'R&D-Greece design capacity' })).toHaveTextContent('9 wks46 days');
    const lab = screen.getByTestId('lab-card-Greece');
    expect(within(lab).getByRole('heading', { name: /Greece labs \(100%\)/ })).toBeInTheDocument();

    await user.click(toolbar().getByRole('radio', { name: 'Full year' }));
    expect(within(greece).getByRole('heading', { name: /R&D-Greece Hub \(67%\)/ })).toBeInTheDocument();
    expect(within(greece).getByRole('list', { name: 'R&D-Greece design capacity' })).toHaveTextContent('45 wks223 days');
  });

  it('per-engineer and per-chamber capacity come from their own served fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('9')).toBeInTheDocument();
    const ch = screen.getByTestId('chamber-row-c1');
    expect(within(ch).getByText('2')).toBeInTheDocument();
    expect(within(ch).getByText('39')).toBeInTheDocument(); // working_weeks, not working_weeks_per_chamber
    await user.click(toolbar().getByRole('radio', { name: 'Days' }));
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('46')).toBeInTheDocument();
  });

  it('cards are read-only until "Edit": chips are plain labels, values plain text, no toggles or inputs', () => {
    renderWithProviders(<PlanningPage />);
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Allow / })).toHaveLength(0);
    const row = screen.getByTestId('engineer-row-e1');
    expect(within(row).getByText('A+')).toBeInTheDocument();
    expect(within(row).queryByText('C')).not.toBeInTheDocument();
    expect(within(row).queryByRole('group')).not.toBeInTheDocument();
    // Each card has its own Edit next to "+ Add"; the per-row pencil / trash stay.
    expect(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit Greece labs' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Edit Ada Lovelace' })).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Deactivate Ada Lovelace' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Delete Ada Lovelace' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Save / })).not.toBeInTheDocument();
  });

  it('in edit mode the chips are toggle buttons reflecting allowed_categories (all eight) and the lab steps, PDD first', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    await user.click(screen.getByRole('button', { name: 'Edit Greece labs' }));
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
    // Only the edited cards: PD-India stays read-only.
    expect(within(screen.getByTestId('hub-card-PD-India')).queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('edit → toggle → Save sends exactly the changed fields, once per changed row; nothing before Save', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    const save = screen.getByRole('button', { name: 'Save R&D-Greece Hub' });
    expect(save).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' }));
    await user.click(screen.getByRole('button', { name: 'Allow category B for Ada Lovelace' }));
    expect(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' })).toHaveAttribute('data-changed', 'true');
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('Unsaved')).toBeInTheDocument();
    expect(updateEngineer).not.toHaveBeenCalled();
    expect(save).toBeEnabled();

    await user.click(save);
    expect(updateEngineer).toHaveBeenCalledTimes(1);
    expect(updateEngineer).toHaveBeenCalledWith({ engineerId: 'e1', body: { allowed_categories: ['A+', 'C'] } });
    // Back to read mode.
    expect(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' })).toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Allow / })).toHaveLength(0);
  });

  it('FTE, platforms, efficiency and stages are drafted and saved together per row; a value set back is not sent', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    const fte = screen.getByRole('spinbutton', { name: 'FTE for Ada Lovelace' });
    await user.clear(fte);
    await user.type(fte, '0.8{Enter}');
    expect(fte).toHaveAttribute('data-changed', 'true');
    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' }));
    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' })); // back to served
    expect(updateEngineer).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save R&D-Greece Hub' }));
    expect(updateEngineer).toHaveBeenCalledTimes(1);
    expect(updateEngineer).toHaveBeenCalledWith({ engineerId: 'e1', body: { fte: 0.8 } });

    await user.click(screen.getByRole('button', { name: 'Edit Greece labs' }));
    const plat = screen.getByRole('spinbutton', { name: 'Platforms for GR-CH1' });
    await user.clear(plat);
    await user.type(plat, '3');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Allow stage PDD-H Certification for GR-CH1' }));
    expect(updateChamber).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Save Greece labs' }));
    expect(updateChamber).toHaveBeenCalledTimes(1);
    expect(updateChamber).toHaveBeenCalledWith({ chamberId: 'c1', body: { platforms: 3, allowed_stages: ['PDD-F', 'PDD-H'] } });
  });

  it('Cancel restores the saved values and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Greece labs' }));
    const eff = screen.getByRole('spinbutton', { name: 'Efficiency for GR-CH1' });
    await user.clear(eff);
    await user.type(eff, '0.5');
    await user.click(screen.getByRole('button', { name: 'Allow stage OEM-E Proof of concept for GR-CH1' }));
    expect(screen.getByTestId('card-edit-count')).toHaveTextContent('1 row unsaved');
    await user.click(screen.getByRole('button', { name: 'Cancel Greece labs edits' }));
    expect(updateChamber).not.toHaveBeenCalled();
    const ch = screen.getByTestId('chamber-row-c1');
    expect(within(ch).getByText('0.21')).toBeInTheDocument();
    expect(within(ch).queryByText(/OEM-E/)).not.toBeInTheDocument();
    // Editing again starts from the saved values.
    await user.click(screen.getByRole('button', { name: 'Edit Greece labs' }));
    expect(screen.getByRole('spinbutton', { name: 'Efficiency for GR-CH1' })).toHaveValue(0.21);
    expect(screen.getByRole('button', { name: 'Allow stage OEM-E Proof of concept for GR-CH1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('an invalid value shows the form schema message, disables Save and is not sent', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    const fte = screen.getByRole('spinbutton', { name: 'FTE for Ada Lovelace' });
    await user.clear(fte);
    await user.type(fte, '0{Enter}');
    expect(screen.getByText('FTE must be greater than 0')).toBeInTheDocument();
    expect(fte).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('button', { name: 'Save R&D-Greece Hub' })).toBeDisabled();
    expect(updateEngineer).not.toHaveBeenCalled();
    // Escape restores the saved value.
    await user.type(fte, '{Escape}');
    expect(fte).toHaveValue(1);
  });

  it('partial failure: saved rows leave edit state, a failed row keeps its draft and shows the server message', async () => {
    const user = userEvent.setup();
    const grace: EngineerRead = { ...engineer, id: 'e3', name: 'Grace Hopper', allowed_categories: ['A'] };
    hooks.useEngineerList.mockReturnValue(ready([engineer, grace, lokesh]));
    updateEngineer.mockImplementation(({ engineerId }: { engineerId: string }) =>
      engineerId === 'e3' ? Promise.reject(new ApiError(422, 'bad', 'fte exceeds the hub limit')) : Promise.resolve({}),
    );
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' }));
    const fte = screen.getByRole('spinbutton', { name: 'FTE for Grace Hopper' });
    await user.clear(fte);
    await user.type(fte, '2');
    expect(screen.getByTestId('card-edit-count')).toHaveTextContent('2 rows unsaved');
    await user.click(screen.getByRole('button', { name: 'Save R&D-Greece Hub' }));

    expect(updateEngineer).toHaveBeenCalledTimes(2);
    expect(updateEngineer).toHaveBeenNthCalledWith(1, { engineerId: 'e1', body: { allowed_categories: ['A+', 'B', 'C'] } });
    expect(updateEngineer).toHaveBeenNthCalledWith(2, { engineerId: 'e3', body: { fte: 2 } });
    const failedRow = screen.getByTestId('engineer-row-e3');
    expect(await within(failedRow).findByRole('alert')).toHaveTextContent('Not saved: fte exceeds the hub limit');
    expect(within(failedRow).getByText('Unsaved')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'FTE for Grace Hopper' })).toHaveValue(2);
    // Still in edit mode for the failed row only.
    expect(screen.getByRole('button', { name: 'Save R&D-Greece Hub' })).toBeEnabled();
    expect(screen.getByTestId('card-edit-count')).toHaveTextContent('1 row unsaved');
    expect(within(screen.getByTestId('engineer-row-e1')).queryByRole('alert')).not.toBeInTheDocument();

    // Retrying sends only the failed row.
    updateEngineer.mockReset();
    updateEngineer.mockResolvedValue({});
    await user.click(screen.getByRole('button', { name: 'Save R&D-Greece Hub' }));
    expect(updateEngineer).toHaveBeenCalledTimes(1);
    expect(updateEngineer).toHaveBeenCalledWith({ engineerId: 'e3', body: { fte: 2 } });
    expect(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' })).toBeInTheDocument();
  });

  it('a 403 on Save downgrades the page to read-only and drops edit mode', async () => {
    const user = userEvent.setup();
    updateChamber.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Greece labs' }));
    await user.click(screen.getByRole('button', { name: 'Allow stage PDD-H Certification for GR-CH1' }));
    await user.click(screen.getByRole('button', { name: 'Save Greece labs' }));
    expect(screen.queryByRole('button', { name: /^Edit Greece labs/ })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: /^Allow / })).toHaveLength(0);
  });

  it('drafts survive switching tabs and back', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' }));
    await user.click(screen.getByRole('tab', { name: 'Chambers' }));
    await user.click(screen.getByRole('tab', { name: 'Overview' }));
    expect(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' })).toHaveAttribute('aria-pressed', 'true');
    expect(updateEngineer).not.toHaveBeenCalled();
  });

  it('a read-only role sees static values and no Edit, toggles or inputs', () => {
    renderWithProviders(<PlanningPage />, { session: { roles: ['Portfolio Manager'], permissions: permissionsFrom({ capacity_planning: 'r' }) } });
    expect(screen.queryAllByRole('spinbutton')).toHaveLength(0);
    expect(screen.queryAllByRole('button', { name: /^Allow / })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /^Edit .*(Hub|labs)$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Add engineer to/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^(Delete|Deactivate|Reactivate) / })).not.toBeInTheDocument();
    const row = screen.getByTestId('engineer-row-e1');
    expect(within(row).getByText('A+')).toBeInTheDocument();
    expect(within(row).queryByText('C')).not.toBeInTheDocument();
    expect(within(row).getByText('1')).toBeInTheDocument();
  });

  it('a Hub Planner gets Edit only on the cards of their own hub (and its lab region)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />, {
      session: { roles: ['Hub Planner'], hub_scope_all: false, hub_ids: ['hub-2'], permissions: permissionsFrom({ capacity_planning: 'rw' }) },
    });
    expect(screen.queryByRole('button', { name: 'Edit R&D-Greece Hub' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Edit Greece labs' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Edit PD-India Hub' }));
    expect(within(screen.getByTestId('hub-card-PD-India')).getAllByRole('spinbutton')).toHaveLength(1);
    expect(within(screen.getByTestId('hub-card-R&D-Greece')).queryAllByRole('spinbutton')).toHaveLength(0);
  });

  it('has no serious axe violations with cards in edit mode and a change pending', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    await user.click(screen.getByRole('button', { name: 'Edit Greece labs' }));
    await user.click(screen.getByRole('button', { name: 'Allow category C for Ada Lovelace' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  }, 30000);

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
    expect(within(screen.getByTestId('engineer-row-e1')).getByText('9')).toBeInTheDocument();
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
    expect(hooks.useEngineerList).toHaveBeenCalledWith([], 'active');
    await user.click(screen.getByRole('button', { name: 'Hub' }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('option', { name: 'PD-India' }));
    expect(hooks.useEngineerList).toHaveBeenCalledWith(['hub-1', 'hub-2'], 'active');
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

describe('PlanningPage (P38-T06 deactivate / reactivate)', () => {
  const inactive: EngineerRead = {
    ...engineer,
    id: 'e9',
    name: 'Theoni',
    active: false,
    deactivated_week: 47,
    deactivated_plan_year: 2026,
    deactivation_reason: 'left_company',
  };

  function listFor(status: unknown) {
    if (status === 'inactive') return ready([inactive]);
    if (status === 'all') return ready([engineer, inactive, lokesh]);
    return ready([engineer, lokesh]);
  }

  it('the roster shows active engineers by default; Show Inactive / All asks the server and tags inactive rows', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => listFor(status));
    renderWithProviders(<PlanningPage />);
    expect(hooks.useEngineerList).toHaveBeenCalledWith(undefined, 'active');
    expect(screen.queryByTestId('engineer-row-e9')).not.toBeInTheDocument();
    const show = within(screen.getByTestId('engineer-status-filter-overview'));
    expect(show.getByRole('radio', { name: 'Active' })).toHaveAttribute('aria-checked', 'true');
    await user.click(show.getByRole('radio', { name: 'All' }));
    expect(hooks.useEngineerList).toHaveBeenCalledWith(undefined, 'all');
    const row = screen.getByTestId('engineer-row-e9');
    expect(within(row).getByTestId('inactive-tag')).toHaveTextContent('Inactive');
    expect(within(row).getByRole('button', { name: 'Reactivate Theoni' })).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: 'Deactivate Theoni' })).not.toBeInTheDocument();
    // Same Show state on the Engineers tab.
    await user.click(screen.getByRole('tab', { name: 'Engineers' }));
    expect(within(screen.getByTestId('engineer-status-filter-engineers')).getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true');
    expect(hooks.useEngineerList).toHaveBeenCalledWith([], 'all');
  });

  it('an inactive engineer is outside the card draft: no FTE input or chip toggles in edit mode', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => listFor(status));
    renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-status-filter-overview')).getByRole('radio', { name: 'All' }));
    await user.click(screen.getByRole('button', { name: 'Edit R&D-Greece Hub' }));
    const active = screen.getByTestId('engineer-row-e1');
    const gone = screen.getByTestId('engineer-row-e9');
    expect(within(active).getAllByRole('spinbutton')).toHaveLength(1);
    expect(within(gone).queryAllByRole('spinbutton')).toHaveLength(0);
    expect(within(gone).queryAllByRole('button', { name: /^Allow category / })).toHaveLength(0);
    // Deactivate stays a row action outside the draft.
    expect(within(active).getByRole('button', { name: 'Deactivate Ada Lovelace' })).toBeInTheDocument();
  });

  it('"Show Inactive" with none says so', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => (status === 'inactive' ? ready([]) : listFor(status)));
    renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-status-filter-overview')).getByRole('radio', { name: 'Inactive' }));
    expect(screen.getAllByText('No inactive engineers in this hub.').length).toBeGreaterThan(0);
  });

  it('a Hub Planner (write, own hub) sees no Deactivate or Reactivate anywhere', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => listFor(status));
    renderWithProviders(<PlanningPage />, {
      session: { roles: ['Hub Planner'], hub_scope_all: false, hub_ids: ['hub-1'], permissions: permissionsFrom({ capacity_planning: 'rw' }) },
    });
    await user.click(within(screen.getByTestId('engineer-status-filter-overview')).getByRole('radio', { name: 'All' }));
    expect(screen.getByRole('button', { name: 'Edit Ada Lovelace' })).toBeInTheDocument();
    // (Chamber Delete is unchanged by P38.)
    expect(screen.queryByRole('button', { name: /^(Deactivate|Reactivate|Delete) (Ada|Theoni|Lokesh)/ })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: 'Engineers' }));
    expect(screen.queryByRole('button', { name: /^(Deactivate|Reactivate|Delete) (Ada|Theoni|Lokesh)/ })).not.toBeInTheDocument();
  });

  it('Deactivate opens the popup; on success the toast reports the served counts and links to the "No leader" register', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue({
      engineer: { ...engineer, active: false },
      reassigned: 0,
      left_without_leader: 1,
      left_without_leader_project_ids: ['p1'],
      warnings: [],
      run: { status: 'not_needed', run_id: null },
    });
    hooks.useDeactivateEngineer.mockReturnValue({ mutateAsync, isPending: false });
    hooks.useDeactivationPreview.mockReturnValue({
      ...ready({
        engineer: { id: 'e1', name: 'Ada Lovelace', hub: 'R&D-Greece', active: true },
        deactivation_week: 47,
        has_linked_login: false,
        open_projects: [
          {
            project_id: 'p1', name: 'Cooler One', hub: 'R&D-Greece', status: 'On Hold', priority: 'P2', category: 'B',
            schedulable: false, frozen: false, progress_tracked: false, done_stages: 0, in_flight_lab: false, candidates: [],
          },
        ],
        supply_effect: null,
        led_projects_token: 'tok',
      }),
      isFetching: false,
    });
    renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-row-e1')).getByRole('button', { name: 'Deactivate Ada Lovelace' }));
    const dialog = await screen.findByRole('dialog', { name: 'Deactivate Ada Lovelace?' });
    expect(hooks.useDeactivationPreview).toHaveBeenCalledWith('e1');
    await user.selectOptions(within(dialog).getByTestId('deactivate-reason'), 'changed_role');
    await user.click(within(dialog).getByRole('button', { name: 'Deactivate anyway' }));
    expect(mutateAsync).toHaveBeenCalledWith({
      engineerId: 'e1',
      body: { reason: 'changed_role', led_projects_token: 'tok', reassignments: [{ project_id: 'p1', leader_engineer_id: null }] },
    });
    const toast = await screen.findByTestId('deactivation-result');
    expect(screen.queryByRole('dialog', { name: 'Deactivate Ada Lovelace?' })).not.toBeInTheDocument();
    expect(toast).toHaveTextContent('Ada Lovelace deactivated');
    expect(within(toast).getByTestId('deactivation-result-counts')).toHaveTextContent('0 projects got a new leader. 1 project has no leader.');
    expect(within(toast).getByTestId('deactivation-run-message')).toHaveTextContent('No recalculation was needed');
    expect(within(toast).getByRole('link', { name: 'Show projects with no leader' })).toHaveAttribute('href', '/projects?leader=no_leader');
    await user.click(within(toast).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('deactivation-result')).not.toBeInTheDocument();
  });

  it('Reactivate asks first, calls the endpoint, and shows a 409 ENGINEER_ALREADY_ACTIVE in place', async () => {
    const user = userEvent.setup();
    const reactivate = vi.fn().mockRejectedValueOnce(new ApiError(409, 'conflict', undefined, 'ENGINEER_ALREADY_ACTIVE')).mockResolvedValueOnce({});
    hooks.useReactivateEngineer.mockReturnValue({ mutateAsync: reactivate, isPending: false });
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => listFor(status));
    renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-status-filter-overview')).getByRole('radio', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: 'Reactivate Theoni' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reactivate Theoni?' });
    expect(dialog).toHaveTextContent(/do not get back the projects/);
    expect(reactivate).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Reactivate' }));
    expect(reactivate).toHaveBeenCalledWith('e9');
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('already active');
    await user.click(within(dialog).getByRole('button', { name: 'Reactivate' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Reactivate Theoni?' })).not.toBeInTheDocument());
  });

  it('editing an inactive engineer changes the name only', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => listFor(status));
    renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-status-filter-overview')).getByRole('radio', { name: 'Inactive' }));
    await user.click(screen.getByRole('button', { name: 'Edit name of Theoni' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/^FTE/)).toBeDisabled();
    const name = within(dialog).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Theoni K.');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(updateEngineer).toHaveBeenCalledWith({ engineerId: 'e9', body: { name: 'Theoni K.' } });
  });

  it('has no serious axe violations with inactive rows and the Show filter', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockImplementation((_hub: unknown, status: unknown) => listFor(status));
    const { container } = renderWithProviders(<PlanningPage />);
    await user.click(within(screen.getByTestId('engineer-status-filter-overview')).getByRole('radio', { name: 'All' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  }, 30000);
});
