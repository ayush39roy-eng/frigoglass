import type { APIRequestContext, Browser, Page } from '@playwright/test';
import { test, expect, seriousAxeViolations } from './fixtures';
import { appendFileSync } from 'node:fs';
import { actAs, apiGet, BACKEND_URL, checkAxe, DEV_EMAILS, type DevRole } from './dev-session';
import { MatrixPage } from './pages/matrix.page';
import { ProjectsPage } from './pages/projects.page';

/**
 * Final gate (P21–P26), qa-inspector. Live checks against a DISPOSABLE stack
 * (own Postgres at p26a, client_2026 --schedule, dev-mode uvicorn, solo solver
 * worker, `vite preview --mode e2e`). Identity from the dev header (`actAs`).
 *
 * MUTATING (rubric versions, one score, alice's roles — restored): run on a
 * disposable DB only, serially, after the read-only specs.
 *
 *   RPD_E2E_BASE_URL=… RPD_E2E_BACKEND_URL=… RPD_P19_MATCH='final-gate-p21-p26' \
 *     npx playwright test -c playwright.p19qa.config.ts
 */

// Not serial: a failure must not skip the remaining checks. State shared between tests is re-read from the API.

const SHOT = process.env.RPD_FINAL_SHOTS ?? 'test-results-final-gate';
// A label per run (labels are unique and a dimension is never deleted, ADR 0037); set RPD_QA_SUFFIX to rerun.
const QA_SUFFIX = process.env.RPD_QA_SUFFIX ?? '1';
const QA_LABEL = `QA Gate Sustainability ${QA_SUFFIX}`;
const QA_PILLAR = `QA Gate Pillar ${QA_SUFFIX}`;

interface RubricDim {
  key: string;
  label: string;
  pillar: string;
  weight: number;
  inverted: boolean;
  active: boolean;
}
interface Rubric {
  version: number;
  total_weight: number;
  can_edit: boolean;
  dimensions: RubricDim[];
}
interface MatrixRow {
  project_id: string;
  project_name: string;
  hub: string;
  has_score: boolean;
  normalized_pct: number | null;
  score_band: string | null;
  suggested_band: string | null;
  capacity_fill: boolean;
  capacity_fill_reason: string | null;
  missing_dimension_keys: string[];
  rubric_version: number;
  dimension_scores: { key: string; score: number | null }[];
}
interface PreviewProject {
  project_id: string;
  project_name: string;
  new_normalized_pct: number | null;
  new_score_band: string | null;
  new_suggested_band: string | null;
  new_capacity_fill: boolean;
}
interface Preview {
  current_total_weight: number;
  proposed_total_weight: number;
  projects: PreviewProject[];
}

const H = (role: DevRole) => ({ 'X-Dev-User-Email': DEV_EMAILS[role], 'Content-Type': 'application/json' });

async function settle(page: Page): Promise<void> {
  await expect(page.getByRole('navigation', { name: 'Surfaces' })).toBeVisible({ timeout: 20_000 });
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

async function rows(request: APIRequestContext, role: DevRole = 'admin'): Promise<MatrixRow[]> {
  return apiGet<MatrixRow[]>(request, role, '/priorities?limit=1000');
}

/** P26-T03: the rubric is edited inline in the "Scoring scale and dimensions" card (was a side sheet). */
async function openSheet(page: Page): Promise<import('@playwright/test').Locator> {
  const matrix = new MatrixPage(page);
  await matrix.rubricEditButton().click();
  const sheet = matrix.rubricCard();
  await expect(sheet).toBeVisible();
  await expect(sheet.getByTestId('rubric-row').first()).toBeVisible();
  return sheet;
}

/** P26-T03: version history is a dialog opened from the card header. */
async function openHistory(page: Page): Promise<import('@playwright/test').Locator> {
  const matrix = new MatrixPage(page);
  await matrix.rubricHistoryButton().click();
  return matrix.rubricHistoryDialog();
}

async function setWeight(sheet: import('@playwright/test').Locator, label: string, weight: number): Promise<void> {
  const w = sheet.getByRole('spinbutton', { name: `Weight of ${label}` });
  await w.fill(String(weight));
}

async function save(page: Page, sheet: import('@playwright/test').Locator, reason: string): Promise<number> {
  await sheet.getByTestId('rubric-reason').fill(reason);
  const put = page.waitForResponse((r) => r.url().endsWith('/scoring-rubric') && r.request().method() === 'PUT');
  await sheet.getByRole('button', { name: 'Save new version' }).click();
  const res = await put;
  expect(res.status(), `PUT /scoring-rubric (${reason})`).toBe(200);
  const body = (await res.json()) as Rubric;
  await expect(sheet.getByText(new RegExp(`Saved as version ${String(body.version)}`))).toBeVisible();
  return body.version;
}

async function newPage(browser: Browser, role: DevRole, width = 1440): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await ctx.newPage();
  await actAs(page, role);
  return page;
}

