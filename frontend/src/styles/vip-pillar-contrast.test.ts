import { describe, expect, it } from 'vitest';

import tokensCss from '@/styles/tokens.css?raw';

/**
 * P14 (ADR 0027 §6): the VIP pillar accents must pass WCAG AA (4.5:1) in both
 * themes — text on the solid pillar band, the ink on a highlighted item's
 * subtle background, and the ink on the bare card surfaces. jsdom computes no
 * contrast, so this measures the token HSL values in cascade order (`:root`
 * blocks, then `.dark` over them), like `lib/categorical-palette-contrast.test.ts`.
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
const PILLARS = ['innovation', 'market', 'performance'] as const;
const SURFACES = ['--color-surface', '--color-surface-raised'] as const;

describe('VIP pillar accent contrast (WCAG AA 4.5:1, P14)', () => {
  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s theme', (_mode, vars) => {
    const c = (name: string) => toRgb(resolve(vars, name));
    it.each(PILLARS)('%s: fg on the solid band', (p) => {
      expect(ratio(c(`--vip-${p}-fg`), c(`--vip-${p}`))).toBeGreaterThanOrEqual(4.5);
    });
    it.each(PILLARS)('%s: ink on the highlighted (subtle) background', (p) => {
      expect(ratio(c(`--vip-${p}-ink`), c(`--vip-${p}-subtle`))).toBeGreaterThanOrEqual(4.5);
    });
    it.each(PILLARS)('%s: ink and body text on the bare surfaces and the subtle background', (p) => {
      for (const s of SURFACES) expect(ratio(c(`--vip-${p}-ink`), c(s))).toBeGreaterThanOrEqual(4.5);
      // An item's own title is `text-text` on the highlight background.
      expect(ratio(c('--color-text'), c(`--vip-${p}-subtle`))).toBeGreaterThanOrEqual(4.5);
    });
  });
});

describe('Warning subtle pair contrast (WCAG AA 4.5:1, QA-P15-1)', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s: warning-subtle-fg on warning-subtle and on the surfaces', (_m, vars) => {
    const c = (name: string) => toRgb(resolve(vars, name));
    expect(ratio(c('--color-warning-subtle-fg'), c('--color-warning-subtle'))).toBeGreaterThanOrEqual(4.5);
    for (const s of ['--color-surface', '--color-canvas']) {
      expect(ratio(c('--color-warning-subtle-fg'), c(s))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
