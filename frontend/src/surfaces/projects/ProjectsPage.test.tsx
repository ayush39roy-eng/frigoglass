import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { seedSession } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';
import { createQueryClient } from '@/lib/query-client';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useHubFilterStore } from '@/stores/hub-filter';
import type { ProjectFilterParams, ProjectFilterResult, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';
import type { ProjectRead } from '@/surfaces/registration/api/types';
import type { RoleName } from '@/types/enums';

/**
 * P22-T01: the merged Projects page (all projects + Project Registration).
 * The list hook is mocked at the hook; the registration writes are mocked at
 * the HTTP client, so these tests pin the endpoint, method and payload the
 * drawer sends (the same ones the old `/register` page sent).
 */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 60,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 60, size: 60 })),
    measureElement: () => undefined,
    measure: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

const useDashboardProjects = vi.fn();
vi.mock('@/surfaces/dashboard/hooks/use-dashboard', () => ({
  useDashboardProjects: (params: ProjectFilterParams) => useDashboardProjects(params),
  useProjectFacets: () => ({
    data: { leaders: [{ id: 'eng-1', name: 'Nikos Papadopoulos' }], steps: [{ code: 'PDD-E', name: 'Design Detailing' }] },
  }),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false }] }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({ askAgent: vi.fn() }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));

const http = vi.hoisted(() => ({
  get: vi.fn(),
  send: vi.fn(),
  sendWithHeaders: vi.fn(),
  download: vi.fn(),
}));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
    apiSendWithHeaders: (method: string, path: string, body?: unknown) => http.sendWithHeaders(method, path, body),
    apiDownload: (path: string, opts: unknown) => http.download(path, opts),
  };
});

// P14 (ADR 0026): a changed priority previews, then confirms with the token.
const moveApi = vi.hoisted(() => ({ previewProjectPriority: vi.fn(), moveProjectPriority: vi.fn() }));
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    previewProjectPriority: (...a: unknown[]) => moveApi.previewProjectPriority(...a),
    moveProjectPriority: (...a: unknown[]) => moveApi.moveProjectPriority(...a),
  };
});

import { ApiError } from '@/lib/api/client';
import ProjectsPage from './ProjectsPage';

// P23: create tests fill seven required fields through Radix selects.
vi.setConfig({ testTimeout: 30_000 });

const P1 = '3f2b8c1e-9a4d-4e6f-8b2a-1c0d9e8f7a65';

function ok(rows: ProjectFilterRow[]): UseQueryResult<ProjectFilterResult> {
  return {
    data: { total_count: rows.length, rows },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as UseQueryResult<ProjectFilterResult>;
}

function row(id: string, overrides: Partial<ProjectFilterRow> = {}): ProjectFilterRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A+',
    status: 'In Development',
    priority: 'P1',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_ROW_DEFAULTS,
    ...overrides,
  } as ProjectFilterRow;
}

