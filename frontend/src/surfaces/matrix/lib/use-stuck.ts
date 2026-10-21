import * as React from 'react';

/** Nearest scrolling ancestor (overflow-y auto/scroll), or null for the window. */
export function scrollParentOf(el: HTMLElement | null): HTMLElement | null {
  let node = el?.parentElement ?? null;
  while (node) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

/**
 * P21: true while a `position: sticky` element is stuck. `sentinelRef` is a
 * zero-height marker placed right before the sticky element: once it has
 * scrolled above the scroll container's top edge, the element is stuck.
 * Listens to the nearest scroll container (the app shell's surface region).
 */
export function useStuck(sentinelRef: React.RefObject<HTMLElement | null>): boolean {
  const [stuck, setStuck] = React.useState(false);

  React.useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return undefined;
    const parent = scrollParentOf(sentinel);
    const target: HTMLElement | Window = parent ?? window;
    let frame = 0;

    const measure = () => {
      frame = 0;
      const top = parent ? parent.getBoundingClientRect().top : 0;
      setStuck(sentinel.getBoundingClientRect().top < top);
    };
    const onScroll = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    target.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      target.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [sentinelRef]);

  return stuck;
}

/**
 * P21: the grid's max height so that, once scrolled to, the whole grid (and
 * its sticky header) sits below the stuck View panel: the scroll region's
 * height minus the stuck panel's height and the page chrome below the grid.
 * Layout only; no data.
 */
export function useGridMaxHeight(
  sentinelRef: React.RefObject<HTMLElement | null>,
  panelRef: React.RefObject<HTMLElement | null>,
  stuck: boolean,
  reserveBelow: number,
): string {
  const [scrollportH, setScrollportH] = React.useState<number | null>(null);
  const [panelH, setPanelH] = React.useState(64);

  React.useEffect(() => {
    const parent = scrollParentOf(sentinelRef.current);
    const read = () => setScrollportH(parent ? parent.clientHeight : window.innerHeight);
    read();
    if (!parent || typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', read);
      return () => window.removeEventListener('resize', read);
    }
    const ro = new ResizeObserver(read);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [sentinelRef]);

  React.useEffect(() => {
    const panel = panelRef.current;
    if (!stuck || !panel) return undefined;
    const read = () => setPanelH(panel.offsetHeight);
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(panel);
    return () => ro.disconnect();
  }, [panelRef, stuck]);

  if (scrollportH === null || scrollportH === 0) return '560px';
  return `${String(Math.max(320, scrollportH - panelH - reserveBelow))}px`;
}
