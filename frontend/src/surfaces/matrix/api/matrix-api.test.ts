import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import { apiGet, apiSend } from '@/lib/api/client';
import {
  applyScenario,
  fetchPriorityMatrix,
  fetchPrioritySummary,
  fetchScenarioVersionDetail,
  fetchScenarioVersions,
  updatePriorityScore,
} from './matrix-api';
import type { PriorityScoreUpdateRequest, ScenarioApplyRequest } from './types';

const mockApiGet = vi.mocked(apiGet);
const mockApiSend = vi.mocked(apiSend);

afterEach(() => vi.clearAllMocks());

describe('matrix-api', () => {
  it('sends the currency (and optional filters) as query params — the toggle only changes this', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchPriorityMatrix({ currency: 'USD', hubId: 'hub-1', category: 'A+' });
    expect(mockApiGet).toHaveBeenCalledWith('/priorities', {
      query: { currency: 'USD', hub_id: 'hub-1', category: 'A+' },
    });
  });

  it('defaults hub/category to undefined (dropped by the client) and still passes currency', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchPriorityMatrix({ currency: 'EUR' });
    expect(mockApiGet).toHaveBeenCalledWith('/priorities', {
      query: { currency: 'EUR', hub_id: undefined, category: undefined },
    });
  });

  it('requests the summary endpoint verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({
      total_projects: 0,
      scored_projects: 0,
      unscored_projects: 0,
      hard_gate_forced_count: 0,
      suggested_band_counts: {},
      set_priority_counts: {},
    });
    await fetchPrioritySummary();
    expect(mockApiGet).toHaveBeenCalledWith('/priorities/summary', {});
  });

  it('PUTs the score body to /priorities/{id} without extra keys', async () => {
    const body: PriorityScoreUpdateRequest = {
      strategic_project: 3,
      new_customer: 3,
      new_options: 3,
      regulatory_compliance: 3,
      quality_improvements: 3,
      rm_savings: 3,
      total_rm_savings: 3,
      gross_margins: 3,
      profitability: 3,
      annual_volume: 3,
      three_year_volume: 3,
      new_models: 3,
      capex_investment: 3,
      hard_gates: [],
    };
    mockApiSend.mockResolvedValueOnce({ ...body, id: 's1', project_id: 'p1', weighted_score: 840, normalized_pct: 60, suggested_band: 'P2' });
    await updatePriorityScore('p1', body);
    expect(mockApiSend).toHaveBeenCalledWith('PUT', '/priorities/p1', body);
  });

  it('POSTs the scenario diff to /scenarios/apply verbatim', async () => {
    const body: ScenarioApplyRequest = {
      notes: 'Q3 replan',
      priority_scores: [
        {
          project_id: 'p1',
          strategic_project: 5, new_customer: 3, new_options: 3, regulatory_compliance: 3,
          quality_improvements: 3, rm_savings: 3, total_rm_savings: 3, gross_margins: 3,
          profitability: 3, annual_volume: 3, three_year_volume: 3, new_models: 3,
          capex_investment: 3, hard_gates: [],
        },
      ],
    };
    mockApiSend.mockResolvedValueOnce({
      run: {
        id: 'r1', version: 4, applied_by_user_id: 'u1', notes: 'Q3 replan',
        entity_types_touched: ['PRIORITY_SCORE'], change_count: 1, created_at: '2026-09-01T00:00:00Z',
      },
      updated_priority_scores: ['s1'],
      suggested_bands: { p1: 'P1' },
    });
    await applyScenario(body);
    expect(mockApiSend).toHaveBeenCalledWith('POST', '/scenarios/apply', body);
  });

  it('requests the scenario versions list verbatim (P5-T03)', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchScenarioVersions();
    expect(mockApiGet).toHaveBeenCalledWith('/scenarios/versions', {});
  });

  it("requests one version's detail by its numeric version, not its uuid id (P5-T03)", async () => {
    mockApiGet.mockResolvedValueOnce({
      id: 'r1', version: 4, applied_by_user_id: 'u1', notes: null,
      entity_types_touched: ['priority_score'], change_count: 1, created_at: '2026-09-01T00:00:00Z',
      changes: [],
    });
    await fetchScenarioVersionDetail(4);
    expect(mockApiGet).toHaveBeenCalledWith('/scenarios/versions/4', {});
  });
});
