import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom';

import { seriousAxeViolations } from '@/test/axe';

import { GridLeaveGuard } from './grid-edit-bar';

/**
 * P34-T04 (qa-inspector): the grid edit session's leave guard. The page tests
 * mount a plain MemoryRouter, so the data-router blocker and the beforeunload
 * listener are pinned here directly.
 */
describe('GridLeaveGuard (P34-T02 unsaved grid edits)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('warns before unloading only while there are unsaved edits, and removes the listener after', () => {
    const add = vi.spyOn(window, 'addEventListener');
    const remove = vi.spyOn(window, 'removeEventListener');
    const { rerender } = render(<GridLeaveGuard when={false} />);
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(0);

    rerender(<GridLeaveGuard when />);
    expect(add.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);

    rerender(<GridLeaveGuard when={false} />);
    expect(remove.mock.calls.filter(([t]) => t === 'beforeunload')).toHaveLength(1);
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  function renderInDataRouter(when: boolean) {
    const router = createMemoryRouter(
      [
        {
          path: '/matrix',
          element: (
            <>
              <Link to="/gantt">Go to Gantt</Link>
              <Link to="/matrix?tab=board">Board tab</Link>
              <GridLeaveGuard when={when} />
            </>
          ),
        },
        { path: '/gantt', element: <p>Gantt page</p> },
      ],
      { initialEntries: ['/matrix'] },
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  it('blocks an in-app navigation with unsaved edits; "Stay" keeps the page, "Leave and discard" proceeds', async () => {
    const user = userEvent.setup();
    const router = renderInDataRouter(true);

    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    const ask = await screen.findByRole('alertdialog', { name: 'Leave with unsaved score edits?' });
    expect(await seriousAxeViolations(document.body)).toEqual([]);
    await user.click(within(ask).getByRole('button', { name: 'Stay on this page' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/matrix');

    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave and discard' }),
    );
    expect(await screen.findByText('Gantt page')).toBeInTheDocument();
  });

  it('does not block a same-page change (query string) or any navigation without unsaved edits', async () => {
    const user = userEvent.setup();
    const router = renderInDataRouter(true);
    await user.click(screen.getByRole('link', { name: 'Board tab' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(router.state.location.search).toBe('?tab=board');
  });

  it('lets a navigation through at once when nothing is unsaved', async () => {
    const user = userEvent.setup();
    renderInDataRouter(false);
    await user.click(screen.getByRole('link', { name: 'Go to Gantt' }));
    expect(await screen.findByText('Gantt page')).toBeInTheDocument();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
