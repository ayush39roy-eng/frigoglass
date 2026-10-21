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

    // P21: the financial columns left the grid; the 13 rubric columns and
    // "Score /100" replace them.
    await expect(page.getByText('TCOGS (USD)')).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Score /100' })).toBeVisible();
  });

  test('P21: sticky View panel, chart row, rubric columns and compare', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const matrix = new MatrixPage(page);
    await matrix.goto();
    await expect(matrix.heading()).toBeVisible();

    await expect(matrix.viewPanel()).toHaveAttribute('data-stuck', 'false');
    await page.getByTestId('surface-region').evaluate((el) => el.scrollTo(0, 900));
    await expect(matrix.viewPanel()).toHaveAttribute('data-stuck', 'true');

    await expect(page.getByTestId('band-distribution')).toBeVisible();
    await expect(page.getByTestId('score-histogram')).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Strategic Alignment' })).toBeVisible();

    const boxes = matrix.compareCheckboxes();
    await boxes.nth(0).check();
    await boxes.nth(1).check();
    await page.getByRole('button', { name: 'Compare (2)' }).click();
    await expect(matrix.compareDialog()).toBeVisible();
    await expect(matrix.compareDialog().getByTestId('compare-total-row')).toContainText('/100');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(matrix.compareBar()).toHaveCount(0);
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

  test('P21-T05: the Priority board is a Matrix tab; /priority-board redirects there', async ({ page }) => {
    const matrix = new MatrixPage(page);
    await page.goto('/priority-board');
    await expect(page).toHaveURL(/\/matrix\?view=board$/);
    await expect(matrix.tab('Priority board')).toHaveAttribute('aria-selected', 'true');
    await expect(matrix.boardColumns()).toHaveCount(5);
    await matrix.tab('Scoring grid').click();
    await expect(page).toHaveURL(/\/matrix$/);
    await expect(matrix.currencyToggleGroup()).toBeVisible();
  });

  test('has no serious/critical axe violations', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    await new MatrixPage(page).goto();
    await expect(page.getByRole('heading', { name: 'Prioritization Matrix' })).toBeVisible();
    const violations = await seriousAxeViolations(page);
    expect(violations, JSON.stringify(violations, null, 2)).toEqual([]);
  });
});
