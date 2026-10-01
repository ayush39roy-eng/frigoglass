import * as React from 'react';

import { usePrefersReducedMotion } from './use-prefers-reduced-motion';

/**
 * Animates the DISPLAYED transition between two values of an already-known
 * number. It never computes, estimates or independently derives anything — the
 * number it ends on is always exactly the `value` prop it was given (Invariant
 * I9 / CLAUDE.md "no independent calculation, including in the frontend"); this
 * is presentation easing of an already-correct figure, the same category as the
 * CSS `width` transition `BarChart` already uses for its bar fills.
 *
 * Deliberately does NOT animate from 0 on first mount. `lib/motion.ts`'s own
 * rule is "motion exists to make a STATE CHANGE legible, not decoration" — a
 * KPI counting up from zero on every page load is decoration (the number never
 * changed; the page did). Animating only when `value` changes on a value the
 * user is already looking at (a schedule re-run bumping the within-year count,
 * a filter narrowing a total) is the legible case, and it is also what keeps
 * this component test-safe: the very first render always shows the exact real
 * value synchronously, so a test that renders once and asserts the number
 * immediately (no `waitFor`) sees the same thing with or without this hook.
 *
 * Gated by `prefers-reduced-motion` — reduced jumps straight to the new value.
 */
export function useCountUp(value: number, durationMs = 600): number {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = React.useState(value);
  const fromRef = React.useRef(value);

  React.useEffect(() => {
    const from = fromRef.current;
    if (from === value || reduced) {
      setDisplay(value);
      fromRef.current = value;
      return;
    }

    let raf = 0;
    const start = performance.now();

    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - (1 - t) ** 3; // ease-out-cubic
      setDisplay(Math.round(from + (value - from) * eased));
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = value;
      }
    };

    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value, durationMs, reduced]);

  return display;
}