async function qaKeyOf(request: APIRequestContext): Promise<string> {
  const r = await apiGet<Rubric>(request, 'admin', '/scoring-rubric');
  return r.dimensions.find((d) => d.label === QA_LABEL)?.key ?? '';
}

test('rubric editor as Frank Admin: weight edit preview equals the saved result; version history', async ({ page, request }) => {
  test.setTimeout(240_000);
  const r0 = await apiGet<Rubric>(request, 'admin', '/scoring-rubric');
  expect(r0.can_edit).toBe(true);
  const strategic = r0.dimensions.find((d) => d.key === 'strategic_project')!;
  console.log('rubric start', r0.version, r0.total_weight, r0.dimensions.length);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await actAs(page, 'admin');
  await page.goto('/matrix');
  await settle(page);
  const sheet = await openSheet(page);
  await expect(sheet.getByTestId('rubric-card-summary')).toContainText(`Version ${String(r0.version)}`);
  await checkAxe(page, 'rubric sheet admin 1440');

  // 1. Weight edit, preview.
  const newWeight = strategic.weight === 60 ? 55 : 60;
  await setWeight(sheet, strategic.label, newWeight);
  await expect(sheet.getByTestId('rubric-proposed-total')).toContainText(String(r0.total_weight - strategic.weight + newWeight));
  const pv = page.waitForResponse((r) => r.url().endsWith('/scoring-rubric/preview') && r.request().method() === 'POST');
  await sheet.getByRole('button', { name: 'Preview impact' }).click();
  const preview = (await (await pv).json()) as Preview;
  await expect(sheet.getByTestId('rubric-preview')).toBeVisible();
  await expect(sheet.getByTestId('rubric-preview-total')).toContainText(`${String(r0.total_weight)} → ${String(preview.proposed_total_weight)}`);
  console.log('preview', preview.current_total_weight, '→', preview.proposed_total_weight, 'projects', preview.projects.length);
  await checkAxe(page, 'rubric sheet preview 1440');
  await page.screenshot({ path: `${SHOT}/rubric-preview-1440.png` });

  // 2. Save; every previewed project's stored score / bands / fill equal the preview.
  const v1 = await save(page, sheet, 'QA final gate: Strategic Project weight');
  expect(v1).toBe(r0.version + 1);
  const after = new Map((await rows(request)).map((x) => [x.project_id, x]));
  let compared = 0;
  const diffs: string[] = [];
  for (const p of preview.projects) {
    const row = after.get(p.project_id);
    if (!row) continue;
    compared += 1;
    if (row.normalized_pct !== p.new_normalized_pct || row.score_band !== p.new_score_band || row.suggested_band !== p.new_suggested_band || row.capacity_fill !== p.new_capacity_fill) {
      diffs.push(`${p.project_name}: preview ${String(p.new_normalized_pct)}/${String(p.new_score_band)}/${String(p.new_suggested_band)}/${String(p.new_capacity_fill)} saved ${String(row.normalized_pct)}/${String(row.score_band)}/${String(row.suggested_band)}/${String(row.capacity_fill)}`);
    }
    expect(row.rubric_version).toBe(v1);
  }
  console.log('preview vs saved compared', compared, 'diffs', diffs.length);
  expect(compared).toBeGreaterThan(0);
  expect(diffs).toEqual([]);
  const r1 = await apiGet<Rubric>(request, 'admin', '/scoring-rubric');
  expect(r1.total_weight).toBe(preview.proposed_total_weight);

  // 3. Version history lists the new version on top.
  const history = await openHistory(page);
  const versions = history.getByTestId('rubric-version');
  await expect(versions).toHaveCount(v1);
  await expect(versions.first()).toContainText('QA final gate: Strategic Project weight');
  await checkAxe(page, 'rubric version history 1440');
  await page.keyboard.press('Escape');
  await expect(new MatrixPage(page).rubricHistoryButton()).toBeFocused();
});