const project: ProjectRead = {
  id: P1,
  name: 'Cooler A',
  external_code: null,
  hub_id: 'hub-1',
  leader_engineer_id: null,
  category: null,
  type: null,
  priority: null,
  status: 'Draft',
  frozen: false,
  actual_start_week: null,
  delay_weeks: 0,
  reg_year: null,
  carry_over: false,
  comments: null,
  customer_name: null,
  tcogs_eur: null,
  selling_price_eur: null,
  gross_margin_pct: null,
  capex_keur: null,
  rm_savings_keur: null,
  target_end_week: null,
  certification_testing_required: true,
  estimated_design_weeks: null,
  estimated_lab_weeks: null,
  plant: null,
  requesting_department: null,
  product_type: null, scoring_tags: [], tag_dimension_keys: [],
  schedule_stale: false,
  workflow_id: 'PDD',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

/** `GET` router for the registration reads. */
function serveGets(detail: ProjectRead = project, gate = { can_leave_draft: false, missing_fields: ['leader_engineer_id', 'category'] }) {
  http.get.mockImplementation((path: string) => {
    if (path === `/projects/${detail.id}`) return Promise.resolve(detail);
    if (path === `/projects/${detail.id}/hard-gate-status`) return Promise.resolve(gate);
    if (path === '/engineers') return Promise.resolve([{ id: 'eng-1', name: 'Nikos Papas', hub_id: 'hub-1' }]);
    return Promise.reject(new ApiError(404, 'not found'));
  });
}

/** P23: the eight required fields `POST /projects` now demands (no Draft;
 *  docs/API_CONTRACT_P23.md §1, priority added by ADR 0034). */
async function fillRequired(user: ReturnType<typeof userEvent.setup>, drawer: HTMLElement): Promise<void> {
  await user.click(within(drawer).getByRole('combobox', { name: /^Leader/ }));
  await user.click(await screen.findByRole('option', { name: 'Nikos Papas' }));
  await user.click(within(drawer).getByRole('combobox', { name: /^Category/ }));
  await user.click(await screen.findByRole('option', { name: 'A' }));
  await user.click(within(drawer).getByRole('combobox', { name: /^Type/ }));
  await user.click(await screen.findByRole('option', { name: /New Model/i }));
  await user.type(within(drawer).getByLabelText(/^Actual start week/), '10');
  await user.type(within(drawer).getByLabelText(/^TCOGS/), '1000');
  await user.type(within(drawer).getByLabelText(/^Selling price/), '1500');
  await user.type(within(drawer).getByLabelText(/^Gross margin/), '20');
  await user.click(within(drawer).getByRole('combobox', { name: /^Priority/ }));
  await user.click(await screen.findByRole('option', { name: 'P2' }));
}

const READ_ONLY = { roles: ['Executive Viewer'] as RoleName[], permissions: ROLE_MATRIX['Executive Viewer'] };

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null, region: null });
  serveGets();
});

