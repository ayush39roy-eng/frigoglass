import axe from 'axe-core';

/**
 * Unit-level axe scan (P9-R03). The Playwright specs in `e2e/` run axe against a
 * live backend. This helper gives the same rules a DOM subtree in jsdom, so
 * structural a11y (labels, `<dl>` content, ARIA) is caught in `pnpm test`.
 *
 * `color-contrast` is disabled here because jsdom does not compute layout or
 * cascade CSS custom properties, so axe cannot measure it. Sidebar contrast is
 * guarded instead by `src/styles/sidebar-contrast.test.ts`, which computes the
 * WCAG ratios from the token HSL values in `tokens.css`.
 */
export async function seriousAxeViolations(node: Element): Promise<string[]> {
  const result = await axe.run(node, {
    rules: {
      'color-contrast': { enabled: false },
      // A component rendered on its own has no page landmarks; that is not a defect.
      region: { enabled: false },
    },
    resultTypes: ['violations'],
  });
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id} (${v.impact ?? 'unknown'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}
