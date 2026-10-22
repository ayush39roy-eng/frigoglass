import type { Browser, Page, Route } from '@playwright/test';

import { test, expect, seriousAxeViolations } from './fixtures';
import { DEV_EMAILS } from './dev-session';
import { MatrixPage } from './pages/matrix.page';

/**
 * QA-F26-1 (final gate P21–P26): the rubric's 409 "Re-apply my draft" must
 * re-apply only the Admin's own changes on the latest version, never revert
 * another Admin's change.
 *
 * Two tabs (two browser contexts, Frank Admin, signed in from the dev login
 * page). `GET` / `PUT /scoring-rubric` are served by ONE in-test mock server
 * (seeded from the real `GET` once), so the second tab's save really gets a
 * 409 and the database is never written. Every other non-GET API call is
 * aborted.
 *
 *   tab A: New Customer 25 → 30, saved (mock v+1)
 *   tab B: New Options 25 → 30 and RM Savings 25 → 40; tab A also had RM Savings 30
 *   tab B: Save → 409 → Reload → New Options re-applied, RM Savings is a
 *          conflict ("Your value 40 · Current 30", default current) → Re-apply → Save
 *   final: New Customer 30, New Options 30, RM Savings 30
 */

interface Dim {
  key: string;
  label: string;
  pillar: string;
  weight: number;
  inverted: boolean;
  active: boolean;
  display_order: number;
  scaled_weight: number | null;
}
interface Rubric {
  version: number;
  total_weight: number;
  dimensions: Dim[];
  reason: string | null;
  [k: string]: unknown;
}
interface PutBody {
  version: number;
  reason: string;
  dimensions: { key?: string | null; label: string; pillar: string; weight: number; inverted: boolean; active: boolean }[];
}

class MockRubricServer {
  rubric: Rubric | null = null;
  puts: { version: number; status: number; body: PutBody }[] = [];

  async handle(route: Route): Promise<void> {
    const req = route.request();
    if (req.method() === 'GET') {
      if (!this.rubric) this.rubric = (await (await route.fetch()).json()) as Rubric;
      await route.fulfill({ json: this.rubric });
      return;
    }
    if (req.method() === 'PUT') {
      const body = req.postDataJSON() as PutBody;
      const current = this.rubric as Rubric;
      if (body.version !== current.version) {
        this.puts.push({ version: body.version, status: 409, body });
        await route.fulfill({
          status: 409,
          json: {
            detail: `The rubric was changed by someone else (now version ${String(current.version)}, you edited version ${String(body.version)}).`,
            code: 'RUBRIC_VERSION_CONFLICT',
          },
        });
        return;
      }
      const dims: Dim[] = body.dimensions.map((d, i) => ({
        ...(current.dimensions.find((x) => x.key === d.key) ?? ({} as Dim)),
        key: d.key ?? `mock_${String(i)}`,
        label: d.label,
        pillar: d.pillar,
        weight: d.weight,
        inverted: d.inverted,
        active: d.active,
        display_order: i + 1,
      }));
      const total = dims.filter((d) => d.active).reduce((s, d) => s + d.weight, 0);
      this.rubric = {
        ...current,
        version: current.version + 1,
        reason: body.reason,
        total_weight: total,
        dimensions: dims.map((d) => ({ ...d, scaled_weight: d.active ? Math.round((d.weight * 10000) / total) / 100 : null })),
      };
      this.puts.push({ version: body.version, status: 200, body });
      await route.fulfill({ json: this.rubric });
      return;
    }
    await route.abort();
  }
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/login');
  await page.getByRole('button', { name: new RegExp(`^Use .* — ${email.replace(/\./g, '\\.')}$`) }).click();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).not.toHaveURL(/\/login/);
}

async function adminTab(browser: Browser, server: MockRubricServer): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  // No writes reach the backend: the rubric is mocked, every other non-GET is aborted.
  // The API is `/api/...` under `vite preview --mode e2e` and `VITE_API_BASE_URL` (no prefix) under `vite dev`.
  await page.route(
    () => true,
    (route) => {
      const req = route.request();
      if (/(^|\/api)\/scoring-rubric$/.test(new URL(req.url()).pathname)) return server.handle(route);
      if (req.method() === 'GET' || req.method() === 'HEAD' || req.method() === 'OPTIONS') return route.fallback();
      return route.abort();
    },
  );
  await signIn(page, DEV_EMAILS.admin);
  return page;
}

async function setWeight(card: ReturnType<MatrixPage['rubricCard']>, label: string, weight: number): Promise<void> {
  await card.getByRole('spinbutton', { name: `Weight of ${label}` }).fill(String(weight));
}

