import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { actAs, apiGet, BACKEND_URL, checkAxe, DEV_EMAILS } from './dev-session';

/**
 * P36-T05 gate (qa-inspector): rank within a priority band (ADR 0050,
 * docs/API_CONTRACT_P36.md), end-to-end against the real backend.
 *
 *  1. Unfiltered board: drag the P1 card at position 3 above the card at
 *     position 2 -> preview dialog -> "Yes, apply" -> after refetch the card is
 *     second with chip "#2", the served band_rank is 2, and a schedule run with
 *     trigger_reason band_rank_move is active.
 *  2. Filtered board (search "Coke"): drag the last visible P1 card above the
 *     second visible one, which has hidden cards between them -> it takes the
 *     anchor's rank (before_project_id placement in the FULL band).
 *  3. Read-only role (Executive Viewer): chips visible, no drag handle.
 *
 * Mutates the disposable gate DB only.
 */

interface Card {
  project_id: string;
  name: string;
  band_rank: number | null;
  status: string;
}
interface Board {
  run_id: string | null;
  columns: { priority: string; count: number; cards: Card[] }[];
}

async function p1Cards(request: APIRequestContext, q = ''): Promise<Card[]> {
  const board = await apiGet<Board>(request, 'admin', `/priority-board${q}`);
  const col = board.columns.find((c) => c.priority === 'P1');
  if (!col) throw new Error('no P1 column');
  return col.cards;
}

async function activeRun(request: APIRequestContext): Promise<string | null> {
  const board = await apiGet<Board>(request, 'admin', '/priority-board');
  return board.run_id;
}

function p1Column(page: Page) {
  return page.locator('[data-testid="board-column"][data-priority="P1"]');
}

async function openBoard(page: Page): Promise<void> {
  await page.goto('/matrix?view=board');
  await expect(p1Column(page).locator('[data-testid="board-card"]').first()).toBeVisible({ timeout: 30_000 });
}

async function dragAbove(page: Page, sourceId: string, targetId: string): Promise<void> {
  const col = p1Column(page);
  const source = col.locator(`[data-testid="board-card"][data-project-id="${sourceId}"]`);
  const target = col.locator(`[data-testid="board-card"][data-project-id="${targetId}"]`);
  await target.scrollIntoViewIfNeeded();
  await source.dragTo(target, { targetPosition: { x: 40, y: 3 } });
}

async function confirmDialog(page: Page, expectedTitle: RegExp): Promise<void> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading').first()).toHaveText(expectedTitle);
  await checkAxe(page, 'p36 re-rank preview dialog');
  await dialog.getByRole('button', { name: /Yes, apply/ }).click();
}

