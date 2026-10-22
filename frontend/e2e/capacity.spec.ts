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

    // P19-T07: the class chart and chamber matrix are removed; the engineer section is
    // collapsed until asked for.
    await expect(capacity.removedDisclosures()).toHaveCount(0);
    await expect(capacity.removedChamberMatrix()).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Engineer utilization by week' })).toHaveCount(0);
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await new CapacityPage(page).goto();
    await expect(page.getByRole('heading', { name: 'RPD Capacity' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});

test.describe('Capacity surface — OEM hubs under Greece (P29, ADR 0042)', () => {
  test('four capacity-hub rows; the Greece row opens its served members breakdown', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const capacity = new CapacityPage(page);
    await capacity.goto();
    await expect(capacity.hubLoadPanel()).toBeVisible();

    await expect(capacity.hubRows()).toHaveCount(4);
    await expect(capacity.hubRow('OEM-HCK')).toHaveCount(0);
    await expect(capacity.hubRow('OEM-Seitek')).toHaveCount(0);

    const toggle = capacity.membersToggle('R&D-Greece');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(capacity.memberRow('OEM-HCK')).toBeVisible();
    await expect(capacity.memberRow('OEM-Seitek')).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