async function saveRubric(card: ReturnType<MatrixPage['rubricCard']>, reason: string): Promise<void> {
  await card.getByTestId('rubric-reason').fill(reason);
  await card.getByRole('button', { name: 'Save new version' }).click();
}

test('QA-F26-1: two tabs, 409, re-apply keeps the other Admin\'s change and asks per field on a conflict', async ({ browser }) => {
  test.setTimeout(180_000);
  const server = new MockRubricServer();
  const a = await adminTab(browser, server);
  const b = await adminTab(browser, server);
  const ma = new MatrixPage(a);
  const mb = new MatrixPage(b);
  for (const m of [ma, mb]) {
    await m.goto();
    await m.rubricEditButton().click();
    await expect(m.rubricCard().getByTestId('rubric-row').first()).toBeVisible();
  }
  const v = (server.rubric as Rubric).version;
  const w0 = (k: string) => (server.rubric as Rubric).dimensions.find((d) => d.key === k)?.weight;
  expect([w0('new_customer'), w0('new_options'), w0('rm_savings')]).toEqual([25, 25, 25]);

  // Tab A saves New Customer 30 and RM Savings 30.
  const ca = ma.rubricCard();
  await setWeight(ca, 'New Customer', 30);
  await setWeight(ca, 'RM Savings', 30);
  await saveRubric(ca, 'QA-F26-1 tab A');
  await expect(ca.getByTestId('rubric-card-notice')).toContainText(`Saved as version ${String(v + 1)}`);
  const afterA = JSON.parse(JSON.stringify(server.rubric)) as Rubric;

  // Tab B, still on version v, edits New Options (disjoint) and RM Savings (conflict).
  const cb = mb.rubricCard();
  await setWeight(cb, 'New Options', 30);
  await setWeight(cb, 'RM Savings', 40);
  await saveRubric(cb, 'QA-F26-1 tab B');
  const conflict = cb.getByTestId('rubric-conflict');
  await expect(conflict).toContainText('Someone else changed the rubric');
  expect(server.puts.at(-1)?.status).toBe(409);
  await conflict.getByRole('button', { name: /Reload latest version/ }).click();

  const comparison = cb.getByTestId('rubric-comparison');
  await expect(comparison).toBeVisible();
  await expect(comparison.getByTestId('rubric-rebase-applied')).toContainText('New Options · weight 25 → 30');
  await expect(comparison.getByTestId('rubric-rebase-applied')).not.toContainText('New Customer');
  const field = comparison.getByRole('group', { name: 'RM Savings · weight' });
  await expect(field.getByTestId('rubric-rebase-values')).toHaveText('Your value 40 · Current 30');
  await expect(field.getByRole('radio', { name: 'Keep current (30)' })).toBeChecked();
  expect(await seriousAxeViolations(b)).toEqual([]);

  await comparison.getByRole('button', { name: `Re-apply my draft on version ${String(v + 1)}` }).click();
  await expect(cb.getByRole('spinbutton', { name: 'Weight of New Customer' })).toHaveValue('30');
  await expect(cb.getByRole('spinbutton', { name: 'Weight of New Options' })).toHaveValue('30');
  await expect(cb.getByRole('spinbutton', { name: 'Weight of RM Savings' })).toHaveValue('30');
  await saveRubric(cb, 'QA-F26-1 tab B re-applied');
  await expect(cb.getByTestId('rubric-card-notice')).toContainText(`Saved as version ${String(v + 2)}`);

  const last = server.puts.at(-1);
  expect(last?.status).toBe(200);
  expect(last?.version).toBe(v + 1);
  const sent = (k: string) => last?.body.dimensions.find((d) => d.key === k)?.weight;
  expect([sent('new_customer'), sent('new_options'), sent('rm_savings')]).toEqual([30, 30, 30]);
  // Nothing else moved: every other dimension is sent exactly as version v+1 had it.
  const strip = (d: { key?: string | null; label: string; pillar: string; weight: number; inverted: boolean; active: boolean }) =>
    ({ key: d.key, label: d.label, pillar: d.pillar, weight: d.weight, inverted: d.inverted, active: d.active });
  const others = (list: PutBody['dimensions']) => list.filter((d) => d.key !== 'new_options').map(strip);
  expect(others(last?.body.dimensions ?? [])).toEqual(others([...afterA.dimensions].sort((x, y) => x.display_order - y.display_order)));
  expect(server.puts.filter((p) => p.status === 200)).toHaveLength(2);
  await a.context().close();
  await b.context().close();
});