describe('Projects page — list and header', () => {
  it('a writer gets the list, the count, Register project and an Edit registration action per row', () => {
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha cooler' }), row('b')]));
    renderWithProviders(<ProjectsPage />);

    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(screen.getByTestId('projects-total')).toHaveTextContent('2 projects');
    expect(screen.getByRole('button', { name: 'Register project' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Alpha cooler' })).toHaveAttribute('href', '/projects/a');
    expect(screen.getByRole('link', { name: 'Open Alpha cooler' })).toHaveAttribute('href', '/projects/a');
    expect(screen.getByRole('button', { name: 'Edit registration of Alpha cooler' })).toBeInTheDocument();
    expect(screen.queryByTestId('read-only-notice')).not.toBeInTheDocument();
  });

  it('a read-only role (Executive Viewer) gets the list without Register or Edit registration', () => {
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha cooler' })]));
    renderWithProviders(<ProjectsPage />, { session: READ_ONLY });

    expect(screen.getByRole('link', { name: 'Alpha cooler' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit registration/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toHaveTextContent('Registering or editing projects');
  });

  it('requests the unfiltered list first (same key as the Dashboard register)', () => {
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    expect(useDashboardProjects).toHaveBeenCalledWith({
      hub_id: undefined,
      category: undefined,
      status_: undefined,
      priority: undefined,
    });
  });

  it('the hub comes from the global header filter (ADR 0020) and shows its chip', () => {
    useHubFilterStore.setState({ hubId: 'hub-1' });
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ hub_id: 'hub-1' }));
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hub: R&D-Greece');
    expect(screen.getByText('No projects match these filters')).toBeInTheDocument();
  });

  it('sends every filter, the search and the sort to the server', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'A+' }));
    await user.click(screen.getByRole('combobox', { name: 'Priority' }));
    await user.click(await screen.findByRole('option', { name: 'P2' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader' }));
    await user.click(await screen.findByRole('option', { name: 'Nikos Papadopoulos' }));
    await user.click(screen.getByRole('combobox', { name: 'Sort' }));
    await user.click(await screen.findByRole('option', { name: 'Priority rank' }));
    const box = screen.getByRole('searchbox', { name: 'Search' });
    expect(box).toHaveAttribute('maxLength', '100');
    await user.type(box, '  tauras ');

    await waitFor(() =>
      expect(useDashboardProjects).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: 'A+', priority: 'P2', leader_engineer_id: 'eng-1', sort: 'priority', q: 'tauras' }),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(box).toHaveValue('');
    await waitFor(() =>
      expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ category: undefined, priority: undefined })),
    );
  });

  it('P23-T01: the Status filter offers the UI statuses only (no In Buyoff, no Draft) and there is no Drafts chip', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a')]));
    renderWithProviders(<ProjectsPage />);

    expect(screen.queryByRole('button', { name: 'Drafts' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).not.toContain('In Buyoff');
    expect(options).not.toContain('Draft');
    for (const st of ['Under Industrialization', 'In Development', 'In Queue', 'Commercialized', 'On Hold', 'Cancelled']) {
      expect(options).toContain(st);
    }
    await user.click(screen.getByRole('option', { name: 'Cancelled' }));
    expect(useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ status_: 'Cancelled' }));
  });

  it('P23-T01: a row that still carries In Buyoff or Draft renders its status badge', () => {
    useDashboardProjects.mockReturnValue(
      ok([row('b', { status: 'In Buyoff', project_name: 'Buyoff cooler' }), row('d', { status: 'Draft', project_name: 'Draft cooler' })]),
    );
    renderWithProviders(<ProjectsPage />);
    expect(screen.getByText('In Buyoff')).toBeInTheDocument();
    expect(screen.getByText('Draft')).toBeInTheDocument();
  });

  it('switches to the card view, with Ask the agent on each card', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a'), row('b')]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('tab', { name: 'Cards' }));
    expect(await screen.findAllByRole('button', { name: 'Ask the agent' })).toHaveLength(2);
  });

  it('renders an error state when the list fails, and an empty state when nothing matches', () => {
    useDashboardProjects.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      refetch: vi.fn(),
    } as unknown as UseQueryResult<ProjectFilterResult>);
    const { unmount } = renderWithProviders(<ProjectsPage />);
    expect(screen.getByText('The project list could not be loaded.')).toBeInTheDocument();
    unmount();

    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    expect(screen.getByText('No projects')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Register project' })).toHaveLength(2);
  });
});

describe('Projects page — Export menu', () => {
  it('offers both exports to a writer; each downloads with the page filters', async () => {
    const user = userEvent.setup();
    http.download.mockResolvedValue({ blob: new Blob(['x']), filename: 'f.csv' });
    useDashboardProjects.mockReturnValue(ok([row('a')]));
    renderWithProviders(<ProjectsPage />);

    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'B' }));
    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Projects list as CSV' }));
    expect(http.download).toHaveBeenLastCalledWith(
      '/exports/dashboard',
      expect.objectContaining({ query: expect.objectContaining({ category: 'B', format: 'csv' }) }),
    );

    await user.click(screen.getByRole('button', { name: 'Export' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Registration register as XLSX' }));
    expect(http.download).toHaveBeenLastCalledWith(
      '/exports/project-registration',
      expect.objectContaining({ query: expect.objectContaining({ category: 'B', format: 'xlsx' }) }),
    );
  });

  it('a role without Registration read only gets the projects list export', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a')]));
    renderWithProviders(<ProjectsPage />, { session: READ_ONLY });
    await user.click(screen.getByRole('button', { name: 'Export' }));
    expect(await screen.findByRole('menuitem', { name: 'Projects list as XLSX' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: /Registration register/ })).not.toBeInTheDocument();
  });
});

