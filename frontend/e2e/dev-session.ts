import type { APIRequestContext, Page } from '@playwright/test';

/**
 * P9-T05 (qa-inspector): dev-mode identity helper for the P9 specs.
 *
 * ADR 0010 / P9-T03: when the backend runs with `RPD_DEV_MODE=true`, an
 * unauthenticated request carrying `X-Dev-User-Email: <seeded email>` acts as
 * that user. The frontend's own dev role switcher stores the chosen email in
 * `sessionStorage['rpd-dev-user-email']` and `lib/api/client.ts` attaches the
 * header from there — so seeding that key before the app boots exercises the
 * real application path (no request interception). `sam.super` is not in the
 * long-running dev Keycloak realm (MEMORY P9-T03), so the P9 specs use this
 * path for every role rather than the Keycloak-token `loginAs` fixture.
 */

export const DEV_EMAILS = {
  superAdmin: 'sam.super@example.com',
  admin: 'frank.admin@example.com',
  portfolioManager: 'alice.pm@example.com',
  hubPlanner: 'bob.hub@example.com',
  engineer: 'carol.eng@example.com',
  executiveViewer: 'dave.exec@example.com',
  auditor: 'erin.audit@example.com',
} as const;

export type DevRole = keyof typeof DEV_EMAILS;

export const BACKEND_URL = process.env.RPD_E2E_BACKEND_URL ?? 'http://localhost:8010';

export async function actAs(page: Page, role: DevRole): Promise<void> {
  const email = DEV_EMAILS[role];
  await page.addInitScript((value) => {
    window.sessionStorage.setItem('rpd-dev-user-email', value);
  }, email);
}

/** Direct backend call (bypasses the browser) as a dev user — used only to
 *  discover fixture ids and to cross-check UI values against stored API values. */
export async function apiGet<T>(
  request: APIRequestContext,
  role: DevRole,
  path: string,
): Promise<T> {
  const res = await request.get(`${BACKEND_URL}${path}`, {
    headers: { 'X-Dev-User-Email': DEV_EMAILS[role] },
  });
  if (!res.ok()) throw new Error(`GET ${path} as ${role} -> ${String(res.status())}`);
  return (await res.json()) as T;
}

/**
 * Runs the serious/critical axe scan, appends a compact summary (rule id,
 * impact, node count, first targets) to `$RPD_E2E_AXE_OUT` when set, and
 * soft-asserts zero violations so the functional flow keeps running and the
 * gate report gets every finding, not just the first.
 */
export async function checkAxe(page: Page, label: string): Promise<void> {
  const { seriousAxeViolations, expect } = await import('./fixtures');
  const violations = await seriousAxeViolations(page);
  const out = process.env.RPD_E2E_AXE_OUT;
  if (out) {
    const { appendFileSync } = await import('node:fs');
    const summary = violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.length,
      targets: v.nodes.slice(0, 4).map((n) => n.target.join(' ')),
      sample: v.nodes[0]?.failureSummary?.split('\n').slice(0, 3).join(' | '),
      html: v.nodes[0]?.html.slice(0, 180),
    }));
    appendFileSync(out, `${JSON.stringify({ label, count: violations.length, summary })}\n`);
  }
  expect.soft(violations.map((v) => `${v.id} (${String(v.impact)}) x${String(v.nodes.length)}`), label).toEqual([]);
}
