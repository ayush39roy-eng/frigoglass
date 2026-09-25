import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DensityRegion, DensityZone, ROW_HEIGHT_PX, useDensity, useRowHeight } from './density-zone';

function Probe() {
  const density = useDensity();
  const rowHeight = useRowHeight();
  return (
    <span data-testid="probe" data-row-height={rowHeight}>
      {density}
    </span>
  );
}

describe('DensityZone', () => {
  it('defaults to overview outside any zone, matching the CSS default on :root', () => {
    render(<Probe />);
    expect(screen.getByTestId('probe')).toHaveTextContent('overview');
  });

  it('sets the data-density attribute that drives every CSS token', () => {
    const { container } = render(
      <DensityRegion density="working">
        <Probe />
      </DensityRegion>,
    );
    expect(container.querySelector('[data-density="working"]')).not.toBeNull();
  });

  it('exposes the same density through context as through the attribute', () => {
    render(
      <DensityRegion density="working">
        <Probe />
      </DensityRegion>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('working');
  });

  it('lets a working island nest inside an overview page', () => {
    render(
      <DensityRegion density="overview">
        <span data-testid="outer">
          <Probe />
        </span>
        <DensityZone density="working">
          <span data-testid="inner-wrap">
            <Probe />
          </span>
        </DensityZone>
      </DensityRegion>,
    );
    const probes = screen.getAllByTestId('probe');
    expect(probes[0]).toHaveTextContent('overview');
    expect(probes[1]).toHaveTextContent('working');
  });

  it('reports the working row height that makes 40 rows fit', () => {
    render(
      <DensityRegion density="working">
        <Probe />
      </DensityRegion>,
    );
    expect(screen.getByTestId('probe')).toHaveAttribute('data-row-height', '32');
  });
});

/**
 * ROW_HEIGHT_PX exists because TanStack Virtual needs a NUMBER for estimateSize and
 * cannot read a CSS custom property without measuring layout. That duplication is
 * the only place in the system where one value is written down twice, so it gets a
 * test rather than a comment asking people to be careful.
 *
 * If this fails: you changed --row-h in tokens.css without changing ROW_HEIGHT_PX,
 * and every virtualized table is now mis-measuring its scroll height.
 */
describe('ROW_HEIGHT_PX ↔ tokens.css', () => {
  // Vitest runs with the frontend package root as cwd; import.meta.url is not a
  // file: URL under the jsdom transform, so resolve from the project root instead.
  const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

  /** Pull `--row-h: 2rem;` out of a given `[data-density='…']` block. */
  function rowHeightRem(zone: string, variable: '--row-h' | '--row-h-compact'): number {
    const block = new RegExp(`\\[data-density='${zone}'\\]\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css);
    expect(block, `no [data-density='${zone}'] block found in tokens.css`).not.toBeNull();
    const match = new RegExp(`${variable}:\\s*([\\d.]+)rem`).exec(block![1]);
    expect(match, `${variable} not found in the '${zone}' block`).not.toBeNull();
    return Number.parseFloat(match![1]);
  }

  it('working row heights match the CSS tokens', () => {
    expect(rowHeightRem('working', '--row-h') * 16).toBe(ROW_HEIGHT_PX.working.default);
    expect(rowHeightRem('working', '--row-h-compact') * 16).toBe(ROW_HEIGHT_PX.working.compact);
  });

  it('overview row heights match the CSS tokens', () => {
    expect(rowHeightRem('overview', '--row-h') * 16).toBe(ROW_HEIGHT_PX.overview.default);
    expect(rowHeightRem('overview', '--row-h-compact') * 16).toBe(ROW_HEIGHT_PX.overview.compact);
  });
});
