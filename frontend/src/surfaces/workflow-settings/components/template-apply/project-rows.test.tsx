import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';

import { ProjectRows, VIRTUALIZE_OVER } from './project-rows';

/**
 * P33-R02: the apply dialog's project lists scroll (`max-h-72`) and their rows
 * hold no focusable content, so the scroll container itself must take focus
 * (axe `scrollable-region-focusable`, serious). The P33-T20 gate caught it on
 * real data; the page-level fixtures had 1–2 rows and never overflowed.
 *
 * jsdom has no layout and no Tailwind CSS: `scrollHeight` / `clientHeight` are 0
 * and `overflow-y` is `visible`, so axe would skip the rule. `layOut` gives the
 * list the geometry a browser computes for 30+ rows in 288 px.
 */

type Row = { id: string; name: string };

function rowsOf(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({ id: `p-${String(i + 1)}`, name: `Project ${String(i + 1)}` }));
}

function renderList(n: number, label = 'Projects updated automatically') {
  const rows = rowsOf(n);
  const ui = (
    <main>
      <ProjectRows rows={rows} rowKey={(r) => r.id} renderRow={(r) => <span>{r.name}</span>} label={label} testId="apply-rows" />
    </main>
  );
  const view = render(ui);
  // The virtual scroll element's ref attaches after the virtualizer's first layout
  // effect; the dialog always re-renders (query + selection state), so do the same.
  view.rerender(ui);
  return view;
}

const VIEW_H = 288; // max-h-72
const VIEW_W = 640;
const ROW_H = 40;

function rect(top: number, height: number, width = VIEW_W): DOMRect {
  return { top, bottom: top + height, left: 0, right: width, width, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
}

function isScroller(el: Element): boolean {
  return el.getAttribute('data-testid') === 'apply-rows';
}

/** A row's top inside the list: its virtual index if it has one, else its sibling position. */
function rowTop(li: Element): number {
  const idx = li.getAttribute('data-index');
  const i = idx === null ? Array.from(li.parentElement?.children ?? []).indexOf(li) : Number(idx);
  return i * ROW_H;
}

/**
 * Lay the list out as a browser would at `max-h-72`: the scroll container is a
 * 288 px window over rows of 40 px, so rows past the 7th sit below its bottom.
 * This is what makes axe evaluate `scrollable-region-focusable` (it needs
 * `scrollHeight > clientHeight`, a scrollable `overflow-y`, and content outside
 * the container's rect), and what lets TanStack Virtual mount a window of rows.
 */
function layOut(rowCount: number): void {
  const contentH = rowCount * ROW_H;
  const geom = (el: Element, scroller: number, li: number, other: number): number =>
    isScroller(el) ? scroller : el.tagName === 'LI' ? li : other;
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return geom(this, VIEW_H, ROW_H, 0);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return geom(this, VIEW_W, VIEW_W, 0);
  });
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
    return geom(this, VIEW_H, ROW_H, 0);
  });
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockImplementation(function (this: Element) {
    return geom(this, VIEW_W, VIEW_W, 0);
  });
  vi.spyOn(Element.prototype, 'scrollHeight', 'get').mockImplementation(function (this: Element) {
    return geom(this, contentH, ROW_H, 0);
  });
  vi.spyOn(Element.prototype, 'scrollWidth', 'get').mockImplementation(function (this: Element) {
    return geom(this, VIEW_W, VIEW_W, 0);
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (isScroller(this)) return rect(0, VIEW_H);
    const li = this.closest('li');
    return li === null ? rect(0, 0, 0) : rect(rowTop(li), ROW_H);
  });
  // jsdom has no Range#getClientRects; axe uses it for elements with text children.
  Range.prototype.getClientRects = function (this: Range) {
    const start = this.startContainer;
    const el = start instanceof Element ? start : start.parentElement;
    const li = el?.closest('li') ?? null;
    const r = li === null ? rect(0, 0, 0) : rect(rowTop(li), ROW_H);
    return Object.assign([r], { item: (i: number) => (i === 0 ? r : null) }) as unknown as DOMRectList;
  };
}

/** Tailwind is not loaded in jsdom: give the container the `overflow-y: auto` its class sets. */
function scrollable(el: HTMLElement): HTMLElement {
  el.style.overflowY = 'auto';
  return el;
}

const FOCUS_RING = ['focus-visible:ring-2', 'focus-visible:ring-ring'];

