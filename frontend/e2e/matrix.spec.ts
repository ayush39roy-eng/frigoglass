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
    await expect(page.getByRole('columnheader', { name: 'Strategic Alignment', exact: true })).toBeVisible();

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

  test('P26-T03: the rubric card is always expanded and read-only for a Portfolio Manager; version history in a dialog', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
    const matrix = new MatrixPage(page);
    await matrix.goto();
    await expect(page.getByTestId('scoring-rubric-button')).toHaveCount(0);
    const card = matrix.rubricCard();
    await expect(card.getByRole('button', { name: /Show rubric|Hide rubric/ })).toHaveCount(0);
    await expect(card.getByTestId('rubric-dimension-row').first()).toBeVisible();
    // Pillar first, one rowspan cell per pillar group, alternating tint like the grid's pillar boxes.
    await expect(card.getByRole('columnheader').first()).toHaveText('Pillar');
    await expect(card.getByTestId('rubric-pillar-group').nth(1)).toHaveAttribute('data-tint', 'true');
    await expect(card.getByTestId('rubric-readonly-note')).toContainText('Read-only · managed by Admins');
    await expect(matrix.rubricEditButton()).toHaveCount(0);
    await matrix.rubricHistoryButton().click();
    const dialog = matrix.rubricHistoryDialog();
    await expect(dialog.getByTestId('rubric-version').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(matrix.rubricHistoryButton()).toBeFocused();
    expect(await seriousAxeViolations(page)).toEqual([]);
  });

  test('P26-T03: an Admin edits inline, previews, and Cancel asks before discarding (nothing saved)', async ({ page }) => {
    await loginAs(page, 'admin');
    let puts = 0;
    page.on('request', (req) => {
      if (req.url().endsWith('/scoring-rubric') && req.method() === 'PUT') puts += 1;
    });
    const matrix = new MatrixPage(page);
    await matrix.goto();
    await matrix.rubricEditButton().click();
    const card = matrix.rubricCard();
    await expect(card.getByTestId('rubric-row').first()).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await card.getByRole('spinbutton', { name: 'Weight of New Customer' }).fill('31');
    await expect(card.getByTestId('rubric-proposed-total')).toBeVisible();
    await card.getByRole('button', { name: 'Preview impact' }).click();
    await expect(card.getByTestId('rubric-preview')).toBeVisible();
    expect(await seriousAxeViolations(page)).toEqual([]);
    await card.getByRole('button', { name: 'Cancel' }).click();
    const ask = page.getByRole('alertdialog', { name: 'Discard your rubric changes?' });
    await ask.getByRole('button', { name: 'Discard changes' }).click();
    await expect(card.getByTestId('rubric-editor')).toHaveCount(0);
    await expect(matrix.rubricEditButton()).toBeFocused();
    expect(puts).toBe(0);
  });

  test('P26-T03: Save sends the version and the reason (PUT mocked, nothing written)', async ({ page }) => {
    await loginAs(page, 'admin');
    let sent: { version: number; reason: string; dimensions: { key?: string | null; weight: number }[] } | null = null;
    await page.route('**/api/scoring-rubric', async (route) => {
      if (route.request().method() !== 'PUT') return route.fallback();
      sent = route.request().postDataJSON() as NonNullable<typeof sent>;
      const current = (await (await route.fetch({ method: 'GET' })).json()) as Record<string, unknown> & { version: number };
      await route.fulfill({ json: { ...current, version: current.version + 1, reason: sent.reason } });
    });
    const matrix = new MatrixPage(page);
    await matrix.goto();
    const summary = await matrix.rubricCard().getByTestId('rubric-card-summary').innerText();
    const version = Number(/Version (\d+)/.exec(summary)?.[1]);
    await matrix.rubricEditButton().click();
    const card = matrix.rubricCard();
    await card.getByRole('spinbutton', { name: 'Weight of New Customer' }).fill('31');
    await card.getByTestId('rubric-reason').fill('e2e mocked save');
    await card.getByRole('button', { name: 'Save new version' }).click();
    await expect(card.getByTestId('rubric-card-notice')).toContainText(`Saved as version ${String(version + 1)}`);
    expect(sent).not.toBeNull();
    expect(sent!.version).toBe(version);
    expect(sent!.reason).toBe('e2e mocked save');
    expect(sent!.dimensions.find((d) => d.key === 'new_customer')?.weight).toBe(31);
  });

  test('P21-T05: the Priority board is a Matrix tab; /priority-board redirects there', async ({ page }) => {
    await loginAs(page, 'portfolioManager');
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
