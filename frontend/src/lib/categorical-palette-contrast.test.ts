import { describe, expect, it } from 'vitest';

import tokensCss from '@/styles/tokens.css?raw';

import { CATEGORICAL_RANK_TEXT, categoricalRankSoftBg } from './categorical-palette';

/**
 * P12-R04 (qa-inspector P12 gate item B): every categorical chip slot must reach
 * WCAG AA 4.5:1 for its TEXT against its own tinted background, in BOTH themes.
 * Live axe found B-OEM (slot 6) at 3.02:1; jsdom computes no contrast, so this
 * test does it from the token HSL values in `tokens.css`, in cascade order
 * (`:root` blocks, then `.dark` over them).
 *
 * The chip is `categoricalRankSoftBg(rank)` (`bg-dashChart-N/AA`, an AA % tint of
 * `--dash-cat-N`) + `categoricalRankText(rank)` (`text-dashChartInk-N`, i.e.
 * `--dash-cat-ink-N`). The tint is composited over every surface a chip can sit
 * on (card, raised row, Boltshift alt row, shell), and the ink is also checked
 * against the bare surface. The class names are parsed, not assumed, so
 * re-pointing a slot at another token or alpha is re-measured here.
 */
type Hsl = [number, number, number];
type Rgb = [number, number, number];

function declarations(css: string, selector: ':root' | '.dark'): Map<string, string> {
  const out = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const block of stripped.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if ((block[1] ?? '').trim() !== selector) continue;
    for (const decl of (block[2] ?? '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
      out.set(decl[1] ?? '', (decl[2] ?? '').trim());
    }
  }
  return out;
}

function resolve(vars: Map<string, string>, name: string): Hsl {
  let value = vars.get(name);
  for (let hops = 0; value?.startsWith('var(') && hops < 5; hops++) {
    value = vars.get(value.slice(4, -1).trim());
  }
  const m = value?.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) throw new Error(`${name} does not resolve to an HSL triple (got ${String(value)})`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function toRgb([h, s, l]: Hsl): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function over(fg: Rgb, bg: Rgb, alpha: number): Rgb {
  return [0, 1, 2].map((i) => fg[i]! * alpha + bg[i]! * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = declarations(tokensCss, ':root');
const dark = new Map([...light, ...declarations(tokensCss, '.dark')]);

const SURFACES = ['--color-surface', '--color-surface-raised', '--color-dash-alt', '--color-shell'] as const;
const SLOTS = CATEGORICAL_RANK_TEXT.map((_, rank) => rank);

function chipTokens(rank: number): { ink: string; tint: string; alpha: number } {
  const text = CATEGORICAL_RANK_TEXT[rank] ?? '';
  const textMatch = text.match(/^text-dashChartInk-(\d+)$/);
  if (!textMatch) throw new Error(`slot ${rank + 1}: unexpected text class ${text}`);
  const bg = categoricalRankSoftBg(rank);
  const bgMatch = bg.match(/^bg-dashChart-(\d+)\/(\d+)$/);
  if (!bgMatch) throw new Error(`slot ${rank + 1}: unexpected tint class ${bg}`);
  return {
    ink: `--dash-cat-ink-${textMatch[1]}`,
    tint: `--dash-cat-${bgMatch[1]}`,
    alpha: Number(bgMatch[2]) / 100,
  };
}

describe('categorical chip text contrast (WCAG AA 4.5:1, P12-R04)', () => {
  it('covers all ten slots, each pairing its own ink with its own tint', () => {
    expect(SLOTS).toHaveLength(10);
    for (const rank of SLOTS) {
      const { ink, tint } = chipTokens(rank);
      expect(ink).toBe(`--dash-cat-ink-${rank + 1}`);
      expect(tint).toBe(`--dash-cat-${rank + 1}`);
    }
  });

  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s theme', (_mode, vars) => {
    it.each(SLOTS.map((rank) => [rank + 1, rank] as const))(
      'slot %i: ink >= 4.5:1 on its tint over every surface, and on the bare surface',
      (_slot, rank) => {
        const { ink, tint, alpha } = chipTokens(rank);
        const inkRgb = toRgb(resolve(vars, ink));
        const tintRgb = toRgb(resolve(vars, tint));
        for (const surface of SURFACES) {
          const ground = toRgb(resolve(vars, surface));
          expect(ratio(inkRgb, over(tintRgb, ground, alpha))).toBeGreaterThanOrEqual(4.5);
          expect(ratio(inkRgb, ground)).toBeGreaterThanOrEqual(4.5);
        }
      },
    );
  });

  it('reproduces the gate finding: the old fill-hue text on B-OEM fails in light mode', () => {
    const fill = toRgb(resolve(light, '--dash-cat-6'));
    const white = toRgb(resolve(light, '--color-surface'));
    expect(ratio(fill, over(fill, white, 0.15))).toBeLessThan(4.5);
  });

  it('the calculation matches a known reference pair (white on black is 21:1)', () => {
    expect(ratio([1, 1, 1], [0, 0, 0])).toBeCloseTo(21, 5);
  });
});
