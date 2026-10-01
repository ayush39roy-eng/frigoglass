import { describe, expect, it } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderApp } from '@/test/render';
import { SURFACES } from './nav';

describe('App shell + routing', () => {
  it('renders the Global RPD Dashboard surface at "/"', async () => {
    renderApp('/');
    expect(await screen.findByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
  });

  it('lists every surface (the original six plus the Audit Log) in the sidebar nav', async () => {
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    for (const surface of SURFACES) {
      expect(within(nav).getByRole('link', { name: surface.label })).toBeInTheDocument();
    }
  });

  it('navigates to the Capacity surface on nav click', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('link', { name: 'Capacity' }));
    expect(await screen.findByRole('heading', { name: 'RPD Capacity' })).toBeInTheDocument();
    // The real surface (P4-T03) renders, not the placeholder — its load/capacity
    // reading guidance is always present. Since the 2026-10-01 client text
    // cleanup that guidance is a popover affordance in the page header rather
    // than a paragraph of body copy, so this asserts it by role + name, like the
    // Registration/Planning navigation tests below.
    expect(
      await screen.findByRole('button', { name: 'How to read these figures' }),
    ).toBeInTheDocument();
  });

  it('navigates to the Prioritization Matrix surface on nav click', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('link', { name: 'Prioritization' }));
    expect(
      await screen.findByRole('heading', { name: 'Prioritization Matrix' }),
    ).toBeInTheDocument();
    // The real surface (P4-T04) renders, not the placeholder — its currency
    // toggle is always present.
    expect(await screen.findByText('Display currency')).toBeInTheDocument();
  });

  it('navigates to the Project Execution Timeline surface on nav click', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('link', { name: 'Timeline' }));
    expect(
      await screen.findByRole('heading', { name: 'Project Execution Timeline' }),
    ).toBeInTheDocument();
    // The real surface (P4-T05) renders, not the placeholder — its zoom control
    // is always present.
    expect(await screen.findByRole('radio', { name: 'Weeks zoom' })).toBeInTheDocument();
  });

  it('navigates to the Project Registration surface on nav click', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('link', { name: 'Register' }));
    expect(
      await screen.findByRole('heading', { name: 'Project Registration' }),
    ).toBeInTheDocument();
    // The real surface (P4-T06) renders, not the placeholder — its "New
    // project" action is always present (before any RBAC downgrade).
    expect(await screen.findByRole('button', { name: 'New project' })).toBeInTheDocument();
  });

  it('navigates to the Capacity Planning surface on nav click', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('link', { name: 'Planning' }));
    expect(await screen.findByRole('heading', { name: 'Capacity Planning' })).toBeInTheDocument();
    // The real surface (P4-T07) renders, not the placeholder — its tab list
    // (Engineers / Chambers / Apply Logic & Auto-assign) is always present.
    expect(await screen.findByRole('tab', { name: 'Apply Logic & Auto-assign' })).toBeInTheDocument();
  });

  it('navigates to the Audit Log surface on nav click', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('link', { name: 'Audit Log' }));
    expect(await screen.findByRole('heading', { name: 'Audit Log' })).toBeInTheDocument();
    // The real surface (P7-T05) renders, not the placeholder — its filter
    // fields are always present (before any RBAC downgrade).
    expect(await screen.findByLabelText('Entity type')).toBeInTheDocument();
  });

  it('renders the not-found page for an unknown route', async () => {
    renderApp('/nope-this-does-not-exist');
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  // 2026-10-01 (Boltshift): the rail is now PERMANENTLY icon-only (spec §4) — there
  // is no expanded state left to collapse into, so the old header toggle button
  // (`PanelLeft`, `useUiStore.sidebarCollapsed`) was removed outright rather than
  // relocated. This replaces the old "collapses the sidebar via the header toggle"
  // test with an assertion of the new, permanent state instead of a no-op control.
  it('renders the sidebar permanently icon-only, with no expand/collapse toggle', async () => {
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Expand sidebar' })).not.toBeInTheDocument();
    // Every surface link still resolves by its accessible name (sr-only label) —
    // the rail shows icons only, see app-sidebar.tsx.
    const nav = screen.getByRole('navigation', { name: 'Surfaces' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('exposes a working colour-theme toggle in the header', async () => {
    const user = userEvent.setup();
    renderApp('/');
    await screen.findByRole('heading', { name: 'Global RPD Dashboard' });
    await user.click(screen.getByRole('radio', { name: 'Dark theme' }));
    await waitFor(() => expect(document.documentElement).toHaveClass('dark'));
  });
});
