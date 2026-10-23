import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import { apiGet, apiSend } from '@/lib/api/client';
import {
  applyScenario,
  fetchMatrixCurrencies,
  fetchPriorityCompare,
  fetchPriorityDistribution,
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
    await fetchPriorityMatrix({ currency: 'USD', hubId: 'hub-1', category: ['A+', 'B'], type: ['NM', 'CO'] });
    expect(mockApiGet).toHaveBeenCalledWith('/priorities', {
      query: { currency: 'USD', hub_id: 'hub-1', category: ['A+', 'B'], type: ['NM', 'CO'] },
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
    // P26: a `scores` map (active keys only; null clears) + hard gates.
    const body: PriorityScoreUpdateRequest = {
      scores: { strategic_project: 3, sustainability_esg: 4, capex_investment: null },
      hard_gates: [],
    };
    mockApiSend.mockResolvedValueOnce({ id: 's1', project_id: 'p1', hard_gates: [], weighted_score: 840, normalized_pct: 60, suggested_band: 'P2', dimension_scores: [], missing_dimension_keys: [], rubric_version: 2 });
    await updatePriorityScore('p1', body);
    expect(mockApiSend).toHaveBeenCalledWith('PUT', '/priorities/p1', body);
  });

  it('POSTs the scenario diff to /scenarios/apply verbatim', async () => {
    const body: ScenarioApplyRequest = {
      notes: 'Q3 replan',
      priority_scores: [
        {
          project_id: 'p1',
          scores: { strategic_project: 5, capex_investment: null }, hard_gates: [],
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

  describe('P21', () => {
    it('reads GET /currency-rates and lists the six offered codes in order; a missing row is not configured', async () => {
      mockApiGet.mockResolvedValueOnce([
        { id: 'a', currency_code: 'EUR', name: 'Euro', rate_to_eur: 1, configured: true, updated_by_user_id: null, updated_at: '' },
        { id: 'b', currency_code: 'EGP', name: 'Egyptian pound', rate_to_eur: null, configured: false, updated_by_user_id: null, updated_at: '' },
      ]);
      const out = await fetchMatrixCurrencies();
      expect(mockApiGet).toHaveBeenCalledWith('/currency-rates', {});
      expect(out.map((c) => [c.currency_code, c.configured])).toEqual([
        ['EUR', true], ['USD', false], ['INR', false], ['EGP', false], ['ZAR', false], ['IDR', false],
      ]);
      expect(out[3]).toEqual({ currency_code: 'EGP', name: 'Egyptian pound', rate_to_eur: null, configured: false });
    });

    it('a pre-P21 row without name / configured gets the static name and configured = rate set', async () => {
      mockApiGet.mockResolvedValueOnce([
        { id: 'r', currency_code: 'USD', rate_to_eur: 1.08, updated_by_user_id: null, updated_at: '' },
      ]);
      const out = await fetchMatrixCurrencies();
      expect(out[1]).toEqual({ currency_code: 'USD', name: 'US dollar', rate_to_eur: 1.08, configured: true });
    });

    it('requests the distribution with the grid filters (no currency)', async () => {
      mockApiGet.mockResolvedValueOnce({ band_distribution: [], score_histogram: [] });
      await fetchPriorityDistribution({ hubId: 'h1', category: ['B'], status: 'In Queue' });
      expect(mockApiGet).toHaveBeenCalledWith('/priorities/distribution', {
        query: { hub_id: 'h1', region: undefined, category: ['B'], type: undefined, status_: 'In Queue', q: undefined },
      });
    });

    it('requests compare with one project_id per selected project, in order', async () => {
      mockApiGet.mockResolvedValueOnce({ projects: [] });
      await fetchPriorityCompare(['a', 'b']);
      expect(mockApiGet).toHaveBeenCalledWith('/priorities/compare?project_id=a&project_id=b', {});
    });
  });

  it('P26: GET /scoring-rubric, GET /scoring-rubric/versions, POST preview and PUT go to their paths verbatim', async () => {
    const { fetchScoringRubric, fetchScoringRubricVersions, previewScoringRubric, updateScoringRubric } = await import('./matrix-api');
    mockApiGet.mockResolvedValue({});
    mockApiSend.mockResolvedValue({});
    await fetchScoringRubric();
    expect(mockApiGet).toHaveBeenLastCalledWith('/scoring-rubric', {});
    await fetchScoringRubricVersions();
    expect(mockApiGet).toHaveBeenLastCalledWith('/scoring-rubric/versions', {});
    const dims = [{ key: 'strategic_project', label: 'Strategic Project', pillar: 'Strategic Alignment', weight: 30, inverted: false, active: true }];
    await previewScoringRubric({ dimensions: dims });
    expect(mockApiSend).toHaveBeenLastCalledWith('POST', '/scoring-rubric/preview', { dimensions: dims });
    await updateScoringRubric({ version: 4, reason: 'why', dimensions: dims });
    expect(mockApiSend).toHaveBeenLastCalledWith('PUT', '/scoring-rubric', { version: 4, reason: 'why', dimensions: dims });
  });
});