test('rubric: add a dimension (projects become incomplete), deactivate and reactivate', async ({ page, request }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await actAs(page, 'admin');
  await page.goto('/matrix');
  await settle(page);
  let sheet = await openSheet(page);
  const scoredBefore = (await rows(request)).filter((x) => x.has_score).length;

  // Add a dimension in a new pillar.
  const form = sheet.getByTestId('rubric-add-form');
  await form.getByLabel('Label').fill(QA_LABEL);
  await form.getByLabel('Pillar').selectOption('New pillar…');
  await form.getByRole('textbox', { name: 'New pillar name' }).fill(QA_PILLAR);
  await form.getByLabel('Weight').fill('20');
  await form.getByRole('button', { name: 'Add dimension' }).click();
  await expect(sheet.getByRole('textbox', { name: `Label of ${QA_LABEL}` })).toBeFocused();
  await checkAxe(page, 'rubric sheet after add 1440');
  const vAdd = await save(page, sheet, 'QA final gate: add a dimension');
  const rAdd = await apiGet<Rubric>(request, 'admin', '/scoring-rubric');
  const qaKey = rAdd.dimensions.find((d) => d.label === QA_LABEL)!.key;
  expect(rAdd.dimensions.filter((d) => d.active)).toHaveLength(14);
  const afterAdd = await rows(request);
  const incomplete = afterAdd.filter((x) => x.has_score && x.missing_dimension_keys.includes(qaKey));
  console.log('add: version', vAdd, 'key', qaKey, 'scored', scoredBefore, 'incomplete', incomplete.length);
  expect(incomplete.length).toBe(scoredBefore);
  expect(afterAdd.every((x) => x.rubric_version === vAdd)).toBe(true);

  // The grid shows 14 dimension columns and the incomplete marker.
  await page.reload();
  await settle(page);
  await expect(page.getByRole('columnheader', { name: QA_PILLAR, exact: true })).toBeVisible();
  await expect(page.getByTestId('incomplete-marker').first()).toBeVisible();

  // Deactivate: no project is incomplete on it any more; the scores are kept.
  sheet = await openSheet(page);
  await sheet.getByRole('checkbox', { name: `Active: ${QA_LABEL}` }).click();
  await expect(sheet.getByRole('list', { name: `${QA_PILLAR} dimensions` }).getByTestId('rubric-inactive-note')).toBeVisible();
  const vOff = await save(page, sheet, 'QA final gate: deactivate');
  const off = await rows(request);
  expect(off.filter((x) => x.missing_dimension_keys.includes(qaKey))).toHaveLength(0);
  expect((await apiGet<Rubric>(request, 'admin', '/scoring-rubric')).dimensions.filter((d) => d.active)).toHaveLength(13);

  // Reactivate (a save leaves edit mode, so edit again).
  sheet = await openSheet(page);
  await sheet.getByRole('button', { name: `Reactivate ${QA_LABEL}` }).click();
  const vOn = await save(page, sheet, 'QA final gate: reactivate');
  expect(vOn).toBe(vOff + 1);
  const on = await rows(request);
  expect(on.filter((x) => x.has_score && x.missing_dimension_keys.includes(qaKey)).length).toBe(scoredBefore);
  console.log('deactivate', vOff, 'reactivate', vOn);
  await expect((await openHistory(page)).getByTestId('rubric-version')).toHaveCount(vOn);
  await page.keyboard.press('Escape');
});

test('rubric: 409 with two tabs, then reload and re-apply', async ({ browser, request }) => {
  test.setTimeout(240_000);
  const a = await newPage(browser, 'admin');
  const b = await newPage(browser, 'admin');
  for (const p of [a, b]) {
    await p.goto('/matrix');
    await settle(p);
  }
  const sa = await openSheet(a);
  const sb = await openSheet(b);
  const v = (await apiGet<Rubric>(request, 'admin', '/scoring-rubric')).version;
  await setWeight(sa, 'New Customer', 30);
  await setWeight(sb, 'New Options', 30);
  const va = await save(a, sa, 'QA final gate: tab A');
  expect(va).toBe(v + 1);
  await sb.getByTestId('rubric-reason').fill('QA final gate: tab B');
  const put = b.waitForResponse((r) => r.url().endsWith('/scoring-rubric') && r.request().method() === 'PUT');
  await sb.getByRole('button', { name: 'Save new version' }).click();
  expect((await put).status()).toBe(409);
  const conflict = sb.getByTestId('rubric-conflict');
  await expect(conflict).toContainText('Someone else changed the rubric');
  await checkAxe(b, 'rubric 409 conflict 1440');
  await conflict.getByRole('button', { name: /Reload latest version/ }).click();
  await expect(sb.getByTestId('rubric-comparison')).toBeVisible();
  await expect(sb.getByTestId('rubric-card-summary')).toContainText(`Version ${String(va)}`);
  await sb.getByRole('button', { name: new RegExp(`Re-apply my draft on version ${String(va)}`) }).click();
  const vb = await save(b, sb, 'QA final gate: tab B re-applied');
  expect(vb).toBe(va + 1);
  const r = await apiGet<Rubric>(request, 'admin', '/scoring-rubric');
  expect(r.dimensions.find((d) => d.key === 'new_customer')!.weight).toBe(30);
  expect(r.dimensions.find((d) => d.key === 'new_options')!.weight).toBe(30);
  await a.context().close();
  await b.context().close();
});