test.describe('P36 rank within a priority band', () => {
  test('unfiltered: P1 card dragged to 2nd position, preview, Yes, #2 after refetch, run recorded', async ({ page, request }) => {
    const before = await p1Cards(request);
    const ranked = before.filter((c) => c.band_rank !== null);
    expect(ranked.length).toBeGreaterThanOrEqual(3);
    const mover = ranked[2]; // band_rank 3
    const anchor = ranked[1]; // band_rank 2
    expect(mover.band_rank).toBe(3);
    const runBefore = await activeRun(request);

    await actAs(page, 'admin');
    await openBoard(page);
    await checkAxe(page, 'p36 priority board (admin, unfiltered)');
    const chip = p1Column(page)
      .locator(`[data-testid="board-card"][data-project-id="${mover.project_id}"]`)
      .getByTestId('board-rank-chip');
    await expect(chip).toHaveText(/^#3(?!\d)/);

    await dragAbove(page, mover.project_id, anchor.project_id);
    await confirmDialog(page, /position 2 in P1/);

    // After refetch: card is 2nd in the column and shows #2.
    await expect(chip).toHaveText(/^#2(?!\d)/, { timeout: 30_000 });
    const domIds = await p1Column(page)
      .locator('[data-testid="board-card"]')
      .evaluateAll((els) => els.map((e) => e.getAttribute('data-project-id')));
    expect(domIds[1]).toBe(mover.project_id);
    expect(domIds[2]).toBe(anchor.project_id);

    const after = await p1Cards(request);
    expect(after.find((c) => c.project_id === mover.project_id)?.band_rank).toBe(2);
    expect(after.find((c) => c.project_id === anchor.project_id)?.band_rank).toBe(3);
    // I37b: dense 1..n.
    const ranks = after.map((c) => c.band_rank).filter((r): r is number => r !== null);
    expect(ranks).toEqual(ranks.map((_, i) => i + 1));

    await expect.poll(() => activeRun(request), { timeout: 30_000 }).not.toBe(runBefore);
    console.log(`P36 e2e unfiltered: run ${String(runBefore)} -> ${String(await activeRun(request))}`);
  });

  test('filtered (search "Coke"): drop above 2nd visible card takes the anchor rank in the full band', async ({ page, request }) => {
    const visible = (await p1Cards(request, '?q=Coke')).filter((c) => c.band_rank !== null);
    const full = await p1Cards(request);
    test.skip(visible.length < 3, 'need >=3 visible ranked Coke cards');
    const anchor = visible[1];
    const mover = visible[visible.length - 1];
    const anchorRank = anchor.band_rank as number;
    const moverRank = mover.band_rank as number;
    expect(moverRank - anchorRank).toBeGreaterThan(1); // hidden cards in between
    const runBefore = await activeRun(request);

    await actAs(page, 'admin');
    await openBoard(page);
    const search = page.getByPlaceholder('Project name or code').first();
    await search.fill('Coke');
    await expect(p1Column(page).locator('[data-testid="board-card"]')).toHaveCount(
      (await p1Cards(request, '?q=Coke')).length,
      { timeout: 15_000 },
    );
    await checkAxe(page, 'p36 priority board (admin, filtered)');

    await dragAbove(page, mover.project_id, anchor.project_id);
    await confirmDialog(page, new RegExp(`position ${String(anchorRank)} in P1`));

    const chip = p1Column(page)
      .locator(`[data-testid="board-card"][data-project-id="${mover.project_id}"]`)
      .getByTestId('board-rank-chip');
    await expect(chip).toHaveText(new RegExp(`^#${String(anchorRank)}(?!\\d)`), { timeout: 30_000 });

    const after = await p1Cards(request);
    const rankOf = (id: string) => after.find((c) => c.project_id === id)?.band_rank;
    expect(rankOf(mover.project_id)).toBe(anchorRank);
    expect(rankOf(anchor.project_id)).toBe(anchorRank + 1);
    // Every other project keeps its relative order.
    const order = (cards: Card[]) =>
      cards
        .filter((c) => c.band_rank !== null && c.project_id !== mover.project_id)
        .sort((a, b) => (a.band_rank as number) - (b.band_rank as number))
        .map((c) => c.project_id);
    expect(order(after)).toEqual(order(full));
    await expect.poll(() => activeRun(request), { timeout: 30_000 }).not.toBe(runBefore);
  });

  test('read-only role sees order chips but no drag handle', async ({ page }) => {
    await actAs(page, 'executiveViewer');
    await openBoard(page);
    await expect(p1Column(page).getByTestId('board-rank-chip').first()).toBeVisible();
    await expect(page.getByTestId('board-drag-handle')).toHaveCount(0);
    await checkAxe(page, 'p36 priority board (executive viewer)');
  });

  test('API: anchor out of hub scope answers NOT_SAME_BAND exactly like a nonexistent anchor', async ({ request }) => {
    const hdr = { 'X-Dev-User-Email': DEV_EMAILS.hubPlanner, 'Content-Type': 'application/json' };
    const own = await apiGet<Board>(request, 'hubPlanner', '/priority-board');
    const all = await apiGet<Board>(request, 'admin', '/priority-board');
    const ownIds = new Set(own.columns.flatMap((c) => c.cards.map((k) => k.project_id)));
    let mover: Card | undefined;
    let foreign: Card | undefined;
    for (const col of all.columns) {
      const ranked = col.cards.filter((c) => c.band_rank !== null);
      const m = ranked.find((c) => ownIds.has(c.project_id));
      const f = ranked.find((c) => !ownIds.has(c.project_id));
      if (m && f) {
        mover = m;
        foreign = f;
        break;
      }
    }
    test.skip(!mover || !foreign, 'no band with both in-scope and out-of-scope projects');
    const post = (anchor: string) =>
      request.post(`${BACKEND_URL}/projects/${mover!.project_id}/band-rank/preview`, {
        headers: hdr,
        data: { before_project_id: anchor, after_project_id: null },
      });
    const r1 = await post(foreign!.project_id);
    const r2 = await post('00000000-0000-0000-0000-000000000000');
    expect(r1.status()).toBe(422);
    expect(r2.status()).toBe(422);
    expect(await r1.json()).toEqual(await r2.json());
  });
});
