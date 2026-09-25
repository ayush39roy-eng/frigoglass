import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';

const hooks = {
  useScenarioVersions: vi.fn(),
  useScenarioVersionDetail: vi.fn(),
};
vi.mock('../hooks/use-matrix', () => ({
  useScenarioVersions: (args: unknown) => hooks.useScenarioVersions(args),
  useScenarioVersionDetail: (version: number | null) => hooks.useScenarioVersionDetail(version),
}));

import { VersionHistoryDialog } from './version-history-panel';
import type { ScenarioApplyRunDetail, ScenarioApplyRunSummary } from '../api/types';

const pending = { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error, refetch = vi.fn()) {
  return { data: undefined, isPending: false, isError: true, error, refetch };
}

const runs: ScenarioApplyRunSummary[] = [
  {
    id: 'r2',
    version: 5,
    applied_by_user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    notes: 'Q3 replan',
    entity_types_touched: ['priority_score'],
    change_count: 2,
    created_at: '2026-08-30T10:15:00Z',
  },
  {
    id: 'r1',
    version: 4,
    applied_by_user_id: null,
    notes: null,
    entity_types_touched: ['priority_score'],
    change_count: 1,
    created_at: '2026-08-01T09:00:00Z',
  },
];

const detail: ScenarioApplyRunDetail = {
  id: 'r2',
  version: 5,
  applied_by_user_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  notes: 'Q3 replan',
  entity_types_touched: ['priority_score'],
  change_count: 2,
  created_at: '2026-08-30T10:15:00Z',
  changes: [
    {
      id: 'c1',
      entity_type: 'priority_score',
      entity_id: 's1',
      project_id: 'p1',
      hub_id: 'h1',
      before_state: {
        id: 's1', project_id: 'p1', strategic_project: 3, new_customer: 3, new_options: 3,
        regulatory_compliance: 3, quality_improvements: 3, rm_savings: 3, total_rm_savings: 3,
        gross_margins: 3, profitability: 3, annual_volume: 3, three_year_volume: 3,
        new_models: 3, capex_investment: 3, hard_gates: [], weighted_score: 840,
        normalized_pct: 60, suggested_band: 'P2',
      },
      after_state: {
        id: 's1', project_id: 'p1', strategic_project: 5, new_customer: 3, new_options: 3,
        regulatory_compliance: 3, quality_improvements: 3, rm_savings: 3, total_rm_savings: 3,
        gross_margins: 3, profitability: 3, annual_volume: 3, three_year_volume: 3,
        new_models: 3, capex_investment: 3, hard_gates: ['Active safety non-compliance'],
        weighted_score: 890, normalized_pct: 64, suggested_band: 'P1',
      },
    },
    {
      id: 'c2',
      entity_type: 'priority_score',
      entity_id: 's2',
      project_id: 'p2',
      hub_id: 'h2',
      before_state: null,
      after_state: {
        id: 's2', project_id: 'p2', strategic_project: 4, new_customer: 4, new_options: 4,
        regulatory_compliance: 4, quality_improvements: 4, rm_savings: 4, total_rm_savings: 4,
        gross_margins: 4, profitability: 4, annual_volume: 4, three_year_volume: 4,
        new_models: 4, capex_investment: 4, hard_gates: [], weighted_score: 1120,
        normalized_pct: 80, suggested_band: 'P1',
      },
    },
  ],
};

const projectLookup = { p1: { name: 'Cooler A', hub: 'R&D-Greece' } };

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useScenarioVersions.mockReturnValue(pending);
  hooks.useScenarioVersionDetail.mockReturnValue(pending);
});

async function openDialog() {
  const user = userEvent.setup();
  renderWithProviders(<VersionHistoryDialog projectLookup={projectLookup} />);
  await user.click(screen.getByRole('button', { name: 'Version history' }));
  return user;
}