const originalGetClientRects = Object.getOwnPropertyDescriptor(Range.prototype, 'getClientRects');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalGetClientRects === undefined) {
    delete (Range.prototype as { getClientRects?: unknown }).getClientRects;
  } else {
    Object.defineProperty(Range.prototype, 'getClientRects', originalGetClientRects);
  }
});

describe('ProjectRows — plain list (≤ 100 rows)', () => {
  it('renders every row in a keyboard-focusable, labelled list with a focus ring', () => {
    renderList(30);
    const list = screen.getByRole('list', { name: 'Projects updated automatically' });
    expect(list.tagName).toBe('UL');
    expect(list).toHaveAttribute('data-testid', 'apply-rows');
    expect(list).toHaveAttribute('tabindex', '0');
    expect(list).not.toHaveAttribute('data-virtualized');
    for (const cls of [...FOCUS_RING, 'max-h-72', 'overflow-y-auto']) expect(list).toHaveClass(cls);
    expect(within(list).getAllByRole('listitem')).toHaveLength(30);
    expect(within(list).getByText('Project 30')).toBeInTheDocument();
  });

  it('is reachable with Tab, so a keyboard user can scroll it', async () => {
    renderList(30);
    await userEvent.tab();
    expect(screen.getByRole('list', { name: 'Projects updated automatically' })).toHaveFocus();
  });

  it('has no serious axe violations when 30 rows overflow the list', async () => {
    layOut(30);
    const { container } = renderList(30);
    scrollable(screen.getByRole('list', { name: 'Projects updated automatically' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('control: the same overflowing list without tabIndex fails scrollable-region-focusable', async () => {
    // Proves the overflow set-up above really makes axe evaluate the rule.
    layOut(30);
    const { container } = renderList(30);
    const list = scrollable(screen.getByRole('list', { name: 'Projects updated automatically' }));
    list.removeAttribute('tabindex');
    const violations = await seriousAxeViolations(container);
    expect(violations.some((v) => v.startsWith('scrollable-region-focusable'))).toBe(true);
  });

  it('renders exactly 100 rows without virtualizing', () => {
    renderList(VIRTUALIZE_OVER);
    const list = screen.getByRole('list', { name: 'Projects updated automatically' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(VIRTUALIZE_OVER);
    expect(document.querySelector('[data-virtualized]')).toBeNull();
  });
});

describe('ProjectRows — virtualized (> 100 rows)', () => {
  it('mounts only a window of rows in a focusable, labelled region with a focus ring', async () => {
    layOut(240);
    renderList(240, 'Projects not changed');
    const region = screen.getByRole('region', { name: 'Projects not changed' });
    expect(region).toHaveAttribute('data-virtualized', 'true');
    expect(region).toHaveAttribute('data-testid', 'apply-rows');
    expect(region).toHaveAttribute('tabindex', '0');
    for (const cls of [...FOCUS_RING, 'max-h-72', 'overflow-y-auto']) expect(region).toHaveClass(cls);

    const list = within(region).getByRole('list', { name: 'Projects not changed' });
    const items = await within(list).findAllByRole('listitem');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThan(VIRTUALIZE_OVER);
    expect(items[0]).toHaveTextContent('Project 1');
    expect(items[0]).toHaveAttribute('aria-setsize', '240');
    expect(items[0]).toHaveAttribute('aria-posinset', '1');
    expect(within(list).queryByText('Project 240')).toBeNull();
  });

  it('is reachable with Tab', async () => {
    renderList(240, 'Projects not changed');
    await userEvent.tab();
    expect(screen.getByRole('region', { name: 'Projects not changed' })).toHaveFocus();
  });

  it('has no serious axe violations when the 240-row region overflows', async () => {
    layOut(240);
    const { container } = renderList(240, 'Projects not changed');
    const region = scrollable(screen.getByRole('region', { name: 'Projects not changed' }));
    await within(region).findAllByRole('listitem');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('control: the overflowing region without tabIndex fails scrollable-region-focusable', async () => {
    layOut(240);
    const { container } = renderList(240, 'Projects not changed');
    const region = scrollable(screen.getByRole('region', { name: 'Projects not changed' }));
    await within(region).findAllByRole('listitem');
    region.removeAttribute('tabindex');
    const violations = await seriousAxeViolations(container);
    expect(violations.some((v) => v.startsWith('scrollable-region-focusable'))).toBe(true);
  });
});
