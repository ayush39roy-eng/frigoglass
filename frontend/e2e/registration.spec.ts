import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { ProjectsPage } from './pages/projects.page';

/**
 * Project Registration (P4-T06), merged into the Projects page in P22-T01:
 * the form is a drawer opened from "Register project" / "Edit registration",
 * and the leave-Draft hard gate lives in the edit drawer.
 */
test.describe('Project Registration on the Projects page (P4-T06, P22-T01)', () => {
  test('draft -> hard-gate-status -> submit (leave Draft) end-to-end', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const projects = new ProjectsPage(page);
    await projects.goto();
    await expect(projects.heading()).toBeVisible();

    const projectName = `E2E Playwright Draft ${String(Date.now())}`;

    // 1. Create — a new project starts in Draft, only Name + Hub required to save.
    await projects.registerButton().click();
    const createDrawer = projects.drawer();
    await expect(createDrawer).toBeVisible();
    await createDrawer.getByLabel(/^Name/).fill(projectName);
    await createDrawer.getByLabel(/^Hub/).click();
    await page.getByRole('option').first().click();
    await createDrawer.getByRole('button', { name: 'Create draft' }).click();
    await expect(createDrawer).toBeHidden();

    // Back on the list with the new row highlighted.
    await projects.searchBox().fill(projectName);
    const row = projects.rowByName(projectName);
    await expect(row).toBeVisible();

    // 2. Hard-gate status BEFORE required fields are filled — served verbatim.
    await projects.editButtonFor(projectName).click();
    let drawer = projects.drawer();
    await expect(drawer.getByText('Required fields missing before this project can leave Draft:')).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Submit — leave Draft' })).toBeDisabled();

    // 3. Edit — fill the 7 hard-gate fields.
    await drawer.getByLabel(/^Leader/).click();
    await page.getByRole('option').filter({ hasNotText: 'Unassigned' }).first().click();
    await drawer.getByLabel(/^Category/).click();
    await page.getByRole('option', { name: 'A', exact: true }).click();
    await drawer.getByLabel(/^Type/).click();
    await page.getByRole('option').filter({ hasNotText: 'Unset' }).first().click();
    await drawer.getByLabel(/^Actual start week/).fill('12');
    await drawer.getByLabel('TCOGS (EUR)', { exact: false }).fill('1000');
    await drawer.getByLabel('Selling price (EUR)', { exact: false }).fill('1500');
    await drawer.getByLabel('Gross margin (%)', { exact: false }).fill('20');
    await drawer.getByRole('button', { name: 'Save changes' }).click();
    await expect(drawer).toBeHidden();

    // 4. Hard-gate status AFTER — re-fetched, not recomputed.
    await projects.editButtonFor(projectName).click();
    drawer = projects.drawer();
    await expect(drawer.getByText('All required fields are set — this project can leave Draft.')).toBeVisible();
    const readySubmit = drawer.getByRole('button', { name: 'Submit — leave Draft' });
    await expect(readySubmit).toBeEnabled();

    // 5. Submit — POST /projects/{id}/submit, leaves Draft for "In Queue".
    await readySubmit.click();
    await expect(drawer.getByText('Submitted. The project left Draft for In Queue.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(drawer).toBeHidden();
    await expect(row.getByText('In Queue', { exact: true })).toBeVisible();
    await expect(row.getByText('Draft', { exact: true })).toHaveCount(0);
  });

  test('unsaved edits are guarded; Escape asks, Discard closes without saving', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const projects = new ProjectsPage(page);
    await projects.goto();
    await projects.registerButton().click();
    const drawer = projects.drawer();
    await drawer.getByLabel(/^Name/).fill('Never saved');
    await page.keyboard.press('Escape');
    const confirm = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await expect(confirm).toBeVisible();
    await confirm.getByRole('button', { name: 'Discard changes' }).click();
    await expect(drawer).toBeHidden();
    await expect(projects.registerButton()).toBeFocused();
  });

  test('/register redirects to Projects; has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await page.goto('/register');
    await expect(page).toHaveURL(/\/projects$/);
    await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
