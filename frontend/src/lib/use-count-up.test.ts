import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useCountUp } from './use-count-up';

describe('useCountUp', () => {
  const originalMatchMedia = window.matchMedia;

  afterEach(() => {
    vi.useRealTimers();
    window.matchMedia = originalMatchMedia;
  });

  it('shows the exact real value on first render — no count-up from zero on mount', () => {
    const { result } = renderHook(() => useCountUp(42));
    // Synchronous, no timers advanced: a test that asserts the number
    // immediately after render (the existing StatCard/WithinYearPanel tests)
    // must see it without waiting for any animation frame.
    expect(result.current).toBe(42);
  });

  it('animates toward a new value when the value changes, and settles exactly on it', () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ value }) => useCountUp(value, 200), {
      initialProps: { value: 0 },
    });
    expect(result.current).toBe(0);

    rerender({ value: 100 });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(result.current).toBe(100);
  });

  it('jumps straight to the new value with no animation under prefers-reduced-motion', () => {
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList) as typeof window.matchMedia;

    const { result, rerender } = renderHook(({ value }) => useCountUp(value, 5_000), {
      initialProps: { value: 0 },
    });
    rerender({ value: 100 });
    // No `act(() => vi.advanceTimersByTime(...))` needed — reduced motion sets
    // the value synchronously inside the effect, before this assertion runs.
    expect(result.current).toBe(100);
  });
});
