import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { PriorityMoveContext, type PriorityMoveApi } from '@/components/shared/priority-move/priority-move-context';
import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';

import { compareBandRank, formatBandRank, nextRankSort, sortByBandRank } from '../lib/band-rank';
import { ProjectsTable } from './projects-table';

// Render every row (jsdom has no layout), as in ProjectsPage.test.tsx.
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

function row(id: string, name: string, priority: ProjectFilterRow['priority'], bandRank: number | null): ProjectFilterRow {
  return {
    ...P13_ROW_DEFAULTS,
    project_id: id,
    project_name: name,
    hub: 'R&D-Greece',
    category: null,
    status: 'In Development',
    priority,
    is_vip: false,
    tracking_status: 'idle',
    band_rank: bandRank,
    band_size: bandRank === null ? null : 12,
  } as ProjectFilterRow;
}

const ROWS = [row('a', 'Alpha', 'P2', 1), row('b', 'Bravo', 'P1', 3), row('c', 'Charlie', null, null), row('d', 'Delta', 'P1', 1)];

function host(): PriorityMoveApi {
  return { requestMove: vi.fn(), requestRankMove: vi.fn(), followPatch: vi.fn(), busy: false };
}

function renderTable(api: PriorityMoveApi | null, canEdit = true): void {
  renderWithProviders(
    <PriorityMoveContext.Provider value={api}>
      <ProjectsTable rows={ROWS} canEdit={canEdit} highlightId={null} />
    </PriorityMoveContext.Provider>,
  );
}

function names(): string[] {
  return screen.getAllByTestId('projects-row').map((r) => r.getAttribute('data-project-id') ?? '');
}

describe('P54 (ADR 0064 R2): register Rank column', () => {
  it('helpers: "P1 · 3", priority then rank, unranked last', () => {
    expect(formatBandRank('P1', 3)).toBe('P1 · 3');
    expect(formatBandRank(null, 3)).toBeNull();
    expect(formatBandRank('P1', null)).toBeNull();
    expect(compareBandRank({ priority: 'P1', band_rank: 9 }, { priority: 'P2', band_rank: 1 })).toBeLessThan(0);
    expect(sortByBandRank(ROWS, 'asc').map((r) => r.project_id)).toEqual(['d', 'b', 'a', 'c']);
    expect(sortByBandRank(ROWS, 'desc').map((r) => r.project_id)).toEqual(['a', 'b', 'd', 'c']);
    expect(sortByBandRank(ROWS, 'none')).toBe(ROWS);
    expect(nextRankSort('none')).toBe('asc');
    expect(nextRankSort('asc')).toBe('desc');
    expect(nextRankSort('desc')).toBe('none');
  });

  it('renders the band and rank, "—" when unranked, read-only without the right', () => {
    renderTable(host(), false);
    const cells = screen.getAllByTestId('rank-cell').map((c) => c.textContent);
    expect(cells).toEqual(['P2 · 1', 'P1 · 3', 'P1 · 1']);
    const charlie = screen.getAllByTestId('projects-row').find((r) => r.getAttribute('data-project-id') === 'c');
    expect(within(charlie as HTMLElement).queryByTestId('rank-cell')).toBeNull();
    expect(screen.queryByTestId('board-rank-input')).not.toBeInTheDocument();
  });

  it('the Rank header sorts by priority then rank (asc, desc, off)', async () => {
    const user = userEvent.setup();
    renderTable(host());
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
    const header = screen.getByRole('columnheader', { name: 'Rank' });
    expect(header).toHaveAttribute('aria-sort', 'none');
    await user.click(screen.getByTestId('sort-rank'));
    expect(names()).toEqual(['d', 'b', 'a', 'c']);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await user.click(screen.getByTestId('sort-rank'));
    expect(names()).toEqual(['a', 'b', 'd', 'c']);
    await user.click(screen.getByTestId('sort-rank'));
    expect(names()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('typing a position opens the shared preview with the board request ({ to_rank })', async () => {
    const user = userEvent.setup();
    const api = host();
    renderTable(api);
    const input = screen.getByRole('textbox', { name: /Position of Bravo in P1/ });
    await user.clear(input);
    await user.type(input, '1{Enter}');
    expect(api.requestRankMove).toHaveBeenCalledTimes(1);
    expect(api.requestRankMove).toHaveBeenCalledWith(
      { projectId: 'b', projectName: 'Bravo', priority: 'P1', status: 'In Development' },
      { to_rank: 1 },
      expect.objectContaining({ position: 1, fromPosition: 3 }),
    );
  });

  it('no move host: read-only text, no input', () => {
    renderTable(null);
    expect(screen.queryByTestId('board-rank-input')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('rank-cell')[1]).toHaveTextContent('P1 · 3');
  });
});