describe('VersionHistoryDialog', () => {
  it('is closed by default and never fetches before being opened', () => {
    renderWithProviders(<VersionHistoryDialog projectLookup={projectLookup} />);
    expect(screen.queryByText('Scenario version history')).not.toBeInTheDocument();
  });

  it('opens to the version list, scoped copy never claims "every schedule run"', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    await openDialog();
    expect(screen.getByText('Scenario version history')).toBeInTheDocument();
    expect(screen.getByText(/not every schedule run/i)).toBeInTheDocument();
  });

  it('shows a loading skeleton while the version list is pending', async () => {
    hooks.useScenarioVersions.mockReturnValue(pending);
    await openDialog();
    expect(document.querySelector('[aria-busy="true"]')).toBeInTheDocument();
  });

  it('shows an error with retry when the version list fails to load', async () => {
    const refetch = vi.fn();
    hooks.useScenarioVersions.mockReturnValue(failed(new Error('boom'), refetch));
    const user = await openDialog();
    expect(screen.getByText('The scenario version history could not be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });

  it('shows an empty state when no scenarios have been applied yet', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready([]));
    await openDialog();
    expect(screen.getByText('No scenarios applied yet')).toBeInTheDocument();
  });

  it('lists every version with its applied-by / notes / change count, most-recent-first order as given by the API', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    await openDialog();
    const rows = screen.getAllByTestId('version-history-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('v5')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Q3 replan')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('2')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('v4')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('system')).toBeInTheDocument();
  });

  it('clicking "View diff" requests that version\'s detail and shows the diff view', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    hooks.useScenarioVersionDetail.mockReturnValue(ready(detail));
    const user = await openDialog();

    const rows = screen.getAllByTestId('version-history-row');
    await user.click(within(rows[0]!).getByRole('button', { name: 'View diff' }));

    expect(hooks.useScenarioVersionDetail).toHaveBeenLastCalledWith(5);
    expect(screen.getByText('Version 5')).toBeInTheDocument();
  });

  it('resolves a changed project via the passed-in lookup, and falls back to the raw id otherwise', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    hooks.useScenarioVersionDetail.mockReturnValue(ready(detail));
    const user = await openDialog();
    await user.click(within(screen.getAllByTestId('version-history-row')[0]!).getByRole('button', { name: 'View diff' }));

    expect(screen.getByText('Cooler A')).toBeInTheDocument();
    expect(screen.getByText('p2')).toBeInTheDocument(); // no lookup entry — raw id fallback
  });

  it('shows a field-level diff for a changed score, and a "New score" badge with no before-values for a first-time score', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    hooks.useScenarioVersionDetail.mockReturnValue(ready(detail));
    const user = await openDialog();
    await user.click(within(screen.getAllByTestId('version-history-row')[0]!).getByRole('button', { name: 'View diff' }));

    const changes = screen.getAllByTestId('version-detail-change');
    expect(changes).toHaveLength(2);
    expect(changes[0]!.textContent).toContain('Strategic Project: 3 → 5');
    expect(changes[0]!.textContent).toContain('Hard gates: none → Active safety non-compliance');
    expect(within(changes[1]!).getByText('New score')).toBeInTheDocument();
    expect(changes[1]!.textContent).toContain('Strategic Project: — → 4');
  });

  it('the back button returns from a version detail to the list', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    hooks.useScenarioVersionDetail.mockReturnValue(ready(detail));
    const user = await openDialog();
    await user.click(within(screen.getAllByTestId('version-history-row')[0]!).getByRole('button', { name: 'View diff' }));
    expect(screen.getByText('Version 5')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /All versions/ }));
    expect(screen.getByText('Scenario version history')).toBeInTheDocument();
  });

  it('shows a scope-appropriate 404 message with no retry affordance for an out-of-scope version', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    const refetch = vi.fn();
    hooks.useScenarioVersionDetail.mockReturnValue(failed(new ApiError(404, 'not found'), refetch));
    const user = await openDialog();
    await user.click(within(screen.getAllByTestId('version-history-row')[0]!).getByRole('button', { name: 'View diff' }));

    expect(screen.getByText('Version not available')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('shows a generic retryable error for a non-404 detail failure', async () => {
    hooks.useScenarioVersions.mockReturnValue(ready(runs));
    const refetch = vi.fn();
    hooks.useScenarioVersionDetail.mockReturnValue(failed(new ApiError(500, 'boom'), refetch));
    const user = await openDialog();
    await user.click(within(screen.getAllByTestId('version-history-row')[0]!).getByRole('button', { name: 'View diff' }));

    expect(screen.getByText('This version could not be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalled();
  });
});
