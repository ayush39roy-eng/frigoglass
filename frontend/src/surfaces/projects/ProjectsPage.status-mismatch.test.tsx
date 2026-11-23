import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { ProjectFilterParams, ProjectFilterResult, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';

/**
 * P35-T08b (OQ #84 assumption): the Projects register's status-vs-current-step
 * warning. The served `status_mismatch` drives read mode and an unedited
 * Edit-mode select; an edited status is compared with the served
 * `expected_status` (no step → status rule in the browser).
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
  useProjectFacets: () => ({ data: { leaders: [], steps: [] } }),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [{ id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null }],
  }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({ askAgent: vi.fn() }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: vi.fn() }));

const http = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn() }));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
  };
});

import ProjectsPage from './ProjectsPage';
import { statusMismatchExpected } from './lib/status-mismatch';

vi.setConfig({ testTimeout: 30_000 });

const MSG = (expected: string) => `Status differs from the current step (expected: ${expected})`;

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
    priority_applicable: true,
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'B',
    status: 'In Development',
    priority: 'P2',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_ROW_DEFAULTS,
    leader_engineer_id: 'eng-1',
    current_step_code: 'PDD-E',
    expected_status: 'In Development',
    status_mismatch: false,
    ...overrides,
  };
}

function rowEl(name: string): HTMLElement {
  const el = screen.getByRole('link', { name }).closest<HTMLElement>('[role="row"]');
  if (!el) throw new Error(`no row for ${name}`);
  return el;
}

/** P44-T01: every row's own "Edit" (there is no toolbar Edit any more). */
async function startEdit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  for (;;) {
    const next = screen.queryAllByRole('button', { name: /^Edit / })[0];
    if (!next) break;
    await user.click(next);
  }
  expect(screen.getByTestId('register-edit-mode')).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  http.get.mockImplementation((path: string) =>
    path === '/engineers' ? Promise.resolve([{ id: 'eng-1', name: 'Nikos Papas', hub_id: 'hub-1' }]) : Promise.reject(new Error('404')),
  );
});

describe('statusMismatchExpected (served flag / served expected status)', () => {
  it('uses the served flag for the served status', () => {
    expect(statusMismatchExpected(row('a', { status: 'In Queue', status_mismatch: true }), 'In Queue')).toBe('In Development');
    expect(statusMismatchExpected(row('a'), 'In Development')).toBeNull();
  });

  it('compares an edited status with the served expected status', () => {
    expect(statusMismatchExpected(row('a'), 'Commercialized')).toBe('In Development');
    expect(statusMismatchExpected(row('a', { status: 'In Queue', status_mismatch: true }), 'In Development')).toBeNull();
  });

  it('never warns for the exempt statuses or with no served expected status', () => {
    for (const s of ['On Hold', 'Cancelled', 'In Buyoff', 'Draft'] as const) {
      expect(statusMismatchExpected(row('a'), s)).toBeNull();
    }
    expect(statusMismatchExpected(row('a', { status: 'On Hold', expected_status: null }), 'Commercialized')).toBeNull();
    // A pre-T08b API (fields absent) shows nothing.
    const legacy = { status: 'In Queue', expected_status: undefined, status_mismatch: undefined } as unknown as ProjectFilterRow;
    expect(statusMismatchExpected(legacy, 'In Queue')).toBeNull();
  });
});

describe('Projects register — status mismatch outline (P35-T08b)', () => {
  it('read mode: outlines a served mismatch with tooltip and screen-reader text, and nothing otherwise', () => {
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha', status: 'In Queue', status_mismatch: true }),
        row('b', { project_name: 'Beta' }),
      ]),
    );
    renderWithProviders(<ProjectsPage />);

    const mark = within(rowEl('Alpha')).getByTestId('status-mismatch');
    expect(mark).toHaveAttribute('title', MSG('In Development'));
    expect(mark).toHaveClass('ring-danger');
    expect(mark).toHaveTextContent(MSG('In Development'));
    expect(within(rowEl('Beta')).queryByTestId('status-mismatch')).not.toBeInTheDocument();
  });

  it('read mode: no outline for On Hold, Cancelled, In Buyoff or Draft (served expected null)', () => {
    useDashboardProjects.mockReturnValue(
      ok(
        (['On Hold', 'Cancelled', 'In Buyoff', 'Draft'] as const).map((s, i) =>
          row(String(i), { project_name: s, status: s, expected_status: null, status_mismatch: false }),
        ),
      ),
    );
    renderWithProviders(<ProjectsPage />);
    expect(screen.queryAllByTestId('status-mismatch')).toHaveLength(0);
    expect(document.querySelector('[data-status-mismatch]')).toBeNull();
  });

  it('edit mode: the select carries the served mismatch as its accessible description', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha', status: 'In Queue', status_mismatch: true }),
        row('b', { project_name: 'Beta' }),
      ]),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);

    const alpha = screen.getByRole('combobox', { name: 'Status of Alpha' });
    expect(alpha).toHaveAccessibleDescription(MSG('In Development'));
    const wrap = alpha.closest('[data-status-mismatch]');
    expect(wrap).toHaveAttribute('title', MSG('In Development'));
    expect(wrap).toHaveClass('ring-danger');
    const beta = screen.getByRole('combobox', { name: 'Status of Beta' });
    expect(beta).not.toHaveAccessibleDescription();
    expect(beta.closest('[data-status-mismatch]')).toBeNull();
  });

  it('edit mode: editing to the expected status clears the warning; editing away creates it', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha', status: 'In Queue', status_mismatch: true }),
        row('b', { project_name: 'Beta' }),
      ]),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);

    const alpha = screen.getByRole('combobox', { name: 'Status of Alpha' });
    await user.selectOptions(alpha, 'In Development');
    expect(alpha).not.toHaveAccessibleDescription();
    expect(alpha.closest('[data-status-mismatch]')).toBeNull();

    const beta = screen.getByRole('combobox', { name: 'Status of Beta' });
    await user.selectOptions(beta, 'Commercialized');
    expect(beta).toHaveAccessibleDescription(MSG('In Development'));
    expect(beta.closest('[data-status-mismatch]')).toHaveAttribute('title', MSG('In Development'));

    // Back to the served status: the served flag (no mismatch) applies again.
    await user.selectOptions(beta, 'In Development');
    expect(beta).not.toHaveAccessibleDescription();
  });

  it('edit mode: an edit to On Hold or Cancelled never warns', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha', status: 'In Queue', status_mismatch: true })]));
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);

    const alpha = screen.getByRole('combobox', { name: 'Status of Alpha' });
    for (const s of ['On Hold', 'Cancelled'] as const) {
      await user.selectOptions(alpha, s);
      expect(alpha).not.toHaveAccessibleDescription();
      expect(alpha.closest('[data-status-mismatch]')).toBeNull();
    }
  });

  it('has no serious axe violations with a mismatch shown in read and edit mode', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha', status: 'In Queue', status_mismatch: true })]));
    const { container } = renderWithProviders(<ProjectsPage />);
    expect(await seriousAxeViolations(container)).toEqual([]);
    await startEdit(user);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});
