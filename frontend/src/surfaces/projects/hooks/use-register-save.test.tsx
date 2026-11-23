import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';

const api = vi.hoisted(() => ({ save: vi.fn() }));
vi.mock('../api/register-edits', async () => {
  const actual = await vi.importActual<typeof import('../api/register-edits')>('../api/register-edits');
  return { ...actual, saveRegisterEdits: (body: unknown) => api.save(body) };
});

import { ApiError } from '@/lib/api/client';
import { REGISTER_SAVE_COPY, refusedResult, useRegisterSave } from './use-register-save';

/**
 * Owner 2026-11-23: "I change the status but it is still not updated", and a
 * failed save showed "The edits could not be saved. Nothing was changed." for a
 * server error without a readable body. The register list reads a `dashboard`
 * key with the default 30 s staleTime: a Save must re-read it at once.
 */

let stored = 'In Development';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(
    () => ({
      list: useQuery({ queryKey: ['dashboard', 'projects', null], queryFn: () => Promise.resolve({ status: stored }) }),
      board: useQuery({ queryKey: ['priority-board', 'x'], queryFn: () => Promise.resolve({ status: stored }) }),
      reg: useRegisterSave(),
    }),
    { wrapper },
  );
}

const EDIT = { edits: [{ project_id: 'a', status: 'On Hold' as const, base: { status: 'In Development' } }] };

beforeEach(() => {
  vi.clearAllMocks();
  stored = 'In Development';
});

describe('useRegisterSave', () => {
  it('a saved status shows in the register row and the board without a reload', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.list.data?.status).toBe('In Development'));
    api.save.mockImplementation(() => {
      stored = 'On Hold';
      return Promise.resolve({
        project_ids: ['a'], projects_marked_stale: ['a'], recalc_status: 'not_needed',
        schedule_run_id: null, baseline_run_id: null, task_id: null, eff_changes: [],
      });
    });
    let res: Awaited<ReturnType<typeof result.current.reg.save>> | undefined;
    await act(async () => {
      res = await result.current.reg.save(EDIT);
    });
    expect(res?.ok).toBe(true);
    await waitFor(() => expect(result.current.list.data?.status).toBe('On Hold'));
    await waitFor(() => expect(result.current.board.data?.status).toBe('On Hold'));
  });

  it('a 502 with no readable body says the save was not confirmed and re-reads the stored values', async () => {
    const { result } = setup();
    await waitFor(() => expect(result.current.list.data?.status).toBe('In Development'));
    api.save.mockImplementation(() => {
      stored = 'In Queue'; // the server committed before the gateway failed
      return Promise.reject(new ApiError(502, 'Request failed (502 Bad Gateway)'));
    });
    let res: Awaited<ReturnType<typeof result.current.reg.save>> | undefined;
    await act(async () => {
      res = await result.current.reg.save(EDIT);
    });
    expect(res?.ok).toBe(false);
    expect(res?.message).toBe(REGISTER_SAVE_COPY.serverError(502));
    expect(res?.message).not.toContain('Nothing was changed');
    await waitFor(() => expect(result.current.list.data?.status).toBe('In Queue'));
  });

  it('a network failure and a coded refusal keep their own wording', () => {
    expect(refusedResult(new ApiError(0, 'Network request failed')).message).toBe(REGISTER_SAVE_COPY.unreachable);
    expect(refusedResult(new ApiError(500, 'x', 'Database is busy')).message).toBe('Database is busy');
    expect(refusedResult(new TypeError('boom')).message).toBe(REGISTER_SAVE_COPY.fallback);
  });
});
