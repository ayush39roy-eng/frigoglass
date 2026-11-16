import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { ApiError } from '@/lib/api/client';

import type { DeactivationOpenProject, DeactivationPreview, EngineerRead } from '../api/types';

const hooks = {
  useDeactivationPreview: vi.fn(),
  useDeactivateEngineer: vi.fn(),
};
vi.mock('../hooks/use-planning', () => ({
  useDeactivationPreview: (id: unknown) => hooks.useDeactivationPreview(id),
  useDeactivateEngineer: () => hooks.useDeactivateEngineer(),
}));

import { DeactivateEngineerDialog } from './deactivate-engineer-dialog';

const SECOND =
  'Their recorded stages will not show on the Gantt, and any lab test in progress gives up its chamber in the plan, until someone sets a leader.';

const engineer: EngineerRead = {
  id: 'e-elena',
  name: 'Elena Micu',
  hub_id: 'hub-ro',
  fte: 1,
  allowed_categories: ['A'],
  user_id: 'u1',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  weekdays_per_week: 5,
  capacity_weeks: { year: 44, remaining: 4 },
  capacity_days: { year: 220, remaining: 20 },
  counts_in_capacity: true,
  active: true,
};

const XENA = { engineer_id: 'x', name: 'Xena', fte: 1, load_weeks: 3 };
const YORGOS = { engineer_id: 'y', name: 'Yorgos', fte: 0.5, load_weeks: 9 };

function project(id: string, over: Partial<DeactivationOpenProject> = {}): DeactivationOpenProject {
  return {
    project_id: id,
    name: `Cooler ${id}`,
    hub: 'PD-Romania',
    status: 'In Development',
    priority: 'P1',
    category: 'A',
    schedulable: true,
    frozen: false,
    progress_tracked: false,
    done_stages: 0,
    in_flight_lab: false,
    candidates: [XENA, YORGOS],
    ...over,
  };
}

function preview(open: DeactivationOpenProject[], over: Partial<DeactivationPreview> = {}): DeactivationPreview {
  return {
    engineer: { id: 'e-elena', name: 'Elena Micu', hub: 'PD-Romania', active: true },
    deactivation_week: 47,
    has_linked_login: true,
    open_projects: open,
    supply_effect: {
      capacity_hub: 'PD-Romania',
      yearly_design_capacity: { before: 412.5, after: 398.1 },
      remaining_design_capacity: { before: 38, after: 33.2 },
    },
    led_projects_token: 'tok-1',
    ...over,
  };
}

let current: DeactivationPreview;
let refetch: ReturnType<typeof vi.fn>;
let mutateAsync: ReturnType<typeof vi.fn>;

function seed(p: DeactivationPreview) {
  current = p;
}

beforeEach(() => {
  vi.clearAllMocks();
  refetch = vi.fn().mockResolvedValue({});
  mutateAsync = vi.fn().mockResolvedValue({
    engineer: { ...engineer, active: false },
    reassigned: 1,
    left_without_leader: 0,
    left_without_leader_project_ids: [],
    warnings: [],
    run: { status: 'queued', run_id: 'r1' },
  });
  hooks.useDeactivationPreview.mockImplementation(() => ({
    data: current,
    isPending: false,
    isError: false,
    isFetching: false,
    error: null,
    refetch,
  }));
  hooks.useDeactivateEngineer.mockImplementation(() => ({ mutateAsync, isPending: false }));
});

function renderDialog(props: Partial<Parameters<typeof DeactivateEngineerDialog>[0]> = {}) {
  const onDeactivated = vi.fn();
  const onForbidden = vi.fn();
  const utils = renderWithProviders(
    <DeactivateEngineerDialog engineer={engineer} onClose={vi.fn()} onDeactivated={onDeactivated} onForbidden={onForbidden} {...props} />,
  );
  return { ...utils, onDeactivated, onForbidden };
}

async function chooseReason(user: ReturnType<typeof userEvent.setup>) {
  await user.selectOptions(screen.getByTestId('deactivate-reason'), 'left_company');
}

function leaderSelect(projectId: string): HTMLSelectElement {
  return within(screen.getByTestId(`deactivate-row-${projectId}`)).getByTestId('deactivate-leader') as HTMLSelectElement;
}

