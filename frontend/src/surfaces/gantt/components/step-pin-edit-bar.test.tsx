import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, RouterProvider, createMemoryRouter } from 'react-router-dom';

import { StepPinEditBar, StepPinLeaveGuard } from './step-pin-edit-bar';

/**
 * P40-R02 (qa note on the P40 gate): the unsaved step-weeks bar's own states
 * and the leave guard (reload and in-app navigation with unsaved weeks).
 */

function bar(over: Partial<ComponentProps<typeof StepPinEditBar>> = {}) {
  const props: ComponentProps<typeof StepPinEditBar> = {
    changedCount: 1,
    projectCount: 1,
    invalidCount: 0,
    onSave: vi.fn(),
    onCancel: vi.fn(),
    saving: false,
    error: null,
    tooMany: null,
    ...over,
  };
  render(<StepPinEditBar {...props} />);
  return props;
}

describe('StepPinEditBar', () => {
  it('counts steps and projects (plural), and Save / Cancel call back', async () => {
    const user = userEvent.setup();
    const props = bar({ changedCount: 3, projectCount: 2 });
    expect(screen.getByTestId('step-pin-edit-count')).toHaveTextContent('3 steps changed in 2 projects');
    expect(screen.queryByTestId('step-pin-edit-error')).not.toBeInTheDocument();
    await user.click(screen.getByTestId('step-pin-edit-save'));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(props.onSave).toHaveBeenCalledTimes(1);
    expect(props.onCancel).toHaveBeenCalledTimes(1);
  });

  it('red steps: a status message (plural) and Save disabled', () => {
    bar({ changedCount: 2, invalidCount: 2 });
    const msg = screen.getByTestId('step-pin-edit-error');
    expect(msg).toHaveTextContent('2 steps have weeks in red: fix them to save.');
    expect(msg).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('step-pin-edit-save')).toBeDisabled();
  });

  it('too many steps: an alert and Save disabled', () => {
    bar({ tooMany: 'One save takes at most 500 steps. Save fewer at a time.' });
    const msg = screen.getByTestId('step-pin-edit-error');
    expect(msg).toHaveAttribute('role', 'alert');
    expect(msg).toHaveTextContent('at most 500 steps');
    expect(screen.getByTestId('step-pin-edit-save')).toBeDisabled();
  });

  it('a save error wins over the red-steps text; while saving both buttons are disabled', () => {
    bar({ error: 'Nothing was saved.', invalidCount: 1, saving: true });
    expect(screen.getByTestId('step-pin-edit-error')).toHaveTextContent('Nothing was saved.');
    expect(screen.getByTestId('step-pin-edit-error')).toHaveAttribute('role', 'alert');
    expect(screen.getByTestId('step-pin-edit-save')).toHaveTextContent('Saving…');
    expect(screen.getByTestId('step-pin-edit-save')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  });
});

describe('StepPinLeaveGuard', () => {
  it('asks the browser before unload only while there are unsaved weeks', () => {
    const { rerender } = render(<StepPinLeaveGuard when />);
    const ev = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);

    rerender(<StepPinLeaveGuard when={false} />);
    const ev2 = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  function renderInDataRouter(when: boolean) {
    const router = createMemoryRouter(
      [
        {
          path: '/gantt',
          element: (
            <>
              <Link to="/dashboard">Go to dashboard</Link>
              <StepPinLeaveGuard when={when} />
            </>
          ),
        },
        { path: '/dashboard', element: <p>Dashboard page</p> },
      ],
      { initialEntries: ['/gantt'] },
    );
    render(<RouterProvider router={router} />);
    return router;
  }

  it('in-app navigation with unsaved weeks asks; "Stay" keeps the page', async () => {
    const user = userEvent.setup();
    const router = renderInDataRouter(true);
    await user.click(screen.getByRole('link', { name: 'Go to dashboard' }));
    const dialog = await screen.findByTestId('step-pin-leave-dialog');
    expect(dialog).toHaveTextContent('Leave with unsaved step weeks?');
    await user.click(screen.getByRole('button', { name: 'Stay on this page' }));
    expect(router.state.location.pathname).toBe('/gantt');
    expect(screen.queryByTestId('step-pin-leave-dialog')).not.toBeInTheDocument();
  });

  it('"Leave and discard" proceeds', async () => {
    const user = userEvent.setup();
    const router = renderInDataRouter(true);
    await user.click(screen.getByRole('link', { name: 'Go to dashboard' }));
    await user.click(await screen.findByRole('button', { name: 'Leave and discard' }));
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/dashboard');
  });

  it('without unsaved weeks navigation is not blocked', async () => {
    const user = userEvent.setup();
    renderInDataRouter(false);
    await user.click(screen.getByRole('link', { name: 'Go to dashboard' }));
    expect(await screen.findByText('Dashboard page')).toBeInTheDocument();
    expect(screen.queryByTestId('step-pin-leave-dialog')).not.toBeInTheDocument();
  });
});
