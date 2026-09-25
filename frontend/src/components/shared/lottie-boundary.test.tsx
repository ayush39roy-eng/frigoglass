import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

import { LottieBoundary } from './lottie-boundary';

function setReducedMotion(matches: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query.includes('reduced-motion') ? matches : false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as unknown as typeof window.matchMedia;
}

describe('LottieBoundary', () => {
  it('shows the static poster and skips the animation under prefers-reduced-motion', () => {
    setReducedMotion(true);
    render(
      <LottieBoundary
        src={{}}
        label="Priorities applied"
        poster={<span>Priorities applied (static)</span>}
      />,
    );
    expect(screen.getByRole('img', { name: 'Priorities applied' })).toBeInTheDocument();
    expect(screen.getByText('Priorities applied (static)')).toBeInTheDocument();
  });

  it('renders the labelled boundary without crashing when motion is allowed', async () => {
    setReducedMotion(false);
    render(<LottieBoundary src={{}} label="Solver running" poster={<span>Solver running…</span>} />);
    expect(screen.getByRole('img', { name: 'Solver running' })).toBeInTheDocument();
    // Either the Suspense fallback (poster) or the lazily-loaded animation lands here —
    // both are acceptable; the assertion is that the boundary never throws.
    await waitFor(() => {
      expect(screen.getByRole('img', { name: 'Solver running' })).toBeInTheDocument();
    });
  });
});
