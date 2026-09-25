import { test, expect, seriousAxeViolations, loginAs } from './fixtures';
import { MatrixPage } from './pages/matrix.page';

test.describe('Prioritization Matrix surface (P4-T04)', () => {
  test('currency toggle re-fetches server-converted figures (zero client math)', async ({
    page,
  }) => {
    await loginAs(page, 'portfolioManager');
    const matrix = new MatrixPage(page);
    await matrix.goto();

    await expect(matrix.heading()).toBeVisible();
    await expect(matrix.rateCaption()).toContainText('Base currency');

    let sawCurrencyQuery = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/priorities') && req.url().includes('currency=USD')) {
        sawCurrencyQuery = true;
      }
    });

    await matrix.toggleCurrency('USD');
    await expect(matrix.rateCaption()).toContainText('Active rate: 1 EUR =');
    await expect.poll(() => sawCurrencyQuery).toBe(true);

    // Financial column headers must reflect the selected currency, sourced
    // from the server response — not recomputed in the browser.
    await expect(page.getByText('TCOGS (USD)')).toBeVisible();
  });

  test('editing a project score opens the dialog, submits, and closes it', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const matrix = new MatrixPage(page);
    await matrix.goto();
    await expect(matrix.heading()).toBeVisible();

    const editButton = matrix.firstEditButton();
    await expect(editButton).toBeVisible();
    await editButton.click();

    const dialog = matrix.scoreEditDialog();
    await expect(dialog).toBeVisible();

    await page.getByRole('button', { name: 'Save score' }).click();
    await expect(dialog).toBeHidden();
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await new MatrixPage(page).goto();
    await expect(page.getByRole('heading', { name: 'Prioritization Matrix' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