test('rubric: read only as Alice PM (UI and API)', async ({ page, request }) => {
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await actAs(page, 'portfolioManager');
    await page.goto('/matrix');
    await settle(page);
    const sheet = new MatrixPage(page).rubricCard();
    await expect(sheet.getByTestId('rubric-readonly-note')).toContainText('Read-only');
    await expect(new MatrixPage(page).rubricEditButton()).toHaveCount(0);
    await expect(sheet.getByRole('textbox')).toHaveCount(0);
    await expect(sheet.getByRole('spinbutton')).toHaveCount(0);
    await expect(sheet.getByRole('button', { name: 'Save new version' })).toHaveCount(0);
    await expect(sheet.getByTestId('rubric-add-form')).toHaveCount(0);
    await checkAxe(page, `rubric sheet read-only PM ${String(width)}`);
    await page.screenshot({ path: `${SHOT}/rubric-readonly-${String(width)}.png` });
  }
  const r = await apiGet<Rubric>(request, 'portfolioManager', '/scoring-rubric');
  expect(r.can_edit).toBe(false);
  const put = await request.put(`${BACKEND_URL}/scoring-rubric`, {
    headers: H('portfolioManager'),
    data: { version: r.version, reason: 'should be refused', dimensions: r.dimensions.map(({ key, label, pillar, weight, inverted, active }) => ({ key, label, pillar, weight, inverted, active })) },
  });
  expect(put.status()).toBe(403);
  const pv = await request.post(`${BACKEND_URL}/scoring-rubric/preview`, { headers: H('portfolioManager'), data: { dimensions: [] } });
  expect([403, 422]).toContain(pv.status());
  expect(pv.status(), 'preview refused for a PM before validation').toBe(403);
});

test('rubric editor at 390 (admin): sheet, edit and preview axe clean', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await actAs(page, 'admin');
  await page.goto('/matrix');
  await settle(page);
  const sheet = await openSheet(page);
  const box = (await sheet.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(390);
  await checkAxe(page, 'rubric sheet admin 390');
  await setWeight(sheet, 'New Customer', 31);
  await sheet.getByRole('button', { name: 'Preview impact' }).click();
  await expect(sheet.getByTestId('rubric-preview')).toBeVisible();
  await checkAxe(page, 'rubric sheet preview 390');
  await page.screenshot({ path: `${SHOT}/rubric-preview-390.png` });
  await page.keyboard.press('Escape');
});

