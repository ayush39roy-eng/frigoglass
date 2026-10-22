import * as React from 'react';

/**
 * Holds the reader's place when `key` changes and the content above them
 * re-lays out (owner ask 2026-10-22: changing the hub filter must not throw the
 * Dashboard to a random line).
 *
 * The anchor is one of `containerRef`'s direct children: the one holding the
 * focused element (the filter the reader just used), else the first one still
 * visible at the top of the scroller. It is measured on the reader's last
 * pointer / key press, i.e. BEFORE the change renders: the commit that applies
 * the new filter can already shift the page (a filter chip appearing above). While the new data
 * lands it keeps that anchor at the same distance from the scroller's top, by
 * correcting the scroll offset whenever the container resizes. It lets go after
 * `settleMs`, or as soon as the reader scrolls themselves.
 */
export function useKeepScrollAnchor(
  containerRef: React.RefObject<HTMLElement | null>,
  key: string,
  settleMs = 4000,
): void {
  const first = React.useRef(true);
  const snapshot = React.useRef<{ anchor: HTMLElement; offset: number; at: number } | null>(null);

  React.useEffect(() => {
    const take = (): void => {
      const container = containerRef.current;
      if (!container) return;
      const found = pickAnchor(container);
      snapshot.current = found ? { ...found, at: Date.now() } : null;
    };
    window.addEventListener('pointerdown', take, { capture: true, passive: true });
    window.addEventListener('keydown', take, { capture: true, passive: true });
    return () => {
      window.removeEventListener('pointerdown', take, true);
      window.removeEventListener('keydown', take, true);
    };
  }, [containerRef]);

  React.useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      return undefined;
    }
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return undefined;

    const scroller = scrollParent(container);
    const viewTop = (): number => (scroller ? scroller.getBoundingClientRect().top : 0);
    const children = Array.from(container.children) as HTMLElement[];
    const snap = snapshot.current;
    const picked =
      snap && Date.now() - snap.at < SNAPSHOT_FRESH_MS && container.contains(snap.anchor) ? snap : pickAnchor(container);
    if (!picked) return undefined;
    const { anchor, offset } = picked;
    // The change may already have moved the anchor in this commit: put it back now.
    const scrollBy = (dy: number): void => {
      if (scroller) scroller.scrollTop += dy;
      else window.scrollBy(0, dy);
    };
    const correct = (): void => {
      const dy = anchor.getBoundingClientRect().top - viewTop() - offset;
      if (Math.abs(dy) >= 1) scrollBy(dy);
    };

    correct();
    const ro = new ResizeObserver(correct);
    ro.observe(container);
    for (const c of children) ro.observe(c);

    const release = (): void => {
      ro.disconnect();
      window.clearTimeout(timer);
      for (const ev of USER_SCROLL_EVENTS) window.removeEventListener(ev, release, true);
    };
    const timer = window.setTimeout(release, settleMs);
    for (const ev of USER_SCROLL_EVENTS) window.addEventListener(ev, release, { capture: true, passive: true });
    return release;
  }, [containerRef, key, settleMs]);
}

const USER_SCROLL_EVENTS = ['wheel', 'touchmove'] as const;
/** A press older than this did not cause the change (e.g. a filter set elsewhere). */
const SNAPSHOT_FRESH_MS = 10_000;

function pickAnchor(container: HTMLElement): { anchor: HTMLElement; offset: number } | null {
  const scroller = scrollParent(container);
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  const children = Array.from(container.children) as HTMLElement[];
  const active = document.activeElement;
  const anchor =
    children.find((c) => active instanceof Node && c.contains(active)) ??
    children.find((c) => c.getBoundingClientRect().bottom > top);
  return anchor ? { anchor, offset: anchor.getBoundingClientRect().top - top } : null;
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if ((overflowY === 'auto' || overflowY === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}
