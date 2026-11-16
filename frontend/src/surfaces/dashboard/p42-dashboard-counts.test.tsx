import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { VipBoardResponse } from '@/lib/api/vip';

import type { CompletingWithinYear, CompletingWithinYearRow, ProjectFilterRow } from './api/types';
import { DeliveryGaugeCard } from './components/delivery-gauge-card';
import { ExecKpiStrip } from './components/executive/exec-kpi-strip';
import { PortfolioAnalytics } from './components/portfolio-analytics';
import { WithinYearKpis } from './components/within-year-panel';
import { YEAR_BASIS_COPY } from './components/year-basis-note';
import { selectOutcomeRows, selectRiskRows } from './lib/executive';
import { outcomeOf, outcomeTotal, withinYearSharePct } from './lib/outcome';
import { P13_ROW_DEFAULTS, servedBand, servedCompleting, servedRow } from './test-fixtures';

// The KPI dialog lists through TanStack Virtual; jsdom has no layout, so list every row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

/**
 * P42-T04 (ADR 0056, I53): every Dashboard / Executive year figure is SERVED —
 * the bucket per row (`outcome`), the counting denominator
 * (`counting_outcome_count`), the share (`within_year_share_pct`) and the two
 * non-counting counts (`queued_count`, `not_scheduled_priority_count`). The
 * browser derives none of them. The fixtures below make the served share
 * deliberately different from any ratio the browser could compute, so a
 * recomputation would fail.
 */

function row(id: string, o: Partial<CompletingWithinYearRow> = {}): CompletingWithinYearRow {
  return servedRow({
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A',
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
    ...o,
  });
}

const ROWS: CompletingWithinYearRow[] = [
  row('w1', { within_year: true, last_step_end_week: 30 }),
  row('w2', { within_year: true, last_step_end_week: 40 }),
  row('s1', { spillover: true, last_step_end_week: 60 }),
  row('b1', { blocked: true }),
  // Queued P3: structurally left out, served bucket QUEUED.
  row('q1', { priority: 'P3', status: 'In Queue', left_out: true, counts_toward_year: false }),
  // Queued P3 that is on hold at a stage: QUEUED outranks BLOCKED on the server.
  row('q2', { priority: 'P3', status: 'In Queue', blocked: true, counts_toward_year: false }),
  // P4, never planned.
  row('n1', { priority: 'P4', status: 'In Queue', counts_toward_year: false, not_scheduled_priority: true }),
];

const DATA: CompletingWithinYear = servedCompleting({
  has_active_schedule_run: true,
  schedule_run_version: 9,
  within_year_count: 2,
  spillover_count: 1,
  left_out_count: 0,
  blocked_count: 1,
  queued_count: 2,
  not_scheduled_priority_count: 1,
  excluded_count: 0,
  // Served values, deliberately not 2 / 4: the browser must not divide.
  counting_outcome_count: 4,
  within_year_share_pct: 61.4,
  priority_delivery: [],
  regions: [],
  rows: ROWS,
});

describe('P42 dashboard: served buckets', () => {
  it('outcomeOf reads the served bucket; QUEUED and NOT_SCHEDULED_PRIORITY are their own buckets', () => {
    expect(ROWS.map((r) => [r.project_id, outcomeOf(r)])).toEqual([
      ['w1', 'within_year'],
      ['w2', 'within_year'],
      ['s1', 'spillover'],
      ['b1', 'blocked'],
      ['q1', 'queued'],
      ['q2', 'queued'],
      ['n1', 'not_scheduled'],
    ]);
    // A served bucket wins over the raw flags.
    expect(outcomeOf({ outcome: 'QUEUED' })).toBe('queued');
    expect(outcomeOf({ outcome: null })).toBe('unresolved');
  });

  it('the denominator and the share are the served fields', () => {
    expect(outcomeTotal(DATA)).toBe(4);
    expect(withinYearSharePct(DATA)).toBe(61);
  });

  it('the "counted" KPI rows are the counting rows only; queued / not scheduled open their own lists', () => {
    expect(selectOutcomeRows(DATA.rows, 'scheduled').map((r) => r.project_id)).toEqual(['w1', 'w2', 's1', 'b1']);
    expect(selectOutcomeRows(DATA.rows, 'blocked').map((r) => r.project_id)).toEqual(['b1']);
    expect(selectOutcomeRows(DATA.rows, 'queued').map((r) => r.project_id)).toEqual(['q1', 'q2']);
    expect(selectOutcomeRows(DATA.rows, 'not_scheduled').map((r) => r.project_id)).toEqual(['n1']);
  });
});

describe('P42 Detailed view: within-year KPIs', () => {
  it('shows the served counted figure, the served share and the year-basis copy with both served counts', async () => {
    const user = userEvent.setup();
    const view = renderWithProviders(<WithinYearKpis data={DATA} activeRun={undefined} pipelineTotal={253} />);
    expect(screen.getByTestId('within-year-total-projects')).toHaveTextContent('4 counted this year');
    expect(screen.getByText('61% of run')).toBeInTheDocument();

    const note = screen.getByTestId('year-basis-note');
    expect(note).toHaveTextContent(YEAR_BASIS_COPY);
    expect(note).toHaveTextContent('Year figures count P1, P2 and started P3 only.');
    expect(within(note).getByTestId('year-basis-queued')).toHaveTextContent('Queued P3 2');
    expect(within(note).getByTestId('year-basis-not_scheduled')).toHaveTextContent('Not scheduled (P4) 1');
    // Never "of M" (P36-R02 copy rule).
    expect(view.container.textContent).not.toMatch(/scheduled of \d/);

    await user.click(within(note).getByTestId('year-basis-queued'));
    const dialog = await screen.findByTestId('exec-kpi-dialog');
    expect(within(dialog).getByTestId('exec-kpi-dialog-title')).toHaveTextContent('Queued (P3, not counted this year) — 2 projects');
    expect(within(dialog).getByText('Project q1')).toBeInTheDocument();
    expect(within(dialog).queryByText('Project w1')).toBeNull();
  });

  it('the delivery gauge prints the served share over the served denominator', () => {
    renderWithProviders(<DeliveryGaugeCard data={DATA} />);
    expect(screen.getByRole('img', { name: '61% delivered within the year' })).toBeInTheDocument();
    expect(screen.getByText('Counted this year')).toBeInTheDocument();
  });

  it('has no serious or critical axe violations', async () => {
    const view = renderWithProviders(<WithinYearKpis data={DATA} activeRun={undefined} />);
    expect(await seriousAxeViolations(view.container)).toEqual([]);
  });
});