test('grid, compare and the edit dialog with 14 dimensions; a score save completes a project', async ({ page, request }) => {
  test.setTimeout(180_000);
  const qaKey = await qaKeyOf(request);
  expect(qaKey, 'the add-dimension test ran first').not.toBe('');
  const all = await rows(request);
  const target = all.find((x) => x.has_score && x.missing_dimension_keys.includes(qaKey))!;
  const other = all.find((x) => x.has_score && x.project_id !== target.project_id)!;
  expect(target.dimension_scores).toHaveLength(14);

  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await actAs(page, 'admin');
    await page.goto('/matrix');
    await settle(page);
    await expect(page.getByRole('columnheader', { name: QA_PILLAR, exact: true })).toBeVisible();
    await checkAxe(page, `matrix grid 14 dimensions ${String(width)}`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/matrix');
  await settle(page);
  const matrix = new MatrixPage(page);

  // Compare two projects: 14 dimension score menus per project.
  await page.getByRole('searchbox').first().fill('');
  await matrix.compareCheckbox(target.project_name).first().check();
  await matrix.compareCheckbox(other.project_name).first().check();
  await page.getByRole('button', { name: 'Compare (2)' }).click();
  const cmp = matrix.compareDialog();
  await expect(cmp).toBeVisible();
  await expect(cmp).toContainText(QA_LABEL);
  await expect(cmp.getByRole('combobox', { name: new RegExp(` score for ${escapeRe(target.project_name)}$`) })).toHaveCount(14);
  await checkAxe(page, 'compare dialog 14 dimensions 1440');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Clear' }).click();

  // Edit dialog: 14 menus; score the new dimension only.
  await matrix.editButtonFor(target.project_name).first().click();
  const dlg = matrix.scoreEditDialog();
  await expect(dlg).toBeVisible();
  await expect(dlg.getByTestId('score-edit-select')).toHaveCount(14);
  await expect(dlg.getByTestId('score-edit-incomplete')).toBeVisible();
  await checkAxe(page, 'score edit dialog 14 dimensions 1440');
  const put = page.waitForRequest((r) => r.url().includes(`/priorities/${target.project_id}`) && r.method() === 'PUT');
  await dlg.getByLabel(QA_LABEL, { exact: true }).selectOption('4');
  await dlg.getByRole('button', { name: 'Save score' }).click();
  const body = (await put).postDataJSON() as { scores: Record<string, number | null> };
  console.log('score PUT body', JSON.stringify(body));
  expect(Object.keys(body.scores)).toEqual([qaKey]);
  expect(body.scores[qaKey]).toBe(4);
  await expect(dlg).toBeHidden();
  const after = (await rows(request)).find((x) => x.project_id === target.project_id)!;
  expect(after.missing_dimension_keys).not.toContain(qaKey);
});

test('capacity-fill chips agree on grid, board and workspace', async ({ page, request }) => {
  test.setTimeout(180_000);
  const all = await rows(request);
  const filled = all.filter((x) => x.capacity_fill);
  console.log('capacity_fill rows', filled.length);
  expect(filled.length).toBeGreaterThan(0);
  const board = await apiGet<{ columns: { cards: { project_id: string; suggested_band: string; score_band: string; capacity_fill: boolean; capacity_fill_reason: string | null }[] }[] }>(request, 'admin', '/priority-board');
  const cards = new Map(board.columns.flatMap((c) => c.cards).map((c) => [c.project_id, c]));
  const mismatch: string[] = [];
  for (const r of all) {
    const c = cards.get(r.project_id);
    if (!c) continue;
    if (c.capacity_fill !== r.capacity_fill || c.suggested_band !== r.suggested_band || c.score_band !== r.score_band || c.capacity_fill_reason !== r.capacity_fill_reason) mismatch.push(r.project_name);
  }
  expect(mismatch, 'board cards vs matrix rows').toEqual([]);
  const p = filled[0]!;
  const ws = await apiGet<{ priority_score: { suggested_band: string; score_band: string; capacity_fill: boolean; capacity_fill_reason: string | null } | null }>(request, 'admin', `/projects/${p.project_id}/workspace`);
  expect(ws.priority_score).toMatchObject({ suggested_band: p.suggested_band, score_band: p.score_band, capacity_fill: true, capacity_fill_reason: p.capacity_fill_reason });
  const chipName = `Suggested band P1 by capacity fill, score band ${String(p.score_band)}`;
  console.log('promoted project', p.project_name, p.hub, chipName);

  await page.setViewportSize({ width: 1440, height: 1000 });
  await actAs(page, 'admin');
  // Grid: the Capacity fill filter narrows to exactly the served promoted rows.
  await page.goto('/matrix');
  await settle(page);
  await page.getByRole('button', { name: 'Capacity fill' }).click();
  await expect(page.getByText(new RegExp(`${String(filled.length)} of ${String(all.length)} projects`))).toBeVisible();
  const gridRow = page.getByRole('row').filter({ hasText: p.project_name }).first();
  await expect(gridRow.getByRole('button', { name: chipName })).toBeVisible();
  await gridRow.getByRole('button', { name: chipName }).hover();
  await expect(page.getByTestId('band-chip-reason').first()).toHaveText(p.capacity_fill_reason ?? '');
  await checkAxe(page, 'matrix grid capacity fill filter + tooltip 1440');
  // Board (Cards and List).
  for (const layout of ['Cards', 'List'] as const) {
    await page.goto('/matrix?view=board');
    await settle(page);
    await page.getByTestId('board-layout-toggle').first().getByRole('button', { name: layout }).click();
    await page.getByRole('searchbox').first().fill(p.project_name);
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', { name: chipName }).first()).toBeVisible();
  }
  // Workspace.
  await page.goto(`/projects/${p.project_id}`);
  await expect(page.getByTestId('score-suggested-band').getByRole('button', { name: chipName })).toBeVisible();
  await expect(page.getByTestId('score-fill-reason')).toContainText(p.capacity_fill_reason ?? '');
  await checkAxe(page, 'workspace capacity fill 1440');
});

test('board tab: Cards / List, column headers never covered by the stuck panel (1440, 390)', async ({ page }) => {
  test.setTimeout(180_000);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await actAs(page, 'admin');
    await page.goto('/matrix?view=board');
    await settle(page);
    for (const layout of ['Cards', 'List'] as const) {
      const toggle = page.getByTestId('board-layout-toggle').first();
      if (await toggle.isVisible()) await toggle.getByRole('button', { name: layout }).click();
      else continue;
      await page.waitForTimeout(300);
      for (const scroll of ['top', 'bottom'] as const) {
        await page.getByTestId('surface-region').evaluate((el, s) => el.scrollTo(0, s === 'top' ? 0 : el.scrollHeight), scroll);
        await page.waitForTimeout(400);
        const covered = await page.evaluate(() => {
          const out: string[] = [];
          let seen = 0;
          for (const h of Array.from(document.querySelectorAll('[data-testid="board-column-header"]'))) {
            const r = h.getBoundingClientRect();
            const x = r.left + r.width / 2;
            const y = r.top + r.height / 2;
            if (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) continue;
            seen += 1;
            const el = document.elementFromPoint(x, y);
            if (!el || !h.contains(el)) out.push(`${(h.textContent ?? '').slice(0, 20)} -> ${el?.getAttribute('data-testid') ?? el?.tagName ?? 'none'}`);
          }
          return { seen, out };
        });
        console.log(`board ${String(width)} ${layout} ${scroll}: headers in view ${String(covered.seen)}, covered ${String(covered.out.length)}`, covered.out.join('; '));
        expect(covered.out, `board ${String(width)} ${layout} ${scroll}`).toEqual([]);
      }
      await checkAxe(page, `board ${layout} ${String(width)}`);
      await page.screenshot({ path: `${SHOT}/board-${layout}-${String(width)}.png` });
    }
  }
});

