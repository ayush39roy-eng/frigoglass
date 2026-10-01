import { afterEach, describe, expect, it, vi } from 'vitest';

import { setDevUserEmail } from '@/lib/api/dev-user';

import { saveLeadTimes } from './workflow-settings-api';

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
    const result = await saveLeadTimes({ lead_times: [] });
    expect(result.staleCount).toBe(187);
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/workflow-settings\/lead-times$/);
    expect((init as RequestInit).method).toBe('PUT');
  });

  it('sends X-Dev-User-Email only when a dev user has been selected', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    fetchSpy.mockClear();
    await saveLeadTimes({ lead_times: [] });
    const headersOf = (i: number) =>
      (fetchSpy.mock.calls[i]![1] as RequestInit).headers as Record<string, string>;
    expect(headersOf(0)['X-Dev-User-Email']).toBeUndefined();
    setDevUserEmail('ellie.exec@example.com');
    await saveLeadTimes({ lead_times: [] });
    expect(headersOf(1)).toEqual(expect.objectContaining({ 'X-Dev-User-Email': 'ellie.exec@example.com' }));
  });

  it('carries the error envelope code onto ApiError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ detail: 'cycle', code: 'CYCLE' }), { status: 422 }),
    );
    await expect(saveLeadTimes({ lead_times: [] })).rejects.toMatchObject({ status: 422, code: 'CYCLE', detail: 'cycle' });
  });
});
