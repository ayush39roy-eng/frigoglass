import { describe, expect, it } from 'vitest';

import { cn } from './utils';

describe('cn', () => {
  it('joins truthy class names, dropping falsy ones', () => {
    const showB = false;
    expect(cn('a', showB && 'b', undefined, 'c')).toBe('a c');
  });

  it('de-duplicates conflicting Tailwind utilities, keeping the last one', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4');
  });
});
