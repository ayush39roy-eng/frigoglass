import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { VipBoardResponse } from '@/lib/api/vip';

import type { CompletingWithinYear, CompletingWithinYearRow } from '../../api/types';

// The projects dialog renders through the shared VirtualDataTable; in jsdom
// the real virtualizer measures a 0-height viewport, so (as in
// virtual-data-table.test.tsx) it is mocked to list every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

// The VIP board dialog is its own tested component; stubbed to observe props.
const vipDialog = vi.fn();
vi.mock('../vip/vip-board-dialog', () => ({
  VipBoardDialog: (props: { area: { area: string } | null }) => {
    vipDialog(props);
    return props.area ? <div data-testid="vip-board-dialog" data-area={props.area.area} /> : null;
  },
}));

import { ExecKpiStrip } from './exec-kpi-strip';

function row(overrides: Partial<CompletingWithinYearRow>): CompletingWithinYearRow {
  return {
    project_id: 'p-x',
    project_name: 'Project X',
    hub: 'PD-India',
    category: null,
    priority: 'P1',
    within_year: false,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: null,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

const ROWS: CompletingWithinYearRow[] = [
  row({ project_id: 'w1', project_name: 'Within One', within_year: true, last_step_end_week: 44 }),
  row({ project_id: 's1', project_name: 'Spill One', spillover: true, last_step_end_week: 61 }),
  row({ project_id: 's2', project_name: 'Spill Two', spillover: true }),
  row({ project_id: 'l1', project_name: 'Left One', left_out: true }),
  // Blocked wins outright (P9-F02): counted/listed ONLY under Blocked.
  row({ project_id: 'b1', project_name: 'Blocked One', blocked: true, within_year: true }),
];

const DATA: CompletingWithinYear = {
  has_active_schedule_run: true,
  schedule_run_version: 4,
  within_year_count: 1,
  spillover_count: 2,
  left_out_count: 1,
  blocked_count: 1,
  priority_delivery: [],
  rows: ROWS,
};

function board(areaCount: 1 | 2): VipBoardResponse {
  const mk = (area: 'Greece' | 'India', highlighted: number) => ({
    area,
    label: area,
    hubs: [],
    item_count: 1,
    highlighted_count: highlighted,
    vip_project_count: highlighted,
    high_risk_count: 0,
    linked_project_count: 0,
    vip_items: [],
    items: [],
  });
  return {
    run_id: 'r',
    pillars: [],
    areas: areaCount === 1 ? [mk('Greece', 3)] : [mk('Greece', 3), mk('India', 4)],
  };
}

describe('ExecKpiStrip (P28, ADR 0039 §3 + addenda)', () => {
  it('renders six identical fixed-size tiles with the served figures verbatim', () => {
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={253} vipBoard={board(1)} />);
    const tile = (id: string) => within(screen.getByTestId(id));
    expect(tile('exec-kpi-scheduled').getByText('5')).toBeInTheDocument();
    expect(tile('exec-kpi-scheduled').getByText('of 253')).toBeInTheDocument();
    expect(tile('exec-kpi-within-year').getByText('1')).toBeInTheDocument();
    expect(tile('exec-kpi-spillover').getByText('2')).toBeInTheDocument();
    expect(tile('exec-kpi-left-out').getAllByText('1').length).toBeGreaterThan(0);
    expect(tile('exec-kpi-blocked').getAllByText('1').length).toBeGreaterThan(0);
    expect(tile('exec-kpi-vip').getByText('3')).toBeInTheDocument();
    for (const label of ['Scheduled', 'Within year', 'Spillover', 'Left out', 'On hold', 'VIP']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    // Within-year badge: the shared share formula (1 of 5 → 20%).
    expect(tile('exec-kpi-within-year').getByText('20%')).toBeInTheDocument();

    // Equal size by construction: every tile carries the SAME fixed frame.
    const tiles = screen.getAllByTestId(/exec-kpi-.*-tile$/).filter((el) => el.hasAttribute('data-exec-kpi-tile'));
    expect(tiles).toHaveLength(6);
    for (const el of tiles) {
      expect(el.className).toContain('h-[5.75rem]');
      expect(el.className).toContain('w-full');
    }
  });

  it('QA-F28-2/F28-3: the badge never shares the label row at any width; every tile keeps ONE fixed frame', () => {
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={253} vipBoard={board(1)} />);
    const tiles = screen.getAllByTestId(/exec-kpi-.*-tile$/).filter((el) => el.hasAttribute('data-exec-kpi-tile'));
    expect(tiles).toHaveLength(6);
    const frames = new Set(tiles.map((el) => el.className.split(/\s+/).filter((c) => /^(md:)?(h|w|px|py)-/.test(c)).sort().join(' ')));
    // Identical footprint: taller fixed frame below md, the approved height from md up.
    expect(frames.size).toBe(1);
    expect([...frames][0]!.split(' ')).toEqual(expect.arrayContaining(['h-[7.5rem]', 'md:h-[5.75rem]', 'w-full']));
    for (const el of tiles) {
      const header = within(el).getByTestId('exec-kpi-tile-header');
      const label = within(el).getByTestId('exec-kpi-tile-label');
      const badge = within(el).getByTestId('exec-kpi-tile-badge');
      const figureLine = within(el).getByTestId('exec-kpi-tile-figure-line');
      // The label row holds ONLY the icon chip and the label — no badge, at any breakpoint.
      const [icon, onlyLabel, ...rest] = [...header.children] as HTMLElement[];
      expect(rest).toHaveLength(0);
      expect(onlyLabel).toBe(label);
      expect(header).not.toContainElement(badge);
      expect(icon!.className.split(/\s+/)).toEqual(expect.arrayContaining(['hidden', 'md:grid']));
      // The badge follows the number on the figure line: under it below md, beside it from md.
      expect(figureLine).toContainElement(badge);
      expect(figureLine.lastElementChild).toBe(badge);
      expect(figureLine.className.split(/\s+/)).toEqual(expect.arrayContaining(['flex-col', 'md:flex-row']));
      expect(label.className).not.toMatch(/truncate|ellipsis|line-clamp|whitespace-nowrap|break-words|anywhere|break-all/);
    }
    const scheduled = within(screen.getByTestId('exec-kpi-scheduled'));
    expect(scheduled.getByTestId('exec-kpi-tile-label')).toHaveTextContent(/^Scheduled$/);
    expect(scheduled.getByTestId('exec-kpi-tile-figure-line')).toHaveTextContent(/^5of 253$/);
  });

  it('each run tile is a button that opens the dialog with exactly its served rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={253} vipBoard={board(1)} />);

    const scheduled = screen.getByTestId('exec-kpi-scheduled-tile');
    expect(scheduled).toHaveAttribute('aria-haspopup', 'dialog');
    await user.click(scheduled);
    let dialog = screen.getByTestId('exec-kpi-dialog');
    // Count in the title matches the tile's number (selection = served flags).
    expect(within(dialog).getByTestId('exec-kpi-dialog-title')).toHaveTextContent('Scheduled projects — 5 projects');
    expect(within(dialog).getByText('Within One')).toBeInTheDocument();
    expect(within(dialog).getByText('Blocked One')).toBeInTheDocument();
    // Row anatomy: link target, hub, end week ("—" when null), outcome chip.
    expect(within(dialog).getByRole('link', { name: 'Within One' })).toHaveAttribute('href', '/projects/w1');
    expect(within(dialog).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(dialog).getByText('W44')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    // Focus returns to the opening tile (Radix restores it async on close).
    await waitFor(() => { expect(screen.getByTestId('exec-kpi-scheduled-tile')).toHaveFocus(); });

    await user.click(screen.getByTestId('exec-kpi-blocked-tile'));
    dialog = screen.getByTestId('exec-kpi-dialog');
    expect(within(dialog).getByTestId('exec-kpi-dialog-title')).toHaveTextContent(
      'On hold (at a stage) — 1 project',
    );
    // Blocked wins: the blocked row is here and ONLY here…
    expect(within(dialog).getByText('Blocked One')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    await user.click(screen.getByTestId('exec-kpi-within-year-tile'));
    dialog = screen.getByTestId('exec-kpi-dialog');
    // …never double-listed under Within year, so counts match the tiles.
    expect(within(dialog).getByTestId('exec-kpi-dialog-title')).toHaveTextContent('1 project');
    expect(within(dialog).queryByText('Blocked One')).not.toBeInTheDocument();
  });

  it('the VIP tile opens the existing VIP board dialog directly when one area is in scope', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={253} vipBoard={board(1)} />);
    await user.click(screen.getByTestId('exec-kpi-vip-tile'));
    expect(screen.getByTestId('vip-board-dialog')).toHaveAttribute('data-area', 'Greece');
    expect(screen.queryByTestId('exec-vip-picker')).not.toBeInTheDocument();
  });

  it('with several areas the VIP tile opens a small picker, then the board dialog', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={253} vipBoard={board(2)} />);
    // The tile shows the summed served highlighted counts (3 + 4).
    expect(within(screen.getByTestId('exec-kpi-vip')).getByText('7')).toBeInTheDocument();
    await user.click(screen.getByTestId('exec-kpi-vip-tile'));
    const picker = screen.getByTestId('exec-vip-picker');
    const areas = within(picker).getAllByTestId('exec-vip-picker-area');
    expect(areas).toHaveLength(2);
    await user.click(areas[1]!);
    expect(screen.getByTestId('vip-board-dialog')).toHaveAttribute('data-area', 'India');
  });

  it('falls back to the pipeline total (NOT clickable) + VIP with a short notice when there is no active run', () => {
    renderWithProviders(
      <ExecKpiStrip
        data={{ ...DATA, has_active_schedule_run: false, schedule_run_version: null }}
        pipelineTotal={253}
        vipBoard={null}
      />,
    );
    const pipeline = screen.getByTestId('exec-kpi-pipeline');
    expect(pipeline).toHaveTextContent('253');
    expect(within(pipeline).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-vip')).toHaveTextContent('—');
    expect(screen.getByTestId('exec-no-run-notice')).toHaveTextContent(/No schedule has been computed yet/);
    for (const id of ['exec-kpi-scheduled', 'exec-kpi-within-year', 'exec-kpi-spillover', 'exec-kpi-left-out', 'exec-kpi-blocked']) {
      expect(screen.queryByTestId(id)).not.toBeInTheDocument();
    }
  });

  it('shows — for the VIP tile while the board is unresolved (never invents 0, not clickable)', () => {
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={null} vipBoard={null} />);
    const vip = screen.getByTestId('exec-kpi-vip');
    expect(vip).toHaveTextContent('—');
    expect(within(vip).queryByRole('button')).not.toBeInTheDocument();
  });
});
