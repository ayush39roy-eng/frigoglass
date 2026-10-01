import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { GlassPanel } from './glass-panel';

describe('GlassPanel', () => {
  it('renders children and defaults to the hero (60%) opacity treatment', () => {
    render(<GlassPanel data-testid="panel">content</GlassPanel>);
    const panel = screen.getByTestId('panel');
    expect(panel).toHaveTextContent('content');
    expect(panel.className).toContain('bg-glass/60');
    expect(panel.className).toContain('shadow-glass');
  });

  it('switches to the content (90%) opacity treatment for dense data', () => {
    render(
      <GlassPanel data-testid="panel" opacity="content">
        content
      </GlassPanel>,
    );
    expect(screen.getByTestId('panel').className).toContain('bg-glass/90');
  });

  it('merges a caller className without dropping the variant classes', () => {
    render(
      <GlassPanel data-testid="panel" className="p-card">
        content
      </GlassPanel>,
    );
    expect(screen.getByTestId('panel').className).toContain('p-card');
    expect(screen.getByTestId('panel').className).toContain('rounded-panel');
  });
});
