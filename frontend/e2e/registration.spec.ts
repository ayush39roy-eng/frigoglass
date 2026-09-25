import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { RegistrationPage } from './pages/registration.page';

test.describe('Project Registration surface (P4-T06)', () => {
  test('draft -> hard-gate-status -> submit (leave Draft) end-to-end', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const registration = new RegistrationPage(page);
    await registration.goto();
    await expect(registration.heading()).toBeVisible();

    const projectName = `E2E Playwright Draft ${String(Date.now())}`;

    // 1. Create — a new project starts in Draft, only Name + Hub required to save.
    await registration.newProjectButton().click();
    const createDialog = registration.formDialog();
    await expect(createDialog).toBeVisible();
    await createDialog.getByLabel(/^Name/).fill(projectName);
    await createDialog.getByLabel(/^Hub/).click();
    await page.getByRole('option').first().click();
    await createDialog.getByRole('button', { name: 'Create draft' }).click();
    await expect(createDialog).toBeHidden();

    const row = registration.rowByName(projectName);
    await expect(row).toBeVisible();

    // 2. Hard-gate status BEFORE required fields are filled — GET
    // /projects/{id}/hard-gate-status verbatim, never recomputed client-side.
    await registration.expandButtonFor(projectName).click();
    await expect(page.getByText('Required fields missing before this project can leave Draft:')).toBeVisible();
    const submitButton = page.getByRole('button', { name: 'Submit — leave Draft' });
    await expect(submitButton).toBeDisabled();

    // 3. Edit — fill the 7 hard-gate fields (leader, category, type,
    // actual_start_week, tcogs_eur, selling_price_eur, gross_margin_pct).
    await registration.editButtonFor(projectName).click();
    const editDialog = registration.formDialog();
    await expect(editDialog).toBeVisible();

    await editDialog.getByLabel(/^Leader/).click();
    await page.getByRole('option').filter({ hasNotText: 'Unassigned' }).first().click();

    await editDialog.getByLabel(/^Category/).click();
    await page.getByRole('option', { name: 'A', exact: true }).click();

    await editDialog.getByLabel(/^Type/).click();
    await page.getByRole('option').filter({ hasNotText: 'Unset' }).first().click();

    await editDialog.getByLabel(/^Actual start week/).fill('12');
    await editDialog.getByLabel('TCOGS (EUR)', { exact: false }).fill('1000');
    await editDialog.getByLabel('Selling price (EUR)', { exact: false }).fill('1500');
    await editDialog.getByLabel('Gross margin (%)', { exact: false }).fill('20');

    await editDialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(editDialog).toBeHidden();

    // 4. Hard-gate status AFTER — re-fetched, not recomputed.
    if (!(await page.getByText('All required fields are set').isVisible())) {
      await registration.expandButtonFor(projectName).click();
    }
    await expect(page.getByText('All required fields are set — this project can leave Draft.')).toBeVisible();
    const readySubmit = page.getByRole('button', { name: 'Submit — leave Draft' });
    await expect(readySubmit).toBeEnabled();

    // 5. Submit — POST /projects/{id}/submit, leaves Draft for "In Queue".
    await readySubmit.click();
    await expect(row.getByText('In Queue', { exact: true })).toBeVisible();
    await expect(row.getByText('Draft', { exact: true })).toHaveCount(0);
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await new RegistrationPage(page).goto();
    await expect(page.getByRole('heading', { name: 'Project Registration' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
