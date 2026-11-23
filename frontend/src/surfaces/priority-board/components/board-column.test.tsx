import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { PriorityBoardCard } from '../api';
import type { DisplayColumn } from '../lib/board-model';
import { BoardColumn, VIRTUALIZE_OVER, type BoardColumnProps } from './board-column';

function card(i: number): PriorityBoardCard {
  return {
    project_id: `p${String(i)}`, name: `Project ${String(i)}`, hub_id: 'h', hub: 'R&D-Greece', category: 'A',
    status: 'In Queue', external_code: null, score: null, band: null, suggested_band: null, score_band: null,
    capacity_fill: false, capacity_fill_reason: null, hard_gated: false, is_vip: false, projected_end_week: null,
    within_year: null, health: null, tracking_status: 'live', band_rank: i + 1, hub_rank: i + 1, hub_band_size: null, frozen: false,
  };
}

function bigColumn(): DisplayColumn {
  const n = VIRTUALIZE_OVER + 20;
  return {
    priority: 'P1', count: n, design_weeks: 0, lab_weeks: 0, label: 'Must do this year', not_scheduled: false, queued_count: 0,
    cards: Array.from({ length: n }, (_, i) => ({ card: card(i), servedPriority: 'P1' as const, pending: false })),
  };
}

function props(overrides: Partial<BoardColumnProps> = {}): BoardColumnProps {
  return {
    column: bigColumn(), canDragCard: () => true, liftedId: null, isDropTarget: false, acceptsDrop: false,
    instructionsId: 'i', onPointerDragStart: vi.fn(), onPointerDragEnd: vi.fn(), onHandleKeyDown: vi.fn(),
    onHandleBlur: vi.fn(), onColumnDragOver: vi.fn(), onColumnDragLeave: vi.fn(), onColumnDrop: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('BoardColumn — P36 drop slots in a virtualized column (> 100 cards)', () => {
  it('rows carry their slot index, the drop line renders on the slot row, and a drag over a row reports its slot', async () => {
    // jsdom lays nothing out: give the scroll body a 600 px window so the virtualizer renders rows.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(240);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      top: 0, bottom: 600, left: 0, right: 240, width: 240, height: 600, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);
    const onColumnDragOver = vi.fn();
    const p = props({ indicatorSlot: 1, onColumnDragOver });
    const view = renderWithProviders(<BoardColumn {...p} />);
    // The scroll body's ref attaches after the virtualizer's first layout effect; the page
    // always re-renders (queries, hover state), so do the same here.
    view.rerender(<BoardColumn {...p} />);
    const list = screen.getByRole('list', { name: 'P1 projects' });
    expect(list).toHaveAttribute('data-virtualized', 'true');
    // The virtualizer mounts its window after measuring; only part of the column is in the DOM.
    const items = await within(list).findAllByRole('listitem');
    expect(items.length).toBeLessThan(VIRTUALIZE_OVER);
    const row = document.querySelector<HTMLElement>('[data-slot-index="1"]');
    expect(row).not.toBeNull();
    if (!row) return;
    expect(row.querySelector('[data-testid="board-drop-indicator"]')).toHaveAttribute('data-edge', 'top');
    vi.spyOn(row, 'getBoundingClientRect').mockReturnValue({ top: 0, bottom: 100, height: 100 } as DOMRect);
    const event = createEvent.dragOver(row, { dataTransfer: { dropEffect: '' } });
    Object.defineProperty(event, 'clientY', { value: 70 });
    fireEvent(row, event);
    expect(onColumnDragOver).toHaveBeenCalledWith('P1', expect.anything(), 2);
  });
});
