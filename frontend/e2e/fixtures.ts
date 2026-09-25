import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { test as base, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

import type { DevUserKey } from './global-setup';

/**
 * P4-T09 (qa-inspector) auth fixture.
 *
 * The frontend has no browser-side login flow yet (`docs/MEMORY.md`
 * P4-T04-review: "no `/me` endpoint; frontend auth is P6-T03"), so nothing in
 * app code ever attaches an `Authorization` header. To exercise the real
 * backend end-to-end anyway, `loginAs(role)` installs a Playwright network
 * route on `/api/**` (the E2E-only same-origin proxy path — see
 * `vite.config.ts`) that injects a real Keycloak-issued bearer token minted
 * by `global-setup.ts`. This is request-level test instrumentation, not a
 * change to any application source file, and it does not weaken the real
 * `backend/core/oidc.py` verification the backend still performs on every
 * request.
 */

function loadTokens(): Record<DevUserKey, string> {
  const p = path.join(fileURLToPath(new URL('.', import.meta.url)), '.tokens.json');
  return JSON.parse(readFileSync(p, 'utf-8')) as Record<DevUserKey, string>;
}

let tokensCache: Record<DevUserKey, string> | null = null;
function tokens(): Record<DevUserKey, string> {
  tokensCache ??= loadTokens();
  return tokensCache;
}

export async function loginAs(page: Page, role: DevUserKey): Promise<void> {
  const token = tokens()[role];
  await page.route('**/api/**', async (route) => {
    const headers = { ...route.request().headers(), Authorization: `Bearer ${token}` };
    await route.continue({ headers });
  });
}

/** Runs an axe-core scan against the currently-rendered page and returns only
 *  `serious`/`critical` violations — the gate the `qa-testing` skill defines
 *  ("moderate and below are logged but don't fail the build"). */
export async function seriousAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
}

export const test = base;
export { expect } from '@playwright/test';