describe('Projects page — registration drawer', () => {
  it('Register project (P23: no Draft step) POSTs /projects with the required fields, then highlights the new row', async () => {
    const user = userEvent.setup();
    const created = { ...project, id: 'new-1', name: 'Cooler B', status: 'In Queue' as const };
    http.send.mockResolvedValue(created);
    useDashboardProjects.mockReturnValue(ok([row('new-1', { project_name: 'Cooler B', status: 'In Queue' })]));
    renderWithProviders(<ProjectsPage />);

    const register = screen.getByRole('button', { name: 'Register project' });
    await user.click(register);
    const drawer = await screen.findByRole('dialog', { name: 'Register a project' });
    await user.type(within(drawer).getByLabelText(/^Name/), 'Cooler B');
    await user.click(within(drawer).getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    expect(within(drawer).queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
    expect(within(drawer).queryByText('Leave Draft')).not.toBeInTheDocument();
    await fillRequired(user, drawer);
    // P27 (ADR 0038): ticked out of order, sent in canonical order.
    await user.click(within(drawer).getByRole('checkbox', { name: 'Improvement' }));
    await user.click(within(drawer).getByRole('checkbox', { name: 'New Models' }));
    await user.click(within(drawer).getByRole('button', { name: 'Register project' }));

    await waitFor(() => expect(http.send).toHaveBeenCalledTimes(1));
    expect(http.send).toHaveBeenCalledWith('POST', '/projects', {
      name: 'Cooler B',
      // Untouched text fields go as '' — unchanged from the old /register form.
      external_code: '',
      hub_id: 'hub-1',
      leader_engineer_id: 'eng-1',
      category: 'A',
      type: 'NM',
      priority: 'P2',
      actual_start_week: 10,
      delay_weeks: 0,
      reg_year: null,
      carry_over: false,
      comments: '',
      customer_name: '',
      tcogs_eur: 1000,
      selling_price_eur: 1500,
      gross_margin_pct: 20,
      capex_keur: null,
      rm_savings_keur: null,
      target_end_week: null,
      certification_testing_required: true,
      estimated_design_weeks: null,
      estimated_lab_weeks: null,
      scoring_tags: ['new_models', 'improvement'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('projects-saved-status')).toHaveTextContent('Registered “Cooler B”.');
    expect(screen.getByTestId('projects-saved-status')).not.toHaveTextContent('Draft');
    expect(screen.getByTestId('row-highlight-badge')).toHaveTextContent('New');
    await waitFor(() => expect(register).toHaveFocus());
  });

  it('P23-T02: a 422 naming missing fields keeps the drawer open and marks those fields', async () => {
    const user = userEvent.setup();
    http.send.mockRejectedValue(
      new ApiError(
        422,
        'invalid',
        JSON.stringify({
          message: 'Project cannot be registered: required fields missing.',
          missing_fields: ['gross margin'],
          field_errors: { gross_margin_pct: 'Gross margin is required.' },
        }),
        'HARD_GATE_FIELDS_MISSING',
      ),
    );
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getAllByRole('button', { name: 'Register project' })[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'Register a project' });
    await user.type(within(drawer).getByLabelText(/^Name/), 'Cooler C');
    await user.click(within(drawer).getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await fillRequired(user, drawer);
    await user.click(within(drawer).getByRole('button', { name: 'Register project' }));
    expect(await within(drawer).findByText('Gross margin is required.')).toBeInTheDocument();
    expect(within(drawer).getByLabelText(/^Gross margin/)).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('dialog', { name: 'Register a project' })).toBeInTheDocument();
  });

  it('validates on the client: no POST without a name', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getAllByRole('button', { name: 'Register project' })[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'Register a project' });
    await user.click(within(drawer).getByRole('button', { name: 'Register project' }));
    expect(await within(drawer).findAllByRole('alert')).not.toHaveLength(0);
    expect(http.send).not.toHaveBeenCalled();
    expect(drawer).toBeInTheDocument();
  });

  it('Edit registration loads GET /projects/{id}, PATCHes the edited body and highlights the row', async () => {
    const user = userEvent.setup();
    const inQueue = { ...project, status: 'In Queue' as const, priority: 'P1' as const };
    serveGets(inQueue);
    http.sendWithHeaders.mockResolvedValue({ data: { ...inQueue, name: 'Cooler A2' }, headers: new Headers() });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderWithProviders(<ProjectsPage />);

    const edit = screen.getByRole('button', { name: 'Edit registration of Cooler A' });
    await user.click(edit);
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    expect(http.get).toHaveBeenCalledWith(`/projects/${P1}`, expect.anything());
    const name = within(drawer).getByLabelText(/^Name/);
    await user.clear(name);
    await user.type(name, 'Cooler A2');
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(http.sendWithHeaders).toHaveBeenCalledTimes(1));
    const [method, path, body] = http.sendWithHeaders.mock.calls[0]! as [string, string, Record<string, unknown>];
    expect(method).toBe('PATCH');
    expect(path).toBe(`/projects/${P1}`);
    expect(body).toMatchObject({ name: 'Cooler A2', hub_id: 'hub-1', priority: 'P1' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('projects-saved-status')).toHaveTextContent('Saved the registration of “Cooler A2”.');
    expect(screen.getByTestId('row-highlight-badge')).toHaveTextContent('Updated');
    await waitFor(() => expect(edit).toHaveFocus());
  });

  it('a Draft shows the served hard gate: missing fields listed, Submit disabled', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A', status: 'Draft' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    expect(await within(drawer).findByText('Required fields missing before this project can leave Draft:')).toBeInTheDocument();
    expect(within(drawer).getByText('leader_engineer_id')).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Submit — leave Draft' })).toBeDisabled();
    expect(http.get).toHaveBeenCalledWith(`/projects/${P1}/hard-gate-status`, expect.anything());
  });

  it('a Draft that passes the gate submits POST /projects/{id}/submit and stays open with a confirmation', async () => {
    const user = userEvent.setup();
    serveGets(project, { can_leave_draft: true, missing_fields: [] });
    http.send.mockResolvedValue({ ...project, status: 'In Queue' });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A', status: 'Draft' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    const submit = await within(drawer).findByRole('button', { name: 'Submit — leave Draft' });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    expect(http.send).toHaveBeenCalledWith('POST', `/projects/${P1}/submit`, { target_status: 'In Queue' });
    expect(await within(drawer).findByText('Submitted. The project left Draft for In Queue.')).toBeInTheDocument();
  });

  it('shows Frozen / Stale and the workflow from the registration', async () => {
    const user = userEvent.setup();
    serveGets({ ...project, status: 'In Queue', frozen: true, schedule_stale: true, workflow_id: 'OEM' });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    const status = within(drawer).getByRole('region', { name: 'Registration status' });
    expect(status).toHaveTextContent('Workflow OEM');
    expect(status).toHaveTextContent('Frozen');
    expect(status).toHaveTextContent('Stale');
  });

  it('Escape with unsaved edits asks first; Keep editing keeps them, Discard closes without saving', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getAllByRole('button', { name: 'Register project' })[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'Register a project' });
    await user.type(within(drawer).getByLabelText(/^Name/), 'Half typed');

    await user.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(within(drawer).getByLabelText(/^Name/)).toHaveValue('Half typed');

    await user.click(within(drawer).getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(http.send).not.toHaveBeenCalled();
  });

  it('Escape on a clean form closes at once and returns focus to the trigger', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a')]));
    renderWithProviders(<ProjectsPage />);
    const register = screen.getByRole('button', { name: 'Register project' });
    await user.click(register);
    await screen.findByRole('dialog', { name: 'Register a project' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await waitFor(() => expect(register).toHaveFocus());
  });

  it('a 403 on create downgrades the page: notice shown, Register hidden', async () => {
    const user = userEvent.setup();
    http.send.mockRejectedValue(new ApiError(403, 'forbidden'));
    useDashboardProjects.mockReturnValue(ok([row('a')]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    const drawer = await screen.findByRole('dialog', { name: 'Register a project' });
    await user.type(within(drawer).getByLabelText(/^Name/), 'Cooler B');
    await user.click(within(drawer).getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await fillRequired(user, drawer);
    await user.click(within(drawer).getByRole('button', { name: 'Register project' }));
    expect(await screen.findByText(/read-only access to Project Registration/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register project' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit registration/ })).not.toBeInTheDocument();
  });

  it('P11: an edit whose PATCH reports X-Schedule-Recalc shows the honest outcome (deferred)', async () => {
    const user = userEvent.setup();
    const inQueue = { ...project, status: 'In Queue' as const, priority: 'P1' as const };
    serveGets(inQueue);
    http.sendWithHeaders.mockResolvedValue({
      data: { ...inQueue, priority: 'P2' },
      headers: new Headers({ 'X-Schedule-Recalc': 'deferred' }),
    });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    expect(within(drawer).getByText('Changing priority recalculates the timeline.')).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      'Saved — the timeline updates automatically after the current recalculation',
    );
  });

  it('P14: a priority change previews first; Yes applies it with the token, then PATCHes the rest without priority', async () => {
    const user = userEvent.setup();
    const inQueue = { ...project, status: 'In Queue' as const, priority: 'P1' as const };
    serveGets(inQueue);
    http.sendWithHeaders.mockResolvedValue({ data: { ...inQueue, priority: 'P2' }, headers: new Headers() });
    moveApi.previewProjectPriority.mockResolvedValue({
      result: 'preview', project_id: P1, from_priority: 'P1', to_priority: 'P2', baseline_run_id: 'run-1',
      preview_token: 'tok-r', moved: null,
      summary: { affected: 0, delayed: 0, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 },
      changes: [], hidden_count: 0, elapsed_ms: 3,
    });
    moveApi.moveProjectPriority.mockResolvedValue({
      project_id: P1, priority_before: 'P1', priority_after: 'P2', recalc_status: 'applied',
      schedule_run_id: 'run-2', baseline_run_id: 'run-1', task_id: null, changes: [], hidden_count: 0,
    });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    await user.click(within(drawer).getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'P2' }));
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));

    const preview = await screen.findByRole('dialog', { name: 'Move to P2?' });
    expect(moveApi.previewProjectPriority).toHaveBeenCalledWith(P1, 'P2', expect.anything());
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
    const yes = within(preview).getByRole('button', { name: 'Yes, apply' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(moveApi.moveProjectPriority).toHaveBeenCalledWith(P1, 'P2', 'tok-r');
    await waitFor(() => expect(http.sendWithHeaders).toHaveBeenCalledTimes(1));
    const body = http.sendWithHeaders.mock.calls[0]![2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('priority');
    expect(body).toHaveProperty('name', 'Cooler A');
  });

  it('P14: No on the priority preview saves nothing and keeps the drawer open with an explanation', async () => {
    const user = userEvent.setup();
    const inQueue = { ...project, status: 'In Queue' as const, priority: 'P1' as const };
    serveGets(inQueue);
    moveApi.previewProjectPriority.mockResolvedValue({
      result: 'preview', project_id: P1, from_priority: 'P1', to_priority: 'P3', baseline_run_id: 'run-1',
      preview_token: 'tok-r', moved: null,
      summary: { affected: 0, delayed: 0, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 },
      changes: [], hidden_count: 0, elapsed_ms: 3,
    });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    await user.click(within(drawer).getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'P3' }));
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    const preview = await screen.findByRole('dialog', { name: 'Move to P3?' });
    await user.click(within(preview).getByRole('button', { name: 'No, cancel' }));
    expect(await screen.findByText(/The priority move was not applied, so nothing was saved/)).toBeInTheDocument();
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
    expect(moveApi.moveProjectPriority).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });
});

describe('Projects page — P24-T02 workbook fields and "No leader" (ADR 0035)', () => {
  it('the Workbook fields toggle adds Plant / Req. dept / Product type columns with the served values', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha cooler', plant: 'Kato Achaia', requesting_department: 'Marketing', product_type: 'ICM' }),
        row('b', { project_name: 'Beta cooler' }),
      ]),
    );
    renderWithProviders(<ProjectsPage />);
    expect(screen.queryByRole('columnheader', { name: 'Plant' })).not.toBeInTheDocument();
    const toggle = screen.getByRole('button', { name: 'Workbook fields' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    for (const header of ['Plant', 'Req. dept', 'Product type']) {
      expect(screen.getByRole('columnheader', { name: header })).toBeInTheDocument();
    }
    const table = screen.getByRole('table', { name: 'Projects' });
    expect(within(table).getByText('Kato Achaia')).toBeInTheDocument();
    expect(within(table).getByText('Marketing')).toBeInTheDocument();
    expect(within(table).getByText('ICM')).toBeInTheDocument();
    expect(within(table).getAllByText('Not set')).toHaveLength(3);
  });

  it('a null leader reads "No leader" (accessible "No leader assigned"); Left Out adds the hint', () => {
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha cooler', leader_engineer_id: null, outcome: 'LEFT_OUT' }),
        row('b', { project_name: 'Beta cooler', leader_engineer_id: null, outcome: 'SPILLOVER' }),
        row('c', { project_name: 'Gamma cooler', leader_engineer_id: 'eng-1', leader_name: 'Nikos', outcome: 'LEFT_OUT' }),
      ]),
    );
    renderWithProviders(<ProjectsPage />);
    const labels = screen.getAllByTestId('no-leader');
    expect(labels).toHaveLength(2);
    for (const label of labels) {
      expect(within(label).getByText('No leader')).toHaveAttribute('aria-hidden', 'true');
      expect(within(label).getByText('No leader assigned')).toHaveClass('sr-only');
    }
    // Only the project that is both leaderless and Left Out gets the hint.
    const hints = screen.getAllByTestId('no-leader-left-out');
    expect(hints).toHaveLength(1);
    expect(hints[0]).toHaveTextContent('Left out: no leader assigned');
    expect(labels[0]).toContainElement(hints[0]!);
    expect(screen.getByText('Nikos')).toBeInTheDocument();
  });

  it('the edit drawer shows the fields read-only and never sends them in the PATCH', async () => {
    const user = userEvent.setup();
    const charter = { ...project, status: 'In Queue' as const, priority: 'P1' as const, plant: 'Kato Achaia', requesting_department: 'Marketing', product_type: null };
    serveGets(charter);
    http.sendWithHeaders.mockResolvedValue({ data: charter, headers: new Headers() });
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    const block = within(drawer).getByRole('group', { name: 'From the client workbook' });
    expect(block).toHaveTextContent('PlantKato Achaia');
    expect(block).toHaveTextContent('Requesting departmentMarketing');
    expect(block).toHaveTextContent('Product typeNot set');
    expect(within(block).queryByRole('textbox')).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(http.sendWithHeaders).toHaveBeenCalledTimes(1));
    const body = http.sendWithHeaders.mock.calls[0]![2] as Record<string, unknown>;
    expect(body).not.toHaveProperty('plant');
    expect(body).not.toHaveProperty('requesting_department');
    expect(body).not.toHaveProperty('product_type');
  });
});

