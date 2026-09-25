/**
 * THE SHARED CHART THEME.
 *
 * One source of truth for every chart in the app, whatever draws it. Today that is
 * hand-built SVG (the Dashboard bar chart, the capacity heatmap, the Gantt) and
 * Recharts; `toEChartsTheme()` exists so that when a chart genuinely needs ECharts —
 * a large heatmap or a dense scatter, where hand-rolled SVG stops being tractable —
 * it inherits the same look for free rather than arriving with the ECharts defaults.
 *
 * NOTE: ECharts is NOT a dependency of this project today. Nothing imports it, and it
 * is heavy enough (~350KB unminified core) to matter against a 400KB initial budget.
 * `toEChartsTheme()` is ~30 lines deriving from the same constants below; it is not a
 * speculative port of the library.
 *
 * Colour values are read from CSS custom properties at call time rather than
 * hard-coded, so charts follow the light/dark theme without a JS re-render. Callers
 * inside React should prefer the Tailwind classes (`fill-chart-1`, `stroke-chart-grid`)
 * where the drawing API accepts a className; the resolver here is for the APIs that
 * demand a literal colour string.
 */

/* -------------------------------------------------------------------------- */
/* Reading tokens                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Resolve a token to a real `hsl(...)` string.
 *
 * Tokens are stored as bare HSL channels ("221 83% 53%") so Tailwind's alpha
 * modifier works; anything reading them outside Tailwind has to wrap them.
 * Returns a safe fallback during SSR/tests where there is no computed style.
 */
export function token(name: string, alpha = 1): string {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return 'transparent';
  }
  const channels = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  if (!channels) return 'transparent';
  return alpha === 1 ? `hsl(${channels})` : `hsl(${channels} / ${alpha})`;
}

/** The six-step categorical ramp, in ramp order (darkest → lightest). */
export const SERIES_TOKENS = [
  '--chart-1',
  '--chart-2',
  '--chart-3',
  '--chart-4',
  '--chart-5',
  '--chart-6',
] as const;

/* -------------------------------------------------------------------------- */
/* Series assignment — BY VALUE, never by category index                       */
/* -------------------------------------------------------------------------- */

/**
 * Assign ramp colours to series ordered by magnitude, not by the order the data
 * happened to arrive in.
 *
 * This is the single highest-leverage rule in the chart theme. When the largest
 * series is always the darkest, a reader ranks the series before reading a single
 * axis label. When colour is assigned by category index — the default in every
 * charting library — the ranking is invisible and the legend becomes mandatory.
 *
 * Returns an index-aligned array of colour strings: `out[i]` is the colour for
 * `values[i]`, even though the colour was chosen from `values[i]`'s RANK.
 *
 * Series beyond the sixth all take the last ramp step. That is deliberate: a
 * categorical chart with more than six series is a chart that should have been a
 * table, and making the overflow visibly undifferentiated surfaces that rather
 * than hiding it behind invented colours.
 */
export function assignSeriesColors(values: readonly number[]): string[] {
  const ranked = values
    .map((value, index) => ({ value, index }))
    .sort((a, b) => b.value - a.value);

  const out = new Array<string>(values.length);
  ranked.forEach(({ index }, rank) => {
    out[index] = token(SERIES_TOKENS[Math.min(rank, SERIES_TOKENS.length - 1)]);
  });
  return out;
}