test('registration: per-field errors for every missing required field; POST 422 lists them; creates In Queue', async ({ page, request }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await actAs(page, 'portfolioManager');
  const projects = new ProjectsPage(page);
  await projects.goto();
  await settle(page);
  const posts: string[] = [];
  page.on('request', (r) => { if (r.method() === 'POST' && /\/projects$/.test(r.url())) posts.push(r.url()); });
  await projects.registerButton().click();
  const drawer = projects.drawer();
  await drawer.getByLabel(/^Name/).fill(`QA final gate ${String(Date.now())}`);
  await drawer.getByLabel(/^Hub/).click();
  await page.getByRole('option').first().click();
  await drawer.getByRole('button', { name: 'Register project' }).click();
  const errs = drawer.getByText(/ is required\.$/);
  await expect(errs.first()).toBeVisible();
  const texts = await errs.allInnerTexts();
  console.log('client-side field errors', texts);
  expect(texts.length).toBeGreaterThanOrEqual(8);
  expect(posts, 'nothing sent with missing fields').toEqual([]);
  await checkAxe(page, 'registration drawer field errors 1440');
  await page.keyboard.press('Escape');
  const discard = page.getByRole('alertdialog', { name: 'Discard unsaved changes?' });
  if (await discard.isVisible()) await discard.getByRole('button', { name: 'Discard changes' }).click();

  const hubs = await apiGet<{ id: string }[]>(request, 'admin', '/hubs');
  const res = await request.post(`${BACKEND_URL}/projects`, { headers: H('portfolioManager'), data: { name: 'QA gate API', hub_id: hubs[0]!.id } });
  expect(res.status()).toBe(422);
  const body = (await res.json()) as { code: string; detail: { field_errors: Record<string, string> } };
  console.log('POST 422', body.code, Object.keys(body.detail.field_errors));
  expect(body.code).toBe('HARD_GATE_FIELDS_MISSING');
  expect(Object.keys(body.detail.field_errors).sort()).toEqual(
    ['actual_start_week', 'category', 'gross_margin_pct', 'leader_engineer_id', 'priority', 'selling_price_eur', 'tcogs_eur', 'type'].sort(),
  );
});

