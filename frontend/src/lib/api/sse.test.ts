import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseSseFrames, streamSolverProgress } from './sse';

afterEach(() => vi.restoreAllMocks());

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

describe('parseSseFrames', () => {
  it('parses data frames, skips heartbeat comments, keeps a partial tail', () => {
    const { events, rest } = parseSseFrames(': heartbeat\n\ndata: {"schedule_run_id":"r","status":"running","percent":40}\n\ndata: {"sta');
    expect(events).toEqual([{ schedule_run_id: 'r', status: 'running', percent: 40 }]);
    expect(rest).toBe('data: {"sta');
  });
});

describe('streamSolverProgress (fetch-streamed, never EventSource)', () => {
  it('relays events across chunk boundaries and stops at the terminal status', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    fetchSpy.mockClear();
    fetchSpy.mockResolvedValue(
      new Response(
        streamOf([
          'data: {"schedule_run_id":"r","status":"queued"}\n\n: heartbeat\n\ndata: {"schedule_run_id":"r","sta',
          'tus":"running","percent":50}\n\ndata: {"schedule_run_id":"r","status":"completed"}\n\n',
        ]),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      ),
    );
    const seen: string[] = [];
    const terminal = await streamSolverProgress('r', (e) => seen.push(e.status));
    expect(seen).toEqual(['queued', 'running', 'completed']);
    expect(terminal?.status).toBe('completed');
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toMatch(/\/schedule-runs\/r\/progress$/);
    expect((init as RequestInit).headers).toEqual(expect.objectContaining({ Accept: 'text/event-stream' }));
  });

  it('rejects with ApiError on a non-2xx', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"detail":"nope"}', { status: 403 }));
    await expect(streamSolverProgress('r', () => undefined)).rejects.toMatchObject({ status: 403 });
  });
});
