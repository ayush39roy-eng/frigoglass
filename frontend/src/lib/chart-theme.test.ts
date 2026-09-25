import { beforeEach, describe, expect, it } from 'vitest';

import { assignSeriesColors, CHART_STRUCTURE, SERIES_TOKENS, seriesColorByRank } from './chart-theme';

/**
 * jsdom resolves custom properties only when they are actually declared, and the
 * app stylesheet is not loaded in unit tests. Declaring the ramp inline gives the
 * resolver something real to read, so these tests exercise the ordering logic
 * against genuine token resolution rather than against `transparent` fallbacks.
 */
beforeEach(() => {
  const style = document.documentElement.style;
  SERIES_TOKENS.forEach((name, i) => {
    style.setProperty(name, `${200 + i} 80% 50%`);
  });
});

describe('assignSeriesColors', () => {
  it('gives the darkest ramp step to the LARGEST series, not the first one', () => {
    // Smallest value first, so index order and rank order disagree.
    const colors = assignSeriesColors([10, 90, 50]);
    expect(colors[1]).toBe(seriesColorByRank(0)); // 90 is rank 0
    expect(colors[2]).toBe(seriesColorByRank(1)); // 50 is rank 1
    expect(colors[0]).toBe(seriesColorByRank(2)); // 10 is rank 2
  });

  it('returns one colour per input, index-aligned', () => {
    expect(assignSeriesColors([5, 4, 3, 2])).toHaveLength(4);
  });

  it('collapses every series past the sixth onto the last ramp step', () => {
    const colors = assignSeriesColors([9, 8, 7, 6, 5, 4, 3, 2]);
    const last = seriesColorByRank(SERIES_TOKENS.length - 1);
    expect(colors[6]).toBe(last);
    expect(colors[7]).toBe(last);
  });

  it('handles ties without dropping a series', () => {
    const colors = assignSeriesColors([7, 7, 7]);
    expect(colors.filter(Boolean)).toHaveLength(3);
  });

  it('handles an empty series list', () => {
    expect(assignSeriesColors([])).toEqual([]);
  });
});

describe('seriesColorByRank', () => {
  it('clamps a negative rank to the first step rather than returning undefined', () => {
    expect(seriesColorByRank(-1)).toBe(seriesColorByRank(0));
  });

  it('clamps an out-of-range rank to the last step', () => {
    expect(seriesColorByRank(99)).toBe(seriesColorByRank(SERIES_TOKENS.length - 1));
  });
});

describe('CHART_STRUCTURE', () => {
  it('never draws vertical grid lines', () => {
    expect(CHART_STRUCTURE.grid.vertical).toBe(false);
    expect(CHART_STRUCTURE.grid.horizontal).toBe(true);
  });

  it('pins the bar baseline at zero', () => {
    expect(CHART_STRUCTURE.barBaseline).toBe(0);
  });

  it('caps donuts at six segments and requires a centre total', () => {
    expect(CHART_STRUCTURE.donut.maxSegments).toBe(6);
    expect(CHART_STRUCTURE.donut.requireCentreTotal).toBe(true);
  });
});
