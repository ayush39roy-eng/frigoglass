import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';

import { EDIT_POLL_MS, editFreshness } from '@/lib/use-edit-freshness';

import { useAnyEditInProgress, useEditSession } from './edit-session';

describe('edit session + freshness (ADR 0059 C2)', () => {
  it('idle: focus refetch and a 60 s poll; editing: both off', () => {
    expect(editFreshness(false)).toEqual({
      refetchOnWindowFocus: true,
      refetchInterval: EDIT_POLL_MS,
      refetchIntervalInBackground: false,
    });
    expect(EDIT_POLL_MS).toBe(60_000);
    expect(editFreshness(true)).toMatchObject({ refetchOnWindowFocus: false, refetchInterval: false });
  });

  it('an open editor pauses every editable query until it closes or unmounts', () => {
    const watcher = renderHook(() => useAnyEditInProgress());
    expect(watcher.result.current).toBe(false);
    const editor = renderHook(({ active }) => useEditSession(active), { initialProps: { active: true } });
    watcher.rerender();
    expect(watcher.result.current).toBe(true);
    editor.rerender({ active: false });
    watcher.rerender();
    expect(watcher.result.current).toBe(false);
    editor.rerender({ active: true });
    editor.unmount();
    watcher.rerender();
    expect(watcher.result.current).toBe(false);
  });
});
