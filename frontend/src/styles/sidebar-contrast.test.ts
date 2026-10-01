import { describe, expect, it } from 'vitest';

import tokensCss from './tokens.css?raw';

/**
 * P9-R03 (qa Q-F1): regression guard for the sidebar's muted labels (nav group
 * labels, "Hub scope", role line). axe cannot measure contrast in jsdom, so this
 * computes the WCAG 2.x ratio straight from the token HSL values, in cascade order
 * (`:root` blocks, then `.dark` over them), for both backgrounds the muted text
 * sits on: the rail (`--color-sidebar`) and the raised hub-scope block
 * (`--color-sidebar-raised`). The labels are used at FULL alpha. A `/NN` alpha
 * modifier on them would lower the real ratio, and this test cannot see that.
 */
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

function resolve(vars: Map<string, string>, name: string): [number, number, number] {
  let value = vars.get(name);
  for (let hops = 0; value?.startsWith('var(') && hops < 5; hops++) {
    value = vars.get(value.slice(4, -1).trim());
  }
  const m = value?.match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)%\s+(\d+(?:\.\d+)?)%$/);
  if (!m) throw new Error(`${name} does not resolve to an HSL triple (got ${String(value)})`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function luminance([h, s, l]: [number, number, number]): number {
  const sat = s / 100;
  const lig = l / 100;
  const a = sat * Math.min(lig, 1 - lig);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return lig - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(f(0)) + 0.7152 * lin(f(8)) + 0.0722 * lin(f(4));
}

function ratio(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = declarations(tokensCss, ':root');
const dark = new Map([...light, ...declarations(tokensCss, '.dark')]);

describe('sidebar muted text contrast (WCAG AA 4.5:1, qa Q-F1)', () => {
  it.each([
    ['light', light],
    ['dark', dark],
  ] as const)('%s mode: muted text reaches 4.5:1 on the rail and on the raised block', (_mode, vars) => {
    const muted = resolve(vars, '--color-sidebar-text-muted');
    expect(ratio(muted, resolve(vars, '--color-sidebar'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(muted, resolve(vars, '--color-sidebar-raised'))).toBeGreaterThanOrEqual(4.5);
  });

  it('the calculation matches a known reference pair (white on black is 21:1)', () => {
    expect(ratio([0, 0, 100], [0, 0, 0])).toBeCloseTo(21, 5);
  });
});
