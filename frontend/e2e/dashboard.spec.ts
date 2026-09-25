import { test, expect, seriousAxeViolations } from './fixtures';
import { loginAs } from './fixtures';
import { DashboardPage } from './pages/dashboard.page';

test.describe('Dashboard surface (P4-T02)', () => {
  test('loads and renders every section sourced from the active schedule run (I9)', async ({
    page,
  }) => {
    await loginAs(page, 'portfolioManager');
    const dashboard = new DashboardPage(page);
    await dashboard.goto();

    await expect(dashboard.heading()).toBeVisible();
    await expect(dashboard.withinYearSection()).toBeVisible();
    await expect(dashboard.pipelineSection()).toBeVisible();
    await expect(dashboard.statusOverviewSection()).toBeVisible();
    await expect(dashboard.hubTypePipelineSection()).toBeVisible();

    // No console errors during a normal authenticated load.
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await page.reload();
    await expect(dashboard.heading()).toBeVisible();
    expect(consoleErrors).toEqual([]);
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await new DashboardPage(page).goto();
    await expect(page.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
