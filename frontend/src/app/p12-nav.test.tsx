import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';

import { AppSidebar } from '@/components/layout/app-sidebar';
import { useHubFilterStore } from '@/stores/hub-filter';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { makeMe } from '@/test/session';

const client = { apiGet: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: (...a: unknown[]) => client.apiGet(...a) };
});

import { SURFACES } from './nav';
import { visibleNavGroups } from './nav-visibility';

function pathsFor(role: keyof typeof ROLE_MATRIX): string[] {
  return visibleNavGroups(makeMe({ permissions: ROLE_MATRIX[role] }))
    .flatMap(([, items]) => items)
    .map((i) => i.path);
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null });
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/check-ins/due') {
      return Promise.resolve({
        week: 31,
        summary: { due_stages: 9, checked_in_stages: 4, projects_live: 2, projects_due: 3, projects_overdue: 1, stale_projects: 0 },
        projects: [],
      });
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

describe('P12 nav entries (API_CONTRACT_P12 §7)', () => {
  it('places VIP after Dashboard, Priority board after Prioritization, Weekly check-in after Timeline', () => {
    const paths = SURFACES.map((s) => s.path);
    expect(paths.indexOf('/vip')).toBe(paths.indexOf('/') + 1);
    expect(paths.indexOf('/priority-board')).toBe(paths.indexOf('/matrix') + 1);
    expect(paths.indexOf('/check-in')).toBe(paths.indexOf('/timeline') + 1);
    const byPath = Object.fromEntries(SURFACES.map((s) => [s.path, s]));
    expect(byPath['/vip']).toMatchObject({ label: 'VIP projects', group: 'Plan', surface: 'dashboard' });
    expect(byPath['/priority-board']).toMatchObject({ label: 'Priority board', group: 'Plan', surface: 'matrix' });
    expect(byPath['/check-in']).toMatchObject({ label: 'Weekly check-in', group: 'Execute', surface: 'project_workspace' });
  });

  it('gates each entry on its surface read permission', () => {
    // Engineer: project_workspace read only among the three.
    expect(pathsFor('Engineer')).toContain('/check-in');
    expect(pathsFor('Engineer')).not.toContain('/vip');
    expect(pathsFor('Engineer')).not.toContain('/priority-board');
    // Executive Viewer reads dashboard, matrix and project_workspace.
    expect(pathsFor('Executive Viewer')).toEqual(expect.arrayContaining(['/vip', '/priority-board', '/check-in']));
    // Auditor reads none of them.
    for (const p of ['/vip', '/priority-board', '/check-in']) expect(pathsFor('Auditor')).not.toContain(p);
  });
});

describe('Sidebar Weekly check-in due badge', () => {
  it('shows the served due_stages − checked_in_stages count, for the current hub filter', async () => {
    useHubFilterStore.setState({ hubId: 'hub-gr' });
    renderWithProviders(<AppSidebar />, { session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    const badge = await screen.findByTestId('nav-badge-/check-in');
    expect(badge).toHaveTextContent('5');
    expect(badge).toHaveTextContent(/^5$/);
    expect(client.apiGet).toHaveBeenCalledWith('/check-ins/due', expect.objectContaining({ query: { hub_id: 'hub-gr' } }));
    // The link's accessible name is unchanged; the count is its description.
    expect(screen.getByRole('link', { name: 'Weekly check-in' })).toHaveAccessibleDescription('5 stages still to check in this week');
  });

  it('never fetches without the check-in surface (Auditor)', async () => {
    renderWithProviders(<AppSidebar />, { session: { permissions: ROLE_MATRIX.Auditor } });
    await waitFor(() => expect(screen.getByRole('navigation', { name: 'Surfaces' })).toBeInTheDocument());
    expect(client.apiGet).not.toHaveBeenCalledWith('/check-ins/due', expect.anything());
    expect(screen.queryByTestId('nav-badge-/check-in')).not.toBeInTheDocument();
  });
});
