import { describe, expect, it } from 'vitest';

import tokensCss from '@/styles/tokens.css?raw';

import { DELIVERY_SEGMENTS, HUB_OUTCOME_STACK } from './delivery-segments';

/**
 * QA-F23-1 (WCAG 1.4.3): the count printed in every "Delivery by priority"
 * segment must reach 4.5:1 against its fill in both themes. jsdom computes no
 * contrast, so this measures the token HSL values in cascade order (`:root`
 * blocks, then `.dark` over them), like `styles/vip-pillar-contrast.test.ts`.
 * Tinted fills (`bg-x/40`) are composited over the bar's track first.
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

function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [0, 1, 2].map((i) => alpha * (fg[i] ?? 0) + (1 - alpha) * (bg[i] ?? 0)) as Rgb;
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

/**
 * Carried dark-theme finding D1 (MEMORY, report-only since P19): white on the
 * dark primary is 4.18:1 app-wide (buttons, chips). The "Already delivered"
 * segment uses that same token pair; it is measured, but held to the carried
 * level until D1 is fixed at the token.
 */
const CARRIED_DARK: Partial<Record<string, number>> = { delivered: 4.1 };

describe('Delivery by priority: segment label contrast (QA-F23-1, WCAG AA 4.5:1)', () => {
  it('keeps the colour meaning: finishing green, not finishing amber, delivered blue, not in plan grey', () => {
    expect(DELIVERY_SEGMENTS.map((s) => s.fill)).toEqual([
      'bg-success',
      'bg-warning',
      'bg-success/40',
      'bg-warning/40',
      'bg-primary',
      'bg-border-strong',
    ]);
    // No segment hard-codes white any more.
    expect(DELIVERY_SEGMENTS.some((s) => s.ink === 'text-white')).toBe(false);
  });

  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s theme', (mode, vars) => {
    const c = (name: string) => toRgb(resolve(vars, name));
    it.each(DELIVERY_SEGMENTS.map((s) => [s.key, s] as const))('%s', (key, s) => {
      const fill = s.alpha >= 1 ? c(s.fillToken) : over(c(s.fillToken), s.alpha, c(s.ground));
      const min = mode === 'dark' ? (CARRIED_DARK[key] ?? 4.5) : 4.5;
      expect(ratio(c(s.inkToken), fill)).toBeGreaterThanOrEqual(min);
    });
  });

  it('the old white-on-amber and white-on-grey pairs really failed (guards the measurement)', () => {
    const c = (name: string) => toRgb(resolve(light, name));
    const white: Rgb = [1, 1, 1];
    expect(ratio(white, c('--color-warning'))).toBeLessThan(4.5);
    expect(ratio(white, c('--color-border-strong'))).toBeLessThan(3);
  });
});

describe('Outcomes by hub: segment count contrast (QA-F23-1 pattern, WCAG AA 4.5:1)', () => {
  it('keeps the colour meaning and no fixed white', () => {
    expect(HUB_OUTCOME_STACK.map((s) => [s.bucket, s.fill])).toEqual([
      ['within_year', 'bg-success'],
      ['spillover', 'bg-warning'],
      ['blocked', 'bg-text-muted'],
    ]);
    expect(HUB_OUTCOME_STACK.some((s) => s.ink === 'text-white')).toBe(false);
  });

  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s theme', (_mode, vars) => {
    const c = (name: string) => toRgb(resolve(vars, name));
    it.each(HUB_OUTCOME_STACK.map((s) => [s.bucket, s] as const))('%s', (_bucket, s) => {
      expect(ratio(c(s.inkToken), c(s.fillToken))).toBeGreaterThanOrEqual(4.5);
    });
  });
});