describe('P42 Executive view', () => {
  const board: VipBoardResponse = { pillars: [], areas: [] } as unknown as VipBoardResponse;

  it('the KPI strip counts the served counting figure, with the year-basis copy and no "of M" badge', () => {
    renderWithProviders(<ExecKpiStrip data={DATA} pipelineTotal={253} vipBoard={board} />);
    const counted = within(screen.getByTestId('exec-kpi-scheduled'));
    expect(counted.getByText('Counted this year')).toBeInTheDocument();
    expect(counted.getByText('4')).toBeInTheDocument();
    expect(counted.queryByText(/^of /)).toBeNull();
    expect(within(screen.getByTestId('exec-kpi-within-year')).getByText('61%')).toBeInTheDocument();
    const note = screen.getByTestId('year-basis-note');
    expect(note).toHaveTextContent('Year figures count P1, P2 and started P3 only.');
    expect(within(note).getByTestId('year-basis-queued')).toHaveTextContent('2');
    expect(within(note).getByTestId('year-basis-not_scheduled')).toHaveTextContent('1');
  });

  it('the risk list leaves out every project that does not count toward the year', () => {
    const reg = (id: string, o: Partial<ProjectFilterRow>): ProjectFilterRow => ({
      project_id: id,
      project_name: `Register ${id}`,
      hub: 'R&D-Greece',
      category: null,
      status: 'In Development',
      priority: 'P1',
      is_vip: false,
      tracking_status: 'overdue',
      ...P13_ROW_DEFAULTS,
      ...o,
    });
    const vip: VipBoardResponse = {
      pillars: [],
      areas: [
        {
          area: 'Greece',
          label: 'Greece',
          hubs: ['R&D-Greece'],
          item_count: 2,
          highlighted_count: 2,
          vip_project_count: 0,
          items: [
            {
              id: 'i1', highlighted: true, children: [], hidden_project_count: 0,
              projects: [
                { id: 'v-count', name: 'VIP counted', hub: 'R&D-Greece', priority: 'P1', status: 'In Development', projected_end_week: 60, within_year: false, health: 'off_track', counts_toward_year: true },
                { id: 'v-queued', name: 'VIP queued', hub: 'R&D-Greece', priority: 'P3', status: 'In Queue', projected_end_week: 60, within_year: false, health: 'off_track', counts_toward_year: false },
              ],
            },
          ],
        },
      ],
    } as unknown as VipBoardResponse;
    const risks = selectRiskRows(
      DATA.rows,
      [reg('o-count', { counts_toward_year: true }), reg('o-queued', { counts_toward_year: false }), reg('o-norun', {})],
      vip,
    );
    expect(risks.map((r) => [r.projectId, r.reason])).toEqual([
      ['b1', 'blocked'],
      ['o-count', 'overdue'],
      ['o-norun', 'overdue'],
      ['v-count', 'vip_not_in_year'],
    ]);
  });
});

describe('P42 portfolio analytics', () => {
  it('delivery by priority: served label, counting headline and the served queued / not-scheduled segments', () => {
    const p3 = servedBand({
      priority: 'P3',
      total: 10,
      within_year: 2,
      in_flight_total: 3,
      in_flight_within_year: 2,
      not_started_total: 7,
      not_started_within_year: 0,
      delivered_total: 0,
      delivered_within_year: 0,
      other_total: 0,
      within_year_share_pct: 66.67,
      in_flight_within_year_share_pct: 66.67,
      not_started_within_year_share_pct: 0,
      in_flight_share_pct: 30,
      not_started_share_pct: 70,
      delivered_share_pct: 0,
      other_share_pct: 0,
      queued_total: 6,
      not_scheduled_priority_total: 1,
      counting_total: 3,
      in_flight_counting_total: 3,
      not_started_counting_total: 0,
    });
    renderWithProviders(<PortfolioAnalytics rows={DATA.rows} priorityDelivery={[p3]} />);
    const band = screen.getByTestId('priority-band-P3');
    expect(band).toHaveTextContent('P3 · In queue');
    expect(band).toHaveTextContent('2 finishing this year · 3 counted');
    expect(band).toHaveTextContent('67%');
    expect(band.querySelector('[data-segment="queued"]')).toHaveAttribute('data-count', '6');
    expect(band.querySelector('[data-segment="not_scheduled"]')).toHaveAttribute('data-count', '1');
    // A queued project is never "not started, not finishing".
    expect(band.querySelector('[data-segment="not_started_not_finishing"]')).toBeNull();
    expect(band).toHaveTextContent('Queued: 6');
    expect(band.textContent).not.toMatch(/ of \d/);
  });
});
