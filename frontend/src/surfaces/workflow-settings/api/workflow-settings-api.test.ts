import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDevUserEmail } from '@/lib/api/dev-user';

import {
  applyTemplate,
  createCategory,
  fetchBEquivalent,
  fetchCategoryTimelines,
  previewApply,
  previewTimeline,
  saveHubCalendar,
} from './workflow-settings-api';

const CAL = { weekdays_per_week: 5, national_holiday_days: 12, medical_leave_days: 0, casual_leave_days: 0, annual_leave_days: 25 };

afterEach(() => {
  setDevUserEmail(null);
  vi.restoreAllMocks();
});

describe('workflow-settings API (contract §3)', () => {
  it('reads X-Schedule-Stale-Count from a successful PUT, verbatim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ workflows: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Schedule-Stale-Count': '187' },
      }),
    );
    fetchSpy.mockClear();
    const result = await saveHubCalendar('hub-gr', CAL);
    expect(result.staleCount).toBe(187);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/workflow-settings\/hub-calendars\/hub-gr$/);
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('sends X-Dev-User-Email only when a dev user has been selected', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    fetchSpy.mockClear();
    await saveHubCalendar('hub-gr', CAL);
    const headersOf = (i: number) =>
      (fetchSpy.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
    expect(headersOf(0)['X-Dev-User-Email']).toBeUndefined();
    setDevUserEmail('ellie.exec@example.com');
    await saveHubCalendar('hub-gr', CAL);
    expect(headersOf(1)).toEqual(expect.objectContaining({ 'X-Dev-User-Email': 'ellie.exec@example.com' }));
  });

  it('carries the error envelope code onto ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'cycle', code: 'CYCLE' }), { status: 422 }),
    );
    await expect(saveHubCalendar('hub-gr', CAL)).rejects.toMatchObject({ status: 422, code: 'CYCLE', detail: 'cycle' });
  });
});

describe('workflow-settings previews (P13-T16, contract §5)', () => {
  it('GETs category-timelines and b-equivalent with the workflow param', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    fetchSpy.mockClear();
    await fetchCategoryTimelines('OEM');
    await fetchBEquivalent('PDD');
    expect(String(fetchSpy.mock.calls[0]![0])).toMatch(/\/workflow-settings\/category-timelines\?workflow=OEM$/);
    expect(String(fetchSpy.mock.calls[1]![0])).toMatch(/\/workflow-settings\/b-equivalent\?workflow=PDD$/);
  });
});

describe('workflow templates API (P33 B2, D, E2, E3)', () => {
  it('POSTs each P33 body verbatim to its endpoint', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    fetchSpy.mockClear();
    const change = { workflow_id: 'PDD' as const, category: 'A', base_version: 3, steps: [{ step_id: 'PDD-E', weeks: 7 }] };
    await previewTimeline({ workflow_id: 'PDD', category: 'A', steps: [{ step_id: 'PDD-E', gap_weeks: -2 }] });
    await previewApply({ changes: [change] });
    await applyTemplate({ changes: [change], selection: { mode: 'none', project_ids: [] } });
    await createCategory({ code: 'B2', label: null, workflow_id: 'PDD', copy_from: 'B', insert_after: 'B' });
    const calls = fetchSpy.mock.calls.map(([url, init]) => [String(url).replace(/^.*\/\/[^/]+/, ''), (init as RequestInit).method, (init as RequestInit).body]);
    expect(calls).toEqual([
      ['/workflow-templates/timeline-preview', 'POST', JSON.stringify({ workflow_id: 'PDD', category: 'A', steps: [{ step_id: 'PDD-E', gap_weeks: -2 }] })],
      ['/workflow-templates/apply-preview', 'POST', JSON.stringify({ changes: [change] })],
      // Manual recalculation (2026-11-24): apply is a plan write, so it always defers.
      ['/workflow-templates/apply', 'POST', JSON.stringify({ changes: [change], selection: { mode: 'none', project_ids: [] }, defer_recalc: true })],
      ['/workflow-templates/categories', 'POST', JSON.stringify({ code: 'B2', label: null, workflow_id: 'PDD', copy_from: 'B', insert_after: 'B' })],
    ]);
  });
});
