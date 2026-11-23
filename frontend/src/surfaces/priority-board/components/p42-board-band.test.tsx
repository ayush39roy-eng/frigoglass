import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { ProjectPriority } from '@/types/enums';

import type { PriorityBoardCard } from '../api';
import type { DisplayColumn } from '../lib/board-model';
import { BoardColumn, type BoardColumnProps } from './board-column';

/**
 * P42-T04 (ADR 0056): the board column header shows the served band label
 * (R42-1; Q stays "Q"), P4 / Q say "Not scheduled", and a queued P3 card
 * carries the served "Queued" badge (R42-7) with its served outcome text.
 */

function card(id: string, overrides: Partial<PriorityBoardCard> = {}): PriorityBoardCard {
  return {
    project_id: id, name: `Project ${id}`, hub_id: 'h', hub: 'R&D-Greece', category: 'A',
    status: 'In Queue', external_code: null, score: null, band: null, suggested_band: null, score_band: null,
    capacity_fill: false, capacity_fill_reason: null, hard_gated: false, is_vip: false, projected_end_week: 40,
    within_year: true, health: 'on_track', tracking_status: 'live', band_rank: 1, hub_rank: 1, hub_band_size: null, frozen: false,
    counts_toward_year: true, not_scheduled_priority: false, queued: false, outcome_label: null,
    ...overrides,
  };
}

function column(priority: ProjectPriority, label: string, cards: PriorityBoardCard[], extra: Partial<DisplayColumn> = {}): DisplayColumn {
  return {
    priority, count: cards.length, design_weeks: 0, lab_weeks: 0, label,
    not_scheduled: priority === 'P4' || priority === 'Q',
    queued_count: cards.filter((c) => c.queued === true).length,
    cards: cards.map((c) => ({ card: c, servedPriority: priority, pending: false })),
    ...extra,
  };
}

function props(col: DisplayColumn): BoardColumnProps {
  return {
    column: col, canDragCard: () => false, liftedId: null, isDropTarget: false, acceptsDrop: false,
    instructionsId: 'i', onPointerDragStart: vi.fn(), onPointerDragEnd: vi.fn(), onHandleKeyDown: vi.fn(),
    onHandleBlur: vi.fn(), onColumnDragOver: vi.fn(), onColumnDragLeave: vi.fn(), onColumnDrop: vi.fn(),
  };
}

describe('P42 priority board', () => {
  it('heads each column with the served band label', () => {
    renderWithProviders(<BoardColumn {...props(column('P1', 'Must do this year', [card('a')]))} />);
    const heading = screen.getByRole('heading', { level: 2 });
    expect(heading).toHaveTextContent('P1 · Must do this year');
    expect(heading).toHaveAttribute('title', 'Priority band P1 — Must do this year');
    expect(screen.queryByTestId('board-column-not-scheduled')).toBeNull();
  });

  it('shows Q as "Q", and says P4 / Q are not scheduled', () => {
    renderWithProviders(<BoardColumn {...props(column('Q', 'Unprioritised', []))} />);
    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent(/^Q$/);
    expect(screen.getByTestId('board-column-not-scheduled')).toHaveTextContent('Not scheduled');
  });

  it('badges a queued P3 card "Queued" and prints its served outcome text; a started P3 has no badge', async () => {
    const queued = card('q', { queued: true, counts_toward_year: false, within_year: false, outcome_label: 'Queued — fits by W40' });
    const started = card('s', { status: 'In Development', band_rank: 2 });
    const view = renderWithProviders(<BoardColumn {...props(column('P3', 'In queue', [queued, started]))} />);

    expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('P3 · In queue');
    // Served `queued_count`, never "of M".
    expect(screen.getByTestId('board-column-queued')).toHaveTextContent(/^1 queued$/);

    const cards = screen.getAllByTestId('board-card');
    const q = cards.find((c) => c.getAttribute('data-project-id') === 'q')!;
    const s = cards.find((c) => c.getAttribute('data-project-id') === 's')!;
    expect(within(q).getByTestId('board-card-queued')).toHaveTextContent('Queued');
    expect(within(q).getByTestId('band-outcome-chip')).toHaveTextContent('Queued — fits by W40');
    expect(within(q).queryByTestId('finish-chip')).toBeNull();
    expect(within(s).queryByTestId('board-card-queued')).toBeNull();
    expect(within(s).getByTestId('finish-chip')).toHaveTextContent('Within year');

    expect(await seriousAxeViolations(view.container)).toEqual([]);
  });

  it('a P4 card shows "Not scheduled (P4)" from the served flags and label', () => {
    const p4 = card('n', {
      counts_toward_year: false, not_scheduled_priority: true, within_year: false, projected_end_week: null,
      outcome_label: 'Not scheduled (P4)',
    });
    renderWithProviders(<BoardColumn {...props(column('P4', 'Miscellaneous', [p4]))} />);
    const el = screen.getByTestId('board-card');
    expect(within(el).getByTestId('band-outcome-chip')).toHaveTextContent('Not scheduled (P4)');
    expect(within(el).getByTestId('band-outcome-chip')).toHaveAttribute('data-outcome', 'NOT_SCHEDULED_PRIORITY');
    // R42-7: the badge is the served `queued`, not derived from the band.
    expect(within(el).queryByTestId('board-card-queued')).toBeNull();
  });
});
