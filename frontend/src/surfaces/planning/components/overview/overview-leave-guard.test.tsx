import { afterEach, describe, expect, it } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom';

import { seriousAxeViolations } from '@/test/axe';

import { selectAnyDirty, useCardEditStore } from './card-edit-store';
import { OverviewLeaveGuard } from './overview-leave-guard';

/**
 * Owner ask 2026-11-17: leaving Capacity Planning with unsaved card edits
 * asks first. PlanningPage tests mount a plain MemoryRouter, so the blocker
 * and the beforeunload listener are pinned here.
 */
function makeDirty(): void {
  act(() => {
    const s = useCardEditStore.getState();
    s.begin('hub:R&D-Greece');
    s.setField('hub:R&D-Greece', 'e1', 'fte', '0.8');
  });
}

describe('card edit store', () => {
  afterEach(() => useCardEditStore.getState().reset());

  it('edit mode alone is not dirty; a draft is; setting back to served (undefined) clears it', () => {
    const s = useCardEditStore.getState();
    s.begin('lab:Greece');
    expect(selectAnyDirty(useCardEditStore.getState())).toBe(false);
    s.setField('lab:Greece', 'c1', 'platforms', '3');
    expect(selectAnyDirty(useCardEditStore.getState())).toBe(true);
    s.setField('lab:Greece', 'c1', 'platforms', undefined);
    expect(useCardEditStore.getState().cards['lab:Greece']?.drafts).toEqual({});
  });

  it('settle keeps failed rows only, and leaves edit mode when nothing failed', () => {
    const s = useCardEditStore.getState();
    s.begin('lab:Greece');
    s.setField('lab:Greece', 'c1', 'platforms', '3');
    s.setField('lab:Greece', 'c2', 'efficiency', '0.5');
    s.settle('lab:Greece', ['c1'], { c2: 'Not saved. Please try again.' });
    const card = useCardEditStore.getState().cards['lab:Greece'];
    expect(card?.drafts).toEqual({ c2: { efficiency: '0.5' } });
    expect(card?.errors).toEqual({ c2: 'Not saved. Please try again.' });
    s.settle('lab:Greece', ['c2'], {});
    expect(useCardEditStore.getState().cards['lab:Greece']).toBeUndefined();
  });

  it('pruneRows drops drafts of rows no longer listed', () => {
    const s = useCardEditStore.getState();
    s.begin('hub:X');
    s.setField('hub:X', 'gone', 'fte', '2');
    s.pruneRows('hub:X', ['other']);
    expect(selectAnyDirty(useCardEditStore.getState())).toBe(false);
  });
});

describe('OverviewLeaveGuard', () => {
  afterEach(() => useCardEditStore.getState().reset());

  it('warns before unloading only while a card holds a draft', () => {
    render(<OverviewLeaveGuard />);
    const clean = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    makeDirty();
    const dirty = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);

    act(() => useCardEditStore.getState().end('hub:R&D-Greece'));
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  function renderInDataRouter() {
    const router = createMemoryRouter(
      [
        {
          path: '/planning',
          element: (
            <>
              <Link to="/gantt">Go to Gantt</Link>
              <OverviewLeaveGuard />
            </>
          ),
        },
        { path: '/gantt', element: <p>Gantt page</p> },
      ],
      { initialEntries: ['/planning'] },
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  it('blocks in-app navigation with unsaved edits; Stay keeps the page, Leave proceeds', async () => {
    const user = userEvent.setup();
    const router = renderInDataRouter();
    makeDirty();
    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Leave with unsaved capacity edits?' });
    expect(await seriousAxeViolations(document.body)).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Stay on this page' }));
    expect(router.state.location.pathname).toBe('/planning');

    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave and discard' }));
    expect(await screen.findByText('Gantt page')).toBeInTheDocument();
  });

  it('lets navigation through when nothing is unsaved', async () => {
    const user = userEvent.setup();
    renderInDataRouter();
    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    expect(await screen.findByText('Gantt page')).toBeInTheDocument();
  });
});
