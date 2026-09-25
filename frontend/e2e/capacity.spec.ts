import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { CapacityPage } from './pages/capacity.page';

test.describe('Capacity surface (P4-T03)', () => {
  test('all three panels render from the active schedule run (I6/I7)', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const capacity = new CapacityPage(page);
    await capacity.goto();

    await expect(capacity.heading()).toBeVisible();
    await expect(capacity.hubLoadPanel()).toBeVisible();
    await expect(capacity.classBreakdownPanel()).toBeVisible();
    await expect(capacity.utilizationPanel()).toBeVisible();

    // GDPR placeholder (OPEN_QUESTIONS #8 / P4-T08): the engineer side of the
    // utilization matrix must stay withheld, not silently start rendering names.
    await expect(page.getByText(/GDPR|withheld|pending/i).first()).toBeVisible();
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await new CapacityPage(page).goto();
    await expect(page.getByRole('heading', { name: 'RPD Capacity' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