describe('DeactivateEngineerDialog (P38-T06)', () => {
  it('lists the open projects with served facts, candidates in served order, supply effect and the login note', () => {
    seed(preview([project('a', { progress_tracked: true, done_stages: 4, in_flight_lab: true })]));
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Deactivate Elena Micu?' });
    const row = within(dialog).getByTestId('deactivate-row-a');
    expect(row).toHaveTextContent('Cooler a');
    expect(row).toHaveTextContent('PD-Romania · In Development · P1 · A');
    expect(row).toHaveTextContent('4 stages done');
    expect(row).toHaveTextContent('Lab test in progress');
    expect(row).toHaveTextContent('Progress tracked');
    const options = within(leaderSelect('a')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['No leader', 'Xena · 1 FTE · 3 wks booked', 'Yorgos · 0.5 FTE · 9 wks booked']);
    expect(screen.getByTestId('deactivate-supply')).toHaveTextContent('Design capacity of PD-Romania: full year 413 → 398 wks, remaining 38 → 33 wks.');
    expect(screen.getByTestId('deactivate-login')).toHaveTextContent(/login is linked/);
    expect(screen.getByTestId('deactivate-facts')).toHaveTextContent('W47');
  });

  it('all rows filled → plain "Deactivate", sending exactly the listed rows, the reason and the token', async () => {
    const user = userEvent.setup();
    seed(preview([project('a'), project('b')]));
    const { onDeactivated } = renderDialog();
    await user.selectOptions(leaderSelect('a'), 'x');
    await user.selectOptions(leaderSelect('b'), 'y');
    const confirm = screen.getByTestId('deactivate-confirm');
    expect(confirm).toBeDisabled(); // no reason yet
    await chooseReason(user);
    expect(confirm).toHaveTextContent(/^Deactivate$/);
    expect(screen.queryByTestId('deactivate-warning')).not.toBeInTheDocument();
    await user.click(confirm);
    expect(mutateAsync).toHaveBeenCalledWith({
      engineerId: 'e-elena',
      body: {
        reason: 'left_company',
        led_projects_token: 'tok-1',
        reassignments: [
          { project_id: 'a', leader_engineer_id: 'x' },
          { project_id: 'b', leader_engineer_id: 'y' },
        ],
      },
    });
    await waitFor(() => expect(onDeactivated).toHaveBeenCalledWith(expect.objectContaining({ reassigned: 1 }), 'Elena Micu'));
  });

  it('one empty row → "Deactivate anyway" and the verbatim warning naming it; null is sent for that row', async () => {
    const user = userEvent.setup();
    seed(preview([project('a'), project('b')]));
    renderDialog();
    await user.selectOptions(leaderSelect('a'), 'x');
    await chooseReason(user);
    expect(screen.getByTestId('deactivate-confirm')).toHaveTextContent('Deactivate anyway');
    const warning = screen.getByTestId('deactivate-warning');
    expect(warning).toHaveTextContent(
      'These 1 projects will have no leader. They will not be scheduled (Left out: no leader) until someone sets a leader.',
    );
    expect(warning).not.toHaveTextContent(SECOND);
    expect(within(warning).getByRole('list', { name: 'Projects that will have no leader' })).toHaveTextContent('Cooler b');
    expect(within(warning).queryByText('Cooler a')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('deactivate-confirm'));
    expect(mutateAsync.mock.calls[0]![0].body.reassignments).toEqual([
      { project_id: 'a', leader_engineer_id: 'x' },
      { project_id: 'b', leader_engineer_id: null },
    ]);
  });

  it('the second warning sentence appears only when an empty row is progress-tracked or has a lab test in flight', async () => {
    const user = userEvent.setup();
    seed(preview([project('a', { progress_tracked: true }), project('b')]));
    renderDialog();
    expect(screen.getByTestId('deactivate-warning')).toHaveTextContent(SECOND);
    await user.selectOptions(leaderSelect('a'), 'x');
    expect(screen.getByTestId('deactivate-warning')).not.toHaveTextContent(SECOND);
  });

  it('"Use one leader for all" fills only the empty rows', async () => {
    const user = userEvent.setup();
    seed(preview([project('a'), project('b'), project('c', { candidates: [YORGOS] })]));
    renderDialog();
    await user.selectOptions(leaderSelect('b'), 'y');
    await user.selectOptions(screen.getByLabelText('Use one leader for all'), 'x');
    expect(leaderSelect('a').value).toBe('x');
    expect(leaderSelect('b').value).toBe('y'); // kept
    expect(leaderSelect('c').value).toBe(''); // Xena is not eligible there
  });

  it('an empty candidate list says so and the row can only be left empty', () => {
    seed(preview([project('a', { hub: 'R&D-Greece', candidates: [] })]));
    renderDialog();
    const row = screen.getByTestId('deactivate-row-a');
    expect(within(row).getByTestId('deactivate-no-candidate')).toHaveTextContent('No eligible engineer in R&D-Greece');
    expect(within(row).queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByTestId('deactivate-warning')).toBeInTheDocument();
  });

  it('a frozen row is required: empty blocks the confirm; with no candidate it says to unfreeze first', async () => {
    const user = userEvent.setup();
    seed(preview([project('f', { frozen: true }), project('g', { frozen: true, candidates: [] })]));
    renderDialog();
    await chooseReason(user);
    const confirm = screen.getByTestId('deactivate-confirm');
    expect(leaderSelect('f')).toBeRequired();
    expect(leaderSelect('f')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByTestId('deactivate-row-f')).toHaveTextContent('Frozen: leader required');
    expect(within(screen.getByTestId('deactivate-row-g')).getByTestId('deactivate-unfreeze')).toHaveTextContent(
      'Unfreeze this project on the Timeline (Gantt) first.',
    );
    expect(screen.getByTestId('deactivate-frozen-block')).toHaveTextContent('Cooler f, Cooler g');
    // Frozen empties are never "anyway": they block.
    expect(screen.queryByTestId('deactivate-warning')).not.toBeInTheDocument();
    expect(confirm).toBeDisabled();
    await user.selectOptions(leaderSelect('f'), 'x');
    expect(confirm).toBeDisabled(); // g still has no leader and no candidate
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it('409 LED_PROJECTS_CHANGED reloads the list and keeps choices still valid', async () => {
    const user = userEvent.setup();
    seed(preview([project('a'), project('b')]));
    mutateAsync.mockRejectedValueOnce(new ApiError(409, 'conflict', 'changed', 'LED_PROJECTS_CHANGED'));
    refetch.mockImplementation(() => {
      seed(preview([project('a'), project('n')], { led_projects_token: 'tok-2' }));
      return Promise.resolve({});
    });
    renderDialog();
    await user.selectOptions(leaderSelect('a'), 'x');
    await user.selectOptions(leaderSelect('b'), 'y');
    await chooseReason(user);
    await user.click(screen.getByTestId('deactivate-confirm'));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId('deactivate-notice')).toHaveTextContent(/changed since the list was loaded/);
    expect(screen.getByTestId('deactivate-row-n')).toBeInTheDocument();
    expect(screen.queryByTestId('deactivate-row-b')).not.toBeInTheDocument();
    expect(leaderSelect('a').value).toBe('x');
    expect(leaderSelect('n').value).toBe('');
    await user.click(screen.getByTestId('deactivate-confirm'));
    expect(mutateAsync.mock.calls[1]![0].body).toMatchObject({
      led_projects_token: 'tok-2',
      reassignments: [
        { project_id: 'a', leader_engineer_id: 'x' },
        { project_id: 'n', leader_engineer_id: null },
      ],
    });
  });

  it('503 ENGINEER_STATUS_BUSY shows the busy copy and keeps the dialog', async () => {
    const user = userEvent.setup();
    seed(preview([project('a')]));
    mutateAsync.mockRejectedValueOnce(new ApiError(503, 'busy', undefined, 'ENGINEER_STATUS_BUSY'));
    const { onDeactivated } = renderDialog();
    await user.selectOptions(leaderSelect('a'), 'x');
    await chooseReason(user);
    await user.click(screen.getByTestId('deactivate-confirm'));
    expect(await screen.findByTestId('deactivate-error')).toHaveTextContent(/being saved\. Nothing was changed/);
    expect(onDeactivated).not.toHaveBeenCalled();
  });

  it('no open project: says so and confirms with a plain "Deactivate"', async () => {
    const user = userEvent.setup();
    seed(preview([], { supply_effect: null, has_linked_login: false }));
    renderDialog();
    expect(screen.getByTestId('deactivate-no-projects')).toBeInTheDocument();
    expect(screen.getByTestId('deactivate-supply')).toHaveTextContent('Not on the capacity roster');
    expect(screen.getByTestId('deactivate-login')).toHaveTextContent('No login is linked');
    await chooseReason(user);
    expect(screen.getByTestId('deactivate-confirm')).toHaveTextContent(/^Deactivate$/);
  });

  it('a 403 preview says Admin only and downgrades the page', () => {
    hooks.useDeactivationPreview.mockImplementation(() => ({
      data: undefined,
      isPending: false,
      isError: true,
      isFetching: false,
      error: new ApiError(403, 'forbidden', undefined, 'ENGINEER_STATUS_ADMIN_ONLY'),
      refetch,
    }));
    const { onForbidden } = renderDialog();
    expect(screen.getByTestId('deactivate-preview-error')).toHaveTextContent('Only an Admin or Super Admin');
    expect(onForbidden).toHaveBeenCalled();
    expect(screen.getByTestId('deactivate-confirm')).toBeDisabled();
  });

  it('is axe-clean with a mixed list (the project list is keyboard-scrollable, P33-R02)', async () => {
    seed(
      preview([
        project('a', { progress_tracked: true, done_stages: 4 }),
        project('b', { frozen: true }),
        project('c', { candidates: [] }),
      ]),
    );
    renderDialog();
    const list = screen.getByTestId('deactivate-project-list');
    expect(list).toHaveAttribute('tabindex', '0');
    expect(await seriousAxeViolations(screen.getByRole('dialog'))).toEqual([]);
  }, 30000);
});
