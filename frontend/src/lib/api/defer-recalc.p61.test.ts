import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRecalcModeStore } from '@/stores/recalc-mode';
import { saveRegisterEdits } from '@/surfaces/projects/api/register-edits';

import { apiSend } from './client';
import { isDeferrableWrite } from './defer-recalc';

/** P61 (ADR 0069): with Auto-recalculate Off, plan writes carry `defer_recalc: true`. */

function okFetch() {
  const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
    Promise.resolve(
      new Response(JSON.stringify({ project_ids: [], recalc_status: 'deferred' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function sentBody(fetchMock: ReturnType<typeof okFetch>): unknown {
  const init = fetchMock.mock.calls[0]?.[1];
  return JSON.parse(String(init?.body));
}

beforeEach(() => {
  useRecalcModeStore.setState({ manualUsers: {}, activeEmail: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('defer_recalc (ADR 0069)', () => {
  it('switch Off: the register save body carries defer_recalc: true', async () => {
    const fetchMock = okFetch();
    useRecalcModeStore.getState().setAutoRecalc(false);
    await saveRegisterEdits({ edits: [{ project_id: 'a', status: 'On Hold' }] });
    expect(sentBody(fetchMock)).toEqual({ edits: [{ project_id: 'a', status: 'On Hold' }], defer_recalc: true });
  });

  it('switch On (default): the body is sent untouched', async () => {
    const fetchMock = okFetch();
    await saveRegisterEdits({ edits: [{ project_id: 'a', status: 'On Hold' }] });
    expect(sentBody(fetchMock)).toEqual({ edits: [{ project_id: 'a', status: 'On Hold' }] });
  });

  it('switch Off: a write the backend does not accept the flag on is untouched', async () => {
    const fetchMock = okFetch();
    useRecalcModeStore.getState().setAutoRecalc(false);
    await apiSend('POST', '/projects/p1/comments', { body_md: 'x' });
    expect(sentBody(fetchMock)).toEqual({ body_md: 'x' });
  });

  it('the switch is per user', () => {
    const store = useRecalcModeStore.getState();
    store.setActiveEmail('a@example.com');
    useRecalcModeStore.getState().setAutoRecalc(false);
    useRecalcModeStore.getState().setActiveEmail('b@example.com');
    expect(useRecalcModeStore.getState().manualUsers).toEqual({ 'a@example.com': true });
  });

  it('covers the plan writes only', () => {
    expect(isDeferrableWrite('PATCH', '/projects/abc')).toBe(true);
    expect(isDeferrableWrite('POST', '/projects/abc/priority/preview')).toBe(true);
    expect(isDeferrableWrite('POST', '/projects/abc/band-rank')).toBe(true);
    expect(isDeferrableWrite('PATCH', '/projects/abc/stages/s1')).toBe(true);
    expect(isDeferrableWrite('PATCH', '/projects/register-edits')).toBe(false);
    expect(isDeferrableWrite('POST', '/projects')).toBe(false);
    expect(isDeferrableWrite('PATCH', '/projects/abc/files/f1')).toBe(false);
  });
});
