import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiSend: (...a: unknown[]) => send(...a) };
});

import { isToRankPlacement, moveProjectBandRank, previewProjectBandRank } from './priority-move';

/** Owner request 2026-11-17: `{ to_rank }` is an alternative body; it never carries anchor keys (422 if combined). */
describe('band-rank request bodies', () => {
  beforeEach(() => {
    send.mockReset();
    send.mockResolvedValue({});
  });

  it('to_rank: preview and confirm send only to_rank (plus the token)', async () => {
    await previewProjectBandRank('p 1', { to_rank: 4 });
    expect(send).toHaveBeenCalledWith('POST', '/projects/p%201/band-rank/preview', { to_rank: 4 }, { signal: undefined });
    await moveProjectBandRank('p1', { to_rank: 4 }, 'tok');
    expect(send).toHaveBeenLastCalledWith('POST', '/projects/p1/band-rank', { to_rank: 4, preview_token: 'tok' });
  });

  it('anchors: unchanged wire shape', async () => {
    await previewProjectBandRank('p1', { before_project_id: 'b', after_project_id: null });
    expect(send).toHaveBeenCalledWith('POST', '/projects/p1/band-rank/preview', { before_project_id: 'b', after_project_id: null }, { signal: undefined });
    await moveProjectBandRank('p1', { before_project_id: null, after_project_id: 'a' }, 'tok');
    expect(send).toHaveBeenLastCalledWith('POST', '/projects/p1/band-rank', { before_project_id: null, after_project_id: 'a', preview_token: 'tok' });
  });

  it('isToRankPlacement tells the two forms apart', () => {
    expect(isToRankPlacement({ to_rank: 1 })).toBe(true);
    expect(isToRankPlacement({ before_project_id: null, after_project_id: null })).toBe(false);
  });
});
