import { test, expect } from './fixtures';
import { loginAs } from './fixtures';
import { DashboardPage } from './pages/dashboard.page';

/**
 * P28 Executive view (ADR 0039), added by P28-R01. Typecheck-only in the
 * gate (not run): it drives `/?view=executive` and asserts the KPI tiles and
 * the "Upcoming completions" card render, at desktop and phone width.
 */
test.describe('Dashboard Executive view (P28)', () => {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 1280, height: 900 },
    { width: 768, height: 900 },
    { width: 390, height: 900 },
  ]) {
    test(`renders the KPI tiles and Upcoming completions at ${String(viewport.width)} px`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await loginAs(page, 'portfolioManager');
      const dashboard = new DashboardPage(page);
      await dashboard.gotoExecutive();

      await expect(dashboard.executiveView()).toBeVisible();
      await expect(dashboard.viewToggleOption('executive')).toHaveAttribute('data-state', 'on');

      for (const tile of ['scheduled', 'within-year', 'spillover', 'left-out', 'blocked', 'vip'] as const) {
        await expect(dashboard.executiveKpi(tile)).toBeVisible();
      }
      // Every tile in the strip has the same footprint (owner requirement).
      const sizes = await page
        .locator('[data-exec-kpi-tile]')
        .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
      expect(new Set(sizes).size).toBe(1);

      await expect(dashboard.upcomingCard()).toBeVisible();
      await expect(dashboard.upcomingCard().getByRole('heading', { name: 'Upcoming completions' })).toBeVisible();

      // QA-F28-1 / QA-F28-2 at every width: project names get a real column
      // (never a few-px sliver that stacks letters), and no tile label is
      // overflowed or overlapped by its badge.
      const nameWidths = await dashboard
        .upcomingRows()
        .getByRole('link')
        .evaluateAll((els) => els.map((el) => el.getBoundingClientRect().width));
      for (const w of nameWidths) expect(w).toBeGreaterThanOrEqual(80);
      const labelIssues = await page.locator('[data-exec-kpi-tile]').evaluateAll((tiles) =>
        tiles.flatMap((tile) => {
          const label = tile.querySelector('[data-testid="exec-kpi-tile-label"]');
          const badge = tile.querySelector('[data-testid="exec-kpi-tile-badge"]');
          const icon = tile.querySelector('[data-testid="exec-kpi-tile-header"] > span:first-child');
          if (!label || !badge || !icon) return ['missing label/badge/icon'];
          // The rendered TEXT boxes (Range rects), not the label element's box.
          const range = document.createRange();
          range.selectNodeContents(label);
          const textRects = [...range.getClientRects()];
          const hits = (r: DOMRect, o: Element) => {
            const b = o.getBoundingClientRect();
            if (b.width === 0 || b.height === 0) return false;
            return Math.min(r.right, b.right) - Math.max(r.left, b.left) > 0.5 && Math.min(r.bottom, b.bottom) - Math.max(r.top, b.top) > 0.5;
          };
          const t = tile.getBoundingClientRect();
          const clipped = label.scrollWidth > label.clientWidth + 1 || textRects.some((r) => r.right > t.right - 2 || r.left < t.left);
          const overlap = textRects.some((r) => hits(r, badge) || hits(r, icon));
          return clipped || overlap ? [`${label.textContent ?? ''}${clipped ? ' clipped' : ''}${overlap ? ' overlapped' : ''}`] : [];
        }),
      );
      expect(labelIssues).toEqual([]);
    });
  }
});
