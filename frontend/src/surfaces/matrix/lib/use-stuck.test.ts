import { describe, expect, it } from 'vitest';

import { inFlowSpaceBelow } from './use-stuck';

function rect(bottom: number): DOMRect {
  return { bottom, top: 0, left: 0, right: 0, width: 0, height: bottom, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
}

function setup() {
  const parent = document.createElement('div');
  const content = document.createElement('div');
  const target = document.createElement('div');
  // An sr-only node deep below everything: it must NOT count (scroll-leak fix 2026-11-13).
  const leaked = document.createElement('span');
  leaked.className = 'sr-only';
  content.append(target, leaked);
  parent.append(content);
  document.body.append(parent);
  content.getBoundingClientRect = () => rect(700);
  target.getBoundingClientRect = () => rect(688);
  Object.defineProperty(parent, 'scrollHeight', { value: 16000 });
  return { parent, content, target };
}

describe('inFlowSpaceBelow', () => {
  it('measures the in-flow content below the element, ignoring absolute overflow in scrollHeight', () => {
    const { parent, target } = setup();
    expect(inFlowSpaceBelow(target, parent)).toBe(12);
    parent.remove();
  });

  it('adds the content child bottom margin and the scroller bottom padding', () => {
    const { parent, content, target } = setup();
    content.style.marginBottom = '4px';
    parent.style.paddingBottom = '8px';
    expect(inFlowSpaceBelow(target, parent)).toBe(24);
    parent.remove();
  });

  it('is 0 when the element is not inside the scroller', () => {
    const { parent } = setup();
    const outside = document.createElement('div');
    document.body.append(outside);
    expect(inFlowSpaceBelow(outside, parent)).toBe(0);
    parent.remove();
    outside.remove();
  });
});
