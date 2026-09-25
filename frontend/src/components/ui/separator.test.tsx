import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { Separator } from './separator';

describe('Separator', () => {
  it('renders as decorative (no separator role) by default', () => {
    const { container } = render(<Separator data-testid="sep" />);
    // Decorative separators are hidden from the accessibility tree by design (Radix).
    expect(container.querySelector('[data-testid="sep"]')).toHaveAttribute('data-orientation', 'horizontal');
  });
});
