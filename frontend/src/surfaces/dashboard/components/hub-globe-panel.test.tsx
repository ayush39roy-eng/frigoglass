import { describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';

// The real `./hub-globe` imports `cobe` and drives a WebGL canvas — jsdom has
// no WebGL context, so every test here mocks it out and asserts only on the
// PANEL's own logic (eligibility gating, real-data legend, empty state, sr
// fallback). `HubGlobe` itself is a separate, tiny, imperative component with
// its own review surface (creates/destroys a `cobe` globe) that is not
// meaningfully unit-testable without a real GPU context.
vi.mock('./hub-globe', () => ({
  HubGlobe: ({ markers }: { markers: { hub: string }[] }) => (
    <div data-testid="hub-globe-stub">{markers.map((m) => m.hub).join(',')}</div>
  ),
}));

import { renderWithProviders } from '@/test/render';
import type { HubTypePipelineRow } from '../api/types';
import { HubGlobePanel } from './hub-globe-panel';

const rows: HubTypePipelineRow[] = [
  { hub: 'R&D-Greece', type: 'NM', count: 3 },
  { hub: 'R&D-Greece', type: 'CO', count: 2 },
  { hub: 'PD-India', type: 'NM', count: 10 },
];

describe('HubGlobePanel', () => {
  it('renders the real per-hub counts in the accessible legend', async () => {
    renderWithProviders(<HubGlobePanel rows={rows} />);
    expect(screen.getByText('Hub footprint')).toBeInTheDocument();
    const legend = screen.getByRole('list', {
      name: /Real project count per hub/i,
    });
    expect(within(legend).getByText('PD-India')).toBeInTheDocument();
    expect(within(legend).getByText('10')).toBeInTheDocument();
    expect(within(legend).getByText('R&D-Greece')).toBeInTheDocument();
    expect(within(legend).getByText('5')).toBeInTheDocument();

    // jsdom has no IntersectionObserver, which the panel treats as "fail open
    // to visible" — so with no reduced-motion / low-power gate tripped, the
    // (mocked) globe mounts.
    await waitFor(() => expect(screen.getByTestId('hub-globe-stub')).toBeInTheDocument());
  });

  it('shows a non-canvas fallback and never mounts the globe under prefers-reduced-motion', () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) =>
      ({
        matches: query.includes('reduce'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList) as typeof window.matchMedia;

    renderWithProviders(<HubGlobePanel rows={rows} />);

    expect(screen.queryByTestId('hub-globe-stub')).not.toBeInTheDocument();
    expect(screen.getByText(/Animated globe disabled/i)).toBeInTheDocument();
    // The legend — the accessible fallback — still renders the real data.
    expect(screen.getByText('PD-India')).toBeInTheDocument();

    window.matchMedia = originalMatchMedia;
  });

  it('renders a non-error empty state when there are no hubs in scope', () => {
    renderWithProviders(<HubGlobePanel rows={[]} />);
    expect(screen.getByText('No hubs in scope')).toBeInTheDocument();
    expect(screen.queryByTestId('hub-globe-stub')).not.toBeInTheDocument();
  });
});