test('Projects page filters show no In Buyoff / Draft; Dashboard has no Capacity booked card', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await actAs(page, 'admin');
  await page.goto('/projects');
  await settle(page);
  await page.getByRole('combobox', { name: /^Status/ }).first().click();
  const opts = await page.getByRole('option').allInnerTexts();
  console.log('Projects status options', opts);
  expect(opts.join('|')).not.toMatch(/In Buyoff|Draft/);
  expect(opts.length).toBeGreaterThanOrEqual(7);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Drafts' })).toHaveCount(0);

  const capacityCalls: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/api/capacity/')) capacityCalls.push(r.url()); });
  await page.goto('/');
  await settle(page);
  await page.getByTestId('surface-region').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.waitForTimeout(800);
  await expect(page.getByRole('heading', { name: /Capacity booked/i })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /Open capacity/i })).toHaveCount(0);
  expect(capacityCalls).toEqual([]);
});

test('Capacity Planning: 23 engineers, Dept filter enabled with served departments', async ({ page, request }) => {
  const engineers = await apiGet<unknown[]>(request, 'admin', '/engineers');
  expect(engineers).toHaveLength(23);
  const opts = await apiGet<{ requesting_departments: string[]; requesting_department_available: boolean }>(request, 'admin', '/planning/resource-load/options');
  expect(opts.requesting_department_available).toBe(true);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await actAs(page, 'admin');
    await page.goto('/planning');
    await settle(page);
    await page.getByRole('tab', { name: 'Engineers' }).click();
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(23);
    await page.getByRole('tab', { name: 'Overview' }).click();
    const dept = page.getByRole('button', { name: /^Dept filter: / });
    await dept.scrollIntoViewIfNeeded();
    await expect(dept).not.toHaveAttribute('aria-disabled', 'true');
    await expect(dept).not.toHaveAccessibleName(/unavailable/);
    await dept.click();
    const n = await page.getByRole('option').count().then(async (c) => c || page.getByRole('menuitemcheckbox').count()).then(async (c) => c || page.getByRole('checkbox').count());
    console.log(`Dept options ${String(width)}`, n, 'served', opts.requesting_departments.length);
    expect(n).toBeGreaterThanOrEqual(opts.requesting_departments.length);
    await checkAxe(page, `planning Dept filter open ${String(width)}`);
    await page.keyboard.press('Escape');
  }
});

test('multi-role user (PM + Engineer, no engineer link) sees the full Gantt', async ({ page, request }) => {
  const users = await apiGet<{ id: string; email: string; roles: string[] }[] | { items: { id: string; email: string; roles: string[] }[] }>(request, 'admin', '/users');
  const list = Array.isArray(users) ? users : users.items;
  const alice = list.find((u) => u.email === DEV_EMAILS.portfolioManager)!;
  const original = alice.roles;
  const patch = await request.patch(`${BACKEND_URL}/users/${alice.id}`, { headers: H('admin'), data: { roles: ['Portfolio Manager', 'Engineer'] } });
  expect(patch.status()).toBe(200);
  try {
    const me = await apiGet<{ roles: string[]; engineer_id: string | null }>(request, 'portfolioManager', '/me');
    expect(me.roles.sort()).toEqual(['Engineer', 'Portfolio Manager']);
    expect(me.engineer_id).toBeNull();
    const ga = await apiGet<{ rows: unknown[] }>(request, 'admin', '/gantt?limit=500');
    const gp = await apiGet<{ rows: unknown[] }>(request, 'portfolioManager', '/gantt?limit=500');
    console.log('gantt rows admin', ga.rows.length, 'PM+Engineer', gp.rows.length);
    expect(gp.rows.length).toBe(ga.rows.length);
    expect(gp.rows.length).toBeGreaterThan(0);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await actAs(page, 'portfolioManager');
    await page.goto('/timeline');
    await settle(page);
    await expect(page.getByTestId('gantt-row-details').first().or(page.getByRole('button', { name: /^Expand steps for / }).first())).toBeVisible();
    await expect(page.getByText(/No projects|Nothing to show/i)).toHaveCount(0);
    await checkAxe(page, 'gantt as PM+Engineer 1440');
  } finally {
    await request.patch(`${BACKEND_URL}/users/${alice.id}`, { headers: H('admin'), data: { roles: original } });
  }
});

