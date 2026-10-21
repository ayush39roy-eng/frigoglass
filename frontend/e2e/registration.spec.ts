import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { ProjectsPage } from './pages/projects.page';

/**
 * Project Registration (P4-T06), merged into the Projects page in P22-T01:
 * the form is a drawer opened from "Register project" / "Edit registration",
 * and (P23, ADR 0034) a project is registered In Queue once its hard-gate
 * fields are set; the leave-Draft gate only remains for legacy Draft rows.
 */
test.describe('Project Registration on the Projects page (P4-T06, P22-T01)', () => {
  test('register -> required fields checked -> created In Queue (P23, no Draft step)', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const projects = new ProjectsPage(page);
    await projects.goto();
    await expect(projects.heading()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Drafts' })).toHaveCount(0);

    const projectName = `E2E Playwright Register ${String(Date.now())}`;

    // 1. Name + Hub alone no longer register: the eight hard-gate fields are checked first.
    await projects.registerButton().click();
    const drawer = projects.drawer();
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Create draft' })).toHaveCount(0);
    await drawer.getByLabel(/^Name/).fill(projectName);
    await drawer.getByLabel(/^Hub/).click();
    await page.getByRole('option').first().click();
    await drawer.getByRole('button', { name: 'Register project' }).click();
    await expect(drawer.getByText('Fill in the required fields marked * to register the project.')).toBeVisible();
    await expect(drawer.getByText('TCOGS is required.')).toBeVisible();

    // 2. Fill them and register — POST /projects creates the project In Queue.
    await drawer.getByLabel(/^Leader/).click();
    await page.getByRole('option').filter({ hasNotText: 'Unassigned' }).first().click();
    await drawer.getByLabel(/^Category/).click();
    await page.getByRole('option', { name: 'A', exact: true }).click();
    await drawer.getByLabel(/^Type/).click();
    await page.getByRole('option').filter({ hasNotText: 'Unset' }).first().click();
    await drawer.getByLabel(/^Priority/).click();
    await page.getByRole('option', { name: 'P3', exact: true }).click();
    await drawer.getByLabel(/^Actual start week/).fill('12');
    await drawer.getByLabel('TCOGS (EUR)', { exact: false }).fill('1000');
    await drawer.getByLabel('Selling price (EUR)', { exact: false }).fill('1500');
    await drawer.getByLabel('Gross margin (%)', { exact: false }).fill('20');
    await drawer.getByRole('button', { name: 'Register project' }).click();
    await expect(drawer).toBeHidden();

    // 3. Back on the list: the row is In Queue, never Draft, and has no leave-Draft gate.
    await projects.searchBox().fill(projectName);
    const row = projects.rowByName(projectName);
    await expect(row).toBeVisible();
    await expect(row.getByText('In Queue', { exact: true })).toBeVisible();
    await expect(row.getByText('Draft', { exact: true })).toHaveCount(0);
    await projects.editButtonFor(projectName).click();
    await expect(projects.drawer().getByText('Leave Draft')).toHaveCount(0);
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
