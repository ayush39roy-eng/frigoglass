import { test, expect } from './fixtures';
import { actAs, apiGet, checkAxe } from './dev-session';

/**
 * P9-T05 (qa-inspector) — P9 changes on existing surfaces: Gantt completion
 * markers (I16 cross-check against the stored API values), Capacity supply
 * breakdown (ADR 0008), Registration P9 fields + OEM categories; axe on each.
 */

interface GanttRow {
  project_id: string;
  expected_end_week: number | null;
  projected_end_week: number | null;
}
interface GanttResponse {
  rows: GanttRow[];
}

test.describe('Gantt completion markers (P9, I16)', () => {
  test('marker weeks equal the stored API values; legend present; axe clean', async ({
    page,
    request,
  }) => {
    const api = await apiGet<GanttResponse>(request, 'superAdmin', '/gantt?limit=500');
    const expectedWeeks = new Set(
      api.rows.map((r) => r.expected_end_week).filter((w): w is number => w !== null),
    );
    const projectedWeeks = new Set(
      api.rows.map((r) => r.projected_end_week).filter((w): w is number => w !== null),
    );

    await actAs(page, 'superAdmin');
    await page.goto('/timeline');
    await expect(
      page.getByRole('heading', { name: 'Project Execution Timeline', exact: true }),
    ).toBeVisible();
    const markers = page.getByTestId('gantt-completion-markers');
    await expect(markers.first()).toBeVisible();
    await expect(page.getByText('Will be completed (active run + delay)')).toBeVisible();

    const expectedDom = await page
      .locator('[data-testid="gantt-marker-expected"]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-week'))));
    const projectedDom = await page
      .locator('[data-testid="gantt-marker-projected"]')
      .evaluateAll((els) => els.map((e) => Number(e.getAttribute('data-week'))));
    expect(expectedDom.length).toBeGreaterThan(0);
    for (const w of expectedDom) expect(expectedWeeks.has(w), `expected W${String(w)}`).toBe(true);
    for (const w of projectedDom) expect(projectedWeeks.has(w), `projected W${String(w)}`).toBe(true);

    await checkAxe(page, 'Gantt: completion markers');
  });
});

test.describe('Capacity supply breakdown (P9, ADR 0008)', () => {
  test('breakdown expands, horizon toggles; axe clean', async ({ page }) => {
    await actAs(page, 'superAdmin');
    await page.goto('/capacity');
    await expect(page.getByRole('heading', { name: 'RPD Capacity', exact: true })).toBeVisible();
    const how = page.getByText('How this is calculated').first();
    await expect(how).toBeVisible();
    await how.click();
    await page.getByRole('radio', { name: 'Remaining year' }).click();
    await expect(page.getByRole('radio', { name: 'Remaining year' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await page.waitForTimeout(300);
    await checkAxe(page, 'Capacity: breakdown expanded, remaining year');
  });
});

test.describe('Registration P9 fields (P9 contract §6)', () => {
  test('new fields present, OEM hub narrows categories; axe clean', async ({ page }) => {
    await actAs(page, 'superAdmin');
    await page.goto('/register');
    await expect(
      page.getByRole('heading', { name: 'Project Registration', exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Expected completion (week)')).toBeVisible();
    await expect(dialog.getByText('Certification testing required')).toBeVisible();
    await expect(dialog.getByLabel('Estimated design weeks')).toBeVisible();
    await expect(dialog.getByLabel('Estimated lab weeks')).toBeVisible();

    await dialog.locator('#reg-hub').click();
    await page.getByRole('option', { name: 'OEM-HCK' }).click();
    await dialog.locator('#reg-category').click();
    const options = await page.getByRole('option').allInnerTexts();
    expect(options).toEqual(expect.arrayContaining(['A-OEM', 'B-OEM', 'C-OEM']));
    expect(options).not.toContain('A+');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await page.waitForTimeout(500);

    await checkAxe(page, 'Registration: create dialog, OEM hub');
  });
});