describe('Projects page — deep link', () => {
  function renderAt(path: string, session?: Parameters<typeof seedSession>[0]) {
    seedSession(session ?? {});
    const client = createQueryClient();
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[path]}>
          <TooltipProvider>
            <ProjectsPage />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }

  it('?edit=<id> opens the drawer for that project', async () => {
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderAt(`/projects?edit=${P1}`);
    expect(await screen.findByRole('dialog', { name: 'Edit Cooler A' })).toBeInTheDocument();
    expect(http.get).toHaveBeenCalledWith(`/projects/${P1}`, expect.anything());
  });

  it('?edit=<id> does nothing for a role without Registration write', async () => {
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A' })]));
    renderAt(`/projects?edit=${P1}`, READ_ONLY);
    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(http.get).not.toHaveBeenCalledWith(`/projects/${P1}`, expect.anything());
  });
});

describe('Projects page — accessibility', () => {
  it('the page with rows has no serious/critical axe violations', async () => {
    useDashboardProjects.mockReturnValue(ok([row('a'), row('b', { priority: null, category: null, is_vip: true })]));
    const { container } = renderWithProviders(<ProjectsPage />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('the open create drawer has no serious/critical axe violations; Comments is labelled', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getAllByRole('button', { name: 'Register project' })[0]!);
    const drawer = await screen.findByRole('dialog', { name: 'Register a project' });
    expect(await seriousAxeViolations(drawer)).toEqual([]);
    expect(within(drawer).getByLabelText('Comments')).toHaveAttribute('id', 'reg-comments');
  });

  it('the open edit drawer for a Draft has no serious/critical axe violations', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row(P1, { project_name: 'Cooler A', status: 'Draft' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit registration of Cooler A' }));
    const drawer = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
    await within(drawer).findByRole('button', { name: 'Submit — leave Draft' });
    expect(await seriousAxeViolations(drawer)).toEqual([]);
  });
});

describe('Projects page — VIP (ADR 0040)', () => {
  const projectLinks = (): string[] =>
    screen
      .getAllByRole('link')
      .filter((a) => /^\/projects\/[^/]+$/.test(a.getAttribute('href') ?? '') && !a.getAttribute('aria-label'))
      .map((a) => a.textContent ?? '');

  it('lists VIP projects first, each group keeping the served order; a missing is_vip is not VIP', () => {
    const legacy = row('d', { project_name: 'Delta' }) as Partial<ProjectFilterRow>;
    delete legacy.is_vip;
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha' }),
        row('b', { project_name: 'Bravo', is_vip: true }),
        row('c', { project_name: 'Charlie' }),
        legacy as ProjectFilterRow,
        row('e', { project_name: 'Echo', is_vip: true }),
      ]),
    );
    renderWithProviders(<ProjectsPage />);
    expect(projectLinks()).toEqual(['Bravo', 'Echo', 'Alpha', 'Charlie', 'Delta']);
    expect(screen.getByRole('button', { name: 'Remove VIP from Bravo' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Make Delta VIP' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('the VIP filter narrows the list to VIP projects and Clear resets it', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Bravo', is_vip: true }), row('c', { project_name: 'Charlie' })]),
    );
    renderWithProviders(<ProjectsPage />);
    const filter = screen.getByTestId('vip-filter');
    expect(filter).toHaveAttribute('aria-pressed', 'false');
    await user.click(filter);
    expect(filter).toHaveAttribute('aria-pressed', 'true');
    expect(projectLinks()).toEqual(['Bravo']);
    expect(screen.getByTestId('projects-total')).toHaveTextContent('1 VIP of 3 projects');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(projectLinks()).toEqual(['Bravo', 'Alpha', 'Charlie']);
  });

  it('the VIP filter with no VIP shows the filtered empty state', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByTestId('vip-filter'));
    expect(screen.getByText('No projects match these filters')).toBeInTheDocument();
  });

  it('the star sends PUT /projects/{id}/vip with the toggled value (list and cards)', async () => {
    const user = userEvent.setup();
    http.send.mockResolvedValue({ project_id: 'a', is_vip: true });
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Bravo', is_vip: true })]),
    );
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Make Alpha VIP' }));
    await waitFor(() => expect(http.send).toHaveBeenCalledWith('PUT', '/projects/a/vip', { is_vip: true }));

    await user.click(screen.getByRole('tab', { name: 'Cards' }));
    const grid = await screen.findByTestId('projects-card-grid');
    await user.click(within(grid).getByRole('button', { name: 'Remove VIP from Bravo' }));
    await waitFor(() => expect(http.send).toHaveBeenCalledWith('PUT', '/projects/b/vip', { is_vip: false }));
    const cards = within(grid).getAllByTestId('project-card').map((c) => c.getAttribute('data-project-id'));
    expect(cards).toEqual(['b', 'a']);
  });

  it('a read-only role sees only a filled star mark on VIP projects, no toggle', () => {
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Bravo', is_vip: true })]),
    );
    renderWithProviders(<ProjectsPage />, { session: READ_ONLY });
    expect(screen.queryByTestId('vip-toggle')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('vip-mark')).toHaveLength(1);
  });
});