/** Ramp colour by rank, for callers that already know a series' rank. */
export function seriesColorByRank(rank: number): string {
  return token(SERIES_TOKENS[Math.min(Math.max(rank, 0), SERIES_TOKENS.length - 1)]);
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                   */
/* -------------------------------------------------------------------------- */

export const CHART_STRUCTURE = {
  /**
   * Horizontal grid lines only, 1px, border colour.
   *
   * Vertical grid lines on a bar chart duplicate information the bars already
   * encode — the bar's own edge IS the category boundary — and they add one line
   * per category, which on a 30-week axis is 30 lines of pure noise.
   */
  grid: { horizontal: true, vertical: false, width: 1 },

  /** No chart border, no background fill. The card already provides both. */
  background: 'none',
  border: 'none',

  /** Axis labels at the label token size. Axis TITLES only where the unit is unclear. */
  axis: { fontSize: 'var(--text-label)', showTitleOnlyWhenUnitIsAmbiguous: true },

  /**
   * Bar charts start at zero. Always, no exceptions, no "but the variation is small".
   * A truncated bar axis makes a 3% difference look like a 300% one, and this app's
   * charts end up in board decks where nobody re-reads the axis.
   */
  barBaseline: 0 as const,

  /**
   * Direct-label series where there are four or fewer; a legend is a last resort.
   * A ten-item legend forces the eye to travel between the mark and the key for
   * every single read.
   */
  directLabelThreshold: 4,

  /** Donuts: part-to-whole only, six segments max, always a centre total. */
  donut: { maxSegments: 6, requireCentreTotal: true },
} as const;

/* -------------------------------------------------------------------------- */
/* Tooltip                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Dark navy surface, mono figures, and — the part that matters — EVERY series at the
 * hovered x-position, not just the series under the cursor. Comparing two series at
 * one week is the actual question a planner has; a single-series tooltip makes them
 * hover twice and hold the first number in their head.
 */
export const TOOLTIP = {
  showAllSeriesAtX: true,
  className:
    'rounded-md border-0 px-s3 py-s2 shadow-overlay bg-chart-tooltip-bg text-chart-tooltip-text',
  fontSize: 'var(--text-label)',
  figureClassName: 'font-mono tabular-nums',
} as const;

/* -------------------------------------------------------------------------- */
/* Recharts adapter                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Props to spread onto Recharts primitives. Recharts styles via props rather than
 * CSS, so these have to resolve tokens to literal strings — hence `token()` calls
 * at render time rather than module scope (module scope would capture the light
 * theme once and never update).
 */
export function rechartsTheme() {
  const axisText = token('--chart-axis-text');
  const grid = token('--chart-grid');

  return {
    cartesianGrid: {
      stroke: grid,
      strokeWidth: 1,
      horizontal: CHART_STRUCTURE.grid.horizontal,
      vertical: CHART_STRUCTURE.grid.vertical,
    },
    xAxis: {
      stroke: grid,
      tick: { fill: axisText, fontSize: 11 },
      tickLine: false,
      axisLine: { stroke: grid },
    },
    yAxis: {
      stroke: grid,
      tick: { fill: axisText, fontSize: 11 },
      tickLine: false,
      axisLine: false,
      // Enforces the zero-baseline rule at the adapter level so an individual
      // chart cannot quietly opt out of it.
      domain: [0, 'auto'] as [number, string],
    },
    tooltip: {
      cursor: { fill: token('--color-text', 0.04) },
      contentStyle: {
        background: token('--chart-tooltip-bg'),
        color: token('--chart-tooltip-text'),
        border: 'none',
        borderRadius: 'var(--radius-lg)',
        fontSize: 12,
        boxShadow: 'var(--shadow-overlay)',
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* ECharts adapter (unused today — see file header)                            */
/* -------------------------------------------------------------------------- */

/**
 * Same theme, shaped for `echarts.registerTheme()`. Derived from the constants
 * above, so there is exactly one place to change a chart colour.
 *
 * Import ECharts by module (`echarts/core` + only the charts and components used),
 * never `echarts/dist` — the full bundle alone would consume most of the 400KB
 * initial budget.
 */
export function toEChartsTheme() {
  const axisText = token('--chart-axis-text');
  const grid = token('--chart-grid');
  const axis = {
    axisLine: { lineStyle: { color: grid } },
    axisTick: { show: false },
    axisLabel: { color: axisText, fontSize: 11 },
    splitLine: { lineStyle: { color: grid, width: 1 } },
  };

  return {
    color: SERIES_TOKENS.map((name) => token(name)),
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Inter Variable, system-ui, sans-serif' },
    // Vertical split lines off on the category axis; horizontal on the value axis.
    categoryAxis: { ...axis, splitLine: { show: false } },
    valueAxis: axis,
    tooltip: {
      backgroundColor: token('--chart-tooltip-bg'),
      borderWidth: 0,
      textStyle: { color: token('--chart-tooltip-text'), fontSize: 12 },
      // The "show every series at this x" rule, in ECharts' vocabulary.
      trigger: 'axis',
    },
  };
}
