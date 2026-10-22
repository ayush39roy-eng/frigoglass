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
    await expect(dashboard.completionProfileSection()).toBeVisible();
    await expect(dashboard.statusOverviewSection()).toBeVisible();
    await expect(dashboard.hubTypePipelineSection()).toBeVisible();
    await expect(dashboard.completingHubTypeSection()).toBeVisible();
    // P23-T03: no Capacity booked card on the Dashboard.
    await expect(dashboard.capacityBookedHeading()).toHaveCount(0);

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

  test('P17-R08: a Hub × Type figure opens exactly its projects, focus returns on close', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const dashboard = new DashboardPage(page);
    await dashboard.goto();
    for (const pattern of [/^View \d+ .* projects? in .*$/, /^View all \d+ projects?$/, /^View all \d+ projects? completing within the year$/]) {
      const cell = dashboard.drillCell(pattern).first();
      await cell.scrollIntoViewIfNeeded();
      const label = (await cell.getAttribute('aria-label')) ?? '';
      const expected = Number(/\d+/.exec(label)?.[0]);
      await cell.click();
      const count = dashboard.drilldownDialog().getByTestId('drilldown-count');
      await expect(count).toHaveAttribute('data-count', String(expected));
      await expect(dashboard.drilldownDialog().getByTestId('drilldown-mismatch')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(cell).toBeFocused();
    }
  });
});
