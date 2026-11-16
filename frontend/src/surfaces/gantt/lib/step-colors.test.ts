import { describe, expect, it } from 'vitest';

import tokensCss from '@/styles/tokens.css?raw';

import { STEP_COLORS, STEP_LETTERS, STEP_PALETTE_HEX, isStepCode, stepColor, stepHatchId, stepTint } from './step-colors';

/**
 * P40-T01: the step palette. One slot per step letter (PDD-X and OEM-X share
 * it), 14 distinct colours per workflow (the old tool's duplicate fixed), and a
 * label ink on every fill that reaches WCAG AA 4.5:1 in both themes. jsdom
 * computes no contrast, so the ratios are computed here from `tokens.css`
 * (`:root`, then `.dark` over it), as `categorical-palette-contrast.test.ts` does.
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
  for (let hops = 0; value?.startsWith('var(') && hops < 5; hops++) value = vars.get(value.slice(4, -1).trim());
  const m = value?.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) throw new Error(`${name} does not resolve to an HSL triple (got ${String(value)})`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function hslToRgb([h, s, l]: Hsl): Rgb {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as Rgb;
}

function luminance(rgb: Rgb): number {
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function ratio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Euclidean RGB distance, 0..~1.73 (enough to say "not the same colour"). */
function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

const light = declarations(tokensCss, ':root');
const dark = new Map([...light, ...declarations(tokensCss, '.dark')]);
const SLOTS = Array.from({ length: 14 }, (_, i) => i + 1);

describe('step colour map (P40-T01)', () => {
  it('keys every PDD and OEM step code; step N of both workflows shares slot N', () => {
    expect(Object.keys(STEP_COLORS)).toHaveLength(28);
    STEP_LETTERS.forEach((l, i) => {
      expect(STEP_COLORS[`PDD-${l}`].slot).toBe(i + 1);
      expect(STEP_COLORS[`OEM-${l}`]).toEqual(STEP_COLORS[`PDD-${l}`]);
      expect(STEP_COLORS[`PDD-${l}`].fill).toBe(`hsl(var(--step-${String(i + 1)}))`);
      expect(STEP_COLORS[`PDD-${l}`].ink).toBe(`hsl(var(--step-ink-${String(i + 1)}))`);
    });
  });

  it('every step of a workflow has its own slot', () => {
    for (const wf of ['PDD', 'OEM'] as const) {
      const slots = STEP_LETTERS.map((l) => STEP_COLORS[`${wf}-${l}`].slot);
      expect(new Set(slots).size).toBe(14);
    }
  });

  it('is the old tool palette with its duplicate (#059669 twice) fixed', () => {
    expect(STEP_PALETTE_HEX).toHaveLength(14);
    expect(new Set(STEP_PALETTE_HEX).size).toBe(14);
    expect(STEP_PALETTE_HEX.slice(0, 13)).toEqual([
      '#1A6FE0', '#8B7FFF', '#0D9488', '#00C9A7', '#F59E0B', '#E11D48', '#7C3AED',
      '#2563EB', '#059669', '#D97706', '#DB2777', '#4F46E5', '#0891B2',
    ]);
    expect(STEP_PALETTE_HEX[13]).not.toBe('#059669');
  });

  it('the light tokens are those hex values (HSL rounding only)', () => {
    for (const slot of SLOTS) {
      const token = hslToRgb(resolve(light, `--step-${String(slot)}`));
      expect(distance(token, hexToRgb(STEP_PALETTE_HEX[slot - 1] ?? ''))).toBeLessThan(0.02);
    }
  });

  it('unknown codes fall back to their sequence slot; helpers name the slot', () => {
    expect(isStepCode('PDD-E')).toBe(true);
    expect(isStepCode('XYZ')).toBe(false);
    expect(stepColor('XYZ', 3).slot).toBe(3);
    expect(stepColor('XYZ', 99).slot).toBe(14);
    expect(stepColor('PDD-E', 1).slot).toBe(5); // the code wins over the order
    expect(stepTint(STEP_COLORS['PDD-B'], 0.2)).toBe('hsl(var(--step-2) / 0.2)');
    expect(stepHatchId(7)).toBe('gantt-hatch-step-7');
  });

  describe.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s theme', (_mode, vars) => {
    it('the 14 fills are pairwise distinct', () => {
      const fills = SLOTS.map((slot) => hslToRgb(resolve(vars, `--step-${String(slot)}`)));
      for (let i = 0; i < fills.length; i++) {
        for (let j = i + 1; j < fills.length; j++) {
          expect(distance(fills[i] as Rgb, fills[j] as Rgb), `slots ${String(i + 1)} / ${String(j + 1)}`).toBeGreaterThan(0.05);
        }
      }
    });

    it.each(SLOTS)('slot %i: the bar label ink reaches AA 4.5:1 on the fill', (slot) => {
      const fill = hslToRgb(resolve(vars, `--step-${String(slot)}`));
      const ink = hslToRgb(resolve(vars, `--step-ink-${String(slot)}`));
      expect(ratio(ink, fill)).toBeGreaterThanOrEqual(4.5);
    });
  });

  it('dark theme: every fill stands out from the dark surface (3:1, non-text contrast)', () => {
    const surface = hslToRgb(resolve(dark, '--color-surface'));
    for (const slot of SLOTS) {
      expect(ratio(hslToRgb(resolve(dark, `--step-${String(slot)}`)), surface), `slot ${String(slot)}`).toBeGreaterThanOrEqual(3);
    }
  });
});