test('restore: rubric back to its starting weights, QA dimension inactive', async ({ request }) => {
  const qaKey = await qaKeyOf(request);
  const r = await apiGet<Rubric>(request, 'admin', '/scoring-rubric');
  const initial: Record<string, number> = { strategic_project: 25, new_customer: 25, new_options: 25 };
  const res = await request.put(`${BACKEND_URL}/scoring-rubric`, {
    headers: H('admin'),
    data: {
      version: r.version,
      reason: 'QA final gate: restore',
      dimensions: r.dimensions.map((d) => ({ key: d.key, label: d.label, pillar: d.pillar, weight: initial[d.key] ?? d.weight, inverted: d.inverted, active: d.key === qaKey ? false : d.active })),
    },
  });
  expect(res.status()).toBe(200);
  const after = (await res.json()) as Rubric;
  console.log('restored rubric version', after.version, 'total', after.total_weight);
  expect(after.total_weight).toBe(295);
});

// ---------------------------------------------------------------------------------------------------------------
// Axe sweep: every surface, light at 1440 and 390 (gating, serious/critical), dark at 1440 (report only).
const SWEEP: { path: string; label: string; role: DevRole }[] = [
  { path: '/', label: 'Dashboard', role: 'admin' },
  { path: '/projects', label: 'Projects', role: 'admin' },
  { path: '/capacity', label: 'Capacity', role: 'admin' },
  { path: '/matrix', label: 'Matrix grid', role: 'admin' },
  { path: '/matrix?view=board', label: 'Matrix board', role: 'admin' },
  { path: '/timeline', label: 'Gantt', role: 'admin' },
  { path: '/check-in', label: 'Weekly check-in', role: 'admin' },
  { path: '/planning', label: 'Capacity planning', role: 'admin' },
  { path: '/settings/workflow', label: 'Workflow settings', role: 'superAdmin' },
  { path: '/admin/users', label: 'User admin', role: 'superAdmin' },
  { path: '/audit-log', label: 'Audit log', role: 'admin' },
  { path: '/history', label: 'Versions & History', role: 'admin' },
  { path: '/downloads', label: 'Downloads', role: 'admin' },
];

async function sweepOne(page: Page, label: string): Promise<void> {
  await page.getByTestId('surface-region').evaluate((el) => el.scrollTo(0, el.scrollHeight)).catch(() => undefined);
  await page.waitForTimeout(500);
  await page.getByTestId('surface-region').evaluate((el) => el.scrollTo(0, 0)).catch(() => undefined);
  await page.waitForTimeout(800);
  await checkAxe(page, label);
}

for (const width of [1440, 390]) {
  for (const s of SWEEP) {
    test(`axe light ${String(width)}: ${s.label}`, async ({ page }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await actAs(page, s.role);
      await page.goto(s.path);
      await settle(page);
      await sweepOne(page, `sweep light ${String(width)} ${s.label}`);
      await page.screenshot({ path: `${SHOT}/sweep-${String(width)}-${s.label.replace(/\W+/g, '-')}.png` });
    });
  }
  test(`axe light ${String(width)}: Project workspace`, async ({ page, request }) => {
    const ps = await apiGet<{ id: string }[]>(request, 'admin', '/projects?limit=5');
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await actAs(page, 'admin');
    await page.goto(`/projects/${ps[0]!.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 20_000 });
    await page.waitForLoadState('networkidle');
    await sweepOne(page, `sweep light ${String(width)} Project workspace`);
  });
}

test('axe dark 1440 (report only)', async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await actAs(page, 'admin');
  await page.goto('/');
  await settle(page);
  await page.getByRole('radio', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveClass(/dark/);
  const out = process.env.RPD_E2E_AXE_OUT;
  for (const s of SWEEP.filter((x) => x.role === 'admin')) {
    await page.goto(s.path);
    await settle(page);
    await page.waitForTimeout(500);
    const v = await seriousAxeViolations(page);
    const summary = v.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.length, sample: x.nodes[0]?.failureSummary?.split('\n').slice(0, 2).join(' | '), html: x.nodes[0]?.html.slice(0, 140) }));
    console.log(`dark ${s.label}:`, v.map((x) => `${x.id} x${String(x.nodes.length)}`).join(', ') || 'clean');
    if (out) appendFileSync(out, `${JSON.stringify({ label: `REPORT-ONLY dark 1440 ${s.label}`, count: v.length, summary })}\n`);
  }
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
