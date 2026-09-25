import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { GanttPage } from './pages/gantt.page';

test.describe('Project Execution Timeline / Gantt surface (P4-T05)', () => {
  test('freezing a project locks it and shows the recalc-needed notice (I10)', async ({
    page,
  }) => {
    // Freeze/unfreeze is Hub Planner / Admin only per docs/DOMAIN_RULES.md and
    // the RBAC matrix (core/rbac.py) — Portfolio Manager is read-only on Gantt.
    await loginAs(page, 'hubPlanner');
    const gantt = new GanttPage(page);
    await gantt.goto();
    await expect(gantt.heading()).toBeVisible();

    const freezeButton = gantt.firstFreezeButton();
    await expect(freezeButton).toBeVisible();
    await freezeButton.click();

    const dialog = gantt.freezeDialog();
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: /^Freeze / })).toBeVisible();

    await dialog.getByLabel('Actual start week').fill('12');
    await dialog.getByRole('button', { name: /^Freeze project$/ }).click();

    await expect(dialog).toBeHidden();
    // Freezing does NOT recalculate the schedule (Invariant I10) — the page
    // must say so, not silently imply dates moved.
    await expect(gantt.recalcNeededNotice()).toBeVisible();
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'hubPlanner');
    await new GanttPage(page).goto();
    await expect(page.getByRole('heading', { name: 'Project Execution Timeline' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
