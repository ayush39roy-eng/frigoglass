import * as React from 'react';

/**
 * "Has this element been scrolled into view yet?" — latching true the first time
 * and never going back, so a chart draws itself once as the reader reaches it
 * rather than animating every time it scrolls past (`lib/motion.ts`'s
 * NEVER_ANIMATE list: "anything that can fire more than once per user
 * interaction").
 *
 * Deliberately NOT framer-motion's `useInView`. Two reasons:
 *  - framer's version calls `IntersectionObserver` unguarded. jsdom does not
 *    implement it and this project's `src/test/setup.ts` only polyfills
 *    `ResizeObserver`, so every test that mounted the chart would throw. The
 *    guard below degrades to "revealed immediately", which is also the correct
 *    behaviour for any environment that cannot observe scrolling at all.
 *  - It keeps the reveal gate out of the always-loaded motion surface area;
 *    this is ~20 lines of platform API, not a reason to widen a dependency.
 *
 * Returns `[ref, revealed]`. Attach the ref to the element whose entry should
 * trigger the reveal.
 */
export function useRevealOnce<T extends HTMLElement>(
  margin = '-60px',
): [React.RefObject<T | null>, boolean] {
  const ref = React.useRef<T>(null);
  const [revealed, setRevealed] = React.useState(
    () => typeof IntersectionObserver === 'undefined',
  );

  React.useEffect(() => {
    if (revealed) return;
    const node = ref.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setRevealed(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setRevealed(true);
          observer.disconnect();
        }
      },
      { rootMargin: margin },
    );
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, [revealed, margin]);

  return [ref, revealed];
}
